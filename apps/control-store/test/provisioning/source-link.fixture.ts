import { parseUlid } from "@ohmyhost/platform";
import { parseProductCommandMessageV1 } from "../../../orchestrator/src/product-command.js";
import type { TestControl } from "../support/control-d1.js";
import { workflowFixture } from "./workflow-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { claimOutboxEvent, acknowledgeOutboxEvent } from "../../src/catalog/operations/outbox.js";
import { SharedCoreRouter } from "../../src/router.js";
export async function sourceLinkFixture(control: TestControl, acknowledged = true) {
  const base = await workflowFixture(control);
  const operationId = parseUlid(newUlid()),
    eventId = parseUlid(newUlid()),
    workflowId = `product-command-v1-source-link-${eventId}-${operationId}`,
    stamp = "2026-10-28T11:01:00.000000Z",
    env = base.p.developmentEnvironmentId;
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row),
      values = Object.values(row);
    await control.core
      .prepare(`INSERT INTO ${table}(${columns}) VALUES(${columns.map(() => "?")})`)
      .bind(...values.map((v) => (v instanceof Uint8Array ? new Uint8Array(v) : v)))
      .run();
  };
  const scope = {
    organization_id: base.p.organizationId,
    project_id: base.p.projectId,
    operation_id: operationId,
  };
  await insert("operations", {
    ...scope,
    billing_epoch_id: base.p.billingEpochId,
    state: "queued",
    created_at: stamp,
    updated_at: stamp,
  });
  await insert("operation_events", {
    ...scope,
    event_id: newUlid(),
    revision: 0,
    event_type: "OperationQueued",
    idempotency_key: `${operationId}:queued`,
    payload: "{}",
    occurred_at: stamp,
  });
  await insert("product_command_intents", {
    ...scope,
    environment_id: env,
    billing_epoch_id: base.p.billingEpochId,
    event_type: "SourceLinkRequestedV1",
    installation_id: "7",
    repository_owner: "o",
    repository_name: "r",
    created_at: stamp,
  });
  await insert("outbox_events", {
    ...scope,
    event_id: eventId,
    billing_epoch_id: base.p.billingEpochId,
    event_type: "SourceLinkRequestedV1",
    payload: JSON.stringify({ environmentId: env }),
    created_at: stamp,
    initial_available_at: stamp,
    available_at: stamp,
    max_attempts: 5,
  });
  await insert("product_workflow_runs", {
    ...scope,
    environment_id: env,
    billing_epoch_id: base.p.billingEpochId,
    event_type: "SourceLinkRequestedV1",
    workflow_id: workflowId,
    event_id: eventId,
    state: "queued",
    created_at: "2026-10-28T11:01:00.500000Z",
    updated_at: "2026-10-28T11:01:00.500000Z",
  });
  const connectionId = newUlid();
  await insert("github_organization_connections", {
    connection_id: connectionId,
    organization_id: base.p.organizationId,
    installation_id: "7",
    account_id: "11",
    account_login: "o",
    account_type: "Organization",
    github_user_id: "12",
    github_user_login: "fixture",
    principal_id: "user:fixture",
    settings_url: "https://github.com/settings/installations/7",
    connected_at: stamp,
  });
  await insert("github_repository_link_consents", {
    ...scope,
    environment_id: env,
    billing_epoch_id: base.p.billingEpochId,
    connection_id: connectionId,
    principal_id: "user:fixture",
    installation_id: "7",
    repository_id: "42",
    repository_owner: "o",
    repository_name: "r",
    idempotency_key: `${operationId}:consent`,
    request_sha256: new Uint8Array(32).fill(1),
    authorized_at: stamp,
  });
  const eventScope = {
      organizationId: parseUlid(base.p.organizationId),
      projectId: parseUlid(base.p.projectId),
      operationId,
      eventId,
    },
    ctx = { directory: control.core, router: new SharedCoreRouter(control.core) };
  if (acknowledged) {
    const attemptId = parseUlid(newUlid()),
      clock = { now: () => new Date("2026-10-28T11:01:01.000Z") };
    const coreClaimed = await claimOutboxEvent(ctx, {
      attemptId,
      now: clock.now().toISOString(),
      leaseMilliseconds: 30000,
      supportedEventTypes: ["SourceLinkRequestedV1"],
      eventScope,
    });
    const ackClock = { now: () => new Date("2026-10-28T11:01:02.000Z") };
    if (coreClaimed === null || coreClaimed.eventId !== eventId)
      throw new Error("Source fixture claim is missing");
    const coreAcknowledged = await acknowledgeOutboxEvent(ctx, {
      organizationId: eventScope.organizationId,
      eventId,
      attemptId,
      now: ackClock.now().toISOString(),
    });
    if (!coreAcknowledged) throw new Error("Source fixture durable handoff is missing");
  }
  const command = parseProductCommandMessageV1({
    version: 1,
    eventType: "SourceLinkRequestedV1",
    eventId,
    organizationId: base.p.organizationId,
    projectId: base.p.projectId,
    environmentId: env,
    operationId,
    billingEpochId: base.p.billingEpochId,
  });
  if (command.eventType !== "SourceLinkRequestedV1") throw new Error("Source fixture kind differs");
  return { control, base, operationId, eventId, workflowId, command, ctx, insert };
}
