import {
  CloudflareAuthorizationClosedError,
  CloudflareProjectDomainConflictError,
} from "@ohmyhost/database";
import type { CloudflareDomainManagementPersistence } from "./runtime.js";
import { CloudflareZoneNotBoundError } from "./runtime.js";

/** Closed project-domain transactions; OAuth codes and plaintext provider tokens stay in the Worker. */
export interface GeneralCloudflareRuntimeBinding {
  claimAuthorization(
    input: Parameters<CloudflareDomainManagementPersistence["claimAuthorization"]>[0],
  ): ReturnType<CloudflareDomainManagementPersistence["claimAuthorization"]>;
  consumeAuthorization(
    input: Parameters<CloudflareDomainManagementPersistence["consumeAuthorization"]>[0],
  ): ReturnType<CloudflareDomainManagementPersistence["consumeAuthorization"]>;
  putGrant(
    input: Parameters<CloudflareDomainManagementPersistence["putGrant"]>[0],
  ): ReturnType<CloudflareDomainManagementPersistence["putGrant"]>;
  readStatus(
    input: Parameters<CloudflareDomainManagementPersistence["readStatus"]>[0] & { now: string },
  ): ReturnType<CloudflareDomainManagementPersistence["readStatus"]>;
  configureDomains(
    input: Parameters<CloudflareDomainManagementPersistence["configureDomains"]>[0] & {
      operationId: string;
      queuedEventId: string;
      startedEventId: string;
      succeededEventId: string;
      auditEventId: string;
      outboxEventId: string;
      occurredAt: string;
    },
  ): ReturnType<CloudflareDomainManagementPersistence["configureDomains"]>;
}
async function invoke<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "CloudflareAuthorizationClosedError")
        throw new CloudflareAuthorizationClosedError();
      if (error.name === "CloudflareProjectDomainConflictError")
        throw new CloudflareProjectDomainConflictError();
      if (error.name === "CloudflareZoneNotBoundError") throw new CloudflareZoneNotBoundError();
    }
    throw error;
  }
}
export function createD1CloudflareDomainManagementPersistence(input: {
  binding: GeneralCloudflareRuntimeBinding;
  clock: { now(): Date };
  ids: { next(): string };
}): CloudflareDomainManagementPersistence {
  return Object.freeze<CloudflareDomainManagementPersistence>({
    claimAuthorization: (request) =>
      invoke(() =>
        input.binding.claimAuthorization({
          organizationId: request.organizationId,
          projectId: request.projectId,
          authorizationId: request.authorizationId,
          principalId: request.principalId,
          zoneName: request.zoneName,
          idempotencyKeySha256: request.idempotencyKeySha256,
          requestSha256: request.requestSha256,
          stateSha256: request.stateSha256,
          issuedAt: request.issuedAt,
          expiresAt: request.expiresAt,
        }),
      ),
    consumeAuthorization: (request) => invoke(() => input.binding.consumeAuthorization(request)),
    putGrant: (request) => invoke(() => input.binding.putGrant(request)),
    readStatus: (request) =>
      invoke(() =>
        input.binding.readStatus({
          organizationId: request.organizationId,
          projectId: request.projectId,
          now: input.clock.now().toISOString(),
        }),
      ),
    configureDomains: (request) => {
      const operationId = input.ids.next(),
        identities = new Set([operationId]);
      const next = () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const id = input.ids.next();
          if (!identities.has(id)) {
            identities.add(id);
            return id;
          }
        }
        throw new Error("Domain configuration event identities are unavailable");
      };
      const command = {
        platform: request.platform,
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: request.principalId,
        idempotencyKeySha256: request.idempotencyKeySha256,
        requestSha256: request.requestSha256,
        projectHandle: request.projectHandle,
        configuredAt: request.configuredAt,
        operationId,
        queuedEventId: next(),
        startedEventId: next(),
        succeededEventId: next(),
        auditEventId: next(),
        outboxEventId: next(),
        occurredAt: input.clock.now().toISOString(),
      };
      return invoke(() => input.binding.configureDomains(command));
    },
  });
}
