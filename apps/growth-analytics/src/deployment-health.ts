import type { GrowthD1 } from "./event-store.js";

export interface DeploymentHealthScope {
  candidate_receipt_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  deployment_id: string;
}
export interface DeploymentHealthObservation extends DeploymentHealthScope {
  schema_version: 1;
  observation_id: string;
  health_status: "passed" | "failed";
  http_status: number;
  observed_at: string;
}
const keys = [
  "schema_version",
  "observation_id",
  "candidate_receipt_id",
  "organization_id",
  "project_id",
  "environment_id",
  "deployment_id",
  "health_status",
  "http_status",
  "observed_at",
];
export function parseDeploymentHealth(input: unknown): DeploymentHealthObservation {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid health observation");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    new TextEncoder().encode(JSON.stringify(value)).length > 4096
  )
    throw new Error("invalid health observation");
  if (
    value["schema_version"] !== 1 ||
    typeof value["observation_id"] !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value["observation_id"],
    )
  )
    throw new Error("invalid health observation");
  for (const key of [
    "candidate_receipt_id",
    "organization_id",
    "project_id",
    "environment_id",
    "deployment_id",
  ])
    if (
      typeof value[key] !== "string" ||
      !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value[key] as string)
    )
      throw new Error("invalid health scope");
  const status = value["http_status"];
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    value["health_status"] !== (status >= 200 && status < 300 ? "passed" : "failed")
  )
    throw new Error("invalid health verdict");
  const observed = value["observed_at"];
  if (
    typeof observed !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(observed) ||
    !Number.isFinite(Date.parse(observed)) ||
    new Date(observed).toISOString() !== observed
  )
    throw new Error("invalid health time");
  return {
    schema_version: 1,
    observation_id: value["observation_id"] as string,
    candidate_receipt_id: value["candidate_receipt_id"] as string,
    organization_id: value["organization_id"] as string,
    project_id: value["project_id"] as string,
    environment_id: value["environment_id"] as string,
    deployment_id: value["deployment_id"] as string,
    health_status: value["health_status"] as "passed" | "failed",
    http_status: status,
    observed_at: observed,
  };
}
export async function appendDeploymentHealth(
  db: GrowthD1,
  input: unknown,
): Promise<"inserted" | "duplicate" | "conflict"> {
  const event = parseDeploymentHealth(input),
    body = JSON.stringify(event);
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO growth_deployment_health (observation_id, candidate_receipt_id, organization_id, project_id, environment_id, deployment_id, observed_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      event.observation_id,
      event.candidate_receipt_id,
      event.organization_id,
      event.project_id,
      event.environment_id,
      event.deployment_id,
      event.observed_at,
      body,
    )
    .run();
  if (result.meta.changes) return "inserted";
  const existing = await db
    .prepare("SELECT body FROM growth_deployment_health WHERE observation_id=?")
    .bind(event.observation_id)
    .first<{ body: string }>();
  return existing?.body === body ? "duplicate" : "conflict";
}
export async function readDeploymentHealth(
  db: GrowthD1,
  scope: DeploymentHealthScope,
): Promise<DeploymentHealthObservation | null> {
  const row = await db
    .prepare(
      "SELECT body FROM growth_deployment_health WHERE candidate_receipt_id=? AND organization_id=? AND project_id=? AND environment_id=? AND deployment_id=? ORDER BY observed_at DESC, observation_id DESC LIMIT 1",
    )
    .bind(
      scope.candidate_receipt_id,
      scope.organization_id,
      scope.project_id,
      scope.environment_id,
      scope.deployment_id,
    )
    .first<{ body: string }>();
  return row ? parseDeploymentHealth(JSON.parse(row.body)) : null;
}
