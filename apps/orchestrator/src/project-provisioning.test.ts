import { describe, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import {
  consumeProjectProvisioningMessage,
  createProjectProvisioningConsumer,
  createProjectProvisioningPublisher,
  deterministicProjectProvisioningWorkflowId,
  parseProjectProvisioningOutboxPayload,
  parseProjectProvisioningMessageV1,
  publishOneProjectProvisioningRequest,
  serializeProjectProvisioningMessageV1,
  type ProjectProvisioningConsumerDependencies,
  type ProjectProvisioningMessageV1,
  type ProjectProvisioningPublisherDependencies,
} from "./project-provisioning.js";

const MESSAGE = {
  version: 1,
  eventType: "ProjectProvisioningRequested",
  eventId: parseUlid("01J00000000000000000000001"),
  organizationId: parseUlid("01J00000000000000000000002"),
  projectId: parseUlid("01J00000000000000000000003"),
  operationId: parseUlid("01J00000000000000000000004"),
} as const satisfies ProjectProvisioningMessageV1;

const ATTEMPT_ID = parseUlid("01J00000000000000000000005");

describe("ProjectProvisioningMessageV1", () => {
  it("parses and serializes the exact frozen versioned ULID scope", () => {
    const parsed = parseProjectProvisioningMessageV1(MESSAGE);

    expect(parsed).toEqual(MESSAGE);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(serializeProjectProvisioningMessageV1(parsed)).toBe(JSON.stringify(MESSAGE));
  });

  it.each([
    null,
    [],
    { ...MESSAGE, version: 2 },
    { ...MESSAGE, eventType: "StaticHostingDeploymentRequested" },
    { ...MESSAGE, eventId: "not-an-ulid" },
    { ...MESSAGE, organizationId: "01J0000000000000000000000I" },
    { ...MESSAGE, projectId: "01j00000000000000000000003" },
    { ...MESSAGE, operationId: "01J000000000000000000000040" },
    { ...MESSAGE, payload: { arbitrary: true } },
    { ...MESSAGE, credential: "secret" },
    { ...MESSAGE, apiKey: "sk-test" },
  ])("rejects malformed, extensible, or credential-bearing input", (input) => {
    expect(() => parseProjectProvisioningMessageV1(input)).toThrow(TypeError);
  });
});

describe("ProjectProvisioningRequested outbox payload", () => {
  const persistedPayload = {
    projectId: MESSAGE.projectId,
    operationId: MESSAGE.operationId,
  };

  it("parses the exact payload persisted by the Control API", () => {
    const parsed = parseProjectProvisioningOutboxPayload(persistedPayload);

    expect(parsed).toEqual(persistedPayload);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    {},
    { projectId: MESSAGE.projectId },
    { operationId: MESSAGE.operationId },
    { ...persistedPayload, extra: true },
    { ...persistedPayload, projectId: "not-an-ulid" },
    { ...persistedPayload, operationId: "not-an-ulid" },
  ])("rejects missing, extra, or invalid persisted payload fields", (payload) => {
    expect(() => parseProjectProvisioningOutboxPayload(payload)).toThrow(TypeError);
  });
});

describe("project provisioning queue publisher", () => {
  it("claims only the named event, validates its exact scope, sends, then ACKs the exact attempt", async () => {
    const calls: string[] = [];
    const dependencies = publisherDependencies({ calls });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
      status: "published",
      eventId: MESSAGE.eventId,
      attemptId: ATTEMPT_ID,
    });
    expect(calls).toEqual(["recover", "claim", "send", "ack"]);
    expect(dependencies.queue.send).toHaveBeenCalledWith(JSON.stringify(MESSAGE), {
      signal: expect.any(AbortSignal),
    });
    expect(dependencies.outbox.acknowledgeExact).toHaveBeenCalledWith({
      eventId: MESSAGE.eventId,
      attemptId: ATTEMPT_ID,
    });
  });

  it("fails closed on a payload/scope mismatch before queue send or ACK", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.outbox.claimProjectProvisioningRequested).mockResolvedValue({
      ...claim(),
      projectId: parseUlid("01J00000000000000000000009"),
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
      status: "invalid_message",
      eventId: MESSAGE.eventId,
      attemptId: ATTEMPT_ID,
      errorCode: "INVALID_PROJECT_PROVISIONING_MESSAGE",
    });
    expect(dependencies.outbox.failInvalidExact).toHaveBeenCalledWith({
      ...expectedAttemptScope(),
      projectId: parseUlid("01J00000000000000000000009"),
      errorCode: "INVALID_PROJECT_PROVISIONING_MESSAGE",
    });
    expect(dependencies.queue.send).not.toHaveBeenCalled();
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it.each([
    { projectId: MESSAGE.projectId },
    { projectId: MESSAGE.projectId, operationId: MESSAGE.operationId, extra: true },
    {
      projectId: parseUlid("01J00000000000000000000009"),
      operationId: MESSAGE.operationId,
    },
    {
      projectId: MESSAGE.projectId,
      operationId: parseUlid("01J00000000000000000000009"),
    },
  ])("rejects an invalid or mismatched persisted payload before queue send", async (payload) => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.outbox.claimProjectProvisioningRequested).mockResolvedValue({
      ...claim(),
      payload,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toMatchObject({
      status: "invalid_message",
      errorCode: "INVALID_PROJECT_PROVISIONING_MESSAGE",
    });
    expect(dependencies.queue.send).not.toHaveBeenCalled();
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("does not consume an unrelated event even if a broken port returns one", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.outbox.claimProjectProvisioningRequested).mockResolvedValue({
      ...claim(),
      eventType: "StaticHostingDeploymentRequested" as "ProjectProvisioningRequested",
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toMatchObject({
      status: "invalid_message",
      errorCode: "INVALID_PROJECT_PROVISIONING_MESSAGE",
    });
    expect(dependencies.queue.send).not.toHaveBeenCalled();
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it.each(["timeout", "uncertain"] as const)(
    "records a %s queue outcome without ACK and returns the durable retry decision",
    async (outcome) => {
      const dependencies = publisherDependencies();
      vi.mocked(dependencies.queue.send).mockResolvedValue(outcome);
      vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
        outcome: "retry_scheduled",
        attemptNumber: 1,
      });

      await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
        status: "retry_scheduled",
        eventId: MESSAGE.eventId,
        attemptId: ATTEMPT_ID,
        attemptNumber: 1,
        cause: outcome,
      });
      expect(dependencies.outbox.recordDeliveryUncertain).toHaveBeenCalledWith({
        ...expectedAttemptScope(),
        cause: outcome,
      });
      expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
    },
  );

  it("treats a thrown queue result as uncertain and persists recovery before returning", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.queue.send).mockRejectedValue(new Error("connection reset"));
    vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
      outcome: "retry_scheduled",
      attemptNumber: 1,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toMatchObject({
      status: "retry_scheduled",
      cause: "uncertain",
    });
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("does not treat an unknown queue adapter result as successful delivery", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.queue.send).mockResolvedValue("unexpected" as never);
    vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
      outcome: "reconciliation_required",
      attemptNumber: 3,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
      status: "reconciliation_required",
      eventId: MESSAGE.eventId,
      attemptId: ATTEMPT_ID,
      attemptNumber: 3,
      cause: "adapter_contract_invalid",
      diagnosticCode: "PROJECT_PROVISIONING_QUEUE_ADAPTER_CONTRACT_INVALID",
    });
    expect(dependencies.outbox.recordDeliveryUncertain).toHaveBeenCalledWith({
      ...expectedAttemptScope(),
      cause: "adapter_contract_invalid",
      diagnosticCode: "PROJECT_PROVISIONING_QUEUE_ADAPTER_CONTRACT_INVALID",
    });
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown durable uncertainty result", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.queue.send).mockResolvedValue("uncertain");
    vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
      outcome: "published",
      attemptNumber: 0,
    } as never);

    await expect(publishOneProjectProvisioningRequest(dependencies)).rejects.toThrow(
      "outbox returned an invalid uncertainty outcome",
    );
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("durably records an asynchronous definitive queue configuration error", async () => {
    const error = new Error("queue binding is absent");
    const dependencies = publisherDependencies({
      classifyQueueError: () => "definitive_configuration",
    });
    vi.mocked(dependencies.queue.send).mockRejectedValue(error);
    vi.mocked(dependencies.outbox.recordQueueConfigurationFailureExact).mockResolvedValue({
      outcome: "reconciliation_required",
      attemptNumber: 3,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
      status: "reconciliation_required",
      eventId: MESSAGE.eventId,
      attemptId: ATTEMPT_ID,
      attemptNumber: 3,
      cause: "definitive_configuration",
      errorCode: "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR",
    });
    expect(dependencies.outbox.recordQueueConfigurationFailureExact).toHaveBeenCalledWith({
      ...expectedAttemptScope(),
      errorCode: "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR",
    });
    expect(dependencies.outbox.recordDeliveryUncertain).not.toHaveBeenCalled();
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("durably records a synchronous definitive queue configuration error", async () => {
    const error = new Error("queue binding is malformed");
    const dependencies = publisherDependencies({
      classifyQueueError: () => "definitive_configuration",
    });
    vi.mocked(dependencies.queue.send).mockImplementation(() => {
      throw error;
    });
    vi.mocked(dependencies.outbox.recordQueueConfigurationFailureExact).mockResolvedValue({
      outcome: "retry_scheduled",
      attemptNumber: 1,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toMatchObject({
      status: "retry_scheduled",
      cause: "definitive_configuration",
      errorCode: "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR",
    });
    expect(dependencies.outbox.recordQueueConfigurationFailureExact).toHaveBeenCalledWith({
      ...expectedAttemptScope(),
      errorCode: "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR",
    });
    expect(dependencies.outbox.recordDeliveryUncertain).not.toHaveBeenCalled();
  });

  it("durably diagnoses an unknown queue error classification", async () => {
    const dependencies = publisherDependencies({
      classifyQueueError: vi.fn().mockReturnValue("anything"),
    });
    vi.mocked(dependencies.queue.send).mockRejectedValue(new Error("adapter failed"));
    vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
      outcome: "reconciliation_required",
      attemptNumber: 3,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
      status: "reconciliation_required",
      eventId: MESSAGE.eventId,
      attemptId: ATTEMPT_ID,
      attemptNumber: 3,
      cause: "classifier_contract_invalid",
      diagnosticCode: "PROJECT_PROVISIONING_QUEUE_CLASSIFIER_CONTRACT_INVALID",
    });
    expect(dependencies.outbox.recordDeliveryUncertain).toHaveBeenCalledWith({
      ...expectedAttemptScope(),
      cause: "classifier_contract_invalid",
      diagnosticCode: "PROJECT_PROVISIONING_QUEUE_CLASSIFIER_CONTRACT_INVALID",
    });
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("fails closed when the exact queue configuration failure attempt is stale", async () => {
    const dependencies = publisherDependencies({
      classifyQueueError: () => "definitive_configuration",
    });
    vi.mocked(dependencies.queue.send).mockRejectedValue(new Error("invalid binding"));
    vi.mocked(dependencies.outbox.recordQueueConfigurationFailureExact).mockResolvedValue(null);

    await expect(publishOneProjectProvisioningRequest(dependencies)).rejects.toThrow(
      "Queue configuration failure belongs to a stale project provisioning attempt",
    );
  });

  it("fails closed on an invalid exact queue configuration failure result", async () => {
    const dependencies = publisherDependencies({
      classifyQueueError: () => "definitive_configuration",
    });
    vi.mocked(dependencies.queue.send).mockRejectedValue(new Error("invalid binding"));
    vi.mocked(dependencies.outbox.recordQueueConfigurationFailureExact).mockResolvedValue({
      outcome: "acknowledged",
      attemptNumber: 0,
    } as never);

    await expect(publishOneProjectProvisioningRequest(dependencies)).rejects.toThrow(
      "outbox returned an invalid uncertainty outcome",
    );
  });

  it("aborts a hung queue send at the client deadline and records timeout uncertainty", async () => {
    const dependencies = publisherDependencies({ queueSendTimeoutMilliseconds: 5 });
    let observedSignal: AbortSignal | undefined;
    vi.mocked(dependencies.queue.send).mockImplementation(
      async (_serialized, { signal }) =>
        new Promise<never>(() => {
          observedSignal = signal;
        }),
    );
    vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
      outcome: "reconciliation_required",
      attemptNumber: 3,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toMatchObject({
      status: "reconciliation_required",
      cause: "timeout",
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("never ACKs a queue send that settles after its deadline", async () => {
    const dependencies = publisherDependencies({ queueSendTimeoutMilliseconds: 5 });
    let settle: ((value: "sent") => void) | undefined;
    vi.mocked(dependencies.queue.send).mockImplementation(
      async () =>
        new Promise<"sent">((resolve) => {
          settle = resolve;
        }),
    );
    vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
      outcome: "retry_scheduled",
      attemptNumber: 1,
    });

    const publishing = publishOneProjectProvisioningRequest(dependencies);
    await expect(publishing).resolves.toMatchObject({ cause: "timeout" });
    settle?.("sent");
    await Promise.resolve();
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("surfaces final-attempt reconciliation without ACK", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.queue.send).mockResolvedValue("uncertain");
    vi.mocked(dependencies.outbox.recordDeliveryUncertain).mockResolvedValue({
      outcome: "reconciliation_required",
      attemptNumber: 3,
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toMatchObject({
      status: "reconciliation_required",
      attemptNumber: 3,
    });
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("reports an expired-final-attempt recovery without claiming another event", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.outbox.recoverExpiredFinalProjectProvisioningClaim).mockResolvedValue({
      eventId: MESSAGE.eventId,
      organizationId: MESSAGE.organizationId,
      projectId: MESSAGE.projectId,
      operationId: MESSAGE.operationId,
      attemptId: ATTEMPT_ID,
      attemptNumber: 3,
    });
    vi.mocked(dependencies.outbox.claimProjectProvisioningRequested).mockResolvedValue(null);

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
      status: "reconciliation_recovered",
      eventId: MESSAGE.eventId,
      organizationId: MESSAGE.organizationId,
      projectId: MESSAGE.projectId,
      operationId: MESSAGE.operationId,
      attemptId: ATTEMPT_ID,
      attemptNumber: 3,
    });
  });

  it("can crash after send and before ACK so a replay remains possible", async () => {
    const dependencies = publisherDependencies({
      afterSend: vi.fn().mockRejectedValue(new Error("simulated crash")),
    });

    await expect(publishOneProjectProvisioningRequest(dependencies)).rejects.toThrow(
      "simulated crash",
    );
    expect(dependencies.queue.send).toHaveBeenCalledOnce();
    expect(dependencies.outbox.acknowledgeExact).not.toHaveBeenCalled();
  });

  it("surfaces a stale exact ACK after send instead of claiming false success", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.outbox.acknowledgeExact).mockResolvedValue(false);

    await expect(publishOneProjectProvisioningRequest(dependencies)).rejects.toThrow(
      "queue send succeeded but its outbox attempt is stale",
    );
  });

  it("fails closed when exact invalid-message persistence is stale", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.outbox.claimProjectProvisioningRequested).mockResolvedValue({
      ...claim(),
      payload: {},
    });
    vi.mocked(dependencies.outbox.failInvalidExact).mockResolvedValue(false);

    await expect(publishOneProjectProvisioningRequest(dependencies)).rejects.toThrow(
      "Invalid project provisioning message belongs to a stale outbox attempt",
    );
  });

  it("returns empty when neither recovery nor a supported claim exists", async () => {
    const dependencies = publisherDependencies();
    vi.mocked(dependencies.outbox.claimProjectProvisioningRequested).mockResolvedValue(null);

    await expect(publishOneProjectProvisioningRequest(dependencies)).resolves.toEqual({
      status: "empty",
    });
  });

  it("fails closed when publisher runtime bindings are absent", () => {
    expect(() => createProjectProvisioningPublisher({})).toThrow(
      "Project provisioning publisher requires an outbox binding",
    );
    expect(() =>
      createProjectProvisioningPublisher({
        outbox: publisherDependencies().outbox,
      }),
    ).toThrow("Project provisioning publisher requires a queue binding");
    expect(() =>
      createProjectProvisioningPublisher({
        ...publisherDependencies(),
        afterSend: "not-a-function",
      }),
    ).toThrow("afterSend hook must be a function");
  });

  it("composes a frozen publisher only when all required bindings exist", async () => {
    const publisher = createProjectProvisioningPublisher(publisherDependencies());

    expect(Object.isFrozen(publisher)).toBe(true);
    await expect(publisher.publishOne()).resolves.toMatchObject({ status: "published" });
  });
});

describe("project provisioning consumer and reconciler", () => {
  it("derives a deterministic identity with no credential or payload material", () => {
    expect(deterministicProjectProvisioningWorkflowId(MESSAGE)).toBe(
      `project-provisioning-v1-${MESSAGE.eventId}-${MESSAGE.operationId}`,
    );
    expect(deterministicProjectProvisioningWorkflowId(MESSAGE).length).toBeLessThanOrEqual(100);
  });

  it("does not deduplicate a wrong-event message into the legitimate workflow", () => {
    const wrongEvent = {
      ...MESSAGE,
      eventId: parseUlid("01J00000000000000000000009"),
    };

    expect(deterministicProjectProvisioningWorkflowId(wrongEvent)).not.toBe(
      deterministicProjectProvisioningWorkflowId(MESSAGE),
    );
  });

  it("deduplicates duplicate delivery through the injected atomic completion port", async () => {
    const execute = vi.fn().mockResolvedValue("completed");
    const completeAtomic = vi
      .fn()
      .mockResolvedValueOnce("applied")
      .mockResolvedValueOnce("duplicate");
    const dependencies = consumerDependencies({ execute, completeAtomic });
    const serialized = serializeProjectProvisioningMessageV1(MESSAGE);

    await expect(consumeProjectProvisioningMessage(dependencies, serialized)).resolves.toEqual({
      status: "completed",
      workflowId: deterministicProjectProvisioningWorkflowId(MESSAGE),
      completion: "applied",
    });
    await expect(consumeProjectProvisioningMessage(dependencies, serialized)).resolves.toEqual({
      status: "completed",
      workflowId: deterministicProjectProvisioningWorkflowId(MESSAGE),
      completion: "duplicate",
    });
    expect(execute).toHaveBeenNthCalledWith(1, {
      workflowId: deterministicProjectProvisioningWorkflowId(MESSAGE),
      message: MESSAGE,
    });
    expect(completeAtomic).toHaveBeenCalledTimes(2);
  });

  it("leaves an executing workflow pending without calling completion", async () => {
    const completeAtomic = vi.fn();

    await expect(
      consumeProjectProvisioningMessage(
        consumerDependencies({
          execute: vi.fn().mockResolvedValue("pending"),
          completeAtomic,
        }),
        serializeProjectProvisioningMessageV1(MESSAGE),
      ),
    ).resolves.toEqual({
      status: "pending",
      workflowId: deterministicProjectProvisioningWorkflowId(MESSAGE),
    });
    expect(completeAtomic).not.toHaveBeenCalled();
  });

  it("rejects non-JSON queue bytes before starting a workflow", async () => {
    const execute = vi.fn();

    await expect(
      consumeProjectProvisioningMessage(consumerDependencies({ execute }), "not-json"),
    ).rejects.toThrow("must be valid JSON");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when required runtime bindings are absent", () => {
    expect(() => createProjectProvisioningConsumer({})).toThrow(
      "Project provisioning consumer requires a workflow binding",
    );
    expect(() => createProjectProvisioningConsumer({ workflow: { execute: vi.fn() } })).toThrow(
      "Project provisioning consumer requires an atomic completion binding",
    );
    const withoutFailure = consumerDependencies();
    expect(() =>
      createProjectProvisioningConsumer({
        workflow: withoutFailure.workflow,
        completion: withoutFailure.completion,
      }),
    ).toThrow("Project provisioning consumer requires an atomic failure binding");
    expect(() =>
      createProjectProvisioningConsumer({
        workflow: withoutFailure.workflow,
        completion: withoutFailure.completion,
        failure: withoutFailure.failure,
      }),
    ).toThrow("Project provisioning consumer requires an atomic reconciliation binding");
  });

  it("composes a frozen consumer only when both required bindings exist", async () => {
    const consumer = createProjectProvisioningConsumer(consumerDependencies());

    expect(Object.isFrozen(consumer)).toBe(true);
    await expect(consumer.consume(serializeProjectProvisioningMessageV1(MESSAGE))).resolves.toEqual(
      {
        status: "completed",
        workflowId: deterministicProjectProvisioningWorkflowId(MESSAGE),
        completion: "applied",
      },
    );
  });

  it.each(["failed", "uncertain"] as const)(
    "persists a %s workflow outcome through its dedicated atomic port",
    async (outcome) => {
      const dependencies = consumerDependencies({
        execute: vi.fn().mockResolvedValue(outcome),
      });

      await expect(
        consumeProjectProvisioningMessage(
          dependencies,
          serializeProjectProvisioningMessageV1(MESSAGE),
        ),
      ).resolves.toEqual(
        outcome === "failed"
          ? {
              status: "failed",
              workflowId: deterministicProjectProvisioningWorkflowId(MESSAGE),
              failure: "applied",
            }
          : {
              status: "reconciliation_required",
              workflowId: deterministicProjectProvisioningWorkflowId(MESSAGE),
              reconciliation: "applied",
            },
      );
    },
  );

  it.each(["missing", "anything", null])(
    "rejects unsupported execute outcome %s without persisting completion",
    async (outcome) => {
      const dependencies = consumerDependencies({ execute: vi.fn().mockResolvedValue(outcome) });

      await expect(
        consumeProjectProvisioningMessage(
          dependencies,
          serializeProjectProvisioningMessageV1(MESSAGE),
        ),
      ).rejects.toThrow("workflow returned an unsupported outcome");
      expect(dependencies.completion.completeAtomic).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["completion", "completed"],
    ["failure", "failed"],
    ["reconciliation", "uncertain"],
  ] as const)("rejects an unsupported %s port outcome", async (port, workflowOutcome) => {
    const dependencies = consumerDependencies({
      execute: vi.fn().mockResolvedValue(workflowOutcome),
      ...(port === "completion"
        ? { completeAtomic: vi.fn().mockResolvedValue("replayed") }
        : port === "failure"
          ? { failAtomic: vi.fn().mockResolvedValue("replayed") }
          : { requireReconciliationAtomic: vi.fn().mockResolvedValue("replayed") }),
    });

    await expect(
      consumeProjectProvisioningMessage(
        dependencies,
        serializeProjectProvisioningMessageV1(MESSAGE),
      ),
    ).rejects.toThrow(`${port} port returned an unsupported outcome`);
  });
});

function claim() {
  return {
    ...MESSAGE,
    payload: { projectId: MESSAGE.projectId, operationId: MESSAGE.operationId },
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    maxAttempts: 3,
  } as const;
}

function expectedAttemptScope() {
  return {
    eventId: MESSAGE.eventId,
    organizationId: MESSAGE.organizationId,
    projectId: MESSAGE.projectId,
    operationId: MESSAGE.operationId,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    maxAttempts: 3,
  } as const;
}

function consumerDependencies(
  options: {
    execute?: ProjectProvisioningConsumerDependencies["workflow"]["execute"];
    completeAtomic?: ProjectProvisioningConsumerDependencies["completion"]["completeAtomic"];
    failAtomic?: ProjectProvisioningConsumerDependencies["failure"]["failAtomic"];
    requireReconciliationAtomic?: ProjectProvisioningConsumerDependencies["reconciliation"]["requireReconciliationAtomic"];
  } = {},
): ProjectProvisioningConsumerDependencies {
  return {
    workflow: {
      execute: options.execute ?? vi.fn().mockResolvedValue("completed"),
    },
    completion: {
      completeAtomic: options.completeAtomic ?? vi.fn().mockResolvedValue("applied"),
    },
    failure: {
      failAtomic: options.failAtomic ?? vi.fn().mockResolvedValue("applied"),
    },
    reconciliation: {
      requireReconciliationAtomic:
        options.requireReconciliationAtomic ?? vi.fn().mockResolvedValue("applied"),
    },
  };
}

function publisherDependencies(
  options: {
    calls?: string[];
    afterSend?: () => Promise<void>;
    queueSendTimeoutMilliseconds?: number;
    classifyQueueError?: ProjectProvisioningPublisherDependencies["classifyQueueError"];
  } = {},
): ProjectProvisioningPublisherDependencies {
  const calls = options.calls ?? [];
  return {
    outbox: {
      recoverExpiredFinalProjectProvisioningClaim: vi.fn(async () => {
        calls.push("recover");
        return null;
      }),
      claimProjectProvisioningRequested: vi.fn(async () => {
        calls.push("claim");
        return claim();
      }),
      acknowledgeExact: vi.fn(async () => {
        calls.push("ack");
        return true;
      }),
      recordDeliveryUncertain: vi.fn(),
      recordQueueConfigurationFailureExact: vi.fn(),
      failInvalidExact: vi.fn(async () => true),
    },
    queue: {
      send: vi.fn(async () => {
        calls.push("send");
        return "sent" as const;
      }),
    },
    queueSendTimeoutMilliseconds: options.queueSendTimeoutMilliseconds ?? 1_000,
    classifyQueueError: options.classifyQueueError ?? (() => "uncertain"),
    ...(options.afterSend === undefined ? {} : { afterSend: options.afterSend }),
  };
}
