/** Exact pure snapshot parsers ported from the Source database; no PostgreSQL runtime dependency. */
import { parseUlid } from "@ohmyhost/platform";
import type {
  ProductCommandIntent,
  ProjectDataChangeSnapshot,
  ProjectDataChangeKind,
  ProjectDataAssignments,
  ProjectDataChangeTransition,
} from "@ohmyhost/database";
import { ProductWorkflowContextConflictError as DeploymentPersistenceConflictError } from "./context.js";
type ProjectBindingRefreshSnapshot = NonNullable<ProductCommandIntent["bindingRefreshSnapshot"]>;
class ProjectDataEnvironmentConflictError extends Error {
  readonly code = "data_change_not_applicable";
  constructor() {
    super("Project data assignments conflict with the requested change");
  }
}

const ID_KEYS = [
  "sourceDeploymentId",
  "sourceRevisionId",
  "sourceCandidateReceiptId",
  "sourceArtifactId",
  "sourcePlanId",
  "sourceBuildExecutionId",
  "dataEnvironmentId",
] as const;
const TEXT_KEYS = [
  "sourceArtifactSha256",
  "sourceNamespace",
  "sourceScriptName",
  "sourceProviderTag",
] as const;
const COUNTER_KEYS = [
  "expectedHeadVersion",
  "expectedGatewayRevision",
  "assignmentVersion",
  "registrationVersion",
] as const;
const KEYS = [...ID_KEYS, ...TEXT_KEYS, ...COUNTER_KEYS].sort();

/** Private persisted intent only: no extra fields or inferred source identity. */
export function parseProjectBindingRefreshSnapshot(value: unknown): ProjectBindingRefreshSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).sort().join(",") !== KEYS.join(",")
  )
    throw new TypeError("Binding refresh snapshot is invalid");
  const input = value as Record<string, unknown>;
  for (const key of ID_KEYS) {
    if (typeof input[key] !== "string") throw new TypeError("Binding refresh snapshot is invalid");
    parseUlid(input[key]);
  }
  if (
    typeof input["sourceArtifactSha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input["sourceArtifactSha256"]) ||
    typeof input["sourceNamespace"] !== "string" ||
    !/^[a-z0-9-]{1,64}$/u.test(input["sourceNamespace"]) ||
    typeof input["sourceScriptName"] !== "string" ||
    !/^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$/u.test(input["sourceScriptName"]) ||
    typeof input["sourceProviderTag"] !== "string" ||
    !/^[a-f0-9]{32}$/u.test(input["sourceProviderTag"])
  )
    throw new TypeError("Binding refresh snapshot is invalid");
  for (const key of COUNTER_KEYS)
    if (
      !Number.isSafeInteger(input[key]) ||
      Number(input[key]) < (key === "registrationVersion" ? 0 : 1)
    )
      throw new TypeError("Binding refresh snapshot is invalid");
  return Object.freeze({ ...input }) as unknown as ProjectBindingRefreshSnapshot;
}

/** Parse only the frozen, credential-free plan that acceptance stored. */
export function parseProjectDataChangeSnapshot(value: unknown): ProjectDataChangeSnapshot {
  const snapshot = record(value);
  if (
    Object.keys(snapshot).sort().join(",") !== "environmentHeads,registrationGenerations,transition"
  )
    invalid();
  const candidate = record(snapshot["transition"]),
    before = record(candidate["before"]);
  const change = candidate["change"] as ProjectDataChangeKind;
  const assignments = before as unknown as ProjectDataAssignments;
  if (
    (before["dataMode"] !== "shared" && before["dataMode"] !== "isolated") ||
    Object.keys(before).sort().join(",") !== "dataMode,dev,prod"
  )
    invalid();
  for (const name of ["dev", "prod"] as const) {
    const assignment = record(before[name]);
    if (
      Object.keys(assignment).sort().join(",") !==
        "assignedAt,assignmentVersion,dataEnvironmentId,environment,environmentId" ||
      assignment["environment"] !== name ||
      typeof assignment["assignedAt"] !== "string" ||
      new Date(assignment["assignedAt"]).toISOString() !== assignment["assignedAt"] ||
      !Number.isSafeInteger(assignment["assignmentVersion"]) ||
      Number(assignment["assignmentVersion"]) < 1
    )
      invalid();
    parseUlid(String(assignment["environmentId"]));
    parseUlid(String(assignment["dataEnvironmentId"]));
  }
  const after = record(candidate["after"]),
    losing = change === "isolate_dev_keeps_data" ? "prod" : "dev";
  const target = record(after[losing]);
  const transition = planProjectDataChangeTransition({
    change,
    assignments,
    newDataEnvironmentId: String(target["dataEnvironmentId"]),
    prodDatabaseReady: true,
  });
  if (canonical(candidate) !== canonical(transition)) invalid();
  const heads = snapshot["environmentHeads"],
    generations = snapshot["registrationGenerations"];
  if (
    !Array.isArray(heads) ||
    heads.length !== 2 ||
    !Array.isArray(generations) ||
    generations.length < 1 ||
    generations.length > 2
  )
    invalid();
  const environmentHeads = heads.map((value) => {
    const head = record(value);
    if (
      Object.keys(head).sort().join(",") !== "environmentId,expectedHeadVersion" ||
      !Number.isSafeInteger(head["expectedHeadVersion"]) ||
      Number(head["expectedHeadVersion"]) < 0
    )
      invalid();
    return Object.freeze({
      environmentId: parseUlid(String(head["environmentId"])),
      expectedHeadVersion: Number(head["expectedHeadVersion"]),
    });
  });
  if (
    new Set(environmentHeads.map((head) => head.environmentId)).size !== 2 ||
    environmentHeads.some(
      (head) =>
        head.environmentId !== transition.before.dev.environmentId &&
        head.environmentId !== transition.before.prod.environmentId,
    )
  )
    invalid();
  const registrationGenerations = generations.map((value) => {
    const generation = record(value);
    if (
      Object.keys(generation).sort().join(",") !== "dataEnvironmentId,registrationVersion" ||
      !Number.isSafeInteger(generation["registrationVersion"]) ||
      Number(generation["registrationVersion"]) < 0
    )
      invalid();
    return Object.freeze({
      dataEnvironmentId: parseUlid(String(generation["dataEnvironmentId"])),
      registrationVersion: Number(generation["registrationVersion"]),
    });
  });
  const physicalIds = new Set([
    transition.before.dev.dataEnvironmentId,
    transition.before.prod.dataEnvironmentId,
  ]);
  if (
    new Set(registrationGenerations.map((item) => item.dataEnvironmentId)).size !==
      physicalIds.size ||
    registrationGenerations.some((item) => !physicalIds.has(item.dataEnvironmentId))
  )
    invalid();
  return Object.freeze({
    transition,
    environmentHeads: Object.freeze(environmentHeads),
    registrationGenerations: Object.freeze(registrationGenerations),
  });
}

export function planProjectDataChangeTransition(input: {
  readonly change: ProjectDataChangeKind;
  readonly assignments: ProjectDataAssignments;
  readonly newDataEnvironmentId: string;
  readonly prodDatabaseReady: boolean;
}): ProjectDataChangeTransition {
  const { change, assignments: before } = input;
  parseUlid(input.newDataEnvironmentId);
  for (const assignment of [before.dev, before.prod]) {
    parseUlid(assignment.environmentId);
    parseUlid(assignment.dataEnvironmentId);
  }
  const shared = before.dev.dataEnvironmentId === before.prod.dataEnvironmentId;
  if (
    shared !== (before.dataMode === "shared") ||
    (change === "isolate_prod_keeps_data" || change === "isolate_dev_keeps_data"
      ? !shared
      : shared) ||
    (change === "share_prod_keeps_data" && !input.prodDatabaseReady) ||
    ![
      "isolate_prod_keeps_data",
      "isolate_dev_keeps_data",
      "share_prod_keeps_data",
      "reset_dev",
    ].includes(change) ||
    (change !== "share_prod_keeps_data" &&
      [before.dev.dataEnvironmentId, before.prod.dataEnvironmentId].includes(
        input.newDataEnvironmentId,
      ))
  )
    throw new ProjectDataEnvironmentConflictError();
  const losing: "dev" | "prod" = change === "isolate_dev_keeps_data" ? "prod" : "dev";
  const after = Object.freeze({
    ...before,
    dataMode: change === "share_prod_keeps_data" ? ("shared" as const) : ("isolated" as const),
    [losing]: Object.freeze({
      ...before[losing],
      dataEnvironmentId:
        change === "share_prod_keeps_data"
          ? before.prod.dataEnvironmentId
          : input.newDataEnvironmentId,
      assignmentVersion: before[losing].assignmentVersion + 1,
    }),
  });
  const removeDevDeployment = change === "share_prod_keeps_data" || change === "reset_dev";
  const reauthorizations: ProjectDataChangeTransition["reauthorizations"] = [
    ...(removeDevDeployment
      ? [
          {
            dataEnvironmentId: before.dev.dataEnvironmentId,
            authorizedEnvironmentIds: Object.freeze([] as string[]),
            direction: "narrow" as const,
          },
        ]
      : []),
    ...(change === "reset_dev"
      ? []
      : [
          {
            dataEnvironmentId:
              change === "share_prod_keeps_data"
                ? before.prod.dataEnvironmentId
                : before.dev.dataEnvironmentId,
            authorizedEnvironmentIds: Object.freeze(
              change === "share_prod_keeps_data"
                ? [before.dev.environmentId, before.prod.environmentId].sort()
                : [before[losing === "dev" ? "prod" : "dev"].environmentId],
            ),
            direction:
              change === "share_prod_keeps_data" ? ("widen" as const) : ("narrow" as const),
          },
        ]),
  ];
  return Object.freeze({
    change,
    before,
    after,
    retiredDataEnvironmentIds: Object.freeze(
      removeDevDeployment ? [before.dev.dataEnvironmentId] : [],
    ),
    reauthorizations: Object.freeze(reauthorizations),
    redeployEnvironments: Object.freeze([losing]),
    removeDevDeployment,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function invalid(): never {
  throw new DeploymentPersistenceConflictError(
    "Project data change snapshot or current state changed",
  );
}
