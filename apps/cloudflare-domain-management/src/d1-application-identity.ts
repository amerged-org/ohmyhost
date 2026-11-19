import { parseUlid } from "@ohmyhost/platform";
import { SharedMailDomainError, type ApplicationDomainIdentityRow } from "@ohmyhost/database";
import { ScopedDnsConflictError } from "./scoped-dns-authorization.js";
import type {
  ApplicationIdentityPersistence,
  ApplicationIdentityMutation,
  ApplicationIdentityView,
  ApplicationAutomaticProof,
} from "./application-domain-identity.js";

interface ApplicationIdentityBinding {
  read(input: unknown): Promise<unknown>;
  declare(input: unknown): Promise<unknown>;
  replay(input: unknown): Promise<unknown>;
  readForVerification(input: unknown): Promise<unknown>;
  completeAction(input: unknown): Promise<unknown>;
  readAutomatic(input: unknown): Promise<unknown>;
  completeAutomatic(input: unknown): Promise<unknown>;
}
function invalid(): never {
  throw new TypeError("application_identity_response_invalid");
}
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function identity(value: unknown): ApplicationDomainIdentityRow | null {
  if (value === null) return null;
  if (
    !record(value, [
      "organizationId",
      "projectId",
      "hostname",
      "registrableDomain",
      "revision",
      "state",
      "challengeName",
      "challengeValue",
      "declaredAt",
      "verifiedAt",
      "expiresAt",
      "revokedAt",
    ])
  )
    return invalid();
  for (const key of ["organizationId", "projectId"]) parseUlid(String(value[key]));
  for (const key of ["hostname", "registrableDomain", "challengeName", "challengeValue"])
    if (typeof value[key] !== "string") return invalid();
  if (
    typeof value["revision"] !== "number" ||
    !Number.isInteger(value["revision"]) ||
    value["revision"] < 1 ||
    !["pending", "verified", "revoked"].includes(String(value["state"]))
  )
    return invalid();
  instant(value["declaredAt"]);
  instant(value["expiresAt"]);
  for (const key of ["verifiedAt", "revokedAt"]) if (value[key] !== null) instant(value[key]);
  return value as unknown as ApplicationDomainIdentityRow;
}
const required = (value: unknown) => identity(value) ?? invalid();
function view(value: unknown): ApplicationIdentityView | null {
  if (value === null) return null;
  if (
    !record(value, [
      "organization_id",
      "project_id",
      "hostname",
      "registrable_domain",
      "status",
      "revision",
      "challenge",
      "verified_at",
      "expires_at",
    ])
  )
    return invalid();
  parseUlid(String(value["organization_id"]));
  parseUlid(String(value["project_id"]));
  if (
    typeof value["hostname"] !== "string" ||
    typeof value["registrable_domain"] !== "string" ||
    typeof value["revision"] !== "number" ||
    !Number.isInteger(value["revision"]) ||
    value["revision"] < 1 ||
    !["pending", "verified", "revoked", "expired"].includes(String(value["status"])) ||
    !record(value["challenge"], ["type", "name", "value"]) ||
    value["challenge"]["type"] !== "TXT" ||
    typeof value["challenge"]["name"] !== "string" ||
    typeof value["challenge"]["value"] !== "string"
  )
    return invalid();
  if (value["verified_at"] !== null) instant(value["verified_at"]);
  instant(value["expires_at"]);
  return value as unknown as ApplicationIdentityView;
}
function automatic(value: unknown): ApplicationAutomaticProof | null {
  if (value === null) return null;
  if (
    !record(value, [
      "hostname",
      "registrableDomain",
      "revision",
      "challengeName",
      "challengeValue",
      "verifiedAt",
      "expiresAt",
      "expiresAtCas",
      "ownershipVersion",
      "billingEpochId",
      "lifecycleVersion",
      "bindingRevision",
      "mailDomainId",
      "environmentId",
      "resourceRevision",
      "resourceDomain",
      "customHostnames",
    ])
  )
    return invalid();
  for (const key of [
    "hostname",
    "registrableDomain",
    "challengeName",
    "challengeValue",
    "resourceDomain",
  ])
    if (typeof value[key] !== "string") return invalid();
  for (const key of [
    "revision",
    "ownershipVersion",
    "lifecycleVersion",
    "bindingRevision",
    "resourceRevision",
  ])
    if (typeof value[key] !== "number" || !Number.isInteger(value[key]) || value[key] < 1)
      return invalid();
  for (const key of ["billingEpochId", "mailDomainId", "environmentId"])
    parseUlid(String(value[key]));
  instant(value["verifiedAt"]);
  instant(value["expiresAt"]);
  if (
    typeof value["expiresAtCas"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value["expiresAtCas"]) ||
    !Array.isArray(value["customHostnames"]) ||
    value["customHostnames"].some((host) => typeof host !== "string")
  )
    return invalid();
  return value as unknown as ApplicationAutomaticProof;
}
function mutation(input: ApplicationIdentityMutation) {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorId: input.actorId,
    idempotencyKeySha256: input.idempotencyKeySha256.slice(7),
    requestSha256: input.requestSha256.slice(7),
    delegation: input.delegation,
  };
}
async function invoke<T>(call: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let raw;
  try {
    raw = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    for (const code of [
      "dns_authority_revoked",
      "mail_domain_mismatch",
      "mail_scope_unavailable",
      "idempotency_conflict",
      "store_busy",
      "store_outcome_unknown",
    ]) {
      if (message !== code && !message.endsWith(`: ${code}`)) continue;
      if (code === "dns_authority_revoked") throw new ScopedDnsConflictError(code);
      if (
        code === "mail_domain_mismatch" ||
        code === "mail_scope_unavailable" ||
        code === "idempotency_conflict"
      )
        throw new SharedMailDomainError(code);
      throw Object.assign(new Error(code), { code });
    }
    throw new Error("application_identity_core_unavailable");
  }
  return parse(raw);
}
/** Proof and receipt compounds as closed Core commands; DNS lookups and every clock/RNG supplier stay in this Worker. */
export async function createD1ApplicationIdentityPersistence(
  raw: unknown,
): Promise<ApplicationIdentityPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    [
      "read",
      "declare",
      "replay",
      "readForVerification",
      "completeAction",
      "readAutomatic",
      "completeAutomatic",
    ].some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("application_identity_binding_required");
  const binding = raw as ApplicationIdentityBinding;
  if (
    (await invoke(
      () =>
        binding.read({
          organizationId: "00000000000000000000000000",
          projectId: "00000000000000000000000000",
          actorId: "user:source-probe",
        }),
      identity,
    )) !== null
  )
    return invalid();
  return {
    read: (scope) => invoke(() => binding.read(scope), identity),
    declare: (request, domain, now, challenge) =>
      invoke(
        () =>
          binding.declare({
            ...mutation(request),
            hostname: domain.hostname,
            registrableDomain: domain.registrableDomain,
            challengeValue: challenge(),
            declaredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 86400000).toISOString(),
          }),
        required,
      ),
    replay: (request, action) =>
      invoke(() => binding.replay({ ...mutation(request), action }), view),
    readForVerification: (request) =>
      invoke(
        () =>
          binding.readForVerification({
            organizationId: request.organizationId,
            projectId: request.projectId,
            actorId: request.actorId,
          }),
        identity,
      ),
    verify: (request, revision, challengeValue, now) =>
      invoke(
        () =>
          binding.completeAction({
            ...mutation(request),
            action: "verify",
            revision,
            challengeValue,
            now: now.toISOString(),
            expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
            viewAt: now.toISOString(),
          }),
        view,
      ),
    revoke: (request, revision, clock) =>
      invoke(
        () =>
          binding.completeAction({
            ...mutation(request),
            action: "revoke",
            revision,
            now: clock().toISOString(),
            viewAt: clock().toISOString(),
          }),
        view,
      ),
    readAutomatic: (request, clock) =>
      invoke(() => binding.readAutomatic({ ...request, now: clock().toISOString() }), automatic),
    completeAutomatic: (request, current, clock) =>
      invoke(
        () =>
          binding.completeAutomatic({ ...request, witness: current, now: clock().toISOString() }),
        (value) => {
          if (
            !record(value, ["status", "revision", "expiresAt"]) ||
            !["stale", "not_due", "revalidated"].includes(String(value["status"])) ||
            typeof value["revision"] !== "number"
          )
            return invalid();
          if (value["expiresAt"] !== null) instant(value["expiresAt"]);
          return value as {
            status: "stale" | "not_due" | "revalidated";
            revision: number;
            expiresAt: string | null;
          };
        },
      ),
  };
}
