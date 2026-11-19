import { fail } from "./control-d1-codec.mjs";

export const ONBOARDING_COLUMNS = Object.freeze({
  signup_sources: "source_id,active,admits_beta,bonus_micros",
  organization_onboarding_requests:
    "request_id,workos_user_id,idempotency_sha256,request_sha256,name,organization_attempted,membership_attempted,workos_organization_id,organization_id,completed_at,created_at,signup_source",
  user_signup_origins: "workos_user_id,source,recorded_at",
  user_signup_attributions:
    "workos_user_id,source_id,first_request_id,bonus_micros,credit_grant_id,attributed_at",
  project_powered_by_flag_periods: "period_id,organization_id,project_id,enabled_at,disabled_at",
});
export const ONBOARDING_TARGETS = Object.freeze([
  "signup_sources",
  "onboarding_requests",
  "user_signup",
  "project_powered_by_flag_periods",
]);
const boolean = (value) => {
  if (value !== "true" && value !== "false") fail("ONBOARDING_BOOLEAN");
  return value === "true" ? "1" : "0";
};
function byUser(rows) {
  const result = new Map();
  for (const row of rows) {
    if (result.has(row.workos_user_id)) fail("ONBOARDING_IDENTITY");
    result.set(row.workos_user_id, row);
  }
  return result;
}

/** Qualified0323 ONE canonical user row; absent origin is never a frozen NULL origin. */
export function mapOnboarding(rows, manifest) {
  for (const name of Object.keys(ONBOARDING_COLUMNS)) {
    const columns = manifest.tables.find((table) => table.name === name).columns;
    for (const column of columns.filter((entry) => entry.kind === "timestamp"))
      for (const row of rows.get(name))
        if (
          row[column.name] !== null &&
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row[column.name])
        )
          fail("ONBOARDING_TIMESTAMP_UNREPRESENTABLE");
  }
  const result = rows.get("signup_sources").map((row) => ({
    table: "signup_sources",
    row: { ...row, active: boolean(row.active), admits_beta: boolean(row.admits_beta) },
  }));
  for (const row of rows.get("organization_onboarding_requests"))
    result.push({
      table: "onboarding_requests",
      row: {
        ...row,
        organization_attempted: boolean(row.organization_attempted),
        membership_attempted: boolean(row.membership_attempted),
      },
    });
  const origins = byUser(rows.get("user_signup_origins"));
  const attributions = byUser(rows.get("user_signup_attributions"));
  for (const user of [...new Set([...origins.keys(), ...attributions.keys()])].sort()) {
    const origin = origins.get(user),
      attribution = attributions.get(user);
    result.push({
      table: "user_signup",
      row: {
        workos_user_id: user,
        origin_present: origin === undefined ? "0" : "1",
        origin_source: origin?.source ?? null,
        recorded_at: origin?.recorded_at ?? attribution.attributed_at,
        attributed_source: attribution?.source_id ?? null,
        first_request_id: attribution?.first_request_id ?? null,
        bonus_micros: attribution?.bonus_micros ?? null,
        credit_grant_id: attribution?.credit_grant_id ?? null,
        attributed_at: attribution?.attributed_at ?? null,
      },
    });
  }
  for (const row of rows.get("project_powered_by_flag_periods"))
    result.push({ table: "project_powered_by_flag_periods", row });
  return result;
}

/** Fixed five original readers; technical envelope timestamp is excluded when origin_present=0. */
export async function readOnboardingSourceFacts(db) {
  const facts = new Map();
  const queries = {
    signup_sources:
      "SELECT source_id,CASE active WHEN 1 THEN 'true' ELSE 'false' END active,CASE admits_beta WHEN 1 THEN 'true' ELSE 'false' END admits_beta,CAST(bonus_micros AS TEXT) bonus_micros FROM signup_sources",
    organization_onboarding_requests:
      "SELECT request_id,workos_user_id,lower(hex(idempotency_sha256)) idempotency_sha256,lower(hex(request_sha256)) request_sha256,name,CASE organization_attempted WHEN 1 THEN 'true' ELSE 'false' END organization_attempted,CASE membership_attempted WHEN 1 THEN 'true' ELSE 'false' END membership_attempted,workos_organization_id,organization_id,completed_at,created_at,signup_source FROM onboarding_requests",
    user_signup_origins:
      "SELECT workos_user_id,origin_source source,recorded_at FROM user_signup WHERE origin_present=1",
    user_signup_attributions:
      "SELECT workos_user_id,attributed_source source_id,first_request_id,bonus_micros,credit_grant_id,attributed_at FROM user_signup WHERE first_request_id IS NOT NULL",
    project_powered_by_flag_periods:
      "SELECT period_id,organization_id,project_id,enabled_at,disabled_at FROM project_powered_by_flag_periods",
  };
  for (const [name, sql] of Object.entries(queries))
    facts.set(name, (await db.prepare(sql).all()).results);
  return facts;
}
