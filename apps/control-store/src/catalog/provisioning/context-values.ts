import { parseUlid, parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import type {
  ProductCommandIntent,
  ProductWorkflowContext,
  ProductWorkflowArtifactExpectation,
  ProductWorkflowProviderScope,
  ProductWorkflowWfpReceipt,
} from "@ohmyhost/database";
import { receiptOf, type Route } from "../gateway/mutations.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import {
  parseProjectBindingRefreshSnapshot,
  parseProjectDataChangeSnapshot,
} from "./context-snapshots.js";

export type Row = Record<string, unknown>;
export type ProductWorkflowWireIntent = Omit<
  ProductCommandIntent,
  "sourceArtifactDigest" | "sourceDigest" | "buildPlanDigest"
> & {
  readonly sourceArtifactDigest: Uint8Array | null;
  readonly sourceDigest: Uint8Array | null;
  readonly buildPlanDigest: Uint8Array | null;
};
export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  )
    return Uint8Array.from(value as number[]);
  throw new TypeError("Persisted evidence bytes are invalid");
}
export function hex(value: unknown): string {
  return Array.from(bytes(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function integer(value: unknown, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new TypeError("Persisted workflow counter is invalid");
  return parsed;
}
export function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}
export function text(row: Row, key: string): string {
  if (typeof row[key] !== "string") throw new TypeError(`Persisted workflow ${key} is invalid`);
  return row[key];
}
export function nullableText(row: Row, key: string): string | null {
  return row[key] == null ? null : text(row, key);
}
export function environmentName(value: unknown): "dev" | "prod" {
  if (value !== "dev" && value !== "prod")
    throw new TypeError("Persisted environment name is invalid");
  return value;
}
export function handle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 59 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(value)
  )
    throw new TypeError("Persisted project handle is invalid");
  return value;
}
export function intentOf(row: Row): ProductWorkflowWireIntent {
  const id = (key: string) => (row[key] == null ? null : parseUlid(text(row, key)));
  const digest = (key: string) => (row[key] == null ? null : bytes(row[key]));
  return {
    eventType: text(row, "event_type") as ProductCommandIntent["eventType"],
    organizationId: parseUlid(text(row, "organization_id")),
    projectId: parseUlid(text(row, "project_id")),
    environmentId: parseUlid(text(row, "environment_id")),
    operationId: parseUlid(text(row, "operation_id")),
    billingEpochId: parseUlid(text(row, "billing_epoch_id")),
    installationId: nullableText(row, "installation_id"),
    repositoryOwner: nullableText(row, "repository_owner"),
    repositoryName: nullableText(row, "repository_name"),
    planId: id("plan_id"),
    sourceConnectionId: id("source_connection_id"),
    sourceGeneration: row["source_generation"] == null ? null : Number(row["source_generation"]),
    deploymentId: id("deployment_id"),
    targetDeploymentId: id("target_deployment_id"),
    targetRevisionId: id("target_revision_id"),
    targetArtifactId: id("target_artifact_id"),
    expectedEtag: nullableText(row, "expected_etag"),
    requestedHandle: nullableText(row, "requested_handle"),
    cleanupRunId: id("cleanup_run_id"),
    sourceEnvironmentId: id("source_environment_id"),
    sourceDeploymentId: id("source_deployment_id"),
    sourceRevisionId: id("source_revision_id"),
    sourceArtifactId: id("source_artifact_id"),
    sourceArtifactDigest: digest("source_artifact_sha256"),
    expectedSourceHeadVersion:
      row["expected_source_head_version"] == null
        ? null
        : Number(row["expected_source_head_version"]),
    expectedTargetHeadVersion:
      row["expected_target_head_version"] == null
        ? null
        : Number(row["expected_target_head_version"]),
    commitSha: nullableText(row, "commit_sha"),
    sourceDigest: digest("source_sha256"),
    buildPlanDigest: digest("build_plan_sha256"),
    providerVersionId: nullableText(row, "provider_version_id"),
    dataChange: (row["data_change"] as ProductCommandIntent["dataChange"]) ?? null,
    dataChangeSnapshot:
      row["data_change_snapshot"] == null
        ? null
        : parseProjectDataChangeSnapshot(JSON.parse(text(row, "data_change_snapshot"))),
    bindingRefreshSnapshot:
      row["binding_refresh_snapshot"] == null
        ? null
        : parseProjectBindingRefreshSnapshot(JSON.parse(text(row, "binding_refresh_snapshot"))),
  };
}
export function wfpOf(
  row: Row,
  projectId: string,
  environmentId: string,
): ProductWorkflowWfpReceipt {
  const bindingDigest = row["binding_set_digest"] == null ? null : bytes(row["binding_set_digest"]);
  if (bindingDigest !== null && bindingDigest.byteLength !== 32)
    throw new TypeError("Persisted binding set digest is invalid");
  return {
    provider: "cloudflare-wfp",
    namespace: text(row, "dispatch_namespace"),
    scriptName: text(row, "script_name"),
    projectId: parseUlid(projectId),
    environmentId: parseUlid(environmentId),
    productDeploymentId: parseUlid(text(row, "deployment_id")),
    providerTag: text(row, "provider_version_id"),
    artifactDigest: `sha256:${hex(row["artifact_sha256"])}`,
    ...(bindingDigest === null ? {} : { bindingSetDigest: `sha256:${hex(bindingDigest)}` }),
    buildReused: row["build_reused"] === 1,
    deployedAt: iso(row["published_at"]),
  };
}
export async function activeReceipt(
  row: Row | undefined,
  input: {
    projectId: string;
    environmentId: string;
    deploymentId: string;
    handle: string;
    environmentName: "dev" | "prod";
  },
): Promise<{
  wfp: ProductWorkflowWfpReceipt;
  gateway: NonNullable<ProductWorkflowContext["activeGateway"]>;
} | null> {
  if (row === undefined) return null;
  const revision = integer(row["shared_gateway_revision"], 1);
  const gateway = await receiptOf(JSON.parse(text(row, "route_value")) as Route);
  const wfp = wfpOf(
    { ...row, deployment_id: input.deploymentId, build_reused: 0 },
    input.projectId,
    input.environmentId,
  );
  if (
    gateway.revision !== revision ||
    !gateway.active ||
    gateway.handle !== input.handle ||
    gateway.environmentName !== input.environmentName ||
    gateway.targetDeploymentId !== input.deploymentId ||
    gateway.targetScriptName !== wfp.scriptName ||
    gateway.targetArtifactDigest !== wfp.artifactDigest ||
    gateway.targetProviderTag !== wfp.providerTag
  )
    throw new ProductWorkflowContextConflictError("Committed gateway route changed");
  return { wfp, gateway: { ...gateway, observedAt: gateway.observedAt.toISOString() } };
}
const OBJECT_VERSION_REFERENCE =
  /^r2-version:(ohmyho-builds-(?:development|production)(?:-eu)?)\/([^#]{1,512})#([0-9a-f]{32})$/u;
export function outputOf(
  value: string,
  scope: ProductWorkflowProviderScope,
  exact: boolean,
): ProductWorkflowArtifactExpectation["output"] {
  const match = OBJECT_VERSION_REFERENCE.exec(value);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    (exact &&
      match[2] !==
        `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}/output/bundle.tar.gz`)
  )
    throw new TypeError("Persisted build artifact object reference is invalid");
  return { bucket: match[1], key: match[2], versionId: match[3], scope };
}
export function artifactOf(
  row: Row,
  projectId: string,
  environmentId: string,
  single = false,
): ProductWorkflowArtifactExpectation {
  const scope = {
    projectId: parseUlid(projectId),
    environmentId: parseUlid(single ? text(row, "build_environment_id") : environmentId),
    operationId: parseUlid(text(row, "operation_id")),
  };
  return {
    receipt: {
      buildId: text(row, "provider_build_id"),
      projectName: text(row, "build_project_name"),
      scope,
    },
    deploymentId: parseUlid(text(row, single ? "build_deployment_id" : "deployment_id")),
    commitSha: text(row, "commit_sha"),
    sourceSha256: hex(row["source_sha256"]),
    buildPlanSha256: hex(row["build_plan_sha256"]),
    frameworkPlan: parseNewProductionFrameworkPlan(JSON.parse(text(row, "framework_plan"))),
    output: outputOf(text(row, "object_version_ref"), scope, true),
  };
}
export async function resourceHash(
  provider: string,
  kind: string,
  locator: string,
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${provider}\0${kind}\0${locator}`),
    ),
  );
  return hex(bytes);
}
