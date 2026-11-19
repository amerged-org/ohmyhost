import { parseUlid } from "@ohmyhost/platform";
import type {
  CloudflareProjectDomainDeletionState,
  CloudflareProjectDomainReceipt,
  CloudflareProjectOAuthRevocation,
} from "@ohmyhost/database";
import type { CloudflareProjectDeletionPersistence } from "./project-deletion.js";
import { decodeGeneralCloudflareGrant } from "./d1-general-dns.js";
export interface CloudflareDeletionRuntimeBinding {
  readDeletion(
    input: Parameters<CloudflareProjectDeletionPersistence["read"]>[0],
  ): Promise<unknown>;
  rotateDeletionGrant(
    input: Parameters<CloudflareProjectDeletionPersistence["rotateGrantForDeletion"]>[0],
  ): Promise<unknown>;
  prepareRevocation(
    input: Parameters<CloudflareProjectDeletionPersistence["prepareRevocation"]>[0],
  ): Promise<unknown>;
  restartRevocation(
    input: Parameters<CloudflareProjectDeletionPersistence["restartRevocationAfterReadback"]>[0],
  ): Promise<unknown>;
  finalizeDeletion(
    input: Parameters<CloudflareProjectDeletionPersistence["finalizeDeletion"]>[0],
  ): Promise<boolean>;
  finalizePlatformDeletion(
    input: Parameters<CloudflareProjectDeletionPersistence["finalizePlatformDeletion"]>[0],
  ): Promise<boolean>;
}
function object(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid private Cloudflare deletion response");
  return value as Record<string, unknown>;
}
function date(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") throw new TypeError("Invalid Cloudflare receipt time");
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError("Invalid Cloudflare receipt time");
  return result;
}
function bytes(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((x) => Number.isInteger(x) && x >= 0 && x <= 255))
    return Uint8Array.from(value as number[]);
  throw new TypeError("Invalid sealed Cloudflare revocation");
}
function deletion(
  value: unknown,
  scope: Parameters<CloudflareProjectDeletionPersistence["read"]>[0],
): CloudflareProjectDomainDeletionState | null {
  if (value === null) return null;
  const r = object(value);
  if (
    r["organizationId"] !== scope.organizationId ||
    r["projectId"] !== scope.projectId ||
    r["operationId"] !== scope.operationId ||
    !Array.isArray(r["receipts"]) ||
    !Array.isArray(r["customHostnameDeleteTargets"])
  )
    throw new TypeError("Cloudflare deletion scope mismatch");
  const receipts = r["receipts"].map((raw) => {
    const item = object(raw);
    return {
      ...item,
      observedAt: date(item["observedAt"]),
      ...(item["providerCreatedAt"] === undefined
        ? {}
        : {
            providerCreatedAt:
              item["providerCreatedAt"] === null ? null : date(item["providerCreatedAt"]),
          }),
    } as unknown as CloudflareProjectDomainReceipt;
  });
  let revocation: CloudflareProjectOAuthRevocation | null = null;
  if (r["revocation"] !== null) {
    const raw = object(r["revocation"]);
    if (
      raw["organizationId"] !== scope.organizationId ||
      raw["projectId"] !== scope.projectId ||
      typeof raw["authorizationId"] !== "string" ||
      typeof raw["operationId"] !== "string" ||
      !["revoke_started", "readback_started", "confirmed"].includes(String(raw["state"]))
    )
      throw new TypeError("Invalid Cloudflare revocation scope");
    revocation = {
      ...raw,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      operationId: parseUlid(raw["operationId"]),
      authorizationId: parseUlid(raw["authorizationId"]),
      refreshTokenSha256: bytes(raw["refreshTokenSha256"]),
    } as unknown as CloudflareProjectOAuthRevocation;
  }
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    operationId: scope.operationId,
    domains: r["domains"] as CloudflareProjectDomainDeletionState["domains"],
    grant: decodeGeneralCloudflareGrant(r["grant"]),
    receipts,
    customHostnameDeleteTargets: r["customHostnameDeleteTargets"].map((raw) => {
      const item = object(raw);
      if (
        !["dev", "prod"].includes(String(item["environmentName"])) ||
        typeof item["customHostnameId"] !== "string" ||
        typeof item["hostname"] !== "string"
      )
        throw new TypeError("Invalid Cloudflare deletion target");
      return {
        environmentName: item["environmentName"] as "dev" | "prod",
        customHostnameId: item["customHostnameId"],
        hostname: item["hostname"],
        observedAt: date(item["observedAt"]).toISOString(),
      };
    }),
    revocation,
  };
}
export function createD1CloudflareProjectDeletionPersistence(
  binding: CloudflareDeletionRuntimeBinding,
): CloudflareProjectDeletionPersistence {
  return Object.freeze<CloudflareProjectDeletionPersistence>({
    read: async (input) => deletion(await binding.readDeletion(input), input),
    rotateGrantForDeletion: async (input) =>
      decodeGeneralCloudflareGrant(await binding.rotateDeletionGrant(input)),
    prepareRevocation: async (input) => {
      const result = await binding.prepareRevocation(input);
      if (result !== "revoke" && result !== "readback" && result !== "blocked")
        throw new TypeError("Invalid Cloudflare revocation decision");
      return result;
    },
    restartRevocationAfterReadback: async (input) =>
      decodeGeneralCloudflareGrant(await binding.restartRevocation(input)),
    finalizeDeletion: (input) => binding.finalizeDeletion(input),
    finalizePlatformDeletion: (input) => binding.finalizePlatformDeletion(input),
  });
}
