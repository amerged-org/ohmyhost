import { describe, expect, it, vi } from "vitest";

import {
  createProductCommandConsumer,
  createProductCommandPublisher,
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
  projectProductCommandMessage,
  serializeProductCommandMessageV1,
} from "./product-command.js";

const base = {
  version: 1,
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
} as const;

describe("product command messages", () => {
  it.each([
    [{ ...base, eventType: "SourceLinkRequestedV1" }, "source-link"],
    [
      {
        ...base,
        eventType: "DeploymentRequestedV1",
        planId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      },
      "deploy",
    ],
    [
      {
        ...base,
        eventType: "DeploymentRollbackRequestedV1",
      },
      "rollback",
    ],
    [
      {
        ...base,
        eventType: "DeploymentPromotionRequestedV1",
      },
      "promotion",
    ],
    [
      {
        ...base,
        eventType: "ProjectHandleChangeRequestedV1",
        requestedHandle: "acme-shop",
      },
      "handle-change",
    ],
    [
      {
        ...base,
        eventType: "ProjectDeletionRequestedV1",
      },
      "delete",
    ],
    [
      { ...base, eventType: "ProjectDataChangeRequestedV1", dataChange: "reset_dev" },
      "data-change",
    ],
  ])("round-trips the strict credential-free %s shape", (input, kind) => {
    const parsed = parseProductCommandMessageV1(input);
    expect(JSON.parse(serializeProductCommandMessageV1(parsed))).toEqual(input);
    expect(deterministicProductCommandWorkflowId(parsed)).toBe(
      `product-command-v1-${kind}-${input.eventId}-${input.operationId}`,
    );
  });

  it.each([
    { ...base, eventType: "DeploymentRequestedV1" },
    { ...base, eventType: "SourceLinkRequestedV1", planId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" },
    {
      ...base,
      eventType: "DeploymentRollbackRequestedV1",
      planId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    },
    {
      ...base,
      eventType: "DeploymentPromotionRequestedV1",
      artifactDigest: "sha256:must-not-enter-the-queue",
    },
    {
      ...base,
      eventType: "ProjectDeletionRequestedV1",
      confirmationId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    },
    { ...base, eventType: "ProjectDeletionRequestedV1", token: "must-not-enter-the-queue" },
    { ...base, eventType: "ProjectDataChangeRequestedV1", dataChange: "copy_prod_to_dev" },
    { ...base, eventType: "ProjectDataChangeRequestedV1", dataChange: "reset_dev", data: {} },
    { ...base, eventType: "UnknownRequestedV1" },
  ])("rejects incomplete, extra, credential-like, and unsupported fields", (input) => {
    expect(() => parseProductCommandMessageV1(input)).toThrow(TypeError);
  });

  it("consumes only strict JSON and maps Workflow terminality conservatively", async () => {
    const input = { ...base, eventType: "SourceLinkRequestedV1" } as const;
    const execute = vi
      .fn()
      .mockResolvedValueOnce("completed")
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("uncertain")
      .mockResolvedValueOnce("invented");
    const consumer = createProductCommandConsumer({ execute });
    const serialized = serializeProductCommandMessageV1(parseProductCommandMessageV1(input));
    await expect(consumer.consume(serialized)).resolves.toMatchObject({
      status: "completed",
      durable: "workflow_terminal",
    });
    await expect(consumer.consume(serialized)).resolves.toMatchObject({ status: "pending" });
    await expect(consumer.consume(serialized)).resolves.toMatchObject({ status: "pending" });
    await expect(consumer.consume(serialized)).rejects.toThrow("unsupported outcome");
    await expect(consumer.consume("not-json")).rejects.toThrow("valid JSON");
  });

  it("requires a Workflow execution capability", () => {
    expect(() => createProductCommandConsumer({})).toThrow("Workflow binding");
  });

  it.each([
    ["SourceLinkRequestedV1", null],
    ["DeploymentRequestedV1", "01ARZ3NDEKTSV4RRFFQ69G5FB1"],
    ["DeploymentRollbackRequestedV1", null],
    ["DeploymentPromotionRequestedV1", null],
    ["ProjectDeletionRequestedV1", null],
  ] as const)(
    "projects immutable %s intent into a locator-only Queue message",
    (eventType, planId) => {
      const message = projectProductCommandMessage(
        {
          eventId: base.eventId,
          organizationId: base.organizationId,
          projectId: base.projectId,
          operationId: base.operationId,
          billingEpochId: base.billingEpochId,
        },
        {
          eventType,
          organizationId: base.organizationId,
          projectId: base.projectId,
          environmentId: base.environmentId,
          operationId: base.operationId,
          billingEpochId: base.billingEpochId,
          planId,
        },
      );
      expect(message).toEqual({
        ...base,
        eventType,
        ...(planId === null ? {} : { planId }),
      });
    },
  );

  it("carries the requested address from the intent into the rename message", () => {
    const message = projectProductCommandMessage(
      {
        eventId: base.eventId,
        organizationId: base.organizationId,
        projectId: base.projectId,
        operationId: base.operationId,
        billingEpochId: base.billingEpochId,
      },
      {
        eventType: "ProjectHandleChangeRequestedV1",
        organizationId: base.organizationId,
        projectId: base.projectId,
        environmentId: base.environmentId,
        operationId: base.operationId,
        billingEpochId: base.billingEpochId,
        planId: null,
        requestedHandle: "acme-shop",
      },
    );
    expect(message).toEqual({
      ...base,
      eventType: "ProjectHandleChangeRequestedV1",
      requestedHandle: "acme-shop",
    });
  });

  it("refuses a rename without a usable address and an address on any other command", () => {
    const scope = {
      eventId: base.eventId,
      organizationId: base.organizationId,
      projectId: base.projectId,
      operationId: base.operationId,
      billingEpochId: base.billingEpochId,
    };
    const intent = {
      organizationId: base.organizationId,
      projectId: base.projectId,
      environmentId: base.environmentId,
      operationId: base.operationId,
      billingEpochId: base.billingEpochId,
      planId: null,
    };
    expect(() =>
      projectProductCommandMessage(scope, {
        ...intent,
        eventType: "ProjectHandleChangeRequestedV1",
        requestedHandle: null,
      }),
    ).toThrow("address");
    expect(() =>
      projectProductCommandMessage(scope, {
        ...intent,
        eventType: "ProjectHandleChangeRequestedV1",
        requestedHandle: "Acme Shop",
      }),
    ).toThrow("Project handle is invalid");
    expect(() =>
      projectProductCommandMessage(scope, {
        ...intent,
        eventType: "DeploymentRollbackRequestedV1",
        requestedHandle: "acme-shop",
      }),
    ).toThrow("address");
  });

  it("rejects an intent outside the exact claimed outbox scope", () => {
    expect(() =>
      projectProductCommandMessage(
        {
          eventId: base.eventId,
          organizationId: base.organizationId,
          projectId: base.projectId,
          operationId: base.operationId,
          billingEpochId: base.billingEpochId,
        },
        {
          eventType: "SourceLinkRequestedV1",
          organizationId: base.organizationId,
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
          environmentId: base.environmentId,
          operationId: base.operationId,
          billingEpochId: base.billingEpochId,
          planId: null,
        },
      ),
    ).toThrow("scope");
  });

  it("publishes and acknowledges one exact product command claim", async () => {
    const message = parseProductCommandMessageV1({ ...base, eventType: "SourceLinkRequestedV1" });
    const acknowledgeExact = vi.fn(async () => true);
    const send = vi.fn(async () => "sent" as const);
    const publisher = createProductCommandPublisher({
      claims: {
        claim: vi.fn(async () => ({
          message,
          eventId: base.eventId,
          organizationId: base.organizationId,
          projectId: base.projectId,
          operationId: base.operationId,
          attemptId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" as const,
          attemptNumber: 1,
          maxAttempts: 5,
        })),
        acknowledgeExact,
        recoverExpiredFinalClaim: vi.fn(async () => false),
        recordDeliveryFailure: vi.fn(),
      },
      queue: { send },
    });
    await expect(publisher.publishOne()).resolves.toEqual({ status: "published" });
    expect(send).toHaveBeenCalledWith(serializeProductCommandMessageV1(message), {
      signal: expect.any(AbortSignal),
    });
    expect(acknowledgeExact).toHaveBeenCalledWith({
      eventId: base.eventId,
      attemptId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    });
  });

  it("keeps an empty product outbox idle and rejects stale acknowledgements", async () => {
    const idle = createProductCommandPublisher({
      claims: {
        claim: vi.fn(async () => null),
        acknowledgeExact: vi.fn(),
        recoverExpiredFinalClaim: vi.fn(async () => false),
        recordDeliveryFailure: vi.fn(),
      },
      queue: { send: vi.fn() },
    });
    await expect(idle.publishOne()).resolves.toEqual({ status: "idle" });

    const message = parseProductCommandMessageV1({ ...base, eventType: "SourceLinkRequestedV1" });
    const stale = createProductCommandPublisher({
      claims: {
        claim: vi.fn(async () => ({
          message,
          eventId: base.eventId,
          organizationId: base.organizationId,
          projectId: base.projectId,
          operationId: base.operationId,
          attemptId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" as const,
          attemptNumber: 1,
          maxAttempts: 5,
        })),
        acknowledgeExact: vi.fn(async () => false),
        recoverExpiredFinalClaim: vi.fn(async () => false),
        recordDeliveryFailure: vi.fn(),
      },
      queue: { send: vi.fn(async () => "sent" as const) },
    });
    await expect(stale.publishOne()).rejects.toThrow("stale");
  });

  it("records Queue uncertainty and recovers exhausted leases before claiming new work", async () => {
    const message = parseProductCommandMessageV1({ ...base, eventType: "SourceLinkRequestedV1" });
    const recordDeliveryFailure = vi.fn(async () => "retry_scheduled" as const);
    const uncertain = createProductCommandPublisher({
      claims: {
        claim: vi.fn(async () => ({
          message,
          eventId: base.eventId,
          organizationId: base.organizationId,
          projectId: base.projectId,
          operationId: base.operationId,
          attemptId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          attemptNumber: 1,
          maxAttempts: 5,
        })),
        acknowledgeExact: vi.fn(),
        recoverExpiredFinalClaim: vi.fn(async () => false),
        recordDeliveryFailure,
      },
      queue: { send: vi.fn(async () => Promise.reject(new Error("timeout"))) },
    });
    await expect(uncertain.publishOne()).resolves.toEqual({ status: "retry_scheduled" });
    expect(recordDeliveryFailure).toHaveBeenCalledOnce();

    const claim = vi.fn();
    const recovered = createProductCommandPublisher({
      claims: {
        claim,
        acknowledgeExact: vi.fn(),
        recoverExpiredFinalClaim: vi.fn(async () => true),
        recordDeliveryFailure: vi.fn(),
      },
      queue: { send: vi.fn() },
    });
    await expect(recovered.publishOne()).resolves.toEqual({ status: "reconciliation_required" });
    expect(claim).not.toHaveBeenCalled();
  });
});
