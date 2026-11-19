import { parseOhmyhostConfigYaml, resolvePackageManager } from "@ohmyhost/contracts";
import {
  packageManagerDeclaration,
  parsePackageManifest,
} from "@ohmyhost/contracts/framework-source-rules";
import type {
  PreviewSourceDelta as WirePreviewSourceDelta,
  PreviewSourceDescriptor,
  PreviewSourceOperation,
  SourceVersion,
} from "@ohmyhost/contracts/previews";
import type { FrameworkPlan } from "@ohmyhost/platform";
import { inspectFrameworkArchive, readPreviewArchive } from "./vite-archive-inspector.js";

export type { PreviewSourceOperation } from "@ohmyhost/contracts/previews";
export type PreviewSourceDelta = WirePreviewSourceDelta<FrameworkPlan>;
interface PreviewDiffRequest {
  readonly previewId: string;
  readonly runtimeGeneration: number;
  readonly tokenGeneration: number;
  readonly from: SourceVersion | null;
  readonly to: SourceVersion;
}
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const dependency =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.ya?ml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc\.yml|\.pnpmfile\.cjs|ohmyhost\.yaml)$/u;

function validVersion(value: SourceVersion): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    ULID.test(value.sourceConnectionId) &&
    Number.isSafeInteger(value.sourceGeneration) &&
    value.sourceGeneration > 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    COMMIT.test(value.commitSha)
  );
}
async function digest(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}`;
}
function installFacts(
  files: Awaited<ReturnType<typeof readPreviewArchive>>,
): PreviewSourceDelta["install"] {
  try {
    const decode = new TextDecoder("utf-8", { fatal: true });
    const configuration = files.get("ohmyhost.yaml");
    if (configuration === undefined) return null;
    const applicationRoot = parseOhmyhostConfigYaml(
      decode.decode(configuration.bytes),
    ).applicationRoot;
    const prefix = applicationRoot === "." ? "" : `${applicationRoot}/`;
    const packageBytes = files.get(`${prefix}package.json`);
    if (packageBytes === undefined) return null;
    const manifest = parsePackageManifest(decode.decode(packageBytes.bytes));
    if (manifest === null) return null;
    const packageManager = resolvePackageManager({
      packageManager: packageManagerDeclaration(manifest),
      files: [...files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length)),
    });
    return {
      applicationRoot,
      manager: packageManager.manager,
      version: packageManager.version,
      lockfile: packageManager.lockfile,
      command: packageManager.installCommand,
    };
  } catch {
    return null;
  }
}

/** Private runtime port: Core authorizes the exact current target before and after acquisition. */
export function createPreviewSourceReader(input: {
  readonly readSource: (request: {
    previewId: string;
    runtimeGeneration: number;
    tokenGeneration: number;
    sequence: number;
  }) => Promise<PreviewSourceDescriptor | null>;
  readonly readArchive: (
    source: PreviewSourceDescriptor,
    commitSha: string,
    sequence: number,
  ) => Promise<Uint8Array>;
}) {
  return Object.freeze({
    async diff(request: PreviewDiffRequest): Promise<PreviewSourceDelta> {
      if (
        !request ||
        !ULID.test(request.previewId) ||
        !Number.isSafeInteger(request.runtimeGeneration) ||
        request.runtimeGeneration <= 0 ||
        !Number.isSafeInteger(request.tokenGeneration) ||
        request.tokenGeneration <= 0 ||
        !validVersion(request.to) ||
        (request.from !== null &&
          (!validVersion(request.from) ||
            request.from.sourceConnectionId !== request.to.sourceConnectionId ||
            request.from.sourceGeneration !== request.to.sourceGeneration ||
            request.from.sequence > request.to.sequence ||
            (request.from.sequence === request.to.sequence &&
              request.from.commitSha !== request.to.commitSha)))
      )
        throw new TypeError("Invalid preview source version");
      const authority = {
        previewId: request.previewId,
        runtimeGeneration: request.runtimeGeneration,
        tokenGeneration: request.tokenGeneration,
        sequence: request.to.sequence,
      };
      const source = await input.readSource(authority);
      if (
        !source ||
        source.sourceConnectionId !== request.to.sourceConnectionId ||
        stable(source.targetSource) !== stable(request.to)
      )
        throw new Error("Preview source is unavailable");
      const targetArchive = await input.readArchive(
        source,
        request.to.commitSha,
        request.to.sequence,
      );
      const next = await readPreviewArchive(targetArchive);
      let from = request.from;
      let prior: Awaited<ReturnType<typeof readPreviewArchive>> = new Map();
      if (from?.sequence === request.to.sequence) prior = next;
      else if (from !== null) {
        let archive: Uint8Array | undefined;
        try {
          archive = await input.readArchive(source, from.commitSha, from.sequence);
        } catch {
          // The base could be unreachable or temporarily unavailable. A caller must start a
          // clean workspace for this full snapshot; overlaying it could leave deleted files.
          console.warn(JSON.stringify({ event: "preview_source_base_unavailable" }));
          from = null;
        }
        if (archive !== undefined) prior = await readPreviewArchive(archive);
      }
      const inspection = await inspectFrameworkArchive(targetArchive);
      const operations: PreviewSourceOperation[] = [];
      for (const path of [...prior.keys()].sort())
        if (!next.has(path)) operations.push({ kind: "delete", path });
      for (const [path, file] of [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const sha256 = await digest(file.bytes);
        const old = prior.get(path);
        if (
          old === undefined ||
          old.executable !== file.executable ||
          (await digest(old.bytes)) !== sha256
        )
          operations.push({
            kind: "write",
            path,
            bytes: file.bytes,
            sha256,
            executable: file.executable,
          });
      }
      const current = await input.readSource(authority);
      if (!current || stable(source) !== stable(current))
        throw new Error("Preview source authority changed");
      return {
        from,
        to: request.to,
        operations,
        dependenciesChanged: from === null || operations.some((item) => dependency.test(item.path)),
        install: installFacts(next),
        inspection,
      };
    },
  });
}
