import { describe, expect, it } from "vitest";
import { mailDeliveryDecision, mailPrice, MAIL_ACCESS_WINDOW_MS } from "./mail-delivery.js";
const received = Date.parse("2026-09-22T00:00:00Z");
describe("mail delivery budget", () => {
  it("allows one initial attempt and only three retries at 1, 24 and 71 hours", () => {
    for (const [attempts, hours] of [
      [0, 0],
      [1, 1],
      [2, 24],
      [3, 71],
    ] as const) {
      expect(
        mailDeliveryDecision({
          receivedAt: received,
          firstAttemptAt: attempts ? received : null,
          attempts,
          delivered: false,
          now: received + hours * 3600000,
        }),
      ).toEqual({ state: "due" });
      if (attempts)
        expect(
          mailDeliveryDecision({
            receivedAt: received,
            firstAttemptAt: received,
            attempts,
            delivered: false,
            now: received + hours * 3600000 - 1,
          }).state,
        ).toBe("waiting");
    }
    expect(
      mailDeliveryDecision({
        receivedAt: received,
        firstAttemptAt: received,
        attempts: 4,
        delivered: false,
        now: received + 71 * 3600000,
      }),
    ).toEqual({ state: "delivery_failed" });
  });
  it("never extends the original receipt deadline, including delayed ingress", () => {
    expect(
      mailDeliveryDecision({
        receivedAt: received,
        firstAttemptAt: received + 48 * 3600000,
        attempts: 2,
        delivered: false,
        now: received + MAIL_ACCESS_WINDOW_MS,
      }),
    ).toEqual({ state: "expired" });
    expect(
      mailDeliveryDecision({
        receivedAt: received,
        firstAttemptAt: null,
        attempts: 0,
        delivered: false,
        now: received + MAIL_ACCESS_WINDOW_MS,
      }),
    ).toEqual({ state: "expired" });
  });
  it("stops on success and rejects malformed counters and times", () => {
    expect(
      mailDeliveryDecision({
        receivedAt: received,
        firstAttemptAt: received,
        attempts: 1,
        delivered: true,
        now: received,
      }),
    ).toEqual({ state: "delivered" });
    for (const attempts of [-1, 5, 1.5])
      expect(() =>
        mailDeliveryDecision({
          receivedAt: received,
          firstAttemptAt: received,
          attempts,
          delivered: false,
          now: received,
        }),
      ).toThrow();
    expect(() =>
      mailDeliveryDecision({
        receivedAt: NaN,
        firstAttemptAt: null,
        attempts: 0,
        delivered: false,
        now: received,
      }),
    ).toThrow();
  });
  it("charges 0.18 credits per sent or received message using integers", () => {
    expect(mailPrice(1n)).toEqual({ providerCostMicros: 900n, chargeMicros: 180000n });
    expect(mailPrice(2000n).chargeMicros).toBe(360000000n);
    expect(() => mailPrice(-1n)).toThrow();
  });
});
