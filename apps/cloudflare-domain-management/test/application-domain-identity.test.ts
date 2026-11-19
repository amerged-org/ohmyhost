import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { CloudflareCustomerDnsConflictError } from "@ohmyhost/provider-cloudflare";
import { createCloudflareDomainSecrets } from "../src/secrets.js";
import {
  aad,
  openToken,
  signedState,
  type Authorization,
} from "../src/scoped-dns-authorization.js";

import {
  createApplicationDomainIdentityRuntime,
  type ApplicationIdentityPersistence,
} from "../src/application-domain-identity.js";

const request = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  actorId: "user:owner",
  idempotencyKeySha256: `sha256:${"a".repeat(64)}`,
  requestSha256: `sha256:${"b".repeat(64)}`,
  expectedRevision: 1,
};
const delegation = {
  grantId: "6f1c1b0e-9f3a-4c53-8d57-3d5a9f0f3a11",
  grantRevision: 2,
  clientId: "client-1",
  consentHash: "c".repeat(64),
};

describe("application domain identity delegation", () => {
  it("preserves existing DNS signatures and sealed tokens while authority uses a converted proof", async () => {
    const custody = createCloudflareDomainSecrets({
      keyBase64: Buffer.alloc(32, 7).toString("base64"),
      keyVersion: 1,
      crypto: webcrypto as Crypto,
    });
    const original: Authorization = {
      organizationId: request.organizationId,
      purpose: "application_identity",
      resourceId: request.projectId,
      resourceRevision: 1,
      authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      principalId: request.actorId,
      zoneName: "example.com",
      idempotencyKeySha256: Buffer.alloc(32, 1),
      requestSha256: Buffer.alloc(32, 2),
      stateSha256: Buffer.alloc(32, 3),
      issuedAt: "2026-11-04T08:00:00.000Z",
      expiresAt: "2026-11-04T08:10:00.000Z",
      delegation,
    };
    const originalState = await signedState(original, custody.stateSigner);
    expect(originalState).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAX.Z7eOfSkWc315tDpblWSuP9531FoXgA3slWPuHwUsLL4",
    );
    const converted = {
      ...original,
      delegation: {
        ...delegation,
        grantId: "6f1c1b0e-9f3a-4c53-8d57-3d5a9f0f3a12",
        action: "projects:write" as const,
        authorizationRestriction: {
          projectIds: [request.projectId as import("@ohmyhost/platform").Ulid],
        },
      },
      signedDelegation: original.delegation,
    };
    expect(await signedState(converted, custody.stateSigner)).toBe(originalState);
    expect(
      await signedState({ ...original, delegation: converted.delegation }, custody.stateSigner),
    ).not.toBe(originalState);
    const largeRestriction = {
      ...converted.delegation,
      authorizationRestriction: {
        projectIds: Array.from(
          { length: 1000 },
          (_, index) => String(index).padStart(26, "0") as import("@ohmyhost/platform").Ulid,
        ),
      },
    };
    const largeState = await signedState(
      { ...original, delegation: largeRestriction },
      custody.stateSigner,
    );
    expect(largeState).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{43}$/u);
    expect(largeState).not.toBe(
      await signedState({ ...original, delegation: converted.delegation }, custody.stateSigner),
    );
    const sealed = await custody.tokenCipher.seal(
      "fixture-private-dns-token",
      `${aad(original)}:access`,
    );
    await expect(
      openToken(
        custody.tokenCipher,
        {
          ...converted,
          zoneId: "a".repeat(32),
          accountId: "b".repeat(32),
          accessCiphertext: Buffer.from(sealed.ciphertext, "base64"),
          accessNonce: Buffer.from(sealed.nonce, "base64"),
          refreshCiphertext: Buffer.from(sealed.ciphertext, "base64"),
          refreshNonce: Buffer.from(sealed.nonce, "base64"),
          keyVersion: sealed.keyVersion,
          accessExpiresAt: original.expiresAt,
          connectedAt: original.issuedAt,
          revokedAt: null,
          dnsReceipts: [],
        },
        "access",
      ),
    ).resolves.toBe("fixture-private-dns-token");
  });
  it("hands an exact MCP delegation to the persistence and refuses any other shape", async () => {
    const revoke = vi.fn(async () => ({ revoked: true }));
    const runtime = createApplicationDomainIdentityRuntime({
      persistence: { revoke } as unknown as ApplicationIdentityPersistence,
      clock: { now: () => new Date("2026-10-30T00:00:00.000Z") },
      observeTxt: async () => true,
      ensureChallenge: async () => undefined,
    });

    await runtime.revokeApplicationDomainIdentity({ ...request, delegation });
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ delegation }),
      1,
      expect.any(Function),
    );
    const restricted = {
      ...delegation,
      action: "projects:write",
      authorizationRestriction: {
        actions: ["projects:write"],
        organizationIds: [request.organizationId],
        projectIds: [request.projectId],
        mailDomainIds: [],
      },
    };
    await runtime.revokeApplicationDomainIdentity({ ...request, delegation: restricted });
    expect(revoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ delegation: restricted }),
      1,
      expect.any(Function),
    );
    for (const changed of [
      { ...delegation, grantId: "not-a-uuid" },
      { ...delegation, consentHash: "short" },
      { ...delegation, clientId: "client with space" },
      { ...delegation, grantRevision: 0 },
      { ...delegation, extra: true },
      { ...restricted, action: "operator:manage" },
      { ...restricted, authorizationRestriction: null },
      { ...restricted, authorizationRestriction: { actions: ["operator:manage"] } },
      { ...restricted, authorizationRestriction: { projectIds: ["foreign-not-an-id"] } },
      { ...restricted, authorizationRestriction: { unknown: [] } },
    ])
      await expect(
        runtime.revokeApplicationDomainIdentity({ ...request, delegation: changed }),
      ).rejects.toThrow(TypeError);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("verifies a published TXT even when the reconciliation of the grant refuses, and stays pending without it", async () => {
    const row = {
      hostname: "www.example.com",
      revision: 1,
      state: "pending",
      challengeName: "_omh-project.www.example.com",
      challengeValue: "omh-domain-v1=published",
    };
    const verify = vi.fn(async () => ({ status: "verified" as const, revision: 1 }));
    const persistence = {
      replay: async () => null,
      readForVerification: async () => row,
      verify,
    } as unknown as ApplicationIdentityPersistence;
    const refusal = () => {
      throw new CloudflareCustomerDnsConflictError();
    };
    const verifyWith = (observed: boolean) =>
      createApplicationDomainIdentityRuntime({
        persistence,
        clock: { now: () => new Date("2026-10-30T00:00:00.000Z") },
        observeTxt: async () => observed,
        ensureChallenge: async () => refusal(),
      }).verifyApplicationDomainIdentity(request);

    // A hand-published TXT makes the grant's reconciliation refuse, but the TXT itself is the proof.
    await expect(verifyWith(true)).resolves.toEqual({ status: "verified", revision: 1 });
    expect(verify).toHaveBeenCalledTimes(1);
    await expect(verifyWith(false)).resolves.toEqual({
      status: "conflict",
      code: "application_identity_dns_pending",
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("fails the verification on a reconciliation error that is neither a provider nor a persistence refusal, and logs it", async () => {
    const row = {
      hostname: "www.example.com",
      revision: 1,
      state: "pending",
      challengeName: "_omh-project.www.example.com",
      challengeValue: "omh-domain-v1=published",
    };
    const verify = vi.fn(async () => ({ status: "verified" as const, revision: 1 }));
    const persistence = {
      replay: async () => null,
      readForVerification: async () => row,
      verify,
    } as unknown as ApplicationIdentityPersistence;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const runtime = createApplicationDomainIdentityRuntime({
        persistence,
        clock: { now: () => new Date("2026-10-30T00:00:00.000Z") },
        observeTxt: async () => true,
        ensureChallenge: async () => {
          throw new TypeError("sealed grant token cannot be opened");
        },
      });

      // Only provider and persistence refusals are superseded by the public TXT; any other failure is not verified over.
      await expect(runtime.verifyApplicationDomainIdentity(request)).rejects.toThrow(TypeError);
      expect(verify).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(
        JSON.stringify({
          event: "application_identity_reconcile_failed",
          organizationId: request.organizationId,
          projectId: request.projectId,
          error: "TypeError",
        }),
      );
    } finally {
      logged.mockRestore();
    }
  });
});
