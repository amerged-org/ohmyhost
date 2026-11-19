import { createHash } from "node:crypto";

import { parseUlid } from "@ohmyhost/platform";
import { CloudflareCustomerDnsRejectedError } from "@ohmyhost/provider-cloudflare";
import { describe, expect, it, vi } from "vitest";

import {
  CloudflareProjectDeletionConflictError,
  CloudflareProjectDeletionUnavailableError,
  createCloudflareProjectDeletion,
  openDeletionHostnameDnsAccess,
} from "../src/project-deletion.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const OPERATION_ID = parseUlid("00000000000000000000000003");
const AUTHORIZATION_ID = parseUlid("00000000000000000000000004");
const NOW = "2026-08-29T12:00:00.000Z";
type ReceiptCommon = Readonly<{
  organizationId: typeof ORGANIZATION_ID;
  projectId: typeof PROJECT_ID;
  observedAt: string;
}>;

describe("Cloudflare project-domain deletion", () => {
  it("keeps current Free DNS on platform authority when the project also has customer DNS access", async () => {
    const fixture = setup([]);

    const result = await fixture.deletion.deleteProject(request());

    expect(result).toMatchObject({ outcome: "deleted", oauthGrant: "revoked" });
    expect(fixture.platformDns.deleteRecords).toHaveBeenCalledOnce();
    expect(fixture.platformRoutes.deleteRoute).toHaveBeenCalledTimes(2);
    expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();
    expect(fixture.oauth.refreshAccessToken).not.toHaveBeenCalled();
    expect(fixture.oauth.revokeRefreshToken).toHaveBeenCalledOnce();
  });

  it("deletes the mail delegation records through the project grant before revoking it", async () => {
    const order: string[] = [];
    const fixture = setup(order, { includeMailNs: true });

    const result = await fixture.deletion.deleteProject(request());

    expect(result).toMatchObject({ outcome: "deleted", oauthGrant: "revoked" });
    expect(fixture.dns.deleteRecords).toHaveBeenCalledOnce();
    expect(fixture.dns.deleteRecords).toHaveBeenCalledWith(
      "access-token-secret",
      expect.objectContaining({ zoneId: "a".repeat(32), zoneName: "aixyte.com" }),
    );
    const delegation = fixture.dns.deleteRecords.mock.calls[0]?.[1].records ?? [];
    expect(delegation).toHaveLength(4);
    expect(delegation.every((record) => record.type === "NS")).toBe(true);
    expect(order.indexOf("dns")).toBeLessThan(order.indexOf("oauth-revoke"));
    const platformRecords = fixture.platformDns.deleteRecords.mock.calls[0]?.[0].records ?? [];
    expect(platformRecords.every((record) => record.type !== "NS")).toBe(true);
    const delegationOutcomes = (value: typeof result) =>
      value.receipts
        .filter((item) => [21, 22, 23, 24].map(rid).includes(item["receiptId"] as never))
        .map((item) => item["outcome"]);
    expect(delegationOutcomes(result)).toEqual(["deleted", "deleted", "deleted", "deleted"]);

    // A delegation the owner already removed reads back absent and is reported as such.
    const removed = setup([], { includeMailNs: true });
    removed.dns.deleteRecords.mockResolvedValueOnce({
      status: "replayed" as never,
      recordIds: [],
    });
    const replayed = await removed.deletion.deleteProject(request());
    expect(delegationOutcomes(replayed)).toEqual(["absent", "absent", "absent", "absent"]);
  });

  it("deletes only the latest NS identities and reports every historical NS receipt", async () => {
    const fixture = setup([], { includeMailNs: true });
    const state = mailDelegationHistoryState();
    fixture.persistence.read.mockResolvedValueOnce(state as never);

    const result = await fixture.deletion.deleteProject(request());

    expect(
      state.receipts.filter((receipt) => receipt.kind === "dns_record" && receipt.type === "NS"),
    ).toHaveLength(8);
    const records = fixture.dns.deleteRecords.mock.calls[0]?.[1].records ?? [];
    expect(records).toHaveLength(4);
    expect(result.receipts).toHaveLength(state.receipts.length);
    expect(
      result.receipts
        .filter((item) => item["kind"] === "dns_record" && item["outcome"] === "deleted")
        .map((item) => item["receiptId"]),
    ).toEqual(expect.arrayContaining([21, 22, 23, 24, 30, 31, 32, 33].map(rid)));
  });

  it("never deletes a delegation outside the grant's zone or without customer authority", async () => {
    const foreign = setup([], { includeMailNs: true });
    foreign.persistence.read.mockResolvedValueOnce({
      ...foreign.state,
      receipts: foreign.state.receipts.map((receipt) =>
        receipt.kind === "dns_record" && receipt.type === "NS"
          ? { ...receipt, zoneId: "f".repeat(32) }
          : receipt,
      ),
    } as never);
    await expect(foreign.deletion.deleteProject(request())).rejects.toBeInstanceOf(
      CloudflareProjectDeletionConflictError,
    );
    const missingCustomerAccess = setup([], { missingGrant: true, includeMailNs: true });
    await expect(missingCustomerAccess.deletion.deleteProject(request())).rejects.toBeInstanceOf(
      CloudflareProjectDeletionConflictError,
    );
    for (const fixture of [foreign, missingCustomerAccess]) {
      expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();
      expect(fixture.platformDns.deleteRecords).not.toHaveBeenCalled();
      expect(fixture.oauth.revokeRefreshToken).not.toHaveBeenCalled();
    }
  });

  it("replays delegation absence without rotating authority once OAuth revocation started", async () => {
    const fixture = setup([], { includeMailNs: true, readbackStarted: true });

    const result = await fixture.deletion.deleteProject(request());

    expect(result).toMatchObject({ outcome: "deleted", oauthGrant: "revoked" });
    expect(result.receipts.every((receipt) => receipt["outcome"] === "absent")).toBe(true);
    expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();
    expect(fixture.oauth.refreshAccessToken).not.toHaveBeenCalled();
    const continuation = { ...request(), operationId: parseUlid("00000000000000000000000009") };
    const completed = { ...finalizedDeletionState(), operationId: continuation.operationId };
    fixture.persistence.read.mockResolvedValueOnce(completed as never);
    await expect(fixture.deletion.deleteProject(continuation)).resolves.toMatchObject({
      outcome: "absent",
      operationId: continuation.operationId,
    });
    for (const invalid of [
      {
        ...completed,
        revocation: {
          ...completed.revocation,
          authorizationId: parseUlid("00000000000000000000000008"),
        },
      },
      { ...completed, revocation: { ...completed.revocation, state: "provider_started" } },
      { ...completed, domains: { ...completed.domains, deletedAt: null } },
    ]) {
      fixture.persistence.read.mockResolvedValueOnce(invalid as never);
      await expect(fixture.deletion.deleteProject(continuation)).rejects.toBeInstanceOf(
        CloudflareProjectDeletionConflictError,
      );
    }
    expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();
  });

  it("deletes current platform DNS and routes before revoking customer OAuth", async () => {
    const order: string[] = [];
    const fixture = setup(order);

    const deleted = await fixture.deletion.deleteProject(request());

    expect(deleted).toMatchObject({
      outcome: "deleted",
      operationId: OPERATION_ID,
      oauthGrant: "revoked",
      observedAt: NOW,
    });
    expect(deleted.receipts).toHaveLength(fixture.state.receipts.length);
    expect(order).toEqual([
      "platform-dns",
      "platform-route:dev-calm-otter-waves",
      "platform-route:calm-otter-waves",
      "oauth-revoke",
      "mark-domains",
      "revoke-grant",
    ]);
    expect(JSON.stringify(deleted)).not.toContain("access-token-secret");
    const completed = finalizedDeletionState();
    fixture.persistence.read.mockResolvedValueOnce(completed as never);
    const replay = await fixture.deletion.deleteProject(request());
    expect(replay).toMatchObject({ outcome: "absent", oauthGrant: "revoked" });
    expect(replay.receipts).toHaveLength(completed.receipts.length);
    expect(replay.receipts.every((receipt) => receipt["outcome"] === "absent")).toBe(true);
    expect(order).toHaveLength(6);
    expect(fixture.platformDns.deleteRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ type: "CNAME", ttl: 1, proxied: true }),
        ]),
      }),
    );
    expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();

    const history = setup([]);
    const historicalState = {
      ...history.state,
      receipts: [
        ...history.state.receipts,
        ...history.state.receipts
          .filter((receipt) => receipt.kind === "dns_record" && receipt.type === "CNAME")
          .map((receipt, index) => ({
            ...receipt,
            receiptId: rid(40 + index),
            providerResourceId: `${index + 7}`.repeat(32),
            content: "dev.check.omh.st",
            observedAt: "2026-08-29T12:01:00.000Z",
          })),
      ],
    };
    history.persistence.read.mockResolvedValueOnce(historicalState as never);
    await history.deletion.deleteProject(request());
    const records = history.platformDns.deleteRecords.mock.calls[0]?.[0].records ?? [];
    expect(records.filter((record) => record.type === "CNAME")).toMatchObject([
      { id: "7".repeat(32), content: "dev.check.omh.st" },
      { id: "8".repeat(32), content: "dev.check.omh.st" },
    ]);
  });

  it("returns exact absence without invoking a provider when the authorized inventory is empty", async () => {
    const fixture = setup([], { empty: true });

    await expect(fixture.deletion.deleteProject(request())).resolves.toEqual({
      outcome: "absent",
      operationId: OPERATION_ID,
      receipts: [],
      oauthGrant: "absent",
      observedAt: NOW,
    });
    expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();
    expect(fixture.oauth.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it("cleans Free DNS without OAuth but never borrows platform authority for customer mail", async () => {
    const free = setup([], { missingGrant: true });

    await expect(free.deletion.deleteProject(request())).resolves.toMatchObject({
      outcome: "deleted",
      oauthGrant: "absent",
    });
    expect(free.platformDns.deleteRecords).toHaveBeenCalledOnce();
    expect(free.platformDns.deleteRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        zoneId: "a".repeat(32),
        records: expect.arrayContaining([expect.objectContaining({ type: "CNAME" })]),
      }),
    );
    expect(free.platformRoutes.deleteRoute).toHaveBeenCalledTimes(2);
    expect(free.dns.deleteRecords).not.toHaveBeenCalled();
    expect(free.oauth.revokeRefreshToken).not.toHaveBeenCalled();
    expect(free.persistence.finalizePlatformDeletion).toHaveBeenCalledOnce();

    const legacy = setup([], { missingGrant: true });
    legacy.persistence.read.mockResolvedValueOnce({
      ...legacy.state,
      receipts: [
        ...legacy.state.receipts,
        hostname(
          { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, observedAt: NOW },
          "dev",
          5,
          "b".repeat(32),
          "dev-calm-otter-waves.dev.check.omh.st",
        ),
      ],
    } as never);
    await expect(legacy.deletion.deleteProject(request())).rejects.toBeInstanceOf(
      CloudflareProjectDeletionConflictError,
    );
    expect(legacy.platformDns.deleteRecords).not.toHaveBeenCalled();
  });

  it("fails closed when the deletion operation has no authorized durable state", async () => {
    const fixture = setup();
    fixture.persistence.read.mockResolvedValueOnce(null as never);
    await expect(fixture.deletion.deleteProject(request())).rejects.toBeInstanceOf(
      CloudflareProjectDeletionUnavailableError,
    );
  });

  it("finishes a deletion whose expired grant Cloudflare revoked, without touching the customer's zone", async () => {
    const fixture = setup([], { expiring: true, includeMailNs: true });
    fixture.oauth.refreshAccessToken.mockRejectedValueOnce(
      new CloudflareCustomerDnsRejectedError(),
    );
    fixture.oauth.observeRefreshToken.mockResolvedValueOnce({ state: "revoked" } as never);

    await expect(fixture.deletion.deleteProject(request())).resolves.toMatchObject({
      outcome: "deleted",
      oauthGrant: "revoked",
    });
    expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();
    expect(fixture.persistence.finalizeDeletion).toHaveBeenCalledOnce();
  });

  it("stores the pair an active observation rotated after a refused refresh, and continues the deletion with it", async () => {
    const fixture = setup([], { expiring: true, includeMailNs: true });
    const rotatedAt = "2026-08-29T12:00:01.000Z";
    fixture.oauth.refreshAccessToken.mockRejectedValueOnce(
      new CloudflareCustomerDnsRejectedError(),
    );
    // Cloudflare answered the observation with a live pair: that exchange already rotated the stored refresh token.
    fixture.oauth.observeRefreshToken.mockResolvedValueOnce({
      state: "active",
      tokens: {
        accessToken: "readback-access-token",
        refreshToken: "readback-refresh-token",
        expiresInSeconds: 3600,
        scopes: ["dns.write", "zone.read"] as const,
      },
    } as never);
    fixture.persistence.rotateGrantForDeletion.mockResolvedValueOnce({
      ...grant(),
      updatedAt: rotatedAt,
    } as never);

    await expect(fixture.deletion.deleteProject(request())).resolves.toMatchObject({
      outcome: "deleted",
      oauthGrant: "revoked",
    });
    expect(fixture.persistence.rotateGrantForDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: AUTHORIZATION_ID,
        expectedUpdatedAt: NOW,
        accessExpiresAt: "2026-08-29T13:00:00.000Z",
        accessCiphertext: Uint8Array.from(Buffer.from("cipher:readback-access-token")),
        refreshCiphertext: Uint8Array.from(Buffer.from("cipher:readback-refresh-token")),
      }),
    );
    expect(fixture.dns.deleteRecords).toHaveBeenCalledWith(
      "readback-access-token",
      expect.anything(),
    );
    expect(fixture.persistence.prepareRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedGrantUpdatedAt: rotatedAt }),
    );
    expect(fixture.persistence.finalizeDeletion).toHaveBeenCalledOnce();
  });

  it("refreshes an expiring customer grant before deleting the delegation and revokes the rotated grant", async () => {
    const fixture = setup([], { expiring: true, includeMailNs: true });
    const rotatedAt = "2026-08-29T12:00:01.000Z";
    fixture.persistence.rotateGrantForDeletion.mockResolvedValueOnce({
      ...grant(),
      updatedAt: rotatedAt,
    } as never);

    await fixture.deletion.deleteProject(request());

    expect(fixture.oauth.refreshAccessToken).toHaveBeenCalledWith("refresh-token-secret");
    expect(fixture.persistence.rotateGrantForDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: AUTHORIZATION_ID,
        expectedUpdatedAt: NOW,
        accessExpiresAt: "2026-08-29T13:00:00.000Z",
      }),
    );
    expect(fixture.dns.deleteRecords).toHaveBeenCalledWith(
      "refreshed-access-token",
      expect.anything(),
    );
    expect(fixture.persistence.prepareRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedGrantUpdatedAt: rotatedAt }),
    );
  });

  it("revokes a grant even when authorization completed before domains were configured", async () => {
    const fixture = setup([], { grantOnly: true });

    await expect(fixture.deletion.deleteProject(request())).resolves.toMatchObject({
      outcome: "deleted",
      receipts: [],
      oauthGrant: "revoked",
    });
    expect(fixture.oauth.revokeRefreshToken).toHaveBeenCalledWith("refresh-token-secret");
    expect(fixture.dns.deleteRecords).not.toHaveBeenCalled();
  });

  it("persists a revocation intent and reads back a lost refresh-token revoke", async () => {
    const fixture = setup([], { revokeLost: true });

    await expect(fixture.deletion.deleteProject(request())).resolves.toMatchObject({
      outcome: "deleted",
      oauthGrant: "revoked",
    });
    expect(fixture.persistence.prepareRevocation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ authorizationId: AUTHORIZATION_ID }),
    );
    expect(fixture.persistence.prepareRevocation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ authorizationId: AUTHORIZATION_ID }),
    );
    expect(fixture.oauth.observeRefreshToken).toHaveBeenCalledWith("refresh-token-secret");
  });

  it("resumes an interrupted refresh-token revocation with observe-only readback", async () => {
    const fixture = setup([], { readbackStarted: true });

    await expect(fixture.deletion.deleteProject(request())).resolves.toMatchObject({
      outcome: "deleted",
      oauthGrant: "revoked",
    });
    expect(fixture.oauth.revokeRefreshToken).not.toHaveBeenCalled();
    expect(fixture.oauth.observeRefreshToken).toHaveBeenCalledWith("refresh-token-secret");
    expect(fixture.persistence.prepareRevocation).not.toHaveBeenCalled();
    expect(fixture.persistence.finalizeDeletion).toHaveBeenCalledOnce();
  });

  it("rejects an interrupted revocation whose durable token digest no longer matches", async () => {
    const fixture = setup([], { readbackStarted: true });
    const mismatched = deletionState({ readbackStarted: true });
    if (mismatched.revocation === null) throw new Error("Expected revocation state");
    fixture.persistence.read.mockResolvedValueOnce({
      ...mismatched,
      revocation: { ...mismatched.revocation, refreshTokenSha256: new Uint8Array(32) },
    } as never);

    await expect(fixture.deletion.deleteProject(request())).rejects.toBeInstanceOf(
      CloudflareProjectDeletionConflictError,
    );
    expect(fixture.oauth.observeRefreshToken).not.toHaveBeenCalled();
    expect(fixture.persistence.finalizeDeletion).not.toHaveBeenCalled();
  });

  it("persists rotated authority before retrying a revoke proven active by readback", async () => {
    const fixture = setup([], { revokeLost: true, readbackActive: true });

    await expect(fixture.deletion.deleteProject(request())).resolves.toMatchObject({
      oauthGrant: "revoked",
    });
    expect(fixture.persistence.restartRevocationAfterReadback).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRefreshTokenSha256: expect.any(Uint8Array),
        refreshTokenSha256: expect.any(Uint8Array),
      }),
    );
    expect(fixture.oauth.revokeRefreshToken).toHaveBeenNthCalledWith(1, "refresh-token-secret");
    expect(fixture.oauth.revokeRefreshToken).toHaveBeenNthCalledWith(2, "readback-refresh-token");
  });

  it("opens a hostname's DNS only through the deletion's own grant when that grant's zone covers it", async () => {
    const fixture = setup([], { expiring: true });
    fixture.persistence.rotateGrantForDeletion.mockResolvedValueOnce({
      ...grant(),
      updatedAt: "2026-08-29T12:00:01.000Z",
    } as never);
    // The expiring access token is renewed only through the deletion-authorized rotation.
    await expect(
      openDeletionHostnameDnsAccess(fixture.dependencies, request(), "shop.aixyte.com"),
    ).resolves.toEqual({
      status: "ready",
      accessToken: "refreshed-access-token",
      zoneId: "a".repeat(32),
      zoneName: "aixyte.com",
    });
    // A hostname outside the grant's zone, or a project without a grant, holds no DNS record the
    // deletion could remove, so nothing is opened for it.
    for (const hostname of ["aixyte.com.attacker.example", "shop.example.com"])
      await expect(
        openDeletionHostnameDnsAccess(fixture.dependencies, request(), hostname),
      ).resolves.toEqual({ status: "absent" });
    const free = setup([], { missingGrant: true });
    await expect(
      openDeletionHostnameDnsAccess(free.dependencies, request(), "shop.aixyte.com"),
    ).resolves.toEqual({ status: "absent" });
    fixture.persistence.read.mockResolvedValueOnce(null as never);
    await expect(
      openDeletionHostnameDnsAccess(fixture.dependencies, request(), "shop.aixyte.com"),
    ).rejects.toBeInstanceOf(CloudflareProjectDeletionUnavailableError);
    expect(fixture.oauth.refreshAccessToken).toHaveBeenCalledOnce();
  });
});

function setup(
  order: string[] = [],
  options: {
    empty?: boolean;
    missingGrant?: boolean;
    expiring?: boolean;
    includeMailNs?: boolean;
    grantOnly?: boolean;
    revokeLost?: boolean;
    readbackStarted?: boolean;
    readbackActive?: boolean;
  } = {},
) {
  const state = deletionState(options);
  let revocationPreparation = options.readbackStarted ? "blocked" : "revoke";
  const persistence = {
    read: vi.fn(async () => state),
    rotateGrantForDeletion: vi.fn(async () => state.grant),
    prepareRevocation: vi.fn(async () => {
      const outcome = revocationPreparation;
      revocationPreparation = "readback";
      return outcome;
    }),
    restartRevocationAfterReadback: vi.fn(async () => state.grant),
    finalizeDeletion: vi.fn(async () => {
      order.push("mark-domains");
      order.push("revoke-grant");
      return true;
    }),
    finalizePlatformDeletion: vi.fn(async () => {
      order.push("mark-platform-domains");
      return true;
    }),
  };
  const oauth = {
    refreshAccessToken: vi.fn(async () => ({
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token",
      expiresInSeconds: 3600,
      scopes: ["dns.write", "zone.read"] as const,
    })),
    revokeRefreshToken: vi.fn(async () => {
      order.push("oauth-revoke");
      if (options.revokeLost && oauth.revokeRefreshToken.mock.calls.length === 1) {
        throw new Error("lost response");
      }
    }),
    observeRefreshToken: vi.fn(async () =>
      options.readbackActive
        ? {
            state: "active" as const,
            tokens: {
              accessToken: "readback-access-token",
              refreshToken: "readback-refresh-token",
              expiresInSeconds: 3600,
              scopes: ["dns.write", "zone.read"] as const,
            },
          }
        : { state: "revoked" as const },
    ),
  };
  const dns = {
    deleteRecords: vi.fn<
      (
        token: string,
        request: { readonly records: readonly { readonly type: string }[] },
      ) => Promise<{ readonly status: "deleted"; readonly recordIds: readonly string[] }>
    >(async () => {
      order.push("dns");
      return { status: "deleted" as const, recordIds: ["1".repeat(32), "2".repeat(32)] };
    }),
  };
  const platformDns = {
    deleteRecords: vi.fn<
      (request: {
        readonly records: readonly {
          readonly id: string;
          readonly type: string;
          readonly content: string;
        }[];
      }) => Promise<{ status: "deleted" | "replayed"; recordIds: readonly string[] }>
    >(async (): Promise<{ status: "deleted" | "replayed"; recordIds: readonly string[] }> => {
      order.push("platform-dns");
      return { status: "deleted" as const, recordIds: ["1".repeat(32), "2".repeat(32)] };
    }),
  };
  const platformRoutes = {
    deleteRoute: vi.fn(
      async (receipt: { scriptName: string; routeId: string; pattern: string }) => {
        order.push(`platform-route:${receipt.scriptName}`);
        return {
          outcome: "deleted" as const,
          routeId: receipt.routeId,
          pattern: receipt.pattern,
          observedAt: new Date(NOW),
        };
      },
    ),
  };
  const cipher = {
    open: vi.fn(async ({ associatedData }: { associatedData: string }) =>
      associatedData.endsWith(":refresh") ? "refresh-token-secret" : "access-token-secret",
    ),
    seal: vi.fn(async (plaintext: string) => ({
      ciphertext: Buffer.from(`cipher:${plaintext}`).toString("base64"),
      nonce: Buffer.alloc(12, 1).toString("base64"),
      keyVersion: 1,
    })),
  };
  const dependencies = {
    clock: { now: () => new Date(NOW) },
    cipher: cipher as never,
    persistence: persistence as never,
    providers: { oauth, dns, platformDns, platformRoutes } as never,
  };
  return {
    state,
    persistence,
    oauth,
    dns,
    platformDns,
    dependencies,
    deletion: createCloudflareProjectDeletion(dependencies),
    platformRoutes,
  };
}

function request() {
  return { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, operationId: OPERATION_ID };
}

function deletionState(options: {
  empty?: boolean;
  missingGrant?: boolean;
  expiring?: boolean;
  includeMailNs?: boolean;
  grantOnly?: boolean;
  revokeLost?: boolean;
  readbackStarted?: boolean;
  readbackActive?: boolean;
}) {
  if (options.empty) {
    return {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      operationId: OPERATION_ID,
      grant: null,
      domains: null,
      receipts: [],
      revocation: null,
    };
  }
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    operationId: OPERATION_ID,
    grant: options.missingGrant ? null : grant(options.expiring),
    domains: options.grantOnly ? null : domains(),
    receipts: options.grantOnly
      ? []
      : [
          ...receipts(),
          ...(options.includeMailNs
            ? [1, 2, 3, 4].map((value) => ({
                organizationId: ORGANIZATION_ID,
                projectId: PROJECT_ID,
                observedAt: NOW,
                receiptId: rid(20 + value),
                kind: "dns_record" as const,
                providerResourceId: String(4 + value)
                  .repeat(32)
                  .slice(0, 32),
                zoneId: "a".repeat(32),
                zoneName: "aixyte.com" as const,
                type: "NS" as const,
                name: "calm-otter-waves.mail.aixyte.com",
                content: `ns-${value}.awsdns-${value}.${["com", "net", "org", "co.uk"][value - 1]}`,
                ttl: 300,
                proxied: false as const,
                comment: `ohmyhost:${PROJECT_ID}:mail-ns:v1`,
              }))
            : []),
        ],
    revocation: options.readbackStarted
      ? {
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          operationId: OPERATION_ID,
          authorizationId: AUTHORIZATION_ID,
          state: "readback_started" as const,
          refreshTokenSha256: Uint8Array.from(
            createHash("sha256").update("refresh-token-secret").digest(),
          ),
          providerStartedAt: NOW,
          readbackStartedAt: NOW,
          confirmedAt: null,
        }
      : null,
  };
}

function grant(expiring = false) {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    authorizationId: AUTHORIZATION_ID,
    principalId: "user:user_1",
    zoneId: "a".repeat(32),
    zoneName: "aixyte.com" as const,
    accountId: "account_1",
    scopes: ["dns.write", "zone.read"] as const,
    keyVersion: 1,
    accessExpiresAt: expiring ? "2026-08-29T12:00:30.000Z" : "2026-08-29T13:00:00.000Z",
    connectedAt: NOW,
    updatedAt: NOW,
    status: "active" as const,
    accessCiphertext: Uint8Array.from([1]),
    accessNonce: Uint8Array.from({ length: 12 }, () => 2),
    refreshCiphertext: Uint8Array.from([3]),
    refreshNonce: Uint8Array.from({ length: 12 }, () => 4),
    revokedAt: null,
  };
}

function finalizedDeletionState() {
  const state = deletionState({ includeMailNs: true });
  if (state.grant === null || state.domains === null) throw new Error("Expected domain state");
  return {
    ...state,
    grant: {
      ...state.grant,
      status: "revoked" as const,
      accessCiphertext: null,
      accessNonce: null,
      refreshCiphertext: null,
      refreshNonce: null,
      revokedAt: NOW,
    },
    domains: { ...state.domains, deletedAt: NOW },
    revocation: {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      operationId: OPERATION_ID,
      authorizationId: AUTHORIZATION_ID,
      state: "confirmed" as const,
      refreshTokenSha256: new Uint8Array(32),
      providerStartedAt: NOW,
      readbackStartedAt: NOW,
      confirmedAt: NOW,
    },
  };
}

function mailDelegationHistoryState() {
  const state = deletionState({ includeMailNs: true });
  const history = state.receipts
    .filter((receipt) => receipt.kind === "dns_record" && receipt.type === "NS")
    .map((receipt, index) => ({
      ...receipt,
      receiptId: rid(30 + index),
      observedAt: "2026-08-29T11:00:00.000Z",
    }));
  return { ...state, receipts: [...history, ...state.receipts] };
}

function domains() {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    operationId: parseUlid("00000000000000000000000009"),
    handle: "calm-otter-waves",
    zoneName: "omh.st" as const,
    productionDomain: "calm-otter-waves.dev.check.omh.st",
    developmentDomain: "dev-calm-otter-waves.dev.check.omh.st",
    mailDomain: "calm-otter-waves.mail.aixyte.com",
    configuredByPrincipalId: "user:user_1",
    configuredAt: NOW,
    deletedAt: null,
  };
}

function receipts() {
  const common = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, observedAt: NOW };
  return [
    {
      ...common,
      receiptId: rid(1),
      kind: "dns_record" as const,
      providerResourceId: "1".repeat(32),
      zoneId: "a".repeat(32),
      zoneName: "omh.st" as const,
      type: "CNAME" as const,
      name: "dev-calm-otter-waves.dev.check.omh.st",
      content: "dev.check.omh.st",
      ttl: 1,
      proxied: true as const,
      comment: `ohmyhost:${PROJECT_ID}:domains:v1`,
    },
    {
      ...common,
      receiptId: rid(2),
      kind: "dns_record" as const,
      providerResourceId: "2".repeat(32),
      zoneId: "a".repeat(32),
      zoneName: "omh.st" as const,
      type: "CNAME" as const,
      name: "calm-otter-waves.dev.check.omh.st",
      content: "dev.check.omh.st",
      ttl: 1,
      proxied: true as const,
      comment: `ohmyhost:${PROJECT_ID}:domains:v1`,
    },
    route(common, "dev", 3, "d".repeat(32), "dev-calm-otter-waves"),
    route(common, "prod", 4, "e".repeat(32), "calm-otter-waves"),
  ];
}

function route(
  common: ReceiptCommon,
  environmentName: "dev" | "prod",
  id: number,
  providerResourceId: string,
  script: string,
) {
  const hostname =
    environmentName === "dev"
      ? "dev-calm-otter-waves.dev.check.omh.st"
      : "calm-otter-waves.dev.check.omh.st";
  return {
    ...common,
    receiptId: rid(id),
    kind: "worker_route" as const,
    environmentName,
    providerResourceId,
    zoneId: "a".repeat(32),
    pattern: `${hostname}/*`,
    script,
  };
}
function hostname(
  common: ReceiptCommon,
  environmentName: "dev" | "prod",
  id: number,
  providerResourceId: string,
  value: string,
) {
  return {
    ...common,
    receiptId: rid(id),
    kind: "custom_hostname" as const,
    environmentName,
    providerResourceId,
    hostname: value,
    status: "active" as const,
    providerCreatedAt: NOW,
    ownershipVerification: {
      type: "txt" as const,
      name: `_cf-custom-hostname.${value}`,
      value: `ownership-${environmentName}`,
    },
    ownershipVerificationHttp: null,
    verificationErrors: [],
  };
}
function rid(value: number) {
  return parseUlid(String(value + 10).padStart(26, "0"));
}
