export interface D1PgcfConfiguration {
  RUNTIME_CONFIGURATION_STATE: "configured";
  PGCF_API_URL: string;
  PGCF_APPS_PROJECT_ID: string;
  PGCF_APPS_API_KEY: string;
  readonly [key: string]: unknown;
}
/** Explicit PGCF configuration; this Worker reaches Control only through typed Core service bindings, never a Core SQL binding. */
export function readD1PgcfConfiguration(raw: unknown): D1PgcfConfiguration {
  if (typeof raw !== "object" || raw === null)
    throw new Error("PGCF D1 configuration is unavailable");
  const value = raw as Record<string, unknown>;
  if (
    value["RUNTIME_CONFIGURATION_STATE"] !== "configured" ||
    typeof value["PGCF_API_URL"] !== "string" ||
    !/^https:\/\/[a-z0-9.-]+\/?$/u.test(value["PGCF_API_URL"]) ||
    typeof value["PGCF_APPS_PROJECT_ID"] !== "string" ||
    !/^prj_[a-z0-9]{20}$/u.test(value["PGCF_APPS_PROJECT_ID"]) ||
    typeof value["PGCF_APPS_API_KEY"] !== "string" ||
    !/^[\x21-\x7e]{16,512}$/u.test(value["PGCF_APPS_API_KEY"]) ||
    Object.keys(value).some(
      (key) =>
        key === "CONTROL_CORE" || key === "CONTROL_GLOBAL" || /^CONTROL_SHARD_[0-9]+$/u.test(key),
    )
  )
    throw new Error("PGCF D1 configuration is unavailable");
  return value as unknown as D1PgcfConfiguration;
}
