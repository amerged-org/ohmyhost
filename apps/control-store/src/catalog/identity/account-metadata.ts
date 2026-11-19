import { z } from "zod";
import { isSignupUtm } from "@ohmyhost/contracts/signup-attribution";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { instant, publicTimestamp, ulid, type CatalogContext } from "../common.js";
import { workosUserId } from "./shared.js";

/** These identifiers came from the already authenticated principal or the private AuthStatus response. */
const mappingsInput = z.strictObject({ organizationIds: z.array(ulid).max(100) });
const profileInput = z.strictObject({
  userId: workosUserId,
  // The original profile accepts every syntactically valid provider ID; its private response is bounded in the API.
  workosOrganizationIds: z.array(z.string().regex(/^org_[A-Za-z0-9_]+$/u)),
});
const recordInput = z.strictObject({
  userId: workosUserId,
  source: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
    .nullable(),
  recordedAt: instant,
  utm: z.custom<Record<string, string>>(isSignupUtm).optional(),
});

/** Original current-identity mapping read; no user/provider metadata or membership grant is inferred. */
export async function readCurrentIdentityMappings(context: CatalogContext, raw: unknown) {
  const input = mappingsInput.parse(raw),
    db = (await context.router.routeShard(0)).db;
  return (
    await db
      .prepare(
        "SELECT organization_id,workos_organization_id FROM organizations WHERE state='active' AND organization_id IN(SELECT value FROM json_each(?1)) ORDER BY organization_id",
      )
      .bind(JSON.stringify(input.organizationIds))
      .all<{ organization_id: string; workos_organization_id: string }>()
  ).results;
}

/** Source113 origin presence and source079 attribution remain separate, including a present NULL origin. */
export async function readAccountProfileFacts(context: CatalogContext, raw: unknown) {
  const input = profileInput.parse(raw),
    db = (await context.router.routeShard(0)).db;
  const [memberships, origins, attributions] = await db.batch([
    db
      .prepare(
        "SELECT m.organization_id AS id,m.workos_organization_id AS workos_id,COALESCE((SELECT r.name FROM onboarding_requests r WHERE r.organization_id=m.organization_id AND r.completed_at IS NOT NULL LIMIT 1),'Workspace') AS name FROM organizations m WHERE m.state='active' AND m.workos_organization_id IN(SELECT value FROM json_each(?1)) ORDER BY m.organization_id",
      )
      .bind(JSON.stringify(input.workosOrganizationIds)),
    db
      .prepare(
        "SELECT origin_source AS source,recorded_at FROM user_signup WHERE workos_user_id=?1 AND origin_present=1",
      )
      .bind(input.userId),
    db
      .prepare(
        "SELECT r.organization_id,u.attributed_source AS source_id FROM user_signup u JOIN onboarding_requests r ON r.request_id=u.first_request_id WHERE u.workos_user_id=?1 AND u.attributed_source IS NOT NULL",
      )
      .bind(input.userId),
  ]);
  const origin = origins?.results[0] as { source: string | null; recorded_at: string } | undefined;
  return {
    memberships: memberships?.results as { id: string; workos_id: string; name: string }[],
    origin:
      origin === undefined
        ? null
        : { source: origin.source, recordedAt: publicTimestamp(origin.recorded_at) },
    workspace:
      (attributions?.results[0] as
        | { organization_id: string | null; source_id: string }
        | undefined) ?? null,
  };
}

/** Freeze the first origin and, independently, the first explicitly supplied campaign snapshot. */
export async function recordAccountSignupSource(context: CatalogContext, raw: unknown) {
  const input = recordInput.parse(raw),
    db = (await context.router.routeShard(0)).db;
  const utm = input.utm === undefined ? null : JSON.stringify(input.utm);
  return runCommand<
    { origin_present: number; utm_parameters: string | null } | null,
    { recorded: true }
  >(db, {
    name: "identity.recordAccountSignupSource",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["user_signup"],
    read: (reader) =>
      reader
        .prepare("SELECT origin_present,utm_parameters FROM user_signup WHERE workos_user_id=?1")
        .bind(input.userId)
        .first(),
    decide: (row) => {
      if (row?.origin_present === 1 && (row.utm_parameters !== null || utm === null))
        return { replay: { recorded: true } };
      const write =
        row === null
          ? db
              .prepare(
                "INSERT INTO user_signup(workos_user_id,origin_source,origin_present,recorded_at,utm_parameters) VALUES(?1,?2,1,?3,?4)",
              )
              .bind(input.userId, input.source, input.recordedAt, utm)
          : db
              .prepare(
                "UPDATE user_signup SET origin_source=CASE WHEN origin_present=0 THEN ?2 ELSE origin_source END,recorded_at=CASE WHEN origin_present=0 THEN ?3 ELSE recorded_at END,origin_present=1,utm_parameters=COALESCE(utm_parameters,?4) WHERE workos_user_id=?1 AND origin_present=?5 AND utm_parameters IS ?6",
              )
              .bind(
                input.userId,
                input.source,
                input.recordedAt,
                utm,
                row.origin_present,
                row.utm_parameters,
              );
      return {
        statements: [write, guard(db, "precondition_changed", "changes()<>1")],
        result: () => ({ recorded: true }),
      };
    },
  });
}
