import { randomBytes } from "node:crypto";
import type { ApplicationDomainIdentityRow } from "@ohmyhost/database";
import { classifyApplicationMailIdentity, parseUlid } from "@ohmyhost/platform";
import {
  CloudflareCustomerDnsConflictError,
  CloudflareCustomerDnsProviderError,
  CloudflareCustomerDnsReceiptMismatchError,
  CloudflareCustomerDnsRejectedError,
  CloudflareCustomerDnsUncertainError,
} from "@ohmyhost/provider-cloudflare";
import {
  parseScopedDnsDelegation,
  ScopedDnsConflictError,
  type ScopedDnsDelegation,
} from "./scoped-dns-authorization.js";

const REVALIDATION_WINDOW = 7 * 24 * 60 * 60 * 1_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export type ApplicationIdentityMutation = ReturnType<typeof parseMutation>;
export type ApplicationIdentityView = ReturnType<typeof identityView>;
export interface ApplicationAutomaticProof {
  hostname: string;
  registrableDomain: string;
  revision: number;
  challengeName: string;
  challengeValue: string;
  verifiedAt: string;
  expiresAt: string;
  expiresAtCas: string;
  ownershipVersion: number;
  billingEpochId: string;
  lifecycleVersion: number;
  bindingRevision: number;
  mailDomainId: string;
  environmentId: string;
  resourceRevision: number;
  resourceDomain: string;
  customHostnames: string[];
}
export interface ApplicationIdentityPersistence {
  read(scope: ReturnType<typeof parseScope>): Promise<ApplicationDomainIdentityRow | null>;
  declare(
    request: ApplicationIdentityMutation,
    domain: { hostname: string; registrableDomain: string },
    now: Date,
    challenge: () => string,
  ): Promise<ApplicationDomainIdentityRow>;
  replay(
    request: ApplicationIdentityMutation,
    action: "verify" | "revoke",
  ): Promise<ApplicationIdentityView | null>;
  readForVerification(
    request: ApplicationIdentityMutation,
  ): Promise<ApplicationDomainIdentityRow | null>;
  verify(
    request: ApplicationIdentityMutation,
    revision: number,
    challengeValue: string,
    now: Date,
  ): Promise<ApplicationIdentityView | null>;
  revoke(
    request: ApplicationIdentityMutation,
    revision: number,
    now: () => Date,
  ): Promise<ApplicationIdentityView | null>;
  readAutomatic(
    request: { organizationId: string; projectId: string; expectedRevision: number },
    clock: () => Date,
  ): Promise<ApplicationAutomaticProof | null>;
  completeAutomatic(
    request: { organizationId: string; projectId: string; expectedRevision: number },
    current: ApplicationAutomaticProof,
    clock: () => Date,
  ): Promise<{
    status: "stale" | "not_due" | "revalidated";
    revision: number;
    expiresAt: string | null;
  }>;
}
/** This proves an intended hostname; it never creates a route or activates a website. */
export function createApplicationDomainIdentityRuntime(input: {
  readonly persistence: ApplicationIdentityPersistence;
  readonly identityPolicy?: {
    readonly classify: typeof classifyApplicationMailIdentity;
    readonly validateStored?: (hostname: string) => unknown;
  };
  readonly parseDelegation?: typeof parseScopedDnsDelegation;
  readonly clock: { now(): Date };
  readonly observeTxt: (name: string, value: string) => Promise<boolean>;
  readonly ensureChallenge: (scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
}) {
  const persistence = input.persistence;
  const classify = input.identityPolicy?.classify ?? classifyApplicationMailIdentity;
  const validateStored =
    input.identityPolicy === undefined
      ? classifyApplicationMailIdentity
      : input.identityPolicy.validateStored;
  return Object.freeze({
    /** Installed workspace desired state may refresh its existing, still-valid public proof. */
    async revalidateApplicationDomainIdentity(raw: unknown) {
      const value = exact(raw, ["organizationId", "projectId", "expectedRevision"]);
      const request = {
        organizationId: parseUlid(String(value["organizationId"])),
        projectId: parseUlid(String(value["projectId"])),
        expectedRevision: requireRevision(value["expectedRevision"]),
      };
      const current = await persistence.readAutomatic(request, () => input.clock.now());
      if (current === null)
        return { status: "stale" as const, revision: request.expectedRevision, expiresAt: null };
      if (Date.parse(current.expiresAt) - input.clock.now().getTime() > REVALIDATION_WINDOW)
        return {
          status: "not_due" as const,
          revision: current.revision,
          expiresAt: current.expiresAt,
        };
      let observed: boolean;
      try {
        observed = await input.observeTxt(current.challengeName, current.challengeValue);
      } catch {
        observed = false;
      }
      if (!observed)
        return {
          status: "needs_attention" as const,
          revision: current.revision,
          expiresAt: current.expiresAt,
        };
      return persistence.completeAutomatic(request, current, () => input.clock.now());
    },
    async readApplicationDomainIdentity(raw: unknown) {
      const scope = parseScope(raw);
      const row = await persistence.read(scope);
      return row === null ? null : identityView(row, input.clock.now());
    },
    async declareApplicationDomainIdentity(raw: unknown) {
      const request = parseMutation(raw, ["hostname"], input.parseDelegation);
      const domain = classify(String(request["hostname"]));
      if (domain.hostname.length > 240)
        throw new TypeError("Application identity hostname leaves no room for its DNS challenge");
      const now = input.clock.now();
      const row = await persistence.declare(
        request,
        domain,
        now,
        () => `omh-domain-v1=${randomBytes(32).toString("base64url")}`,
      );
      return identityView(row, now);
    },
    async verifyApplicationDomainIdentity(raw: unknown) {
      const request = parseMutation(raw, ["expectedRevision"], input.parseDelegation);
      const revision = requireRevision(request["expectedRevision"]);
      const replay = await persistence.replay(request, "verify");
      if (replay !== null) return replay;
      const row = await persistence.readForVerification(request);
      if (row === null || row.revision !== revision || row.state === "revoked")
        return Object.freeze({ status: "conflict" as const, code: "application_identity_stale" });
      if (validateStored !== undefined) validateStored(row.hostname);
      // With an explicit purpose-bound grant only this exact TXT is reconciled. Manual DNS
      // remains available, and absence of a grant never turns into an implicit consent request.
      // The public TXT observation decides the proof after a provider or persistence refusal of the reconciliation (for
      // example a foreign record at the name), so such a refusal never hides a TXT that is already published. Any other
      // reconciliation error is logged and fails the verification rather than being decided by the observation.
      try {
        await input.ensureChallenge({ ...request, expectedRevision: revision });
      } catch (error) {
        if (!isReconciliationRefusal(error)) {
          console.error(
            JSON.stringify({
              event: "application_identity_reconcile_failed",
              organizationId: request.organizationId,
              projectId: request.projectId,
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
          throw error;
        }
        /* Observed below: a missing TXT still answers pending, and a published one verifies. */
      }
      if (!(await input.observeTxt(row.challengeName, row.challengeValue)))
        return Object.freeze({
          status: "conflict" as const,
          code: "application_identity_dns_pending",
        });
      const now = input.clock.now();
      const verified = await persistence.verify(request, revision, row.challengeValue, now);
      return verified === null
        ? Object.freeze({ status: "conflict" as const, code: "application_identity_stale" })
        : verified;
    },
    async revokeApplicationDomainIdentity(raw: unknown) {
      const request = parseMutation(raw, ["expectedRevision"], input.parseDelegation);
      const row = await persistence.revoke(
        request,
        requireRevision(request["expectedRevision"]),
        () => input.clock.now(),
      );
      return row === null
        ? Object.freeze({ status: "conflict" as const, code: "application_identity_stale" })
        : row;
    },
  });
}

/** Fixed DoH origin, bounded response and an exact owner/type/value match prevent URL/answer substitution. */
export async function observeApplicationIdentityTxt(
  fetcher: typeof globalThis.fetch,
  name: string,
  expectedValue: string,
): Promise<boolean> {
  if (
    !/^_omh-project\.[a-z0-9.-]{3,240}$/u.test(name) ||
    !/^omh-domain-v1=[A-Za-z0-9_-]{43}$/u.test(expectedValue)
  )
    throw new TypeError("Application identity challenge is invalid");
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  const response = await fetcher(url, {
    headers: { accept: "application/dns-json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || response.body === null)
    throw new Error("Application identity DNS is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) throw new Error("Application identity DNS response is too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed) || parsed["Status"] !== 0 || !Array.isArray(parsed["Answer"])) return false;
  return parsed["Answer"].some((answer: unknown) => {
    if (
      !isRecord(answer) ||
      answer["type"] !== 16 ||
      typeof answer["name"] !== "string" ||
      typeof answer["data"] !== "string"
    )
      return false;
    const data = answer["data"];
    return (
      answer["name"].replace(/\.$/u, "").toLowerCase() === name && data === `"${expectedValue}"`
    );
  });
}

function identityView(row: ApplicationDomainIdentityRow, now: Date) {
  return Object.freeze({
    organization_id: row.organizationId,
    project_id: row.projectId,
    hostname: row.hostname,
    registrable_domain: row.registrableDomain,
    status:
      row.state !== "revoked" && Date.parse(row.expiresAt) <= now.getTime() ? "expired" : row.state,
    revision: row.revision,
    challenge: Object.freeze({
      type: "TXT" as const,
      name: row.challengeName,
      value: row.challengeValue,
    }),
    verified_at: row.verifiedAt,
    expires_at: row.expiresAt,
  });
}

function parseScope(raw: unknown) {
  const row = exact(raw, ["actorId", "organizationId", "projectId"]);
  return scope(row);
}

function parseMutation(
  raw: unknown,
  extra: readonly string[],
  parseDelegation: typeof parseScopedDnsDelegation = parseScopedDnsDelegation,
): Record<string, unknown> &
  ReturnType<typeof scope> & {
    idempotencyKeySha256: string;
    requestSha256: string;
    delegation: ScopedDnsDelegation | null;
  } {
  const row = exact(raw, [
    "actorId",
    "organizationId",
    "projectId",
    "idempotencyKeySha256",
    "requestSha256",
    ...extra,
    ...(isRecord(raw) && Object.hasOwn(raw, "delegation") ? ["delegation"] : []),
  ]);
  digest(String(row["idempotencyKeySha256"]));
  digest(String(row["requestSha256"]));
  return {
    ...row,
    ...scope(row),
    idempotencyKeySha256: String(row["idempotencyKeySha256"]),
    requestSha256: String(row["requestSha256"]),
    delegation: row["delegation"] === undefined ? null : parseDelegation(row["delegation"]),
  };
}

/** The provider and persistence refusals of a grant's reconciliation, which the public TXT observation supersedes. */
function isReconciliationRefusal(error: unknown): boolean {
  return (
    error instanceof CloudflareCustomerDnsProviderError ||
    error instanceof CloudflareCustomerDnsRejectedError ||
    error instanceof CloudflareCustomerDnsUncertainError ||
    error instanceof CloudflareCustomerDnsConflictError ||
    error instanceof CloudflareCustomerDnsReceiptMismatchError ||
    error instanceof ScopedDnsConflictError
  );
}

function scope(row: Record<string, unknown>) {
  const actorId = String(row["actorId"]);
  if (actorId.length < 1 || actorId.length > 256 || containsControlCharacter(actorId))
    throw new TypeError("Application identity actor is invalid");
  return {
    organizationId: parseUlid(String(row["organizationId"])),
    projectId: parseUlid(String(row["projectId"])),
    actorId,
  };
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new TypeError("Application identity revision is invalid");
  return Number(value);
}

function digest(value: string): Uint8Array {
  if (!DIGEST.test(value)) throw new TypeError("Application identity mutation digest is invalid");
  return Buffer.from(value.slice(7), "hex");
}

function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== [...keys].sort().join(","))
    throw new TypeError("Application identity input is invalid");
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string) {
  for (const character of value)
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;
  return false;
}
