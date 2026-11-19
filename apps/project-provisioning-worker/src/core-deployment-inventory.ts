import {
  parseUlid,
  parseSharedGatewayReceipt,
  parseNewProductionFrameworkPlan,
  type Ulid,
} from "@ohmyhost/platform";
import { DeploymentPersistenceConflictError } from "@ohmyhost/database/provisioning-persistence";
import type { DeploymentInventoryPort } from "./deployment-inventory-port.js";
export interface DeploymentInventoryRuntimeBinding {
  listNextCacheRetirementScopes(input: unknown): Promise<unknown>;
  recordNextCacheRetired(input: unknown): Promise<unknown>;
  readWfpProjectDeletionEvidence(input: unknown): Promise<unknown>;
  readCandidateCleanupResources(input: unknown): Promise<unknown>;
  recordCleanupAttempt(input: unknown): Promise<unknown>;
  startProjectDataChangeCleanup(input: unknown): Promise<unknown>;
  appendAuditedProjectDataChangeAssignments(input: unknown): Promise<unknown>;
  deleteProjectFunctionSchedules(input: unknown): Promise<unknown>;
  readManagedSourceDeletionInventory(input: unknown): Promise<unknown>;
}

type Parse<T> = (raw: unknown) => T;
type Input = Readonly<Record<string, unknown>>;
function invalid(): never {
  throw new Error("deployment_inventory_response_invalid");
}
const text: Parse<string> = (raw) => (typeof raw === "string" ? raw : invalid());
const ulid: Parse<Ulid> = (raw) => parseUlid(text(raw));
const hex: Parse<string> = (raw) => {
  const value = text(raw);
  return /^[a-f0-9]{64}$/u.test(value) ? value : invalid();
};
const boolean: Parse<boolean> = (raw) => (typeof raw === "boolean" ? raw : invalid());
const time: Parse<string> = (raw) => {
  const value = text(raw);
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
    ? value
    : invalid();
};
const integer =
  (min: number): Parse<number> =>
  (raw) =>
    typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min ? raw : invalid();
const digest: Parse<Uint8Array> = (raw) =>
  raw instanceof Uint8Array && raw.byteLength === 32 ? Uint8Array.from(raw) : invalid();
const list =
  <T>(item: Parse<T>): Parse<T[]> =>
  (raw) =>
    Array.isArray(raw) ? raw.map((one) => item(one)) : invalid();
/** Exactly these keys, each parsed by its own rule; a missing or extra key is a protocol violation. */
const record =
  <S extends Record<string, Parse<unknown>>>(
    shape: S,
  ): Parse<{ [K in keyof S]: ReturnType<S[K]> }> =>
  (raw) => {
    const keys = Object.keys(shape).sort().join(",");
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== keys
    )
      return invalid();
    return Object.fromEntries(
      Object.entries(shape).map(([key, parse]) => [key, parse(Reflect.get(raw, key))]),
    ) as never;
  };
/** The parsed value must carry exactly the expected facts: a foreign project or operation is never accepted. */
const within =
  <T extends object>(parse: Parse<T>, expected: Readonly<Record<string, unknown>>): Parse<T> =>
  (raw) => {
    const value = parse(raw);
    return Object.entries(expected).every(([key, fact]) => Reflect.get(value, key) === fact)
      ? value
      : invalid();
  };

const providerScope = record({ projectId: ulid, environmentId: ulid, operationId: ulid });
const candidateShape = {
  candidateReceiptId: ulid,
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  productDeploymentId: ulid,
  artifactId: ulid,
  namespace: text,
  immutableScriptName: text,
  artifactDigest: digest,
  providerTag: text,
  buildReused: boolean,
  stagedAt: time,
};
const candidate: Parse<import("@ohmyhost/database").WfpCandidateReceipt> = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  return Object.hasOwn(raw, "bindingSetDigest")
    ? record({ ...candidateShape, bindingSetDigest: digest })(raw)
    : record(candidateShape)(raw);
};
const managed = record({
  repos: list(record({ sourceConnectionId: text, namespace: text, repositoryName: text })),
  blobOperations: list(
    record({
      operationId: ulid,
      blobs: list(
        record({
          path: text,
          sha256: hex,
          byteLength: integer(0),
          executable: boolean,
          bucket: text,
          key: text,
          versionId: text,
          eTag: text,
        }),
      ),
    }),
  ),
});
const result: Parse<"created" | "existing"> = (raw) =>
  raw === "created" || raw === "existing" ? raw : invalid();

function deletion(raw: unknown, input: Input) {
  const owned = { organizationId: input["organizationId"], projectId: input["projectId"] };
  return record({
    candidates: list(within(candidate, owned)),
    activeGateways: list(
      within((one) => parseSharedGatewayReceipt(one), { ...owned, active: true }),
    ),
  })(raw);
}
function cleanup(raw: unknown, input: Input) {
  const own = within(providerScope, {
    projectId: input["projectId"],
    environmentId: input["environmentId"],
    operationId: input["operationId"],
  });
  return record({
    sourceArchives: list(
      record({
        bucket: text,
        key: text,
        versionId: text,
        eTag: text,
        byteLength: integer(1),
        scope: own,
        sourceSha256: hex,
      }),
    ),
    artifactExpectations: list(
      record({
        receipt: record({ buildId: text, projectName: text, scope: own }),
        deploymentId: ulid,
        commitSha: text,
        sourceSha256: hex,
        buildPlanSha256: hex,
        frameworkPlan: parseNewProductionFrameworkPlan,
        output: record({ bucket: text, key: text, versionId: text, scope: own }),
      }),
    ),
  })(raw);
}
async function invoke<T>(run: () => Promise<unknown>, parse: Parse<T>): Promise<T> {
  let raw;
  try {
    raw = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "store_outcome_unknown" || message.endsWith(": store_outcome_unknown"))
      throw Object.assign(new Error("store_outcome_unknown"), { code: "store_outcome_unknown" });
    if (
      (error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "deployment_persistence_conflict") ||
      message.includes("DeploymentPersistenceConflictError")
    )
      throw new DeploymentPersistenceConflictError(message);
    throw new Error("deployment_inventory_unavailable");
  }
  return parse(raw);
}

/** Every port method: the private RPC method, the exact wire fields that cross it and the response rule. */
const CALLS: Readonly<
  Record<
    keyof DeploymentInventoryPort,
    {
      rpc: keyof DeploymentInventoryRuntimeBinding;
      fields: readonly string[];
      parse: (raw: unknown, input: Input) => unknown;
    }
  >
> = {
  listNextCacheRetirementScopes: {
    rpc: "listNextCacheRetirementScopes",
    fields: ["organizationId", "projectId", "operationId", "cleanupRunId", "cursor", "limit"],
    parse: (raw, input) => {
      if (raw === null) return null;
      const page = record({
        scopes: list(record({ environmentId: ulid, deploymentId: ulid })),
        nextCursor: (value: unknown) => (value === null ? null : ulid(value)),
      })(raw);
      if (
        page.scopes.length > 100 ||
        page.scopes.some(
          (scope, index) =>
            scope.deploymentId <=
            String(index === 0 ? (input["cursor"] ?? "") : page.scopes[index - 1]?.deploymentId),
        ) ||
        (page.nextCursor !== null &&
          (page.scopes.length === 0 || page.nextCursor !== page.scopes.at(-1)?.deploymentId))
      )
        return invalid();
      return page;
    },
  },
  recordNextCacheRetired: {
    rpc: "recordNextCacheRetired",
    fields: [
      "organizationId",
      "projectId",
      "environmentId",
      "deploymentId",
      "operationId",
      "cleanupRunId",
    ],
    parse: (raw) => (raw === "recorded" || raw === "existing" || raw === null ? raw : invalid()),
  },
  readManagedSourceInventory: {
    rpc: "readManagedSourceDeletionInventory",
    fields: ["organizationId", "projectId", "operationId"],
    parse: managed,
  },
  readDeletionEvidence: {
    rpc: "readWfpProjectDeletionEvidence",
    fields: ["organizationId", "projectId"],
    parse: deletion,
  },
  readCleanupResources: {
    rpc: "readCandidateCleanupResources",
    fields: ["organizationId", "projectId", "environmentId", "operationId"],
    parse: cleanup,
  },
  recordCleanupAttempt: {
    rpc: "recordCleanupAttempt",
    fields: [
      "cleanupAttemptId",
      "organizationId",
      "projectId",
      "operationId",
      "provider",
      "resourceKind",
      "externalRefHash",
      "outcome",
      "errorCode",
      "attemptedAt",
    ],
    parse: result,
  },
  startDataChange: {
    rpc: "startProjectDataChangeCleanup",
    fields: ["organizationId", "projectId", "operationId", "claimId", "snapshot", "now"],
    parse: result,
  },
  switchAssignments: {
    rpc: "appendAuditedProjectDataChangeAssignments",
    fields: ["organizationId", "projectId", "operationId", "claimId", "snapshot", "now"],
    parse: result,
  },
  deleteSchedules: {
    rpc: "deleteProjectFunctionSchedules",
    fields: ["organizationId", "projectId"],
    parse: integer(0),
  },
};
/** Native-shaped fixed methods. No supplier/SQL/provider or generic administrative command crosses RPC. */
export function createCoreDeploymentInventory(raw: unknown): DeploymentInventoryPort {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    Object.values(CALLS).some(({ rpc }) => typeof Reflect.get(raw, rpc) !== "function")
  )
    throw new Error("deployment_inventory_binding_required");
  const binding = raw as DeploymentInventoryRuntimeBinding;
  return Object.fromEntries(
    Object.entries(CALLS).map(([name, { rpc, fields, parse }]) => [
      name,
      (input: Input) =>
        invoke(
          () =>
            binding[rpc](
              Object.fromEntries(
                fields
                  .filter((field) => input[field] !== undefined)
                  .map((field) => {
                    const value = input[field];
                    return [field, value instanceof Uint8Array ? Uint8Array.from(value) : value];
                  }),
              ),
            ),
          (response) => parse(response, input),
        ),
    ]),
  ) as unknown as DeploymentInventoryPort;
}
