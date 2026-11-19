import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsumer, parseMarker, signEnvelope, verifyEnvelope } from "../src/runtime.js";
const marker = {
  schemaVersion: "ohmyhost.diagnostic-marker/v1",
  diagnosticId: "01H00000000000000000000901",
  organizationId: "01H00000000000000000000902",
  projectId: "01H00000000000000000000903",
  environmentId: "01H00000000000000000000904",
  deploymentId: "01H00000000000000000000905",
  source: "runtime",
  code: "RUNTIME_FAILED",
  occurredAt: new Date().toISOString(),
};
const key = Buffer.alloc(32, 7).toString("base64");
describe("diagnostic ingestion", () => {
  afterEach(() => vi.useRealTimers());
  it("accepts only exact structured markers and drops hostile raw tail values", () => {
    expect(parseMarker(marker)).toMatchObject({ code: "RUNTIME_FAILED" });
    for (const value of [
      "secret=abc",
      new Error("raw exception"),
      { ...marker, cookie: "session=secret" },
      { ...marker, code: "raw secret" },
    ])
      expect(parseMarker(value)).toBeNull();
  });
  it("signs and verifies exact queue envelopes", async () => {
    const payload = required(parseMarker(marker));
    const envelope = await signEnvelope(payload, "producer-a", key);
    await expect(verifyEnvelope(envelope, "producer-a", key)).resolves.toEqual(payload);
    await expect(
      verifyEnvelope({ ...envelope, producerId: "attacker" }, "producer-a", key),
    ).resolves.toBeNull();
  });
  it("acks only after committed persistence and retries failures", async () => {
    const payload = required(parseMarker(marker));
    const envelope = await signEnvelope(payload, "producer-a", key);
    const origin = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(origin);
    const persisted = vi.fn(async (input: unknown) => {
        void input;
      }),
      committed = vi.fn(),
      retry = vi.fn();
    await createConsumer(
      { recordDiagnostic: persisted },
      "producer-a",
      key,
    )({ messages: [{ body: envelope, ack: committed, retry }] });
    expect(persisted).toHaveBeenCalledWith(
      expect.objectContaining({
        id: payload.diagnosticId,
        code: "RUNTIME_FAILED",
        recordedAt: new Date(origin).toISOString(),
      }),
    );
    expect(persisted.mock.calls[0]?.[0]).not.toHaveProperty("excerpt");
    expect(committed).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const lost = vi.fn();
    await createConsumer(
      {
        recordDiagnostic: async () => {
          throw new Error("store down");
        },
      },
      "producer-a",
      key,
    )({ messages: [{ body: envelope, ack: lost, retry }] });
    expect(lost).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });
  it("acknowledges the notification of the retired usage bucket rule without a write or a retry", async () => {
    const persisted = vi.fn(),
      ack = vi.fn(),
      retry = vi.fn();
    await createConsumer(
      { recordDiagnostic: persisted },
      "producer-a",
      key,
    )({
      messages: [
        {
          body: {
            account: "00000000000000000000000000000001",
            action: "PutObject",
            bucket: "ohmyho-usage-development",
            object: {
              key: "usage/20261030/20261030T090000Z_20261030T090500Z_a1b2.log.gz",
              size: 1,
            },
            eventTime: "2026-10-30T09:05:01.000Z",
          },
          ack,
          retry,
        },
      ],
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
  });
});
function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected marker");
  return value;
}
