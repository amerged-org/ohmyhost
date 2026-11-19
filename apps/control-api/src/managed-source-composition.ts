import { parseUlid, type Clock, type HostingRegion, type UlidFactory } from "@ohmyhost/platform";
import {
  createManagedSourceSurface,
  ManagedSourceGitInputRefusedError,
  type ManagedSourceGitPort,
  type ManagedSourceBlobPort,
  type ManagedSourcePreparedCommit,
  type ManagedSourceGitFile,
  type ManagedSourceStore,
} from "./managed-source-surface.js";
import { isManagedSourcePath, MANAGED_SOURCE_LIMITS } from "@ohmyhost/contracts/managed-sources";

export interface ManagedSourcePrivateBinding {
  managedGit(method: string, input: unknown): Promise<unknown>;
  managedBlob(method: string, input: unknown): Promise<unknown>;
}

/** The provider port stays behind the source-fetcher service binding, outside public clients. */
export function createManagedSourcePrivatePorts(binding: ManagedSourcePrivateBinding): {
  readonly git: ManagedSourceGitPort;
  readonly blobs: ManagedSourceBlobPort;
} {
  return {
    git: {
      async ensureRepository(repository) {
        await binding.managedGit("ensureRepository", { repository });
      },
      async head(repository) {
        const value = await binding.managedGit("head", { repository });
        if (value === null) return null;
        return commit(value);
      },
      async files(repository, commitSha) {
        const value = await binding.managedGit("files", { repository, commitSha });
        if (!Array.isArray(value) || value.length > MANAGED_SOURCE_LIMITS.files) invalid();
        const files: ManagedSourceGitFile[] = [],
          seen = new Set<string>();
        let total = 0;
        for (const raw of value) {
          if (
            !object(raw) ||
            !isManagedSourcePath(raw["path"]) ||
            typeof raw["executable"] !== "boolean" ||
            !(raw["bytes"] instanceof Uint8Array) ||
            seen.has(raw["path"])
          )
            invalid();
          const bytes = raw["bytes"];
          if (
            bytes.byteLength > MANAGED_SOURCE_LIMITS.fileBytes ||
            (total += bytes.byteLength) > MANAGED_SOURCE_LIMITS.treeBytes
          )
            invalid();
          seen.add(raw["path"]);
          files.push({ path: raw["path"], bytes, executable: raw["executable"] });
        }
        return files;
      },
      async history(repository, input) {
        const value = await binding.managedGit("history", { repository, input });
        if (!Array.isArray(value) || value.length > input.limit) invalid();
        return value.map((raw) => {
          if (
            !object(raw) ||
            typeof raw["message"] !== "string" ||
            raw["message"].length > 4096 ||
            typeof raw["createdAt"] !== "string" ||
            !Number.isFinite(Date.parse(raw["createdAt"]))
          )
            invalid();
          return {
            commitSha: commit(raw["commitSha"]),
            parentSha: raw["parentSha"] === null ? null : commit(raw["parentSha"]),
            message: raw["message"],
            createdAt: raw["createdAt"],
          };
        });
      },
      async prepare(repository, input) {
        const raw = await binding
          .managedGit("prepare", { repository, input })
          .catch((error: unknown) => {
            // The service refuses a snapshot it cannot prepare as an invalid input: a deterministic refusal, not a transient failure.
            if (error instanceof Error && error.message === "managed_source_input_invalid")
              throw new ManagedSourceGitInputRefusedError();
            throw error;
          });
        if (!object(raw) || !("providerState" in raw)) invalid();
        return {
          commitSha: commit(raw["commitSha"]),
          treeSha: commit(raw["treeSha"]),
          parentSha: raw["parentSha"] === null ? null : commit(raw["parentSha"]),
          providerState: raw["providerState"],
        } satisfies ManagedSourcePreparedCommit;
      },
      async push(repository, prepared) {
        await binding.managedGit("push", { repository, prepared });
      },
      async containsCommit(repository, input) {
        const result = await binding.managedGit("containsCommit", { repository, input });
        if (typeof result !== "boolean") invalid();
        return result;
      },
    },
    blobs: {
      async put(input) {
        const raw = await binding.managedBlob("put", input);
        if (
          !object(raw) ||
          !bounded(raw["bucket"], 256) ||
          !bounded(raw["key"], 1024) ||
          !bounded(raw["versionId"], 256) ||
          !bounded(raw["eTag"], 256)
        )
          invalid();
        return {
          bucket: raw["bucket"],
          key: raw["key"],
          versionId: raw["versionId"],
          eTag: raw["eTag"],
        };
      },
      async get(input) {
        const raw = await binding.managedBlob("get", input);
        if (
          !(raw instanceof Uint8Array) ||
          raw.byteLength !== input.byteLength ||
          raw.byteLength > MANAGED_SOURCE_LIMITS.fileBytes
        )
          invalid();
        return raw;
      },
    },
  };
}

/** Provider-facing composition is identical for either closed persistence port. */
export function createManagedSourceCompositionFromStore(input: {
  readonly store: ManagedSourceStore;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly binding: ManagedSourcePrivateBinding;
  readonly namespaces: Readonly<Record<HostingRegion, string>>;
  readonly wake: () => Promise<void>;
}) {
  if (
    input.namespaces.us === input.namespaces.eu ||
    ![input.namespaces.us, input.namespaces.eu].every((name) =>
      /^[a-z0-9][a-z0-9._-]{0,62}$/u.test(name),
    )
  )
    throw new TypeError("Invalid managed Git namespaces");
  return createManagedSourceSurface({
    store: input.store,
    ...createManagedSourcePrivatePorts(input.binding),
    clock: input.clock,
    ids: input.ids,
    namespaces: input.namespaces,
    wake: input.wake,
  });
}

export function parseManagedSourceProcessorInput(raw: unknown) {
  if (!object(raw) || Object.keys(raw).sort().join(",") !== "operationId,organizationId,projectId")
    invalid();
  return {
    organizationId: parseUlid(String(raw["organizationId"])),
    projectId: parseUlid(String(raw["projectId"])),
    operationId: parseUlid(String(raw["operationId"])),
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)
  );
}
function commit(value: unknown): string {
  if (typeof value !== "string" || !/^(?!0{40}$)[a-f0-9]{40}$/u.test(value)) invalid();
  return value;
}
function invalid(): never {
  throw new TypeError("Managed source service returned an invalid scoped result");
}
