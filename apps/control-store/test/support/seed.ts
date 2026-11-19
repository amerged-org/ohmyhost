import { newUlid } from "../../src/catalog/common.js";
import type { createControlStore } from "../../src/store.js";
import { organizationIdWithShard } from "./control-d1.js";

export type Store = ReturnType<typeof createControlStore>;

let counter = 0;
export const digest = (n: number) => n.toString(16).padStart(64, "0");

/** An active organization on the chosen shard, created through the real snapshot command. */
export async function seedOrganization(store: Store, shardCount: number, shardId: number) {
  counter += 1;
  const organizationId = await organizationIdWithShard(
    shardCount,
    shardId,
    500_000 + counter * 997,
  );
  await store.identity.applyOrganizationSnapshot({
    organizationId,
    workosOrganizationId: `org_seed${counter}`,
    state: "active",
    snapshotDigest: digest(counter),
    snapshotFetchedAt: "2026-10-28T09:00:00.000Z",
    synchronizedAt: "2026-10-28T09:00:00.000Z",
    triggerEventId: "evt_seed",
    memberships: [],
    auditEventId: newUlid(),
  });
  return organizationId;
}

export function projectInput(organizationId: string, handle: string, shared = true) {
  const projectId = newUlid();
  const operationId = newUlid();
  const billingEpochId = newUlid();
  const developmentEnvironmentId = newUlid();
  const productionEnvironmentId = newUlid();
  const developmentDataEnvironmentId = newUlid();
  return {
    organizationId,
    projectId,
    billingEpochId,
    principalId: "user:user_seed",
    projectName: `Project ${handle}`,
    projectHandle: handle,
    projectHandleVersion: "customer-chosen-v1",
    projectHandleAttempt: 0,
    dataMode: shared ? "shared" : "isolated",
    region: "eu",
    createdEventId: newUlid(),
    createdAt: "2026-10-28T10:00:00.000Z",
    developmentEnvironmentId,
    productionEnvironmentId,
    developmentDataEnvironmentId,
    productionDataEnvironmentId: shared ? developmentDataEnvironmentId : newUlid(),
    operation: { operationId, eventId: newUlid() },
    audit: {
      auditEventId: newUlid(),
      projectId,
      operationId,
      eventType: "ProjectCreated",
      actorType: "principal",
      actorId: "user:user_seed",
      payload: {},
      occurredAt: "2026-10-28T10:00:00.000Z",
    },
    outbox: {
      eventId: newUlid(),
      eventType: "ProjectCreated",
      payload: {},
      createdAt: "2026-10-28T10:00:00.000Z",
      maxAttempts: 5,
    },
  };
}

export function acceptInput(
  project: ReturnType<typeof projectInput>,
  overrides: Record<string, unknown> = {},
) {
  return {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.developmentEnvironmentId,
    billingEpochId: project.billingEpochId,
    operationId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    outboxEventId: newUlid(),
    principalId: "user:user_seed",
    requestId: "req-1",
    httpMethod: "POST",
    routeTemplate: "/v1/projects/p/deployments",
    idempotencyKey: "key-1",
    canonicalRequestDigest: digest(7),
    eventType: "DeploymentRequestedV1",
    occurredAt: "2026-10-28T11:00:00.000Z",
    ...overrides,
  };
}
