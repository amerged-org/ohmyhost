import { z } from "zod";
import { generatedJsonb } from "../../jsonb-generated.js";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { rowsOf } from "../common.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  bytesOf,
  instant,
  isoOf,
  isoOrNull,
  readSnapshot,
  reject,
  sameBytes,
  sha256,
  shardOfOrganization,
  ulid,
  type PlatformContext,
} from "../platform-support.js";
import {
  claimDomainStatements,
  domainClaimRefusal,
  type ClaimAbortRow,
  type DirectoryClaimRow,
  type DomainClaim,
} from "./domain-claims.js";

const scope = { organizationId: ulid, projectId: ulid };

export const claimCloudflareProjectDomainsInput = z.strictObject({
  ...scope,
  platform: z.enum(["development", "production"]),
  proposedOperationId: ulid,
  principalId: z.string().min(1).max(256),
  idempotencyKeySha256: sha256,
  requestSha256: sha256,
  configuredAt: instant,
});
export const putCloudflareProjectDomainsInput = claimCloudflareProjectDomainsInput
  .omit({ proposedOperationId: true })
  .extend({ operationId: ulid });
export const readCloudflareProjectDomainsInput = z.strictObject(scope);
export const readCloudflareProjectDomainsForOperationInput = z.strictObject({
  ...scope,
  operationId: ulid,
});
export const readCloudflareProjectDomainsByIdempotencyInput = z.strictObject({
  ...scope,
  principalId: z.string().min(1).max(256),
  idempotencyKeySha256: sha256,
  requestSha256: sha256,
});

const cloudflareId = z.string().regex(/^[a-f0-9]{32}$/u);
const sslId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);
const environmentName = z.enum(["dev", "prod"]);
const text = (max: number) => z.string().min(1).max(max);
const receiptBase = { ...scope, receiptId: ulid, observedAt: instant };
export const putCloudflareProjectDomainReceiptInput = z.discriminatedUnion("kind", [
  z.strictObject({
    ...receiptBase,
    kind: z.literal("dns_record"),
    providerResourceId: cloudflareId,
    zoneId: cloudflareId,
    zoneName: hostname,
    type: z.enum(["CNAME", "NS", "TXT"]),
    name: z.string().min(1).max(253),
    content: text(2048),
    ttl: z.number().int().min(1).max(86_400),
    proxied: z.boolean(),
    comment: text(256),
  }),
  z.strictObject({
    ...receiptBase,
    kind: z.literal("custom_hostname"),
    providerResourceId: cloudflareId,
    environmentName,
    hostname,
    status: text(40),
    providerCreatedAt: instant.nullable(),
    ownershipVerification: z
      .strictObject({ type: z.literal("txt"), name: text(253), value: text(2048) })
      .nullable(),
    ownershipVerificationHttp: z
      .strictObject({ httpUrl: z.string().regex(/^https?:\/\//u), httpBody: text(8192) })
      .nullable(),
    verificationErrors: z.array(text(2048)),
  }),
  z.strictObject({
    ...receiptBase,
    kind: z.literal("ssl"),
    providerResourceId: sslId.nullable(),
    customHostnameId: cloudflareId,
    environmentName,
    hostname,
    status: text(40).nullable(),
    type: z.literal("dv").nullable(),
    method: z.enum(["http", "txt", "email"]).nullable(),
    bundleMethod: z.enum(["ubiquitous", "optimal", "force"]).nullable(),
    certificateAuthority: text(128).nullable(),
    validationRecords: z.array(z.record(z.string(), z.unknown())),
  }),
  z.strictObject({
    ...receiptBase,
    kind: z.literal("worker_route"),
    providerResourceId: cloudflareId,
    environmentName,
    zoneId: cloudflareId,
    pattern: text(300),
    script: text(255),
  }),
]);
export const readCloudflareProjectDomainReceiptsInput = z.strictObject(scope);
const deletionScope = { ...scope, operationId: ulid };
export const readCloudflareProjectDomainDeletionStateInput = z.strictObject(deletionScope);
export const markCloudflareProjectDomainsDeletedInput = z.strictObject({
  ...deletionScope,
  deletedAt: instant,
});

export interface CloudflareProjectDomains {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly handle: string;
  readonly zoneName: "omh.st";
  readonly productionDomain: string;
  readonly developmentDomain: string;
  readonly mailDomain: string | null;
  readonly configuredByPrincipalId: string;
  readonly configuredAt: string;
  readonly deletedAt: string | null;
}

interface DomainsRow {
  readonly organization_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly handle: string;
  readonly zone_name: "omh.st";
  readonly production_domain: string;
  readonly development_domain: string;
  readonly mail_domain: string | null;
  readonly configured_by_principal_id: string;
  readonly idempotency_key_sha256: unknown;
  readonly request_sha256: unknown;
  readonly configured_at: string;
  readonly deleted_at: string | null;
}

const DOMAINS_SELECT = `SELECT d.organization_id, d.project_id, d.operation_id, d.handle, d.zone_name, d.production_domain, d.development_domain,
    m.domain AS mail_domain, d.configured_by_principal_id, d.idempotency_key_sha256, d.request_sha256, d.configured_at, d.deleted_at
  FROM cloudflare_project_domains d
  LEFT JOIN project_mail_domains m ON m.organization_id = d.organization_id AND m.project_id = d.project_id`;
const OWNED = `JOIN projects p ON p.organization_id = d.organization_id AND p.project_id = d.project_id AND p.owner_state = 'active' AND p.lifecycle_state IN ('active', 'deleting')`;

function domainsOf(row: DomainsRow): CloudflareProjectDomains {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    operationId: row.operation_id,
    handle: row.handle,
    zoneName: row.zone_name,
    productionDomain: row.production_domain,
    developmentDomain: row.development_domain,
    mailDomain: row.mail_domain,
    configuredByPrincipalId: row.configured_by_principal_id,
    configuredAt: isoOf(row.configured_at),
    deletedAt: isoOrNull(row.deleted_at),
  };
}

async function readDomainsRow(
  db: D1Database,
  input: { organizationId: string; projectId: string },
  requireOwnership: boolean,
): Promise<DomainsRow | null> {
  return db
    .prepare(
      `${DOMAINS_SELECT} ${requireOwnership ? OWNED : ""} WHERE d.organization_id = ? AND d.project_id = ?`,
    )
    .bind(input.organizationId, input.projectId)
    .first<DomainsRow>();
}

export type ClaimInput = z.output<typeof claimCloudflareProjectDomainsInput>;
export interface ClaimedCloudflareProjectDomainsOperation {
  readonly outcome: "created" | "existing";
  readonly domains: CloudflareProjectDomains;
}

interface ClaimSnapshot {
  readonly row: DomainsRow | null;
  readonly project: { handle: string } | null;
  /** The Directory rows and abort tombstones of the two names, read before the one batch that claims them. */
  readonly directory: readonly DirectoryClaimRow[];
  readonly aborts: readonly ClaimAbortRow[];
}

/** The two Directory names of a project's platform hostnames, claimed under one stable claim id. */
export function projectDomainClaims(
  input: Pick<ClaimInput, "organizationId" | "projectId" | "platform" | "configuredAt">,
  handle: string,
  operationId: string,
): DomainClaim[] {
  const root = input.platform === "development" ? "dev.check.omh.st" : "check.omh.st";
  return (
    [
      ["app_prod", `${handle}.${root}`],
      ["app_dev", `dev-${handle}.${root}`],
    ] as const
  ).map(([domainClass, domain]) => ({
    class: domainClass,
    domain,
    organizationId: input.organizationId,
    projectId: input.projectId,
    // Stable across retries of one command: the operation id it proposes.
    claimId: `${operationId}:${handle}`,
    now: input.configuredAt,
  }));
}

/** The Directory rows and abort tombstones of the two names, as one pair of read statements. */
export function projectDomainNameReads(
  db: D1Database,
  names: readonly DomainClaim[],
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db
      .prepare(
        "SELECT class, domain, organization_id, project_id, state, claim_id FROM domain_directory WHERE (class = ?1 AND domain = ?2) OR (class = ?3 AND domain = ?4)",
      )
      .bind(names[0]?.class, names[0]?.domain, names[1]?.class, names[1]?.domain),
    db
      .prepare(
        "SELECT class, domain, claim_id FROM domain_claim_aborts WHERE (class = ?1 AND domain = ?2) OR (class = ?3 AND domain = ?4)",
      )
      .bind(names[0]?.class, names[0]?.domain, names[1]?.class, names[1]?.domain),
  ];
}

/**
 * The pure plan of configuring the platform hostnames of a project: the refusal of a name another owner holds or a
 * sweep closed, or the statements of the ONE batch (both Directory claims with their abort-tombstone fences and the
 * domains row). The standalone command and the customer project admission compose the same plan.
 */
export function projectDomainsClaimPlan(
  db: D1Database,
  input: ClaimInput,
  handle: string,
  snapshot: Pick<ClaimSnapshot, "directory" | "aborts">,
):
  | { readonly reject: Error }
  | { readonly statements: D1PreparedStatement[]; readonly domains: CloudflareProjectDomains } {
  const names = projectDomainClaims(input, handle, input.proposedOperationId);
  for (const name of names) {
    const refusal = domainClaimRefusal(name, snapshot.directory, snapshot.aborts);
    if (refusal !== null) return { reject: refusal };
  }
  const root = input.platform === "development" ? "dev.check.omh.st" : "check.omh.st";
  const productionDomain = `${handle}.${root}`;
  const developmentDomain = `dev-${handle}.${root}`;
  return {
    statements: [
      guard(
        db,
        "scope_inactive",
        "NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = ? AND project_id = ? AND owner_state = 'active' AND lifecycle_state = 'active' AND handle = ?)",
        [input.organizationId, input.projectId, handle],
      ),
      // The Directory claims of both names, with the sweep's abort-tombstone fences, in this one batch.
      ...names.flatMap((name) =>
        claimDomainStatements(
          db,
          name,
          snapshot.directory.find((row) => row.class === name.class && row.domain === name.domain)
            ?.claim_id ?? null,
        ),
      ),
      db
        .prepare(
          "INSERT INTO cloudflare_project_domains(organization_id, project_id, operation_id, handle, zone_name, production_domain, development_domain, configured_by_principal_id, idempotency_key_sha256, request_sha256, configured_at) VALUES (?1, ?2, ?3, ?4, 'omh.st', ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.proposedOperationId,
          handle,
          productionDomain,
          developmentDomain,
          input.principalId,
          input.idempotencyKeySha256,
          input.requestSha256,
          input.configuredAt,
        ),
    ],
    domains: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      operationId: input.proposedOperationId,
      handle,
      zoneName: "omh.st" as const,
      productionDomain,
      developmentDomain,
      mailDomain: null,
      configuredByPrincipalId: input.principalId,
      configuredAt: isoOf(input.configuredAt),
      deletedAt: null,
    },
  };
}

/**
 * Configures the platform hostnames of a project (`<handle>.check.omh.st`, `dev-<handle>...`). The two
 * names are claimed in the directory first; the shard insert is exactly-once by the project key and by
 * the idempotency key. Returns null when the project is not active or the project already runs under
 * another idempotency key.
 */
export async function claimCloudflareProjectDomainsOperation(
  context: PlatformContext,
  raw: unknown,
): Promise<ClaimedCloudflareProjectDomainsOperation | null> {
  return claim(context, claimCloudflareProjectDomainsInput.parse(raw));
}

/** `putCloudflareProjectDomains`: the same claim, returning only the domains. */
export async function putCloudflareProjectDomains(
  context: PlatformContext,
  raw: unknown,
): Promise<CloudflareProjectDomains | null> {
  const { operationId, ...rest } = putCloudflareProjectDomainsInput.parse(raw);
  const claimed = await claim(context, { ...rest, proposedOperationId: operationId });
  return claimed?.domains ?? null;
}

async function claim(
  context: PlatformContext,
  input: ClaimInput,
): Promise<ClaimedCloudflareProjectDomainsOperation | null> {
  const db = await shardOfOrganization(context, input.organizationId);
  const root = input.platform === "development" ? "dev.check.omh.st" : "check.omh.st";
  const read = async (shard: D1Database): Promise<ClaimSnapshot> => {
    const [domains, project] = await readSnapshot(shard, [
      [
        `${DOMAINS_SELECT} ${OWNED} WHERE d.organization_id = ? AND d.project_id = ?`,
        input.organizationId,
        input.projectId,
      ],
      [
        "SELECT handle FROM projects WHERE organization_id = ? AND project_id = ? AND owner_state = 'active' AND lifecycle_state = 'active'",
        input.organizationId,
        input.projectId,
      ],
    ]);
    return {
      row: (domains?.[0] as DomainsRow | undefined) ?? null,
      project: (project?.[0] as { handle: string } | undefined) ?? null,
      directory: [],
      aborts: [],
    };
  };
  // The two names are claimed in the SAME batch as the domains row (no reservation, no read-side effect): the read only
  // looks at who holds the names and which claims the sweep closed, so a command that fails or is lost leaves nothing.
  const reservingRead = async (shard: D1Database): Promise<ClaimSnapshot> => {
    const snapshot = await read(shard);
    if (snapshot.row !== null || snapshot.project === null) return snapshot;
    const names = projectDomainClaims(input, snapshot.project.handle, input.proposedOperationId);
    const [directory, aborts] = await shard.batch([...projectDomainNameReads(shard, names)]);
    return {
      ...snapshot,
      directory: rowsOf<DirectoryClaimRow>(directory),
      aborts: rowsOf<ClaimAbortRow>(aborts),
    };
  };
  const command: Command<ClaimSnapshot, ClaimedCloudflareProjectDomainsOperation | null> = {
    name: "domains.claimCloudflareProjectDomainsOperation",
    input,
    // claim_lost: the sweep closed a claim between the read and the write; the re-read reports it as expired.
    retryOn: ["scope_inactive", "precondition_changed", "claim_lost"],
    naturalKeyTables: ["cloudflare_project_domains", "domain_directory"],
    read: reservingRead,
    decide: (snapshot) => {
      if (snapshot.row !== null) {
        const row = snapshot.row;
        if (
          !sameBytes(bytesOf(row.idempotency_key_sha256), input.idempotencyKeySha256) ||
          row.configured_by_principal_id !== input.principalId ||
          row.zone_name !== "omh.st" ||
          row.production_domain !== `${row.handle}.${root}` ||
          row.development_domain !== `dev-${row.handle}.${root}` ||
          !sameBytes(bytesOf(row.request_sha256), input.requestSha256)
        ) {
          // The stored claim belongs to another key: no match means "unavailable", a near match a conflict.
          return sameBytes(bytesOf(row.idempotency_key_sha256), input.idempotencyKeySha256)
            ? reject(
                "cloudflare_project_domain_conflict",
                "Cloudflare project-domain state conflicts with durable state",
              )
            : { replay: null };
        }
        return { replay: { outcome: "existing" as const, domains: domainsOf(row) } };
      }
      if (snapshot.project === null) return { replay: null };
      const plan = projectDomainsClaimPlan(db, input, snapshot.project.handle, snapshot);
      if ("reject" in plan) return plan;
      return {
        statements: plan.statements,
        result: () => ({ outcome: "created" as const, domains: plan.domains }),
      };
    },
  };
  return runCommand(db, command);
}

export async function readCloudflareProjectDomains(
  context: PlatformContext,
  raw: unknown,
): Promise<CloudflareProjectDomains | null> {
  const input = readCloudflareProjectDomainsInput.parse(raw);
  const row = await readDomainsRow(
    await shardOfOrganization(context, input.organizationId),
    input,
    true,
  );
  return row === null ? null : domainsOf(row);
}

export async function readCloudflareProjectDomainsForOperation(
  context: PlatformContext,
  raw: unknown,
): Promise<CloudflareProjectDomains | null> {
  const input = readCloudflareProjectDomainsForOperationInput.parse(raw);
  const row = await readDomainsRow(
    await shardOfOrganization(context, input.organizationId),
    input,
    true,
  );
  return row === null || row.operation_id !== input.operationId ? null : domainsOf(row);
}

export async function readCloudflareProjectDomainsByIdempotency(
  context: PlatformContext,
  raw: unknown,
): Promise<CloudflareProjectDomains | null> {
  const input = readCloudflareProjectDomainsByIdempotencyInput.parse(raw);
  const row = await readDomainsRow(
    await shardOfOrganization(context, input.organizationId),
    input,
    true,
  );
  if (row === null || !sameBytes(bytesOf(row.idempotency_key_sha256), input.idempotencyKeySha256)) {
    return null;
  }
  if (
    row.configured_by_principal_id !== input.principalId ||
    !sameBytes(bytesOf(row.request_sha256), input.requestSha256)
  ) {
    throw reject(
      "cloudflare_project_domain_conflict",
      "Cloudflare project-domain state conflicts with durable state",
    ).reject;
  }
  return domainsOf(row);
}

type ReceiptInput = z.output<typeof putCloudflareProjectDomainReceiptInput>;

/** The shared gateway Worker a project hostname is served by (`project_gateway_script_name`). */
export function projectGatewayScriptName(
  handle: string,
  environment: "dev" | "prod",
  productionDomain: string,
): string | null {
  if (environment !== "dev" && environment !== "prod") return null;
  if (productionDomain === `${handle}.check.omh.st`) return "ohmyho-gateway-production";
  if (
    productionDomain === `${handle}.dev.check.omh.st` ||
    productionDomain === `${handle}.poc.aixyte.com`
  ) {
    return "ohmyho-gateway-poc-private-fullstack";
  }
  return null;
}

function receiptBody(input: ReceiptInput): Record<string, unknown> {
  const identity = new Set([
    "organizationId",
    "projectId",
    "receiptId",
    "kind",
    "observedAt",
    "providerResourceId",
  ]);
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => !identity.has(key)));
  // The body stores instants in their JavaScript ISO form, the form a reader returns.
  const created = body["providerCreatedAt"];
  return typeof created === "string" ? { ...body, providerCreatedAt: isoOf(created) } : body;
}

const RECEIPT_SOURCE_FIELDS = [
  "zone_id",
  "zone_name",
  "dns_type",
  "dns_name",
  "dns_content",
  "dns_ttl",
  "dns_proxied",
  "dns_comment",
  "hostname_status",
  "provider_created_at",
  "ownership_verification",
  "ownership_verification_http",
  "verification_errors",
  "ssl_status",
  "ssl_type",
  "ssl_method",
  "ssl_bundle_method",
  "ssl_certificate_authority",
  "ssl_validation_records",
  "route_pattern",
  "route_script",
] as const;

/** Original physical fields accompany the compatibility body on every new observation. */
function receiptSourceValues(input: ReceiptInput): (string | number | null)[] {
  const values: Record<(typeof RECEIPT_SOURCE_FIELDS)[number], string | number | null> =
    Object.fromEntries(RECEIPT_SOURCE_FIELDS.map((field) => [field, null])) as Record<
      (typeof RECEIPT_SOURCE_FIELDS)[number],
      string | number | null
    >;
  if (input.kind === "dns_record")
    Object.assign(values, {
      zone_id: input.zoneId,
      zone_name: input.zoneName,
      dns_type: input.type,
      dns_name: input.name,
      dns_content: input.content,
      dns_ttl: input.ttl,
      dns_proxied: input.proxied ? 1 : 0,
      dns_comment: input.comment,
    });
  if (input.kind === "custom_hostname")
    Object.assign(values, {
      hostname_status: input.status,
      provider_created_at: input.providerCreatedAt,
      ownership_verification:
        input.ownershipVerification === null ? null : generatedJsonb(input.ownershipVerification),
      ownership_verification_http:
        input.ownershipVerificationHttp === null
          ? null
          : generatedJsonb(input.ownershipVerificationHttp),
      verification_errors: `{${input.verificationErrors
        .map((value) => {
          if (value.includes("\0")) throw new TypeError("Invalid PostgreSQL verification error");
          return value === "" || /^null$/iu.test(value) || /[{},"\\ \t\n\r\v\f]/u.test(value)
            ? `"${value.replace(/["\\]/gu, "\\$&")}"`
            : value;
        })
        .join(",")}}`,
    });
  if (input.kind === "ssl")
    Object.assign(values, {
      ssl_status: input.status,
      ssl_type: input.type,
      ssl_method: input.method,
      ssl_bundle_method: input.bundleMethod,
      ssl_certificate_authority: input.certificateAuthority,
      ssl_validation_records: generatedJsonb(input.validationRecords),
    });
  if (input.kind === "worker_route")
    Object.assign(values, {
      zone_id: input.zoneId,
      route_pattern: input.pattern,
      route_script: input.script,
    });
  return RECEIPT_SOURCE_FIELDS.map((field) => values[field]);
}

export interface CloudflareProjectDomainReceipt {
  readonly receiptId: string;
  readonly kind: ReceiptInput["kind"];
  readonly providerResourceId: string | null;
  readonly observedAt: string;
  readonly [field: string]: unknown;
}

function receiptFrom(row: {
  receipt_id: string;
  kind: ReceiptInput["kind"];
  provider_resource_id: string | null;
  observed_at: string;
  body: string;
}): CloudflareProjectDomainReceipt {
  return {
    ...(JSON.parse(row.body) as Record<string, unknown>),
    receiptId: row.receipt_id,
    kind: row.kind,
    providerResourceId: row.provider_resource_id,
    observedAt: isoOf(row.observed_at),
  };
}

function canonicalReceiptBody(value: unknown): string {
  const order = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(order);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, order(child)]),
    );
  };
  return JSON.stringify(order(value));
}

/**
 * Appends one provider observation of a project's DNS record, custom hostname, SSL certificate or worker
 * route. The names must match the project's configured domains; replaying the exact receipt is "existing".
 */
export async function putCloudflareProjectDomainReceipt(
  context: PlatformContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const input = putCloudflareProjectDomainReceiptInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  const body = JSON.stringify(receiptBody(input));
  interface Snapshot {
    domain: DomainsRow | null;
    mailDomain: boolean;
    hostnameReceipt: boolean;
    stored: {
      body: string;
      kind: string;
      observed_at: string;
      project_id: string;
      provider_resource_id: string | null;
    } | null;
    sameKeyOtherReceipt: boolean;
    foreignId: boolean;
  }
  const command: Command<Snapshot, "created" | "existing"> = {
    name: "domains.putCloudflareProjectDomainReceipt",
    input,
    retryOn: ["scope_inactive", "precondition_changed"],
    naturalKeyTables: ["cloudflare_project_domain_receipts"],
    read: async (shard) => {
      const [domain, mail, hostnameReceipt, stored, sameKey, identity] = await readSnapshot(shard, [
        [
          "SELECT * FROM cloudflare_project_domains WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL",
          input.organizationId,
          input.projectId,
        ],
        [
          "SELECT 1 FROM project_mail_domains WHERE organization_id = ? AND project_id = ? AND domain = ?",
          input.organizationId,
          input.projectId,
          input.kind === "dns_record" ? input.name : "",
        ],
        [
          "SELECT 1 FROM cloudflare_project_domain_receipts WHERE organization_id = ? AND project_id = ? AND kind = 'custom_hostname' AND provider_resource_id = ? AND environment_name = ? AND hostname = ?",
          input.organizationId,
          input.projectId,
          input.kind === "ssl" ? input.customHostnameId : "",
          input.kind === "ssl" ? input.environmentName : "",
          input.kind === "ssl" ? input.hostname : "",
        ],
        [
          "SELECT body, kind, observed_at, project_id, provider_resource_id FROM cloudflare_project_domain_receipts WHERE organization_id = ? AND receipt_id = ?",
          input.organizationId,
          input.receiptId,
        ],
        [
          "SELECT receipt_id FROM cloudflare_project_domain_receipts WHERE organization_id = ? AND project_id = ? AND kind = ? AND provider_resource_id = ? AND observed_at = ? AND receipt_id <> ?",
          input.organizationId,
          input.projectId,
          input.kind,
          input.providerResourceId,
          input.observedAt,
          input.receiptId,
        ],
        [
          "SELECT organization_id, project_id FROM cloudflare_project_domain_receipts WHERE receipt_id=?",
          input.receiptId,
        ],
      ]);
      const globalId = identity?.[0] as { organization_id: string; project_id: string } | undefined;
      return {
        domain: (domain?.[0] as DomainsRow | undefined) ?? null,
        mailDomain: (mail?.length ?? 0) > 0,
        hostnameReceipt: (hostnameReceipt?.length ?? 0) > 0,
        stored: (stored?.[0] as Snapshot["stored"] | undefined) ?? null,
        sameKeyOtherReceipt: (sameKey?.length ?? 0) > 0,
        foreignId:
          globalId !== undefined &&
          (globalId.organization_id !== input.organizationId ||
            globalId.project_id !== input.projectId),
      };
    },
    decide: (snapshot) => {
      if (snapshot.foreignId)
        return reject(
          "cloudflare_project_domain_conflict",
          "Cloudflare project-domain state conflicts with durable state",
        );
      if (snapshot.stored !== null) {
        return canonicalReceiptBody(JSON.parse(snapshot.stored.body)) ===
          canonicalReceiptBody(JSON.parse(body)) &&
          snapshot.stored.kind === input.kind &&
          snapshot.stored.project_id === input.projectId &&
          snapshot.stored.provider_resource_id === input.providerResourceId &&
          Date.parse(snapshot.stored.observed_at) === Date.parse(input.observedAt)
          ? { replay: "existing" as const }
          : reject(
              "cloudflare_project_domain_conflict",
              "Cloudflare project-domain state conflicts with durable state",
            );
      }
      const domain = snapshot.domain;
      const conflict = reject(
        "cloudflare_project_domain_conflict",
        "Cloudflare project-domain state conflicts with durable state",
      );
      if (domain === null || snapshot.sameKeyOtherReceipt) return conflict;
      const expected = (environment: "dev" | "prod") =>
        environment === "dev" ? domain.development_domain : domain.production_domain;
      if (input.kind === "dns_record" && input.type === "NS" && !snapshot.mailDomain)
        return conflict;
      if (
        (input.kind === "custom_hostname" || input.kind === "ssl") &&
        input.hostname !== expected(input.environmentName)
      ) {
        return conflict;
      }
      if (
        input.kind === "worker_route" &&
        (input.pattern !== `${expected(input.environmentName)}/*` ||
          input.script !==
            projectGatewayScriptName(
              domain.handle,
              input.environmentName,
              domain.production_domain,
            ))
      ) {
        return conflict;
      }
      if (input.kind === "ssl" && !snapshot.hostnameReceipt) return conflict;
      const environment = "environmentName" in input ? input.environmentName : null;
      const hostnameValue = "hostname" in input ? input.hostname : null;
      const customHostname = input.kind === "ssl" ? input.customHostnameId : null;
      return {
        statements: [
          guard(
            db,
            "scope_inactive",
            "NOT EXISTS (SELECT 1 FROM cloudflare_project_domains WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL)",
            [input.organizationId, input.projectId],
          ),
          db
            .prepare(
              `INSERT INTO cloudflare_project_domain_receipts(organization_id, receipt_id, project_id, kind, environment_name, provider_resource_id, hostname, custom_hostname_id, body, observed_at,${RECEIPT_SOURCE_FIELDS.join(",")}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,${RECEIPT_SOURCE_FIELDS.map((_, index) => `?${index + 11}`).join(",")})`,
            )
            .bind(
              input.organizationId,
              input.receiptId,
              input.projectId,
              input.kind,
              environment,
              input.providerResourceId,
              hostnameValue,
              customHostname,
              body,
              input.observedAt,
              ...receiptSourceValues(input),
            ),
        ],
        result: () => "created" as const,
      };
    },
  };
  return runCommand(db, command);
}

export async function readCloudflareProjectDomainReceipts(
  context: PlatformContext,
  raw: unknown,
): Promise<readonly CloudflareProjectDomainReceipt[]> {
  const input = readCloudflareProjectDomainReceiptsInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  const rows = await db
    .prepare(
      `SELECT r.receipt_id, r.kind, r.provider_resource_id, r.observed_at, r.body
         FROM cloudflare_project_domain_receipts r
         JOIN projects p ON p.organization_id = r.organization_id AND p.project_id = r.project_id AND p.owner_state = 'active' AND p.lifecycle_state IN ('active', 'deleting')
        WHERE r.organization_id = ? AND r.project_id = ?
        ORDER BY r.observed_at, r.receipt_id`,
    )
    .bind(input.organizationId, input.projectId)
    .all<{
      receipt_id: string;
      kind: ReceiptInput["kind"];
      provider_resource_id: string | null;
      observed_at: string;
      body: string;
    }>();
  return rows.results.map(receiptFrom);
}

/** The project deletion operation that authorizes the cleanup commands below. */
export const DELETION_AUTHORIZED_SQL = `SELECT 1 FROM product_command_intents i
  JOIN projects p ON p.organization_id = i.organization_id AND p.project_id = i.project_id AND p.lifecycle_state = 'deleting' AND p.owner_state = 'active'
  JOIN operations o ON o.organization_id = i.organization_id AND o.operation_id = i.operation_id AND o.state IN ('queued', 'running')
 WHERE i.organization_id = ? AND i.project_id = ? AND i.operation_id = ? AND i.event_type = 'ProjectDeletionRequestedV1'`;

export function deletionParams(input: {
  organizationId: string;
  projectId: string;
  operationId: string;
}): string[] {
  return [input.organizationId, input.projectId, input.operationId];
}

export interface CloudflareProjectDomainDeletionState {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly domains: CloudflareProjectDomains | null;
  readonly receipts: readonly CloudflareProjectDomainReceipt[];
  readonly customHostnameDeleteTargets: readonly {
    readonly environmentName: "dev" | "prod";
    readonly customHostnameId: string;
    readonly hostname: string;
    readonly observedAt: string;
  }[];
}

/**
 * What a project deletion operation must clean up at Cloudflare: the configured domains and the receipts of
 * names that still belong to them, plus the newest custom hostname per environment. Null when the
 * operation is not the project's current deletion.
 */
export async function readCloudflareProjectDomainDeletionState(
  context: PlatformContext,
  raw: unknown,
): Promise<CloudflareProjectDomainDeletionState | null> {
  const input = readCloudflareProjectDomainDeletionStateInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  const [authorized, domains, receipts] = await readSnapshot(db, [
    [DELETION_AUTHORIZED_SQL, ...deletionParams(input)],
    [
      `${DOMAINS_SELECT} WHERE d.organization_id = ? AND d.project_id = ?`,
      input.organizationId,
      input.projectId,
    ],
    [
      "SELECT receipt_id, kind, provider_resource_id, observed_at, body FROM cloudflare_project_domain_receipts WHERE organization_id = ? AND project_id = ? ORDER BY observed_at, receipt_id",
      input.organizationId,
      input.projectId,
    ],
  ]);
  if ((authorized?.length ?? 0) !== 1) return null;
  const domainsRow = (domains?.[0] as DomainsRow | undefined) ?? null;
  const all = (receipts ?? []).map((row) => receiptFrom(row as Parameters<typeof receiptFrom>[0]));
  const current =
    domainsRow === null
      ? all
      : all.filter((receipt) => {
          const webHosts = [domainsRow.development_domain, domainsRow.production_domain];
          if (receipt.kind === "dns_record") {
            const name = String(receipt["name"]);
            if (receipt["type"] === "NS") return name === domainsRow.mail_domain;
            return webHosts.some((host) => name === host || name.endsWith(`.${host}`));
          }
          if (receipt.kind === "worker_route") {
            return webHosts.some((host) => receipt["pattern"] === `${host}/*`);
          }
          return webHosts.includes(String(receipt["hostname"]));
        });
  const newest = new Map<string, CloudflareProjectDomainReceipt>();
  for (const receipt of current) {
    if (receipt.kind !== "custom_hostname") continue;
    const key = `${String(receipt["environmentName"])}\0${receipt.providerResourceId}`;
    const previous = newest.get(key);
    if (previous === undefined || previous.observedAt <= receipt.observedAt)
      newest.set(key, receipt);
  }
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    operationId: input.operationId,
    domains: domainsRow === null ? null : domainsOf(domainsRow),
    receipts: current,
    customHostnameDeleteTargets: [...newest.values()]
      .filter((receipt) => receipt["status"] !== "deleted")
      .map((receipt) => ({
        environmentName: receipt["environmentName"] as "dev" | "prod",
        customHostnameId: String(receipt.providerResourceId),
        hostname: String(receipt["hostname"]),
        observedAt: receipt.observedAt,
      })),
  };
}

/** Soft-deletes the configured domains for a project deletion; repeating it with the same instant is a no-op that still answers true. */
export async function markCloudflareProjectDomainsDeletedForDeletion(
  context: PlatformContext,
  raw: unknown,
): Promise<boolean> {
  const input = markCloudflareProjectDomainsDeletedInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  interface Snapshot {
    authorized: boolean;
    row: { deleted_at: string | null } | null;
  }
  const command: Command<Snapshot, boolean> = {
    name: "domains.markCloudflareProjectDomainsDeletedForDeletion",
    input,
    retryOn: ["precondition_changed"],
    read: async (shard) => {
      const [authorized, row] = await readSnapshot(shard, [
        [DELETION_AUTHORIZED_SQL, ...deletionParams(input)],
        [
          "SELECT deleted_at FROM cloudflare_project_domains WHERE organization_id = ? AND project_id = ?",
          input.organizationId,
          input.projectId,
        ],
      ]);
      return {
        authorized: (authorized?.length ?? 0) === 1,
        row: (row?.[0] as Snapshot["row"] | undefined) ?? null,
      };
    },
    decide: (snapshot) => {
      if (!snapshot.authorized) return { replay: false };
      if (snapshot.row === null) return { replay: true };
      if (snapshot.row.deleted_at !== null) {
        return { replay: snapshot.row.deleted_at <= input.deletedAt };
      }
      const statements: D1PreparedStatement[] = [
        guard(
          db,
          "precondition_changed",
          `NOT EXISTS (${DELETION_AUTHORIZED_SQL})`,
          deletionParams(input),
        ),
        db
          .prepare(
            "UPDATE cloudflare_project_domains SET deleted_at = ? WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL",
          )
          .bind(input.deletedAt, input.organizationId, input.projectId),
        guard(db, "precondition_changed", "changes() = 0"),
      ];
      return { statements, result: () => true };
    },
  };
  return runCommand(db, command);
}
