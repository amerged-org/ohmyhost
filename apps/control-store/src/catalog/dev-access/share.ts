import { z } from "zod";
import { guard } from "../../guards.js";
import { activeAdministratorSql } from "../identity/membership-barrier-sql.js";
import { runCommand, type Plan } from "../../run-command.js";
import {
  conflict,
  instant,
  routeOrganization,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";

const principal = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim());
const hex = z.string().regex(/^(?:[0-9a-f]{2})+$/u);
const sealed = z.strictObject({
  ciphertext: hex,
  nonce: hex.length(24),
  valueSha256: sha256Hex,
  keyVersion: z.number().int().min(1).max(2147483647),
});
const mode = z.enum(["protected", "public"]);
const STATE = `json_object(
  'm',(SELECT dev_access_mode FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active'),
  'g',(SELECT generation FROM dev_share_links WHERE project_id=?2),
  'r',(SELECT revoked_at FROM dev_share_links WHERE project_id=?2),
  'l',(SELECT lower(hex(token_sha256)) FROM dev_share_links WHERE project_id=?2),
  'v',(SELECT dev_access_epoch FROM environments WHERE organization_id=?1 AND project_id=?2 AND name='dev'),
  'a',(SELECT count(*) FROM projects p
    JOIN cloudflare_project_domains d ON d.organization_id=p.organization_id AND d.project_id=p.project_id AND d.deleted_at IS NULL
    JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='dev'
    WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND d.handle=p.handle AND d.zone_name='omh.st'
      AND ${activeAdministratorSql("p.organization_id", "?3")}
      AND EXISTS(SELECT 1 FROM local_authorization_grants g
        WHERE g.organization_id=p.organization_id AND g.principal_kind='user' AND g.principal_id=?3
          AND g.role='owner' AND g.revoked_at IS NULL
          AND ((g.project_id IS NULL AND g.environment_id IS NULL AND g.ownership_version IS NULL AND g.billing_epoch_id IS NULL)
            OR (g.project_id=p.project_id AND g.environment_id IS e.environment_id AND g.ownership_version=p.ownership_version AND g.billing_epoch_id=p.active_billing_epoch_id)))))`;
export type ChangeResult =
  | { readonly replayed: "request"; readonly response: ReturnType<typeof sealedOf> }
  | { readonly replayed: "rotation"; readonly generation: number }
  | { readonly replayed: null; readonly generation: number | null; readonly epoch: number | null };
interface StateFacts {
  m: "protected" | "public" | null;
  g: number | null;
  r: string | null;
  l: string | null;
  v: number | null;
  a: number;
}
const DOMAIN = `SELECT e.environment_id,d.handle,d.development_domain FROM environments e
  JOIN cloudflare_project_domains d ON d.organization_id=e.organization_id AND d.project_id=e.project_id AND d.deleted_at IS NULL
  WHERE e.organization_id=?1 AND e.project_id=?2 AND e.name='dev'`;
const LINK = `SELECT lower(hex(ciphertext)) ciphertext,lower(hex(nonce)) nonce,lower(hex(token_sha256)) value_sha256,key_version FROM dev_share_links WHERE project_id=?1 AND revoked_at IS NULL`;
const REQUEST = `SELECT lower(hex(request_sha256)) request_sha256,lower(hex(response_ciphertext)) ciphertext,lower(hex(response_nonce)) nonce,lower(hex(response_value_sha256)) value_sha256,response_key_version key_version FROM project_dev_access_requests WHERE organization_id=?1 AND project_id=?2 AND actor_id=?3 AND key_sha256=unhex(?4)`;
const ROTATION = `SELECT generation FROM dev_share_link_rotations WHERE project_id=?1 AND key_sha256=unhex(?2)`;

interface Sealed {
  ciphertext: string;
  nonce: string;
  value_sha256: string;
  key_version: number;
}
const sealedOf = (row: Sealed) => ({
  ciphertext: row.ciphertext,
  nonce: row.nonce,
  valueSha256: row.value_sha256,
  keyVersion: row.key_version,
});

const readInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  principalId: principal,
  requestKeySha256: sha256Hex.optional(),
  rotationKeySha256: sha256Hex.optional(),
});

async function snapshot(db: Parameters<typeof runCommand>[0], input: z.output<typeof readInput>) {
  const params = [input.organizationId, input.projectId, input.principalId],
    facts = await db
      .prepare(`SELECT ${STATE} state`)
      .bind(...params)
      .first<{ state: string }>();
  if (facts === null) throw new Error("Dev share state is unavailable");
  const state = JSON.parse(facts.state) as StateFacts;
  const [domain, link, request, rotation] = await Promise.all([
    db
      .prepare(DOMAIN)
      .bind(input.organizationId, input.projectId)
      .first<{ environment_id: string; handle: string; development_domain: string }>(),
    db.prepare(LINK).bind(input.projectId).first<Sealed>(),
    input.requestKeySha256 === undefined
      ? Promise.resolve(null)
      : db
          .prepare(REQUEST)
          .bind(...params, input.requestKeySha256)
          .first<Sealed & { request_sha256: string }>(),
    input.rotationKeySha256 === undefined
      ? Promise.resolve(null)
      : db
          .prepare(ROTATION)
          .bind(input.projectId, input.rotationKeySha256)
          .first<{ generation: number }>(),
  ]);
  return { text: facts.state, state, domain, link, request, rotation };
}

/**
 * The owner's current Dev access state: mode, the unrevoked share link as sealed bytes, its generation and, for the
 * given keys, the stored response of an earlier request and the generation of an earlier rotation. Null when the
 * principal cannot administer the project's Dev environment.
 */
export async function readDevShareState(context: CatalogContext, raw: unknown) {
  const input = readInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    { state, domain, link, request, rotation } = await snapshot(db, input);
  if (state.a !== 1 || state.m === null || state.v === null || domain === null) return null;
  return {
    scope: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: domain.environment_id,
      handle: domain.handle,
      origin: `https://${domain.development_domain}`,
      devAccessEpoch: state.v,
    },
    mode: state.m,
    link: link === null ? null : sealedOf(link),
    generation: state.g,
    request:
      request === null
        ? null
        : { requestSha256: request.request_sha256, response: sealedOf(request) },
    rotationGeneration: rotation?.generation ?? null,
  };
}

const changeInput = readInput
  .omit({ requestKeySha256: true, rotationKeySha256: true })
  .extend({
    now: instant,
    /** The state the caller decided on; a command whose state moved on is refused so the caller decides again. */
    expected: z.strictObject({
      mode,
      generation: z.number().int().min(1).nullable(),
      linkValueSha256: sha256Hex.nullable(),
      epoch: z.number().int().min(0),
    }),
    mode: mode.optional(),
    link: z
      .discriminatedUnion("action", [
        sealed.extend({ action: z.literal("save") }).strict(),
        z.strictObject({ action: z.literal("revoke") }),
      ])
      .optional(),
    bumpEpoch: z.boolean(),
    rotationKeySha256: sha256Hex.optional(),
    receipt: z
      .strictObject({ keySha256: sha256Hex, requestSha256: sha256Hex, response: sealed })
      .optional(),
  })
  .strict();

/**
 * One atomic Dev access change: mode, share link save or revoke, epoch bump, the rotation receipt and the sealed
 * response of the request, together. A repeated receipt or rotation key replays what it stored. Epoch 0 means that no
 * link or ticket was ever issued; saving the first link advances it to 1 in the same batch, as ticket issuance does,
 * whatever `bumpEpoch` says, so a link never coexists with epoch 0. Releasing Core or Control first is safe: the side
 * still on the old schema rejects an epoch-0 state before any write (old Control at its reader, old Core at its change
 * input or renewal view), so the two orders fail at different places and never half-apply.
 */
export async function changeDevAccess(context: CatalogContext, raw: unknown) {
  const input = changeInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    params = [input.organizationId, input.projectId, input.principalId],
    read = {
      ...readInput.parse({
        organizationId: input.organizationId,
        projectId: input.projectId,
        principalId: input.principalId,
        ...(input.receipt === undefined ? {} : { requestKeySha256: input.receipt.keySha256 }),
        ...(input.rotationKeySha256 === undefined
          ? {}
          : { rotationKeySha256: input.rotationKeySha256 }),
      }),
    };
  return runCommand(db, {
    name: "devAccess.change",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_dev_access_requests", "dev_share_link_rotations"],
    read: (reader) => snapshot(reader, read),
    decide: ({ text, state, request, rotation }): Plan<ChangeResult> => {
      if (state.a !== 1 || state.m === null || state.v === null)
        throw conflict("dev_access_unavailable");
      if (request !== null) {
        if (input.receipt === undefined || request.request_sha256 !== input.receipt.requestSha256)
          throw conflict("idempotency_key_reused");
        return { replay: { replayed: "request" as const, response: sealedOf(request) } };
      }
      if (rotation !== null)
        return { replay: { replayed: "rotation" as const, generation: rotation.generation } };
      if (
        state.m !== input.expected.mode ||
        state.g !== input.expected.generation ||
        (state.r === null ? state.l : null) !== input.expected.linkValueSha256 ||
        state.v !== input.expected.epoch
      )
        throw conflict("dev_access_state_changed");
      const saved = input.link?.action === "save" ? input.link : undefined,
        generation = saved === undefined ? state.g : (state.g ?? 0) + 1,
        bumpEpoch = input.bumpEpoch || (saved !== undefined && state.v === 0);
      return {
        statements: [
          guard(db, "precondition_changed", `${STATE} IS NOT ?4`, [...params, text]),
          ...(input.mode === undefined
            ? []
            : [
                db
                  .prepare(
                    "UPDATE projects SET dev_access_mode=?3 WHERE organization_id=?1 AND project_id=?2",
                  )
                  .bind(input.organizationId, input.projectId, input.mode),
              ]),
          ...(saved === undefined
            ? []
            : [
                db
                  .prepare(
                    `INSERT INTO dev_share_links(project_id,organization_id,environment_id,token_sha256,ciphertext,nonce,key_version,created_at)
                     VALUES(?1,?2,(SELECT environment_id FROM environments WHERE organization_id=?2 AND project_id=?1 AND name='dev'),unhex(?3),unhex(?4),unhex(?5),?6,?7)
                     ON CONFLICT(project_id) DO UPDATE SET organization_id=excluded.organization_id,environment_id=excluded.environment_id,
                       token_sha256=excluded.token_sha256,ciphertext=excluded.ciphertext,nonce=excluded.nonce,key_version=excluded.key_version,
                       created_at=excluded.created_at,generation=dev_share_links.generation+1,revoked_at=NULL`,
                  )
                  .bind(
                    input.projectId,
                    input.organizationId,
                    saved.valueSha256,
                    saved.ciphertext,
                    saved.nonce,
                    saved.keyVersion,
                    input.now,
                  ),
              ]),
          ...(input.link?.action === "revoke"
            ? [
                db
                  .prepare(
                    "UPDATE dev_share_links SET revoked_at=?2 WHERE project_id=?1 AND revoked_at IS NULL",
                  )
                  .bind(input.projectId, input.now),
              ]
            : []),
          ...(input.rotationKeySha256 === undefined
            ? []
            : [
                db
                  .prepare(
                    "INSERT INTO dev_share_link_rotations(organization_id,project_id,key_sha256,generation,created_at) VALUES(?1,?2,unhex(?3),(SELECT generation FROM dev_share_links WHERE project_id=?2),?4)",
                  )
                  .bind(input.organizationId, input.projectId, input.rotationKeySha256, input.now),
              ]),
          ...(bumpEpoch
            ? [
                db
                  .prepare(
                    "UPDATE environments SET dev_access_epoch=dev_access_epoch+1 WHERE organization_id=?1 AND project_id=?2 AND name='dev'",
                  )
                  .bind(input.organizationId, input.projectId),
              ]
            : []),
          ...(input.receipt === undefined
            ? []
            : [
                db
                  .prepare(
                    "INSERT INTO project_dev_access_requests(organization_id,project_id,actor_id,key_sha256,request_sha256,response_ciphertext,response_nonce,response_value_sha256,response_key_version,recorded_at) VALUES(?1,?2,?3,unhex(?4),unhex(?5),unhex(?6),unhex(?7),unhex(?8),?9,?10)",
                  )
                  .bind(
                    ...params,
                    input.receipt.keySha256,
                    input.receipt.requestSha256,
                    input.receipt.response.ciphertext,
                    input.receipt.response.nonce,
                    input.receipt.response.valueSha256,
                    input.receipt.response.keyVersion,
                    input.now,
                  ),
              ]),
        ],
        result: () => ({
          replayed: null,
          generation,
          epoch: state.v === null ? null : state.v + (bumpEpoch ? 1 : 0),
        }),
      };
    },
  });
}
