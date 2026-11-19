import type { PreviewRuntimeFence, ProjectPreviewRuntime } from "@ohmyhost/contracts/previews";
import {
  readDatabaseBindingScope,
  readDatabaseRegistrationReceipt,
  type DatabaseBindingScope,
  type DatabaseRegistrationReceipt,
} from "./registry.js";

export interface ProjectPreviewDatabaseBindings {
  readonly PROJECT_PREVIEW_AUTHORITY?: Pick<ProjectPreviewRuntime, "authorizeDatabase">;
}
export interface PreviewDatabaseCall {
  readonly fence: PreviewRuntimeFence;
  readonly operation: "query" | "transaction";
  readonly input: unknown;
}
export interface PreviewDatabaseAuthorization {
  readonly scope: DatabaseBindingScope;
  readonly fingerprint: string;
}
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const unavailable = () => new Error("project_database_unavailable");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Identity comes from a trusted preview Worker, never from the guest's SQL body. */
export function readPreviewDatabaseFence(value: unknown): PreviewRuntimeFence {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "previewId,runtimeGeneration,tokenGeneration" ||
    typeof value["previewId"] !== "string" ||
    !ULID.test(value["previewId"]) ||
    !Number.isSafeInteger(value["runtimeGeneration"]) ||
    Number(value["runtimeGeneration"]) < 1 ||
    !Number.isSafeInteger(value["tokenGeneration"]) ||
    Number(value["tokenGeneration"]) < 1
  )
    throw unavailable();
  return {
    previewId: value["previewId"],
    runtimeGeneration: value["runtimeGeneration"] as number,
    tokenGeneration: value["tokenGeneration"] as number,
  };
}

export function readPreviewDatabaseCall(value: unknown): PreviewDatabaseCall {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "fence,input,operation" ||
    (value["operation"] !== "query" && value["operation"] !== "transaction")
  )
    throw unavailable();
  return {
    fence: readPreviewDatabaseFence(value["fence"]),
    operation: value["operation"],
    input: value["input"],
  };
}

/** Re-read current Core authority and the exact registered physical target at every SQL fence. */
export async function authorizePreviewDatabase(
  env: ProjectPreviewDatabaseBindings,
  fence: PreviewRuntimeFence,
  inspect: (scope: DatabaseBindingScope) => Promise<DatabaseRegistrationReceipt | null>,
  expected?: PreviewDatabaseAuthorization,
): Promise<PreviewDatabaseAuthorization> {
  const authority = env.PROJECT_PREVIEW_AUTHORITY;
  if (!authority) throw unavailable();
  const decision = await authority.authorizeDatabase(fence);
  if (!decision) throw unavailable();
  const preview = decision.preview;
  const binding = readDatabaseRegistrationReceipt(decision.binding);
  if (
    preview.previewId !== fence.previewId ||
    preview.runtimeGeneration !== fence.runtimeGeneration ||
    preview.tokenGeneration !== fence.tokenGeneration ||
    preview.retirement !== "none" ||
    (preview.state !== "starting" && preview.state !== "ready") ||
    binding.status !== "active" ||
    binding.provider !== "pgcf" ||
    binding.organizationId !== preview.organizationId ||
    binding.projectId !== preview.projectId ||
    binding.physicalEnvironmentId !== preview.dataEnvironmentId ||
    binding.region !== preview.region ||
    !binding.authorizedEnvironmentIds.includes(preview.environmentId)
  )
    throw unavailable();
  const scope = readDatabaseBindingScope(
    {
      organizationId: preview.organizationId,
      projectId: preview.projectId,
      environmentId: preview.environmentId,
      physicalEnvironmentId: preview.dataEnvironmentId,
      region: preview.region,
      registrationVersion: binding.registrationVersion,
    },
    preview.region,
  );
  const local = await inspect(scope);
  if (!local || JSON.stringify(readDatabaseRegistrationReceipt(local)) !== JSON.stringify(binding))
    throw unavailable();
  const fingerprint = JSON.stringify([
    scope,
    preview.previewId,
    preview.runtimeGeneration,
    preview.tokenGeneration,
    preview.authGeneration,
    preview.assignmentVersion,
    preview.billingEpochId,
    preview.ownershipVersion,
    preview.lifecycleVersion,
  ]);
  if (expected && fingerprint !== expected.fingerprint) throw unavailable();
  return { scope, fingerprint };
}
