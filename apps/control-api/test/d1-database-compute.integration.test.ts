import { expect, it, vi } from "vitest";
import { ProjectComputeChangeError } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";

import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { NOW, ulidOf } from "../../control-store/test/support/platform-fixtures.js";
import { seedProductRuntimeFixture } from "../../control-store/test/support/product-runtime-fixture.js";
import { IdempotencyKeyReusedError } from "../src/contracts.js";
import {
  createD1DatabaseComputePort,
  dispatchD1DatabaseComputeChanges,
} from "../src/database-compute.js";

it("changes and reads database compute over the Core: the accepted operation, closed refusals, the observed state and the minute dispatch", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      f = await seedProductRuntimeFixture(control);
    await makePaid(control.core, f.organizationId);
    const operationId = ulidOf("compute", f.n);
    await store.productDatabase.acceptCompute({
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId: f.devEnvironmentId,
      billingEpochId: f.billingEpochId,
      operationId,
      operationEventId: ulidOf("compute-queued", f.n),
      auditEventId: ulidOf("compute-audit", f.n),
      outboxEventId: ulidOf("compute-outbox", f.n),
      principalId: "user:fixture",
      requestId: "compute",
      idempotencyKey: `compute-${String(f.n)}`,
      canonicalRequestDigest: "cc".repeat(32),
      httpMethod: "POST",
      routeTemplate: "/v1/projects/{project_id}/database/compute",
      occurredAt: NOW,
      memoryMiB: 512,
      currentStorageMiB: 1024,
      expectedDatabaseId: f.database,
      expectedTargetVersion: 1,
      eventType: "ProjectDatabaseComputeChangeRequestedV1",
    });

    const observation = {
      project_id: f.projectId,
      environment: "dev",
      data_mode: "shared",
      observed_at: NOW,
      database: {
        provider: "pgcf",
        size_class_id: "r512-s1g",
        memory_mib: 512,
        cpu_millicores: 250,
        storage_mib: 1024,
        max_connections: 40,
        suspend_timeout_seconds: 300,
        state: "cold",
        pending_state: null,
        disabled: false,
        region: "us",
      },
    };
    let changed: unknown = { status: "accepted", operationId };
    let observed: () => Promise<unknown> = async () => observation;
    const changeCompute = vi.fn(async () => changed);
    const runComputeChange = vi.fn<(job: unknown) => Promise<unknown>>(async () => ({
        status: "running",
      })),
      binding = {
        readCompute: () => observed(),
        changeCompute,
        runComputeChange,
      },
      port = createD1DatabaseComputePort(binding, {
        readProjectDatabaseOperation: store.productDatabase.readOperation,
        readProjectComputeContext: store.productDatabase.readComputeContext,
      } as never),
      scope = {
        organizationId: parseUlid(f.organizationId),
        projectId: parseUlid(f.projectId),
        principalId: "user:fixture",
        requestId: "req_compute",
      },
      change = {
        ...scope,
        idempotencyKey: "compute-key",
        canonicalRequestDigest: new Uint8Array(32).fill(1),
        environment: "dev" as const,
        memoryMiB: 512 as const,
      };

    // The accepted change answers with the Core's original operation, never with a provider detail.
    expect(await port.set(change)).toMatchObject({ status: 202, body: { id: operationId } });
    const delegation = {
      grantId: crypto.randomUUID(),
      clientId: "client",
      consentHash: "ab".repeat(32),
      action: "projects:write" as const,
      authorizationRestriction: { projectIds: [parseUlid(f.projectId)] },
    };
    await port.set({ ...change, delegation });
    expect(changeCompute).toHaveBeenLastCalledWith(expect.objectContaining({ delegation }));
    changed = { status: "absent" };
    expect(await port.set(change)).toBeNull();
    // Closed refusals keep their own types; anything else is an invalid provider answer.
    changed = { status: "rejected", code: "idempotency_key_reused" };
    await expect(port.set(change)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    changed = { status: "rejected", code: "compute_change_pending" };
    await expect(port.set(change)).rejects.toMatchObject({
      constructor: ProjectComputeChangeError,
      code: "compute_change_pending",
    });
    for (const invalid of [null, [], { status: "queued" }, { status: "rejected", code: "other" }]) {
      changed = invalid;
      await expect(port.set(change)).rejects.toThrow("Invalid compute change result");
    }
    changed = { status: "accepted", operationId: ulidOf("foreign", f.n) };
    await expect(port.set(change)).rejects.toThrow("Compute operation scope mismatch");

    // Current compute is the Core's selection plus the provider's observation, or "unavailable" without one.
    const read = { ...scope, environment: "dev" as const, now: new Date().toISOString() };
    expect(await port.getContext(read)).toMatchObject({
      effective: { memoryMiB: 512 },
      observed: { project_id: f.projectId },
    });
    observed = async () => {
      throw new Error("provider offline");
    };
    expect(await port.getContext(read)).toMatchObject({ observed: "unavailable" });
    observed = async () => null;
    expect(await port.get(read)).toBeNull();
    observed = async () => ({ ...observation, project_id: ulidOf("other", f.n) });
    await expect(port.get(read)).rejects.toThrow("Database compute scope mismatch");

    // The minute dispatch acknowledges the outbox, then runs each due job once and counts invalid answers as failures.
    const dispatch = () =>
      dispatchD1DatabaseComputeChanges({
        runtime: {
          acknowledgeProductComputeOutbox: store.productDatabase.acknowledgeComputeOutbox,
          readDueProductCompute: store.productDatabase.readDueCompute,
        },
        binding,
        clock: { now: () => new Date() },
        ids: { next: () => parseUlid(ulidOf("attempt", Math.floor(Math.random() * 1e6))) },
      });
    expect(await dispatch()).toEqual({ observed: 1, failed: 0 });
    expect(runComputeChange).toHaveBeenCalledWith({
      organizationId: f.organizationId,
      projectId: f.projectId,
      operationId,
    });
    runComputeChange.mockResolvedValueOnce({ status: "unknown" });
    expect(await dispatch()).toEqual({ observed: 1, failed: 1 });
    runComputeChange.mockRejectedValueOnce(new Error("provider offline"));
    expect(await dispatch()).toEqual({ observed: 1, failed: 1 });
  } finally {
    await control.dispose();
  }
});
