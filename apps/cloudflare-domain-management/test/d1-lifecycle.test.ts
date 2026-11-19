import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUlidFactory, SystemEntropy, parseUlid } from "@ohmyhost/platform";
import { CloudflareDomainRuntime } from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { bytes } from "../../control-store/test/support/platform-fixtures.js";
import { seam } from "../../control-store/test/support/wire.js";
import { createCloudflareDomainReconciliation } from "../src/reconciliation.js";
import {
  CloudflareProjectDeletionConflictError,
  createCloudflareProjectDeletion,
  openDeletionDnsAccess,
  openDeletionHostnameDnsAccess,
} from "../src/project-deletion.js";
import { createD1CloudflareDomainReconciliationPersistence } from "../src/d1-reconciliation.js";
import { createD1CloudflareProjectDeletionPersistence } from "../src/d1-project-deletion.js";
import { clock, deletingProject, iso, secrets } from "./support/cloudflare-core.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 60_000);
afterAll(async () => control.dispose());

/** The Cloudflare provider boundary of a project deletion. */
function providers(options: { failRevoke?: number; observe?: "revoked" | "active" } = {}) {
  const calls: string[] = [];
  let revokeFailures = options.failRevoke ?? 0;
  const tokens = (n: number) => ({
    accessToken: `fixture-rotated-access-${n}`,
    refreshToken: `fixture-rotated-refresh-${n}`,
    expiresInSeconds: 3600,
    scopes: ["dns.write", "zone.read"] as ["dns.write", "zone.read"],
  });
  return {
    calls,
    providers: {
      oauth: {
        refreshAccessToken: async () => {
          calls.push("refresh");
          return tokens(1);
        },
        revokeRefreshToken: async (token: string) => {
          calls.push(`revoke:${token}`);
          if (revokeFailures-- > 0) throw new Error("revocation response lost");
        },
        observeRefreshToken: async () => {
          calls.push("observe");
          return options.observe === "active"
            ? ({ state: "active", tokens: tokens(2) } as const)
            : ({ state: "revoked" } as const);
        },
      },
      dns: {
        deleteRecords: async (_token: string, request: { records: readonly { id: string }[] }) => {
          calls.push("customer-dns");
          return { status: "deleted" as const, recordIds: request.records.map(({ id }) => id) };
        },
      },
      platformDns: {
        deleteRecords: async (request: { records: readonly { id: string }[] }) => {
          calls.push("platform-dns");
          return { status: "deleted" as const, recordIds: request.records.map(({ id }) => id) };
        },
      },
      platformRoutes: {
        deleteRoute: async (receipt: { routeId: string; pattern: string }) => {
          calls.push("platform-route");
          return {
            outcome: "deleted" as const,
            routeId: receipt.routeId,
            pattern: receipt.pattern,
            observedAt: new Date(),
          };
        },
      },
    },
  };
}

describe("project deletion over the actual Core", () => {
  it("removes the platform records and route, revokes the customer grant once and finalizes", async () => {
    const f = await deletingProject(control, "delete-grant", { grant: "fresh" }),
      wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
      persistence = createD1CloudflareProjectDeletionPersistence(wire.binding as never),
      fake = providers(),
      deps = { clock, cipher: secrets.tokenCipher, persistence, providers: fake.providers },
      deletion = createCloudflareProjectDeletion(deps);

    // The deletion's own DNS access reads the same grant: absent outside its zone, ready inside it.
    expect(await openDeletionHostnameDnsAccess(deps, f.request, "other.example")).toEqual({
      status: "absent",
    });
    expect(
      await openDeletionHostnameDnsAccess(deps, f.request, `${f.handle}.example.test`),
    ).toMatchObject({
      status: "ready",
      accessToken: "fixture-access-token-1",
      zoneName: "example.test",
    });
    expect(await openDeletionDnsAccess(deps, f.request)).toMatchObject({
      zoneName: "example.test",
    });

    const result = await deletion.deleteProject(f.request);
    expect(result).toMatchObject({ outcome: "deleted", oauthGrant: "revoked" });
    expect(result.receipts).toHaveLength(2);
    expect(fake.calls).toEqual([
      "platform-dns",
      "platform-route",
      "revoke:fixture-refresh-token-1",
    ]);
    // The state after the revocation: confirmed once, grant revoked, domains retired; a replay is a no-op.
    const after = await persistence.read(f.request);
    expect(after).toMatchObject({
      grant: { status: "revoked" },
      revocation: { state: "confirmed", authorizationId: f.authorizationId },
      domains: { deletedAt: expect.any(String) },
    });
    expect(after?.revocation?.refreshTokenSha256).toHaveLength(32);
    expect(await deletion.deleteProject(f.request)).toMatchObject({
      outcome: "absent",
      oauthGrant: "revoked",
    });
    expect(fake.calls).toHaveLength(3);
    await expect(openDeletionDnsAccess(deps, f.request)).rejects.toBeInstanceOf(
      CloudflareProjectDeletionConflictError,
    );
  });

  it("finishes a platform-only deletion and refuses one that still owns custom hostnames", async () => {
    const platformOnly = await deletingProject(control, "delete-platform"),
      persistence = createD1CloudflareProjectDeletionPersistence(
        new CloudflareDomainRuntime({} as never, control.bindings as never) as never,
      ),
      fake = providers(),
      deletion = createCloudflareProjectDeletion({
        clock,
        cipher: secrets.tokenCipher,
        persistence,
        providers: fake.providers,
      });
    expect(await deletion.deleteProject(platformOnly.request)).toMatchObject({
      outcome: "deleted",
      oauthGrant: "absent",
    });
    expect(fake.calls).toEqual(["platform-dns", "platform-route"]);

    const hosted = await deletingProject(control, "delete-hosted", { customHostname: true });
    expect(await persistence.read(hosted.request)).toMatchObject({
      customHostnameDeleteTargets: [
        {
          environmentName: "prod",
          hostname: hosted.production,
          customHostnameId: expect.any(String),
        },
      ],
      receipts: expect.arrayContaining([
        expect.objectContaining({ kind: "custom_hostname", providerCreatedAt: expect.any(Date) }),
      ]),
    });
    await expect(
      createCloudflareProjectDeletion({
        clock,
        cipher: secrets.tokenCipher,
        persistence,
        providers: fake.providers,
      }).deleteProject(hosted.request),
    ).rejects.toBeInstanceOf(CloudflareProjectDeletionConflictError);
    expect(
      await persistence.read({ ...hosted.request, operationId: parseUlid(newUlid()) }),
    ).toBeNull();
  });

  it("recovers an unconfirmed revocation by readback and restarts it on the rotated token", async () => {
    const f = await deletingProject(control, "delete-readback", {
        grant: "stale",
        receipts: false,
      }),
      persistence = createD1CloudflareProjectDeletionPersistence(
        new CloudflareDomainRuntime({} as never, control.bindings as never) as never,
      ),
      fake = providers({ failRevoke: 2, observe: "active" }),
      deps = { clock, cipher: secrets.tokenCipher, persistence, providers: fake.providers };
    // A stale access token is renewed through the deletion-authorized rotation before any DNS use.
    expect(await openDeletionDnsAccess(deps, f.request)).toMatchObject({
      accessToken: "fixture-rotated-access-1",
    });
    expect(fake.calls).toEqual(["refresh"]);
    // The provider answered the first revocation badly: readback finds the token active, rotates and revokes again.
    await expect(createCloudflareProjectDeletion(deps).deleteProject(f.request)).rejects.toThrow(
      "Cloudflare project deletion is unavailable",
    );
    expect(fake.calls.slice(1)).toEqual([
      "revoke:fixture-rotated-refresh-1",
      "observe",
      "revoke:fixture-rotated-refresh-2",
    ]);
    expect((await persistence.read(f.request))?.revocation?.state).toBe("revoke_started");
    const retried = providers({ observe: "revoked" });
    expect(
      await createCloudflareProjectDeletion({
        ...deps,
        providers: retried.providers,
      }).deleteProject(f.request),
    ).toMatchObject({ outcome: "deleted", oauthGrant: "revoked" });
    expect(retried.calls).toEqual(["observe"]);
  });
});

describe("reconciliation reads and wire faults", () => {
  it("answers an unauthorized environment as unavailable and a missing grant as null", async () => {
    const wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
      persistence = createD1CloudflareDomainReconciliationPersistence(wire.binding as never),
      reconciliation = createCloudflareDomainReconciliation({
        clock,
        platform: {
          zoneId: "c".repeat(32),
          zoneName: "omh.st",
          trafficCnameTarget: "dev.check.omh.st",
        },
        persistence,
        providers: {} as never,
      }),
      ids = createUlidFactory({ clock, entropy: new SystemEntropy() }),
      request = {
        organizationId: parseUlid(newUlid()),
        projectId: parseUlid(newUlid()),
        environmentId: parseUlid(newUlid()),
        operationId: parseUlid(newUlid()),
        deploymentId: parseUlid(newUlid()),
        environmentName: "dev" as const,
        gatewayScriptName: "ohmyho-gateway-poc-private-fullstack",
        healthCheckPath: "/health",
      };
    expect(await persistence.read(request)).toBeNull();
    await expect(reconciliation.ensureEnvironment(request)).rejects.toThrow(
      "Cloudflare domain reconciliation is unavailable",
    );
    expect(
      await persistence.rotateGrant({
        organizationId: request.organizationId,
        projectId: request.projectId,
        authorizationId: parseUlid(ids.next()),
        expectedUpdatedAt: iso(0),
        accessCiphertext: bytes(32, 1),
        accessNonce: bytes(12, 2),
        refreshCiphertext: bytes(32, 3),
        refreshNonce: bytes(12, 4),
        keyVersion: 1,
        accessExpiresAt: iso(60_000),
        rotatedAt: iso(0),
      } as never),
    ).toBeNull();
  });

  it("refuses deletion answers that are not exactly what the Core states", async () => {
    const f = await deletingProject(control, "delete-wire", {
        grant: "fresh",
        customHostname: true,
      }),
      wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
      persistence = createD1CloudflareProjectDeletionPersistence(wire.binding as never),
      stored = (await persistence.read(f.request)) as unknown as Record<string, unknown>,
      wireState = (await new CloudflareDomainRuntime(
        {} as never,
        control.bindings as never,
      ).readDeletion(f.request)) as Record<string, unknown>,
      corrupt = async (patch: Record<string, unknown>) => {
        wire.reply("readDeletion", { ...wireState, ...patch });
        await persistence.read(f.request);
      };
    expect(stored).toMatchObject({ grant: { status: "active" } });
    for (const [patch, message] of [
      [{ organizationId: parseUlid(newUlid()) }, "Cloudflare deletion scope mismatch"],
      [{ receipts: "none" }, "Cloudflare deletion scope mismatch"],
      [{ receipts: [{ observedAt: 3 }] }, "Invalid Cloudflare receipt time"],
      [{ receipts: [{ observedAt: "never" }] }, "Invalid Cloudflare receipt time"],
      [{ revocation: { organizationId: "x" } }, "Invalid Cloudflare revocation scope"],
      [
        { customHostnameDeleteTargets: [{ environmentName: "qa" }] },
        "Invalid Cloudflare deletion target",
      ],
    ] as const)
      await expect(corrupt(patch)).rejects.toThrow(message);
    wire.reply("readDeletion", "state");
    await expect(persistence.read(f.request)).rejects.toThrow(
      "Invalid private Cloudflare deletion response",
    );
    wire.reply("readDeletion", {
      ...wireState,
      revocation: {
        organizationId: f.request.organizationId,
        projectId: f.request.projectId,
        operationId: f.request.operationId,
        authorizationId: f.authorizationId,
        refreshTokenSha256: "digest",
        state: "confirmed",
      },
    });
    await expect(persistence.read(f.request)).rejects.toThrow(
      "Invalid sealed Cloudflare revocation",
    );
    wire.reply("readDeletion", {
      ...wireState,
      revocation: {
        organizationId: f.request.organizationId,
        projectId: f.request.projectId,
        operationId: f.request.operationId,
        authorizationId: f.authorizationId,
        refreshTokenSha256: [1, 2, 3],
        state: "confirmed",
      },
    });
    expect((await persistence.read(f.request))?.revocation?.refreshTokenSha256).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
    wire.reply("prepareRevocation", "maybe");
    await expect(
      persistence.prepareRevocation({
        ...f.request,
        authorizationId: parseUlid(f.authorizationId),
        expectedGrantUpdatedAt: iso(0),
        refreshTokenSha256: bytes(32, 1),
        preparedAt: iso(0),
      }),
    ).rejects.toThrow("Invalid Cloudflare revocation decision");
    wire.restore();
    expect(await persistence.finalizeDeletion({ ...f.request, finalizedAt: iso(0) })).toBe(false);
    // Only the platform part may finish while the customer's grant has not been revoked.
    expect(await persistence.finalizePlatformDeletion({ ...f.request, finalizedAt: iso(0) })).toBe(
      true,
    );
  });
});
