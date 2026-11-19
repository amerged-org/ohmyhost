import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createQueueMessageRouter } from "../src/composition.js";
import { consumeProjectProvisioningQueueBatch } from "../src/queue-consumer.js";
import {
  createManagedSourcePublicationConsumer,
  parseManagedSourcePublicationMessage,
  sendWithDeadline,
  type InitializationState,
  type PublicationState,
} from "../src/managed-source-jobs.js";

const id = (n: number) => parseUlid(String(n).padStart(26, "0"));
const message = {
  version: 1,
  eventType: "ManagedSourcePublicationRequestedV1",
  eventId: id(23),
  organizationId: id(2),
  projectId: id(1),
  operationId: id(20),
  billingEpochId: id(4),
  environmentId: id(10),
} as const;

it("routes only exact proven managed locators and retries a processor response without durable completion", async () => {
  for (const invalid of [
    null,
    { ...message, version: 2 },
    { ...message, eventType: "ExternalSourceChange" },
    { ...message, token: "private-test-value" },
    { ...message, eventId: "invalid" },
    { ...message, eventId: 1 },
  ])
    expect(() => parseManagedSourcePublicationMessage(invalid)).toThrow();
  expect(parseManagedSourcePublicationMessage(message)).toEqual(message);
  const readPublication = vi.fn(
    async (): Promise<PublicationState> => ({
      state: "sealed",
      operationState: "running",
      initializationState: null,
    }),
  );
  const process = vi.fn(async () => ({ state: "committed" as const }));
  const consumer = createManagedSourcePublicationConsumer({
    state: { readPublication, readInitialization: vi.fn() },
    processor: { process, initialize: vi.fn() },
  });
  const delivery = { body: JSON.stringify(message), ack: vi.fn(), retry: vi.fn() };
  const provisioning = { consume: vi.fn() },
    product = { consume: vi.fn() };
  await consumeProjectProvisioningQueueBatch(
    { messages: [delivery] },
    createQueueMessageRouter({ provisioning, product, managedSource: consumer }),
  );
  expect(delivery.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  expect(delivery.ack).not.toHaveBeenCalled();
  expect(provisioning.consume).not.toHaveBeenCalled();
  expect(product.consume).not.toHaveBeenCalled();
  expect(process).toHaveBeenCalledWith({
    organizationId: id(2),
    projectId: id(1),
    operationId: id(20),
  });
  readPublication.mockRejectedValueOnce(
    new Error("Managed source Queue message has no exact durable provenance"),
  );
  await expect(consumer.consume(JSON.stringify(message))).rejects.toThrow(/provenance/u);
  expect(process).toHaveBeenCalledOnce();
  process.mockResolvedValueOnce({ state: "staging" } as never);
  await expect(consumer.consume(JSON.stringify(message))).resolves.toMatchObject({
    status: "pending",
  });
  process.mockResolvedValueOnce({ state: "committed", token: "private-test-value" } as never);
  await expect(consumer.consume(JSON.stringify(message))).rejects.toThrow(/response/u);
  readPublication.mockResolvedValue({
    state: "committed",
    operationState: "succeeded",
    initializationState: "initializing",
  });
  await expect(consumer.consume(JSON.stringify(message))).resolves.toMatchObject({
    status: "pending",
  });
  process.mockImplementationOnce(async () => {
    readPublication.mockResolvedValue({
      state: "committed",
      operationState: "succeeded",
      initializationState: "initialized",
    });
    return { state: "committed" };
  });
  await expect(consumer.consume(JSON.stringify(message))).resolves.toMatchObject({
    status: "completed",
    durable: "managed_source_terminal",
  });
  const readInitialization = vi.fn(
    async (): Promise<InitializationState> => ({
      state: "initializing",
      childOperationId: id(30),
      handoff: true,
      childState: "sealed",
      childOperationState: "running",
    }),
  );
  const initialize = vi.fn(async () => ({ state: "pending" as const, childOperationId: id(30) }));
  const initConsumer = createManagedSourcePublicationConsumer({
    state: { readPublication: vi.fn(), readInitialization },
    processor: { process: vi.fn(), initialize },
  });
  const initMessage = { ...message, eventType: "ManagedSourceInitializationRequestedV1" };
  await expect(initConsumer.consume(JSON.stringify(initMessage))).resolves.toMatchObject({
    status: "completed",
    durable: "managed_source_handoff",
  });
  readInitialization.mockResolvedValue({
    state: "initializing",
    childOperationId: id(30),
    handoff: false,
    childState: "staging",
    childOperationState: "running",
  });
  await expect(initConsumer.consume(JSON.stringify(initMessage))).resolves.toMatchObject({
    status: "pending",
  });
});

it("reports a Queue send as timed out after its deadline and as uncertain when it throws", async () => {
  vi.useFakeTimers();
  try {
    const signals: (AbortSignal | undefined)[] = [];
    const hanging = {
      send: (_message: string, options: { readonly signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise<"sent">(() => undefined);
      },
    };
    const pending = sendWithDeadline(hanging, "{}");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe("timeout");
    expect(signals[0]?.aborted).toBe(true);
    await expect(
      sendWithDeadline(
        {
          send: async () => {
            throw new Error("reply lost");
          },
        },
        "{}",
      ),
    ).resolves.toBe("uncertain");
    await expect(sendWithDeadline({ send: async () => "sent" as const }, "{}")).resolves.toBe(
      "sent",
    );
  } finally {
    vi.useRealTimers();
  }
});
