import { describe, expect, it, vi } from "vitest";

import { createPaidDomainRuntime, PaidDomainHostnameUnprovenError } from "../src/paid-domains.js";

const scope = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  actorId: "user:user_1",
};
const digest = `sha256:${"a".repeat(64)}`;

/** The hostname's proof is live and verified: the cases above decide the connection, not the ownership challenge. */
const liveProof = {
  ensureProof: async () => ({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    hostname: "poc.tenant-fixture.com",
    state: "verified",
    challengeName: "_omh-project.poc.tenant-fixture.com",
    challengeValue: `omh-domain-v1=${"a".repeat(43)}`,
    declaredAt: "2026-09-04T20:00:00.000Z",
    verifiedAt: "2026-09-04T20:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
  }),
  readProof: async () => null,
  verifyProof: async () => null,
};
const createRuntime = (
  input: Omit<Parameters<typeof createPaidDomainRuntime>[0], "observeTxt"> & {
    readonly observeTxt?: (name: string, value: string) => Promise<boolean>;
  },
) =>
  createPaidDomainRuntime({
    observeTxt: async () => false,
    ...input,
    persistence: { ...liveProof, ...input.persistence } as never,
  });

describe("Paid project domains", () => {
  it.each(["customers.omh.st", "customers.ohmyho.st"] as const)(
    "plans, applies, observes and deletes a Paid hostname through %s",
    async (cnameTarget) => {
      const customReceipt = {
        customHostnameId: "0542a4b1673d4486ae136036ef941193",
        hostname: "poc.tenant-fixture.com",
        customerCnameTarget: cnameTarget,
        status: "pending",
        ready: false,
        providerCreatedAt: "2026-09-04T20:00:00.000Z",
        ownershipVerification: null,
        ownershipVerificationHttp: null,
        verificationErrors: [],
        ssl: { status: "pending_validation" },
        dnsRecords: [
          {
            type: "CNAME",
            name: "poc.tenant-fixture.com",
            content: cnameTarget,
            purpose: "traffic",
          },
          {
            type: "TXT",
            name: "_acme-challenge.poc.tenant-fixture.com",
            content: "acme-value",
            purpose: "ssl",
          },
        ],
        observedAt: new Date("2026-09-04T20:00:00.000Z"),
      };
      const routeReceipt = {
        routeId: "1234567890abcdef1234567890abcdef",
        hostname: "poc.tenant-fixture.com",
        scriptName: "ohmyho-gateway-production",
        pattern: "poc.tenant-fixture.com/*",
        observedAt: new Date("2026-09-04T20:00:00.000Z"),
      };
      let stored: Record<string, unknown> | null = null;
      let paid = false;
      const persistence = {
        accessReason: async () => (paid ? null : "paid_plan_required"),
        readTarget: vi.fn(
          async (): Promise<
            { gatewayScriptName: string } | "production_deployment_required" | null
          > => ({ gatewayScriptName: "ohmyho-gateway-production" }),
        ),
        claimApply: vi.fn(async (input: Record<string, unknown>) => {
          stored ??= {
            ...input,
            state: input["gatewayScriptName"] === null ? "awaiting_deployment" : "pending",
            customHostnameReceipt: null,
            workerRouteReceipt: null,
            hostnameProven: true,
          };
          if (stored["state"] === "awaiting_deployment" && input["gatewayScriptName"] !== null)
            stored = { ...stored, gatewayScriptName: input["gatewayScriptName"], state: "pending" };
          return stored;
        }),
        putActive: vi.fn(async (input: Record<string, unknown>) => {
          stored = { ...input, state: "active", hostnameProven: true };
          return stored;
        }),
        read: vi.fn(async () => stored),
        claimDelete: vi.fn(async () => ({ ...stored, state: "deleting" })),
        markDeleted: vi.fn(async () => undefined),
      };
      const routes = {
        createRoute: vi.fn(async () => ({ outcome: "created", receipt: routeReceipt })),
        observeRoute: vi.fn(async () => ({ state: "found", ...routeReceipt })),
        deleteRoute: vi.fn(async () => ({ outcome: "deleted" })),
      };
      const customHostnames = {
        createHostname: vi.fn(async () => ({ outcome: "created", receipt: customReceipt })),
        observeHostname: vi.fn(async () => ({
          state: "found",
          ...customReceipt,
          status: "active",
          ready: true,
          ssl: { status: "active" },
        })),
        deleteHostname: vi.fn(async () => ({ outcome: "deleted" })),
      };
      const customerDns = {
        loadAccess: vi.fn(async () => ({
          status: "ready" as const,
          accessToken: "customer-access-token",
          zoneId: "a".repeat(32),
          zoneName: "tenant-fixture.com",
        })),
        reconcileRecords: vi.fn(
          async (_accessToken: string, input: { records: Record<string, unknown>[] }) => ({
            records: input.records.map((record, index) => ({
              id: String(index + 1).repeat(32),
              ...record,
            })),
          }),
        ),
        deleteRecords: vi.fn(async () => ({ status: "deleted" })),
      };
      const runtime = createRuntime({
        cnameTarget,
        clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
        persistence: persistence as never,
        routes: routes as never,
        customHostnames: customHostnames as never,
        customerDns: customerDns as never,
        synchronizeNativePolicy: async () => {},
        recoverNativePolicy: async () => {},
      });

      await expect(runtime.getPaidDomain(scope)).resolves.toMatchObject({
        status: "not_configured",
        hostname: null,
        url: null,
      });
      const apply = () =>
        runtime.applyPaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        });
      persistence.readTarget.mockResolvedValue("production_deployment_required");
      await expect(
        runtime.planPaidDomain({ ...scope, hostname: "poc.tenant-fixture.com" }),
      ).resolves.toMatchObject({ status: "planned" });
      // Apply keeps the Paid check first, then saves only the intent without provider effects.
      await expect(apply()).rejects.toMatchObject({ code: "paid_plan_required" });
      paid = true;
      await expect(apply()).resolves.toMatchObject({
        status: "awaiting_deployment",
        hostname: "poc.tenant-fixture.com",
        url: null,
        sslStatus: null,
        customHostnameStatus: null,
        validationRecords: [],
      });
      await expect(runtime.getPaidDomain(scope)).resolves.toMatchObject({
        status: "awaiting_deployment",
      });
      await expect(apply()).resolves.toMatchObject({ status: "awaiting_deployment" });
      persistence.readTarget.mockResolvedValue(null);
      await expect(
        runtime.planPaidDomain({ ...scope, hostname: "poc.tenant-fixture.com" }),
      ).rejects.toThrow("Paid domain target is unavailable");
      await expect(apply()).rejects.toThrow("Paid domain target is unavailable");
      expect(persistence.claimApply).toHaveBeenCalledTimes(2);
      expect(routes.createRoute).not.toHaveBeenCalled();
      expect(customHostnames.createHostname).not.toHaveBeenCalled();
      expect(customerDns.reconcileRecords).not.toHaveBeenCalled();
      persistence.readTarget.mockResolvedValue({ gatewayScriptName: "ohmyho-gateway-production" });
      paid = false;
      await expect(
        runtime.planPaidDomain({ ...scope, hostname: "poc.tenant-fixture.com" }),
      ).resolves.toMatchObject({
        status: "planned",
        cnameTarget,
        effects: expect.arrayContaining([expect.stringContaining("healthy Prod deployment")]),
      });
      await expect(
        runtime.applyPaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        }),
      ).rejects.toMatchObject({ code: "paid_plan_required" });
      expect(routes.createRoute).not.toHaveBeenCalled();
      expect(customHostnames.createHostname).not.toHaveBeenCalled();
      paid = true;
      await expect(
        runtime.applyPaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        }),
      ).resolves.toMatchObject({ status: "pending", hostname: "poc.tenant-fixture.com" });
      expect(customerDns.reconcileRecords).toHaveBeenCalledWith(
        "customer-access-token",
        expect.objectContaining({
          zoneId: "a".repeat(32),
          zoneName: "tenant-fixture.com",
          records: [
            expect.objectContaining({
              type: "CNAME",
              name: "poc.tenant-fixture.com",
              content: cnameTarget,
              proxied: false,
            }),
            expect.objectContaining({
              type: "TXT",
              name: "_acme-challenge.poc.tenant-fixture.com",
              content: "acme-value",
            }),
          ],
        }),
        { replaceTrafficHostname: "poc.tenant-fixture.com" },
      );
      expect(persistence.putActive.mock.invocationCallOrder[0]).toBeLessThan(
        customerDns.reconcileRecords.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(customerDns.loadAccess.mock.invocationCallOrder[0]).toBeLessThan(
        customerDns.reconcileRecords.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(routes.createRoute.mock.invocationCallOrder[0]).toBeLessThan(
        customHostnames.createHostname.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      paid = false; // Losing Paid does not turn a status read into resource deletion.
      await expect(runtime.getPaidDomain(scope)).resolves.toMatchObject({
        status: "suspended",
        suspensionReason: "paid_plan_required",
        url: null,
      });
      const current = await persistence.read();
      if (current === null) throw new Error("Expected the persisted Paid domain");
      stored = {
        ...current,
        customHostnameReceipt: {
          ...customReceipt,
          customerCnameTarget: "customers.poc.aixyte.com",
        },
      };
      await expect(runtime.getPaidDomain(scope)).rejects.toThrow(
        "requires the current SaaS target",
      );
      await expect(
        runtime.deletePaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        }),
      ).rejects.toThrow("requires the current SaaS target");
      expect(persistence.claimDelete).not.toHaveBeenCalled();
      expect(routes.deleteRoute).not.toHaveBeenCalled();
      expect(customHostnames.deleteHostname).not.toHaveBeenCalled();
      stored = current;
      await expect(
        runtime.deletePaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        }),
      ).resolves.toMatchObject({ status: "deleted", url: null });
      expect(customerDns.deleteRecords).toHaveBeenCalledOnce();
      expect(customerDns.reconcileRecords).toHaveBeenLastCalledWith(
        "customer-access-token",
        expect.objectContaining({ zoneName: "tenant-fixture.com" }),
        { observeOnly: true },
      );
      expect(customerDns.deleteRecords.mock.invocationCallOrder[0]).toBeLessThan(
        routes.deleteRoute.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(routes.deleteRoute.mock.invocationCallOrder[0]).toBeLessThan(
        customHostnames.deleteHostname.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      stored = {
        ...current,
        state: "deleted",
        customHostnameReceipt: {
          ...customReceipt,
          customerCnameTarget: "customers.poc.aixyte.com",
        },
      };
      persistence.claimDelete.mockResolvedValueOnce({ ...stored, state: "deleted" });
      await expect(
        runtime.deletePaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        }),
      ).resolves.toMatchObject({ status: "deleted", hostname: null, cnameTarget, url: null });
      expect(customerDns.deleteRecords).toHaveBeenCalledOnce();
      expect(routes.deleteRoute).toHaveBeenCalledOnce();
      expect(customHostnames.deleteHostname).toHaveBeenCalledOnce();
      // An apply that never stored its receipts may still have created the route or the custom
      // hostname: its deletion removes whatever exists for that exact hostname, and its replay
      // finds nothing left. It never wrote customer DNS, so none is touched.
      const unrecorded = {
        ...current,
        state: "deleting",
        customHostnameReceipt: null,
        workerRouteReceipt: null,
      };
      const deletePending = () =>
        runtime.deletePaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        });
      persistence.claimDelete.mockResolvedValueOnce(unrecorded);
      await expect(deletePending()).resolves.toMatchObject({
        status: "deleted",
        hostname: "poc.tenant-fixture.com",
        url: null,
      });
      expect(routes.observeRoute).toHaveBeenLastCalledWith({
        hostname: "poc.tenant-fixture.com",
        scriptName: "ohmyho-gateway-production",
      });
      expect(routes.deleteRoute).toHaveBeenLastCalledWith(
        expect.objectContaining({ routeId: routeReceipt.routeId, pattern: routeReceipt.pattern }),
      );
      expect(customHostnames.observeHostname).toHaveBeenLastCalledWith({
        hostname: "poc.tenant-fixture.com",
        customerCnameTarget: cnameTarget,
      });
      expect(customHostnames.deleteHostname).toHaveBeenLastCalledWith(
        expect.objectContaining({ customHostnameId: customReceipt.customHostnameId }),
      );
      expect(persistence.markDeleted).toHaveBeenLastCalledWith(
        expect.objectContaining({ hostname: "poc.tenant-fixture.com" }),
      );
      persistence.claimDelete.mockResolvedValueOnce(unrecorded);
      routes.observeRoute.mockResolvedValueOnce({ state: "absent" } as never);
      customHostnames.observeHostname.mockResolvedValueOnce({ state: "absent" } as never);
      await expect(deletePending()).resolves.toMatchObject({ status: "deleted" });
      expect(routes.deleteRoute).toHaveBeenCalledTimes(2);
      expect(customHostnames.deleteHostname).toHaveBeenCalledTimes(2);
      expect(persistence.markDeleted).toHaveBeenCalledTimes(3);
      expect(customerDns.deleteRecords).toHaveBeenCalledOnce();
      await expect(
        runtime.planPaidDomain({ ...scope, hostname: "own.poc.aixyte.com" }),
      ).rejects.toThrow("hostname is invalid");
      // A customer may already have removed or recreated all DNS records without our marker.
      // Cleanup observes an empty owned set and never creates records merely to delete them.
      stored = current;
      const emptyDns = {
        ...customerDns,
        reconcileRecords: vi.fn(async () => ({ records: [] })),
        deleteRecords: vi.fn(),
      };
      const cleanupRuntime = createRuntime({
        cnameTarget,
        clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
        persistence: persistence as never,
        routes: routes as never,
        customHostnames: customHostnames as never,
        customerDns: emptyDns,
        synchronizeNativePolicy: async () => {},
        recoverNativePolicy: async () => {},
      });
      await expect(
        cleanupRuntime.deletePaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        }),
      ).resolves.toMatchObject({ status: "deleted" });
      expect(emptyDns.reconcileRecords).toHaveBeenCalledWith(
        "customer-access-token",
        expect.anything(),
        { observeOnly: true },
      );
      expect(emptyDns.deleteRecords).not.toHaveBeenCalled();
    },
  );

  it("moves an active Paid hostname from its legacy project gateway to the shared gateway in place", async () => {
    const cnameTarget = "customers.omh.st";
    const legacy = `g-p-${scope.projectId.toLowerCase()}-prod`;
    const customHostnameReceipt = {
      customHostnameId: "0542a4b1673d4486ae136036ef941193",
      hostname: "poc.tenant-fixture.com",
      customerCnameTarget: cnameTarget,
      status: "active",
      ready: true,
      ssl: { status: "active" },
      dnsRecords: [
        { type: "CNAME", name: "poc.tenant-fixture.com", content: cnameTarget, purpose: "traffic" },
      ],
      observedAt: new Date("2026-09-22T00:00:00.000Z"),
    };
    const legacyRoute = {
      routeId: "1234567890abcdef1234567890abcdef",
      hostname: "poc.tenant-fixture.com",
      scriptName: legacy,
      pattern: "poc.tenant-fixture.com/*",
      observedAt: new Date("2026-09-22T00:00:00.000Z"),
    };
    const sharedRoute = { ...legacyRoute, scriptName: "ohmyho-gateway-production" };
    let stored: Record<string, unknown> = {
      ...scope,
      hostname: "poc.tenant-fixture.com",
      gatewayScriptName: legacy,
      state: "active",
      customHostnameReceipt,
      workerRouteReceipt: legacyRoute,
    };
    const persistence = {
      accessReason: async () => null,
      readTarget: vi.fn(async () => ({ gatewayScriptName: "ohmyho-gateway-production" })),
      // The durable claim keeps both receipts and changes only the target gateway.
      claimApply: vi.fn(async (input: Record<string, unknown>) => {
        stored = { ...stored, gatewayScriptName: input["gatewayScriptName"] };
        return { ...stored, gatewayRetarget, hostnameProven: true };
      }),
      putActive: vi.fn(async (input: Record<string, unknown>) => {
        stored = { ...input, state: "active", hostnameProven: true };
        return stored;
      }),
      read: vi.fn(async () => stored),
      claimDelete: vi.fn(),
      markDeleted: vi.fn(),
    };
    const routes = {
      createRoute: vi.fn(async () => ({ outcome: "existing", receipt: sharedRoute })),
      retargetRoute: vi.fn(async () => ({ outcome: "updated", receipt: sharedRoute })),
      observeRoute: vi.fn(async () => ({ state: "found", ...sharedRoute })),
      deleteRoute: vi.fn(),
    };
    const customHostnames = {
      createHostname: vi.fn(async () => ({ outcome: "existing", receipt: customHostnameReceipt })),
      observeHostname: vi.fn(async () => ({ state: "found", ...customHostnameReceipt })),
      deleteHostname: vi.fn(),
    };
    // Like amerged.com: a live grant whose zone holds records ohmyho.st does not own, so a DNS
    // reconcile would refuse. A pure gateway move must never get that far.
    let gatewayRetarget = true;
    const customerDns = {
      loadAccess: vi.fn(async () => ({
        status: "ready" as const,
        accessToken: "customer-access-token",
        zoneId: "a".repeat(32),
        zoneName: "tenant-fixture.com",
      })),
      reconcileRecords: vi.fn(async () => {
        throw new Error("Customer DNS records conflict with foreign records");
      }),
      deleteRecords: vi.fn(),
    };
    const runtime = createRuntime({
      cnameTarget,
      clock: { now: () => new Date("2026-09-25T00:00:00.000Z") },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
      customerDns: customerDns as never,
    });
    const apply = () =>
      runtime.applyPaidDomain({
        ...scope,
        hostname: "poc.tenant-fixture.com",
        idempotencyKeySha256: `sha256:${"f".repeat(64)}`,
        requestSha256: digest,
      });

    await expect(apply()).resolves.toMatchObject({
      status: "active",
      hostname: "poc.tenant-fixture.com",
    });
    expect(routes.retargetRoute).toHaveBeenCalledExactlyOnceWith(
      legacyRoute,
      "ohmyho-gateway-production",
    );
    expect(routes.createRoute).not.toHaveBeenCalled();
    expect(persistence.putActive).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayScriptName: "ohmyho-gateway-production",
        workerRouteReceipt: sharedRoute,
        customHostnameReceipt,
      }),
    );
    // The certificate, custom hostname and customer DNS stay; nothing is torn down.
    for (const removal of [
      routes.deleteRoute,
      customHostnames.deleteHostname,
      customerDns.deleteRecords,
      persistence.claimDelete,
    ])
      expect(removal).not.toHaveBeenCalled();
    // A replay after the move finds the shared route and does not rewrite it again.
    await expect(apply()).resolves.toMatchObject({ status: "active" });
    expect(routes.retargetRoute).toHaveBeenCalledOnce();
    expect(routes.createRoute).toHaveBeenCalledOnce();
    // Neither the move nor its replay reads, refreshes or writes customer DNS.
    expect(customerDns.loadAccess).not.toHaveBeenCalled();
    expect(customerDns.reconcileRecords).not.toHaveBeenCalled();
    // An ordinary setup retry of the same shape still reconciles customer DNS.
    gatewayRetarget = false;
    await expect(apply()).rejects.toThrow("conflict with foreign records");
    expect(customerDns.loadAccess).toHaveBeenCalledOnce();
    expect(customerDns.reconcileRecords).toHaveBeenCalledOnce();
    expect(customerDns.deleteRecords).not.toHaveBeenCalled();
  });

  it("creates no route or custom hostname for a hostname without a verified project proof", async () => {
    const routeReceipt = {
      routeId: "1".repeat(32),
      hostname: "poc.tenant-fixture.com",
      scriptName: "ohmyho-gateway-production",
      pattern: "poc.tenant-fixture.com/*",
      observedAt: new Date("2026-09-04T20:00:00.000Z"),
    };
    const customReceipt = {
      customHostnameId: "2".repeat(32),
      hostname: "poc.tenant-fixture.com",
      customerCnameTarget: "customers.omh.st",
      status: "pending",
      ready: false,
      providerCreatedAt: "2026-09-04T20:00:00.000Z",
      ownershipVerification: null,
      ownershipVerificationHttp: null,
      verificationErrors: [],
      ssl: { status: "pending_validation" },
      dnsRecords: [],
      observedAt: new Date("2026-09-04T20:00:00.000Z"),
    };
    const routes = {
      createRoute: vi.fn(async () => ({ outcome: "created", receipt: routeReceipt })),
      retargetRoute: vi.fn(),
      observeRoute: vi.fn(),
      deleteRoute: vi.fn(),
    };
    const customHostnames = {
      createHostname: vi.fn(async () => ({ outcome: "created", receipt: customReceipt })),
      observeHostname: vi.fn(),
      deleteHostname: vi.fn(),
    };
    const persistence = {
      accessReason: async () => null,
      readTarget: async () => ({ gatewayScriptName: "ohmyho-gateway-production" }),
      claimApply: vi.fn(async (input: Record<string, unknown>) => ({
        ...input,
        state: "pending",
        customHostnameReceipt: null,
        workerRouteReceipt: null,
        gatewayRetarget: false,
        hostnameProven: false,
      })),
      putActive: vi.fn(async (input: Record<string, unknown>) => ({ ...input, state: "active" })),
      read: vi.fn(async () => null),
      claimDelete: vi.fn(),
      markDeleted: vi.fn(async () => undefined),
      claimProjectDeletion: vi.fn(),
    };
    const runtime = createRuntime({
      cnameTarget: "customers.omh.st",
      clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
    });

    await expect(
      runtime.applyPaidDomain({
        ...scope,
        hostname: "poc.tenant-fixture.com",
        idempotencyKeySha256: digest,
        requestSha256: digest,
      }),
    ).rejects.toBeInstanceOf(PaidDomainHostnameUnprovenError);
    expect(routes.createRoute).not.toHaveBeenCalled();
    expect(routes.retargetRoute).not.toHaveBeenCalled();
    expect(customHostnames.createHostname).not.toHaveBeenCalled();
  });

  it("deletes an unproven reservation without observing or removing provider objects of the hostname", async () => {
    const routes = {
      createRoute: vi.fn(),
      retargetRoute: vi.fn(),
      observeRoute: vi.fn(async () => ({ state: "found", routeId: "f".repeat(32) })),
      deleteRoute: vi.fn(async () => ({ outcome: "deleted" })),
    };
    const customHostnames = {
      createHostname: vi.fn(),
      observeHostname: vi.fn(async () => ({ state: "found", customHostnameId: "f".repeat(32) })),
      deleteHostname: vi.fn(async () => ({ outcome: "deleted" })),
    };
    const stored = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      hostname: "poc.tenant-fixture.com",
      gatewayScriptName: "ohmyho-gateway-production",
      state: "pending",
      customHostnameReceipt: null,
      workerRouteReceipt: null,
      hostnameProven: false,
    };
    const persistence = {
      accessReason: async () => null,
      readTarget: async () => ({ gatewayScriptName: "ohmyho-gateway-production" }),
      claimApply: vi.fn(),
      putActive: vi.fn(),
      read: vi.fn(async () => stored),
      claimDelete: vi.fn(async () => ({ ...stored, state: "deleting" })),
      markDeleted: vi.fn(async () => undefined),
      claimProjectDeletion: vi.fn(),
    };
    const runtime = createRuntime({
      cnameTarget: "customers.omh.st",
      clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
    });

    await runtime.deletePaidDomain({
      ...scope,
      hostname: "poc.tenant-fixture.com",
      idempotencyKeySha256: digest,
      requestSha256: digest,
    });
    expect(routes.observeRoute).not.toHaveBeenCalled();
    expect(routes.deleteRoute).not.toHaveBeenCalled();
    expect(customHostnames.observeHostname).not.toHaveBeenCalled();
    expect(customHostnames.deleteHostname).not.toHaveBeenCalled();
    expect(persistence.markDeleted).toHaveBeenCalledOnce();
  });

  it("answers reconciliation_required and writes no customer record while the owner's DNS authority is missing", async () => {
    const routeReceipt = {
      routeId: "3".repeat(32),
      hostname: "poc.tenant-fixture.com",
      scriptName: "ohmyho-gateway-production",
      pattern: "poc.tenant-fixture.com/*",
      observedAt: new Date("2026-09-04T20:00:00.000Z"),
    };
    const customReceipt = {
      customHostnameId: "4".repeat(32),
      hostname: "poc.tenant-fixture.com",
      customerCnameTarget: "customers.omh.st",
      status: "pending",
      ready: false,
      providerCreatedAt: "2026-09-04T20:00:00.000Z",
      ownershipVerification: null,
      ownershipVerificationHttp: null,
      verificationErrors: [],
      ssl: { status: "pending_validation" },
      dnsRecords: [
        {
          type: "CNAME",
          name: "poc.tenant-fixture.com",
          content: "customers.omh.st",
          purpose: "traffic",
        },
      ],
      observedAt: new Date("2026-09-04T20:00:00.000Z"),
    };
    const routes = {
      createRoute: vi.fn(async () => ({ outcome: "created", receipt: routeReceipt })),
      retargetRoute: vi.fn(),
      observeRoute: vi.fn(),
      deleteRoute: vi.fn(),
    };
    const customHostnames = {
      createHostname: vi.fn(async () => ({ outcome: "created", receipt: customReceipt })),
      observeHostname: vi.fn(),
      deleteHostname: vi.fn(),
    };
    const customerDns = {
      loadAccess: vi.fn(async () => ({ status: "reauthorization_required" as const })),
      reconcileRecords: vi.fn(),
      deleteRecords: vi.fn(),
    };
    const persistence = {
      accessReason: async () => null,
      readTarget: async () => ({ gatewayScriptName: "ohmyho-gateway-production" }),
      claimApply: vi.fn(async (input: Record<string, unknown>) => ({
        ...input,
        state: "pending",
        customHostnameReceipt: null,
        workerRouteReceipt: null,
        gatewayRetarget: false,
        hostnameProven: true,
      })),
      putActive: vi.fn(async (input: Record<string, unknown>) => ({
        ...input,
        state: "active",
        hostnameProven: true,
      })),
      read: vi.fn(async () => null),
      claimDelete: vi.fn(),
      markDeleted: vi.fn(async () => undefined),
      claimProjectDeletion: vi.fn(),
    };
    const runtime = createRuntime({
      cnameTarget: "customers.omh.st",
      clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
      customerDns: customerDns as never,
    });

    await expect(
      runtime.applyPaidDomain({
        ...scope,
        hostname: "poc.tenant-fixture.com",
        idempotencyKeySha256: digest,
        requestSha256: digest,
      }),
    ).resolves.toMatchObject({
      status: "reconciliation_required",
      hostname: "poc.tenant-fixture.com",
    });
    expect(customerDns.loadAccess).toHaveBeenCalledOnce();
    expect(customerDns.reconcileRecords).not.toHaveBeenCalled();
  });

  it.each(["reauthorization_required", "reconciliation_required"] as const)(
    "keeps a connection whose customer records need the owner's reauthorization to delete (%s): no route, hostname or deletion is written",
    async (accessStatus) => {
      const stored = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        hostname: "poc.tenant-fixture.com",
        gatewayScriptName: "ohmyho-gateway-production",
        state: "active",
        customHostnameReceipt: {
          customHostnameId: "5".repeat(32),
          hostname: "poc.tenant-fixture.com",
          customerCnameTarget: "customers.omh.st",
          status: "active",
          ready: true,
          providerCreatedAt: "2026-09-04T20:00:00.000Z",
          ownershipVerification: null,
          ownershipVerificationHttp: null,
          verificationErrors: [],
          ssl: { status: "active" },
          dnsRecords: [
            {
              type: "CNAME",
              name: "poc.tenant-fixture.com",
              content: "customers.omh.st",
              purpose: "traffic",
            },
          ],
          observedAt: new Date("2026-09-04T20:00:00.000Z"),
        },
        workerRouteReceipt: {
          routeId: "6".repeat(32),
          hostname: "poc.tenant-fixture.com",
          scriptName: "ohmyho-gateway-production",
          pattern: "poc.tenant-fixture.com/*",
          observedAt: new Date("2026-09-04T20:00:00.000Z"),
        },
        hostnameProven: true,
      };
      const routes = {
        createRoute: vi.fn(),
        retargetRoute: vi.fn(),
        observeRoute: vi.fn(),
        deleteRoute: vi.fn(async () => ({ outcome: "deleted" })),
      };
      const customHostnames = {
        createHostname: vi.fn(),
        observeHostname: vi.fn(),
        deleteHostname: vi.fn(async () => ({ outcome: "deleted" })),
      };
      const customerDns = {
        loadAccess: vi.fn(async () => ({ status: accessStatus })),
        reconcileRecords: vi.fn(),
        deleteRecords: vi.fn(),
      };
      const persistence = {
        accessReason: async () => null,
        readTarget: async () => ({ gatewayScriptName: "ohmyho-gateway-production" }),
        claimApply: vi.fn(),
        putActive: vi.fn(),
        read: vi.fn(async () => stored),
        claimDelete: vi.fn(async () => ({ ...stored, state: "deleting" })),
        markDeleted: vi.fn(async () => undefined),
        claimProjectDeletion: vi.fn(),
      };
      const runtime = createRuntime({
        cnameTarget: "customers.omh.st",
        clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
        persistence: persistence as never,
        routes: routes as never,
        customHostnames: customHostnames as never,
        customerDns: customerDns as never,
      });

      await expect(
        runtime.deletePaidDomain({
          ...scope,
          hostname: "poc.tenant-fixture.com",
          idempotencyKeySha256: digest,
          requestSha256: digest,
        }),
      ).resolves.toMatchObject({ status: "reconciliation_required" });
      expect(customerDns.reconcileRecords).not.toHaveBeenCalled();
      expect(customerDns.deleteRecords).not.toHaveBeenCalled();
      expect(routes.deleteRoute).not.toHaveBeenCalled();
      expect(customHostnames.deleteHostname).not.toHaveBeenCalled();
      expect(persistence.markDeleted).not.toHaveBeenCalled();
    },
  );
});

describe("Paid hostname ownership challenge", () => {
  const hostname = "shop.owned.example.net";
  const at = "2026-09-04T20:00:00.000Z";
  const customReceipt = {
    customHostnameId: "3".repeat(32),
    hostname,
    customerCnameTarget: "customers.omh.st",
    status: "pending",
    ready: false,
    providerCreatedAt: at,
    ownershipVerification: null,
    ownershipVerificationHttp: null,
    verificationErrors: [],
    ssl: { status: "pending_validation" },
    dnsRecords: [],
    observedAt: new Date(at),
  };
  const routeReceipt = {
    routeId: "4".repeat(32),
    hostname,
    scriptName: "ohmyho-gateway-production",
    pattern: `${hostname}/*`,
    observedAt: new Date(at),
  };
  const apply = {
    ...scope,
    hostname,
    idempotencyKeySha256: digest,
    requestSha256: digest,
  };

  /** One hostname's proof record, held in memory as the Core stores it: pending until a verify with its exact value. */
  function fakes(input: {
    observed: boolean;
    verifiedUntil?: string;
    capped?: boolean;
    connected?: boolean;
  }) {
    let proof: Record<string, unknown> | null =
      input.verifiedUntil === undefined
        ? null
        : {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            hostname,
            state: "verified",
            challengeName: `_omh-project.${hostname}`,
            challengeValue: `omh-domain-v1=${"v".repeat(43)}`,
            declaredAt: at,
            verifiedAt: at,
            expiresAt: input.verifiedUntil,
          };
    const persistence = {
      accessReason: async () => null,
      readTarget: async () => ({ gatewayScriptName: "ohmyho-gateway-production" }),
      ensureProof: vi.fn(async (request: Record<string, unknown>) => {
        if (input.capped) return null;
        proof ??= {
          organizationId: request["organizationId"],
          projectId: request["projectId"],
          hostname: request["hostname"],
          state: "pending",
          challengeName: `_omh-project.${String(request["hostname"])}`,
          challengeValue: request["challengeValue"],
          declaredAt: request["now"],
          verifiedAt: null,
          expiresAt: null,
        };
        return proof;
      }),
      verifyProof: vi.fn(async (request: Record<string, unknown>) => {
        if (proof === null || proof["state"] !== "pending") return null;
        if (proof["challengeValue"] !== request["challengeValue"]) return null;
        proof = {
          ...proof,
          state: "verified",
          verifiedAt: request["now"],
          expiresAt: request["expiresAt"],
        };
        return proof;
      }),
      readProof: vi.fn(async () => proof),
      claimApply: vi.fn(async (request: Record<string, unknown>) => ({
        ...request,
        state: "pending",
        customHostnameReceipt: null,
        workerRouteReceipt: null,
        gatewayRetarget: false,
        hostnameProven: input.connected === true || proof?.["state"] === "verified",
      })),
      putActive: vi.fn(async (request: Record<string, unknown>) => ({
        ...request,
        state: "active",
        hostnameProven: true,
      })),
      read: vi.fn(async () =>
        input.connected === true
          ? {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              hostname,
              gatewayScriptName: "ohmyho-gateway-production",
              state: "active",
              customHostnameReceipt: customReceipt,
              workerRouteReceipt: routeReceipt,
              hostnameProven: true,
            }
          : null,
      ),
      claimDelete: vi.fn(),
      markDeleted: vi.fn(async () => undefined),
      claimProjectDeletion: vi.fn(),
    };
    const routes = {
      createRoute: vi.fn(async () => ({ outcome: "created", receipt: routeReceipt })),
      retargetRoute: vi.fn(),
      observeRoute: vi.fn(),
      deleteRoute: vi.fn(),
    };
    const customHostnames = {
      createHostname: vi.fn(async () => ({ outcome: "created", receipt: customReceipt })),
      observeHostname: vi.fn(),
      deleteHostname: vi.fn(),
    };
    const observeTxt = vi.fn(async () => input.observed);
    const runtime = createPaidDomainRuntime({
      cnameTarget: "customers.omh.st",
      clock: { now: () => new Date(at) },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
      observeTxt,
    });
    return { runtime, persistence, routes, customHostnames, observeTxt };
  }

  it("issues the challenge with an unproven apply and shows its TXT record through the Paid status", async () => {
    const { runtime, persistence, routes, observeTxt } = fakes({ observed: false });
    await expect(runtime.applyPaidDomain(apply)).rejects.toBeInstanceOf(
      PaidDomainHostnameUnprovenError,
    );
    expect(persistence.ensureProof).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname,
        challengeValue: expect.stringMatching(/^omh-domain-v1=[A-Za-z0-9_-]{43}$/u),
        now: at,
      }),
    );
    expect(observeTxt).toHaveBeenCalledWith(
      `_omh-project.${hostname}`,
      expect.stringMatching(/^omh-domain-v1=/u),
    );
    expect(persistence.verifyProof).not.toHaveBeenCalled();
    expect(routes.createRoute).not.toHaveBeenCalled();
    await expect(runtime.getPaidDomain(scope)).resolves.toMatchObject({
      validationRecords: [
        {
          type: "TXT",
          name: `_omh-project.${hostname}`,
          content: expect.stringMatching(/^omh-domain-v1=/u),
          purpose: "ownership",
        },
      ],
    });
  });

  it("verifies the published challenge at the next apply, connects the hostname and writes no mail identity", async () => {
    const { runtime, persistence, routes, customHostnames } = fakes({ observed: true });
    await expect(runtime.applyPaidDomain(apply)).resolves.toMatchObject({ hostname });
    expect(persistence.verifyProof).toHaveBeenCalledOnce();
    expect(persistence.verifyProof).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: "2026-10-04T20:00:00.000Z", now: at }),
    );
    expect(routes.createRoute).toHaveBeenCalledOnce();
    expect(customHostnames.createHostname).toHaveBeenCalledOnce();
  });

  it("answers an unpublished challenge as ownership required, even when the DNS lookup fails", async () => {
    const { persistence, routes } = fakes({ observed: false });
    const failing = createPaidDomainRuntime({
      cnameTarget: "customers.omh.st",
      clock: { now: () => new Date(at) },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: {
        createHostname: vi.fn(),
        observeHostname: vi.fn(),
        deleteHostname: vi.fn(),
      } as never,
      observeTxt: async () => {
        throw new Error("Application identity DNS is unavailable");
      },
    });
    await expect(failing.applyPaidDomain(apply)).rejects.toBeInstanceOf(
      PaidDomainHostnameUnprovenError,
    );
    expect(routes.createRoute).not.toHaveBeenCalled();
  });

  it("uses a live verified proof without observing DNS", async () => {
    const { runtime, persistence, observeTxt } = fakes({
      observed: false,
      verifiedUntil: "2026-12-01T00:00:00.000Z",
    });
    await expect(runtime.applyPaidDomain(apply)).resolves.toMatchObject({ hostname });
    expect(observeTxt).not.toHaveBeenCalled();
    expect(persistence.verifyProof).not.toHaveBeenCalled();
  });

  it("makes no lookup and no challenge for a replay on a proven connection of the same hostname", async () => {
    const { runtime, persistence, observeTxt } = fakes({ observed: false, connected: true });
    await expect(runtime.applyPaidDomain(apply)).resolves.toMatchObject({ hostname });
    expect(persistence.ensureProof).not.toHaveBeenCalled();
    expect(observeTxt).not.toHaveBeenCalled();
  });

  it("answers a fresh key's same-member connection as it stands and provisions nothing", async () => {
    const customReceipt = {
      customHostnameId: "2".repeat(32),
      hostname: "poc.tenant-fixture.com",
      customerCnameTarget: "customers.omh.st",
      status: "active",
      ready: true,
      providerCreatedAt: "2026-09-04T20:00:00.000Z",
      ownershipVerification: null,
      ownershipVerificationHttp: null,
      verificationErrors: [],
      ssl: { status: "active" },
      dnsRecords: [],
      observedAt: new Date("2026-09-04T20:00:00.000Z"),
    };
    const routeReceipt = {
      routeId: "1".repeat(32),
      hostname: "poc.tenant-fixture.com",
      scriptName: "ohmyho-gateway-production",
      pattern: "poc.tenant-fixture.com/*",
      observedAt: new Date("2026-09-04T20:00:00.000Z"),
    };
    const stored = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      hostname: "poc.tenant-fixture.com",
      gatewayScriptName: "ohmyho-gateway-production",
      state: "active",
      customHostnameReceipt: customReceipt,
      workerRouteReceipt: routeReceipt,
      hostnameProven: true,
      gatewayRetarget: false,
      sameConnection: true,
    };
    const routes = {
      createRoute: vi.fn(async () => ({ outcome: "created", receipt: routeReceipt })),
      retargetRoute: vi.fn(),
      observeRoute: vi.fn(async () => ({ state: "found", ...routeReceipt })),
      deleteRoute: vi.fn(),
    };
    const customHostnames = {
      createHostname: vi.fn(async () => ({ outcome: "created", receipt: customReceipt })),
      observeHostname: vi.fn(async () => ({ state: "found", ...customReceipt })),
      deleteHostname: vi.fn(),
    };
    const persistence = {
      accessReason: async () => null,
      readTarget: async () => ({ gatewayScriptName: "ohmyho-gateway-production" }),
      claimApply: vi.fn(async () => stored),
      putActive: vi.fn(async (input: Record<string, unknown>) => ({ ...input, state: "active" })),
      read: vi.fn(async () => stored),
      claimDelete: vi.fn(),
      markDeleted: vi.fn(),
      claimProjectDeletion: vi.fn(),
    };
    const runtime = createRuntime({
      cnameTarget: "customers.omh.st",
      clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
    });

    await expect(
      runtime.applyPaidDomain({
        ...scope,
        hostname: "poc.tenant-fixture.com",
        idempotencyKeySha256: digest,
        requestSha256: digest,
      }),
    ).resolves.toMatchObject({ hostname: "poc.tenant-fixture.com", status: "active" });
    expect(routes.createRoute).not.toHaveBeenCalled();
    expect(routes.retargetRoute).not.toHaveBeenCalled();
    expect(customHostnames.createHostname).not.toHaveBeenCalled();
    expect(persistence.putActive).not.toHaveBeenCalled();
  });

  it("makes no lookup and no challenge once the project's pending budget is spent", async () => {
    const { runtime, persistence, observeTxt } = fakes({ observed: true, capped: true });
    await expect(runtime.applyPaidDomain(apply)).rejects.toBeInstanceOf(
      PaidDomainHostnameUnprovenError,
    );
    expect(persistence.ensureProof).toHaveBeenCalledOnce();
    expect(observeTxt).not.toHaveBeenCalled();
    expect(persistence.verifyProof).not.toHaveBeenCalled();
  });
});

describe("Paid domain removal after a failed legacy retarget", () => {
  it("deletes the route the retarget left on the shared gateway, and no other, when its receipt still names the legacy script", async () => {
    const cnameTarget = "customers.omh.st";
    const legacy = `g-p-${scope.projectId.toLowerCase()}-prod`;
    const shared = "ohmyho-gateway-production";
    const customHostnameReceipt = {
      customHostnameId: "0542a4b1673d4486ae136036ef941193",
      hostname: "poc.tenant-fixture.com",
      customerCnameTarget: cnameTarget,
      status: "active",
      ready: true,
      ssl: { status: "active" },
      dnsRecords: [
        { type: "CNAME", name: "poc.tenant-fixture.com", content: cnameTarget, purpose: "traffic" },
      ],
      observedAt: new Date("2026-09-22T00:00:00.000Z"),
    };
    const legacyRoute = {
      routeId: "1234567890abcdef1234567890abcdef",
      hostname: "poc.tenant-fixture.com",
      scriptName: legacy,
      pattern: "poc.tenant-fixture.com/*",
      observedAt: new Date("2026-09-22T00:00:00.000Z"),
    };
    // The retarget moved the live route to the shared gateway; the claim stored that target but kept the legacy receipt.
    const live = { ...legacyRoute, scriptName: shared };
    const stored = {
      ...scope,
      hostname: "poc.tenant-fixture.com",
      gatewayScriptName: shared,
      state: "active",
      hostnameProven: true,
      customHostnameReceipt,
      workerRouteReceipt: legacyRoute,
    };
    const routes = {
      createRoute: vi.fn(),
      retargetRoute: vi.fn(),
      observeRoute: vi.fn(async ({ scriptName }: { scriptName: string }) => {
        if (scriptName !== live.scriptName) throw new Error("observed route names another script");
        return { state: "found" as const, ...live };
      }),
      // Like the Cloudflare route provider: a receipt must name the script the live route runs.
      deleteRoute: vi.fn(async (receipt: { routeId: string; scriptName: string }) => {
        if (receipt.routeId !== live.routeId || receipt.scriptName !== live.scriptName)
          throw new Error("route receipt mismatch");
        return { outcome: "deleted" as const };
      }),
    };
    const customHostnames = {
      createHostname: vi.fn(),
      observeHostname: vi.fn(async () => ({ state: "found", ...customHostnameReceipt })),
      deleteHostname: vi.fn(async () => ({ outcome: "deleted" })),
    };
    const persistence = {
      accessReason: async () => null,
      readTarget: async () => ({ gatewayScriptName: shared }),
      claimApply: vi.fn(),
      putActive: vi.fn(),
      read: vi.fn(async () => stored),
      claimDelete: vi.fn(async () => ({ ...stored, state: "deleting" })),
      markDeleted: vi.fn(async () => undefined),
    };
    const customerDns = {
      loadAccess: vi.fn(async () => ({ status: "absent" as const })),
      reconcileRecords: vi.fn(),
      deleteRecords: vi.fn(),
    };
    const runtime = createRuntime({
      cnameTarget,
      clock: { now: () => new Date("2026-09-25T00:00:00.000Z") },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
      customerDns: customerDns as never,
    });

    await runtime.deletePaidDomain({
      ...scope,
      hostname: "poc.tenant-fixture.com",
      idempotencyKeySha256: digest,
      requestSha256: digest,
    });
    expect(routes.deleteRoute).toHaveBeenCalledOnce();
    expect(routes.deleteRoute).toHaveBeenCalledWith(
      expect.objectContaining({ routeId: live.routeId, scriptName: shared }),
    );
    expect(customHostnames.deleteHostname).toHaveBeenCalledOnce();
    expect(persistence.markDeleted).toHaveBeenCalledOnce();
  });
});

describe("Paid domain removal with an expired customer grant", () => {
  it("removes the route and hostname and marks the connection deleted, without the expired grant's records", async () => {
    const cnameTarget = "customers.omh.st";
    const shared = "ohmyho-gateway-production";
    const customHostnameReceipt = {
      customHostnameId: "0542a4b1673d4486ae136036ef941193",
      hostname: "poc.tenant-fixture.com",
      customerCnameTarget: cnameTarget,
      status: "active",
      ready: true,
      ssl: { status: "active" },
      dnsRecords: [
        { type: "CNAME", name: "poc.tenant-fixture.com", content: cnameTarget, purpose: "traffic" },
      ],
      observedAt: new Date("2026-09-22T00:00:00.000Z"),
    };
    const route = {
      routeId: "1234567890abcdef1234567890abcdef",
      hostname: "poc.tenant-fixture.com",
      scriptName: shared,
      pattern: "poc.tenant-fixture.com/*",
      observedAt: new Date("2026-09-22T00:00:00.000Z"),
    };
    const stored = {
      ...scope,
      hostname: "poc.tenant-fixture.com",
      gatewayScriptName: shared,
      state: "active",
      hostnameProven: true,
      customHostnameReceipt,
      workerRouteReceipt: route,
    };
    const routes = {
      createRoute: vi.fn(),
      retargetRoute: vi.fn(),
      observeRoute: vi.fn(),
      deleteRoute: vi.fn(async () => ({ outcome: "deleted" })),
    };
    const customHostnames = {
      createHostname: vi.fn(),
      observeHostname: vi.fn(),
      deleteHostname: vi.fn(async () => ({ outcome: "deleted" })),
    };
    const persistence = {
      accessReason: async () => null,
      readTarget: async () => ({ gatewayScriptName: shared }),
      claimApply: vi.fn(),
      putActive: vi.fn(),
      read: vi.fn(async () => stored),
      claimDelete: vi.fn(async () => ({ ...stored, state: "deleting" })),
      markDeleted: vi.fn(async () => undefined),
    };
    const customerDns = {
      loadAccess: vi.fn(async () => ({ status: "expired" as const })),
      reconcileRecords: vi.fn(),
      deleteRecords: vi.fn(),
    };
    const runtime = createRuntime({
      cnameTarget,
      clock: { now: () => new Date("2026-09-25T00:00:00.000Z") },
      persistence: persistence as never,
      routes: routes as never,
      customHostnames: customHostnames as never,
      customerDns: customerDns as never,
    });

    await runtime.deletePaidDomain({
      ...scope,
      hostname: "poc.tenant-fixture.com",
      idempotencyKeySha256: digest,
      requestSha256: digest,
    });
    expect(customerDns.deleteRecords).not.toHaveBeenCalled();
    expect(routes.deleteRoute).toHaveBeenCalledOnce();
    expect(customHostnames.deleteHostname).toHaveBeenCalledOnce();
    expect(persistence.markDeleted).toHaveBeenCalledOnce();
  });
});
