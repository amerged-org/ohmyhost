import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { activeAdministratorSql } from "../identity/membership-barrier-sql.js";
import { runCommand } from "../../run-command.js";
import { instant, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { bytes, integer, iso, text, type Row } from "../provisioning/context-values.js";
import {
  DATA_TARGET_READY,
  dataChangeAcceptanceStatements,
} from "../provisioning/project-data-change.js";
import { parseProjectDataChangeSnapshot } from "../provisioning/context-snapshots.js";
import { apiActionConfirmationInput, apiActionConfirmationStatement } from "./planning-commands.js";
const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  principalId: z.string().min(1),
});
type Scope = z.output<typeof scope>;
// The compare-and-swap scope of the Dev share renewal, not an issued ticket scope. Epoch 0 is the virgin state of a new
// Dev environment (no link or ticket was ever issued); the renewal advances it to 1 exactly as ticket issuance does.
const renewalScope = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    handle: z.string(),
    origin: z.string(),
    devAccessEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (s) =>
      s.handle.length <= 59 &&
      /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(s.handle) &&
      [`https://dev-${s.handle}.dev.check.omh.st`, `https://dev-${s.handle}.check.omh.st`].includes(
        s.origin,
      ),
  );
const blob = (min: number, max: number) =>
  z
    .unknown()
    .transform(bytes)
    .refine((v) => v.byteLength >= min && v.byteLength <= max);
export const devShareRenewalInput = z.strictObject({
  expected: z.strictObject({
    mode: z.literal("protected"),
    scope: renewalScope,
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
  sealed: z.strictObject({
    ciphertext: blob(17, 5120),
    nonce: blob(12, 12),
    valueSha256: blob(32, 32),
    keyVersion: z.number().int().min(1),
  }),
});
const CURRENT = `SELECT p.data_mode,e.environment_id,e.name,a.data_environment_id,a.assignment_version,a.assigned_at FROM projects p JOIN environments e USING(organization_id,project_id)
 JOIN environment_data_assignments a ON a.organization_id=e.organization_id AND a.project_id=e.project_id AND a.environment_id=e.environment_id AND a.assignment_version=(SELECT max(latest.assignment_version) FROM environment_data_assignments latest WHERE latest.organization_id=e.organization_id AND latest.project_id=e.project_id AND latest.environment_id=e.environment_id)
 WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' ORDER BY e.name`;
const PROJECT = `SELECT p.lifecycle_version,p.active_billing_epoch_id,EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=?1 AND operation.project_id=?2 AND operation.state IN('queued','running')) OR EXISTS(SELECT 1 FROM product_provider_mutation_claims claim WHERE claim.organization_id=?1 AND claim.project_id=?2) busy FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'`;
const HEADS =
  "SELECT environment_id,head_version FROM environments WHERE organization_id=?1 AND project_id=?2 ORDER BY name";
const GENERATIONS = `SELECT physical.data_environment_id,COALESCE((SELECT max(registration_version) FROM(SELECT registration_version FROM project_database_registration_receipts r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.physical_environment_id=physical.data_environment_id UNION ALL SELECT registration_version FROM project_database_registration_reservations p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.physical_environment_id=physical.data_environment_id)),0) registration_version FROM(SELECT DISTINCT data_environment_id FROM(${CURRENT})) physical ORDER BY physical.data_environment_id`;
const PROD_DATA = `SELECT data_environment_id FROM(${CURRENT}) WHERE name='prod'`;
const READY = `SELECT ${DATA_TARGET_READY.replaceAll("?3", `(${PROD_DATA})`)} ready`;
// Literal original readDevScope(...false): no beta-admission or open-epoch narrowing is added.
const OWNED_SHARE = `SELECT environment.environment_id,project.handle,domain.development_domain,environment.dev_access_epoch,project.dev_access_mode
 FROM environments environment JOIN projects project USING(organization_id,project_id)
 JOIN cloudflare_project_domains domain ON domain.organization_id=project.organization_id AND domain.project_id=project.project_id AND domain.deleted_at IS NULL
 JOIN organizations o ON o.organization_id=project.organization_id AND o.state='active'
 WHERE project.organization_id=?1 AND project.project_id=?2 AND environment.name='dev' AND domain.handle=project.handle AND domain.zone_name='omh.st'
 AND project.owner_state='active' AND project.lifecycle_state='active'
 AND ${activeAdministratorSql("project.organization_id", "?3")}
 AND EXISTS(SELECT 1 FROM local_authorization_grants authorization_grant WHERE authorization_grant.organization_id=project.organization_id AND authorization_grant.principal_kind='user' AND authorization_grant.principal_id=?3 AND authorization_grant.role='owner' AND authorization_grant.revoked_at IS NULL
 AND((authorization_grant.project_id IS NULL AND authorization_grant.environment_id IS NULL AND authorization_grant.ownership_version IS NULL AND authorization_grant.billing_epoch_id IS NULL)
 OR(authorization_grant.project_id=project.project_id AND authorization_grant.environment_id IS environment.environment_id AND authorization_grant.ownership_version=project.ownership_version AND authorization_grant.billing_epoch_id=project.active_billing_epoch_id)))`;
const LINKS = "SELECT * FROM dev_share_links WHERE project_id=?1 LIMIT 2";
function renewalReads(db: D1Database, i: Scope) {
  return [
    db.prepare(OWNED_SHARE).bind(i.organizationId, i.projectId, i.principalId),
    db.prepare(LINKS).bind(i.projectId),
  ];
}
export type ApiDataChangeRenewalView =
  | { readonly kind: "absent"; readonly liveShareLinks: 0 }
  | {
      readonly kind: "public" | "protected";
      readonly scope: z.output<typeof renewalScope>;
      readonly generation: number | null;
      readonly liveShareLinks: number;
    };
function renewalView(
  i: Scope,
  owned: readonly Row[],
  links: readonly Row[],
): ApiDataChangeRenewalView {
  if (owned.length > 1 || links.length > 1) throw new Error("data_change_not_applicable");
  const row = owned[0],
    link = links[0],
    live = link !== undefined && link["revoked_at"] === null;
  if (live) {
    blob(17, 5120).parse(link["ciphertext"]);
    blob(12, 12).parse(link["nonce"]);
    blob(32, 32).parse(link["token_sha256"]);
    integer(link["key_version"], 1);
  }
  if (row === undefined) {
    if (live) throw new Error("data_change_not_applicable");
    return { kind: "absent", liveShareLinks: 0 };
  }
  const mode = z.enum(["protected", "public"]).parse(row["dev_access_mode"]);
  return {
    kind: mode,
    scope: renewalScope.parse({
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: row["environment_id"],
      handle: row["handle"],
      origin: `https://${text(row, "development_domain")}`,
      devAccessEpoch: row["dev_access_epoch"],
    }),
    generation: link === undefined ? null : integer(link["generation"], 1),
    liveShareLinks: Number(live),
  };
}
/** Original data-change public planning state, with every assignment/head/registration/readiness fact in one native snapshot. */
export async function readApiProjectDataChangeState(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ includeRenewal: z.boolean().optional() }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const results = await db.batch([
    db.prepare(PROJECT).bind(i.organizationId, i.projectId),
    db.prepare(CURRENT).bind(i.organizationId, i.projectId),
    db.prepare(HEADS).bind(i.organizationId, i.projectId),
    db.prepare(GENERATIONS).bind(i.organizationId, i.projectId),
    db.prepare(READY).bind(i.organizationId, i.projectId),
    ...(i.includeRenewal ? renewalReads(db, i) : []),
  ]);
  const p = results[0]?.results[0];
  if (p === undefined) return null;
  if (p["busy"] === 1) throw new Error("data_change_blocked");
  const assignments = results[1]?.results ?? [];
  if (assignments.length !== 2) throw new Error("data_change_not_applicable");
  const [dev, prod] = assignments;
  if (dev?.["name"] !== "dev" || prod?.["name"] !== "prod")
    throw new Error("data_change_not_applicable");
  const assignment = (r: Row) => ({
    environmentId: parseUlid(text(r, "environment_id")),
    environment: z.enum(["dev", "prod"]).parse(r["name"]),
    dataEnvironmentId: parseUlid(text(r, "data_environment_id")),
    assignmentVersion: integer(r["assignment_version"], 1),
    assignedAt: iso(r["assigned_at"]),
  });
  return {
    lifecycleVersion: integer(p["lifecycle_version"], 1),
    billingEpochId: parseUlid(text(p, "active_billing_epoch_id")),
    assignments: {
      dataMode: z.enum(["shared", "isolated"]).parse(dev["data_mode"]),
      dev: assignment(dev),
      prod: assignment(prod),
    },
    environmentHeads: (results[2]?.results ?? []).map((r) => ({
      environmentId: parseUlid(text(r, "environment_id")),
      expectedHeadVersion: integer(r["head_version"]),
    })),
    registrationGenerations: (results[3]?.results ?? []).map((r) => ({
      dataEnvironmentId: parseUlid(text(r, "data_environment_id")),
      registrationVersion: integer(r["registration_version"]),
    })),
    prodDatabaseReady: results[4]?.results[0]?.["ready"] === 1,
    ...(i.includeRenewal
      ? { renewal: renewalView(i, results[5]?.results ?? [], results[6]?.results ?? []) }
      : {}),
  };
}
/** A confirmation cannot be issued from a stale data-change planning snapshot. */
export async function issueApiProjectDataChangePlan(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = scope
      .extend({
        billingEpochId: ulid,
        expectedProjectVersion: z.number().int().min(1),
        snapshot: z.unknown().transform(parseProjectDataChangeSnapshot),
        confirmation: apiActionConfirmationInput,
      })
      .parse(raw),
    c = i.confirmation;
  if (
    c.organizationId !== i.organizationId ||
    c.projectId !== i.projectId ||
    c.issuedToPrincipalId !== i.principalId ||
    c.action !== "data_change"
  )
    throw new Error("data_change_not_applicable");
  const { db } = await routeOrganization(context, i.organizationId);
  await runCommand(db, {
    name: "productApi.issueDataChangePlan",
    commandId: c.confirmationId,
    input: i,
    read: async () => null,
    decide: () => ({
      statements: [
        ...dataChangeAcceptanceStatements(db, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          environmentId: i.snapshot.transition.before.dev.environmentId,
          operationId: c.confirmationId,
          expectedProjectVersion: i.expectedProjectVersion,
          snapshot: i.snapshot,
        }),
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND active_billing_epoch_id=?3) OR EXISTS(SELECT 1 FROM operations WHERE organization_id=?1 AND project_id=?2 AND state IN('queued','running'))",
          [i.organizationId, i.projectId, i.billingEpochId],
        ),
        apiActionConfirmationStatement(db, c, null),
      ],
      result: () => undefined,
      logResult: null,
    }),
    fromLog: () => undefined,
  });
}
export interface ApiDataChangeRenewalPlan {
  readonly input: Scope & { readonly now: string };
  readonly view: ApiDataChangeRenewalView;
  readonly renewal: z.output<typeof devShareRenewalInput> | null;
  readonly link: Row | null;
}
/** Server-local preflight for the parent accepting batch; never a separate mutation or authority RPC. */
export async function readApiDataChangeRenewalPlan(
  db: D1Database,
  rawScope: unknown,
  rawRenewal: unknown,
): Promise<ApiDataChangeRenewalPlan> {
  const i = scope.extend({ now: instant }).parse(rawScope),
    r = await db.batch(renewalReads(db, i)),
    view = renewalView(i, r[0]?.results ?? [], r[1]?.results ?? []),
    renewal = rawRenewal === undefined ? null : devShareRenewalInput.parse(rawRenewal);
  if (view.kind === "protected") {
    if (
      renewal === null ||
      JSON.stringify(renewal.expected.scope) !== JSON.stringify(view.scope) ||
      renewal.expected.generation !== view.generation
    )
      throw new Error("data_change_not_applicable");
  } else if (renewal !== null) throw new Error("data_change_not_applicable");
  return { input: i, view, renewal, link: r[1]?.results[0] ?? null };
}
/** Original sealed replacement and Dev access epoch bump commit at the END of created data-change acceptance. */
export function apiDataChangeRenewalStatements(
  db: D1Database,
  plan: ApiDataChangeRenewalPlan,
): D1PreparedStatement[] {
  const { input: i, view, link, renewal } = plan;
  if (view.kind === "absent")
    return [
      guard(
        db,
        "precondition_changed",
        "EXISTS(SELECT 1 FROM dev_share_links WHERE project_id=?1 AND revoked_at IS NULL)",
        [i.projectId],
      ),
    ];
  const s = view.scope,
    guards = [
      guard(
        db,
        "precondition_changed",
        "(SELECT count(*) FROM dev_share_links WHERE project_id=?1)>1",
        [i.projectId],
      ),
      guard(
        db,
        "precondition_changed",
        `NOT EXISTS(SELECT 1 FROM(${OWNED_SHARE}) current WHERE environment_id=?4 AND handle=?5 AND development_domain=?6 AND dev_access_epoch=?7 AND dev_access_mode=?8)`,
        [
          i.organizationId,
          i.projectId,
          i.principalId,
          s.environmentId,
          s.handle,
          new URL(s.origin).hostname,
          s.devAccessEpoch,
          view.kind,
        ],
      ),
      guard(
        db,
        "precondition_changed",
        link === null
          ? "EXISTS(SELECT 1 FROM dev_share_links WHERE project_id=?1)"
          : "NOT EXISTS(SELECT 1 FROM dev_share_links WHERE project_id=?1 AND organization_id=?2 AND environment_id=?3 AND generation=?4 AND revoked_at IS ?5 AND token_sha256=?6)",
        link === null
          ? [i.projectId]
          : [
              i.projectId,
              link["organization_id"],
              link["environment_id"],
              link["generation"],
              link["revoked_at"],
              bytes(link["token_sha256"]),
            ],
      ),
    ];
  if (view.kind === "public") return guards;
  if (renewal === null) throw new Error("data_change_not_applicable");
  return [
    ...guards,
    db
      .prepare(
        "INSERT INTO dev_share_links(organization_id,project_id,environment_id,token_sha256,ciphertext,nonce,key_version,generation,created_at,revoked_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL) ON CONFLICT(project_id)DO UPDATE SET organization_id=excluded.organization_id,environment_id=excluded.environment_id,token_sha256=excluded.token_sha256,ciphertext=excluded.ciphertext,nonce=excluded.nonce,key_version=excluded.key_version,generation=excluded.generation,created_at=excluded.created_at,revoked_at=NULL",
      )
      .bind(
        i.organizationId,
        i.projectId,
        s.environmentId,
        renewal.sealed.valueSha256,
        renewal.sealed.ciphertext,
        renewal.sealed.nonce,
        renewal.sealed.keyVersion,
        (view.generation ?? 0) + 1,
        i.now,
      ),
    db
      .prepare(
        "UPDATE environments SET dev_access_epoch=dev_access_epoch+1 WHERE project_id=?1 AND name='dev'",
      )
      .bind(i.projectId),
    guard(db, "precondition_changed", "changes()<>1"),
  ];
}
