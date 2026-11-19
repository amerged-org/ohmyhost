import { webcrypto } from "node:crypto";

import { expect, test, vi } from "vitest";

import { createMailGatewayEmailSender } from "../packages/customer-auth-better-auth/src/mail-gateway.js";
import { validateResendSendInput } from "../packages/provider-resend/src/index.js";

// Each row is a recipient and whether the customer sender and the platform gateway must both accept it. The
// customer sender copies the gateway's rule (requireEmail in provider-resend) by comment, so this table is what
// keeps the two in step.
const RECIPIENTS: readonly (readonly [string, boolean])[] = [
  ["o'brien@example.com", true],
  ["bob_@example.com", true],
  ["_bob@example.com", true],
  ["a.b+tag@sub.example.co.uk", true],
  [`${"a".repeat(242)}@example.com`, true],
  [`${"a".repeat(243)}@example.com`, false],
  ["bob smith@example.com", false],
  ["<bob>@example.com", false],
  ["bob@localhost", false],
  ["bob@example.c", false],
  ["bob@@example.com", false],
  ["", false],
];

test("the customer mail sender and the platform gateway accept and refuse the same recipients", async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      {
        state: "accepted",
        request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        message_id: "drift-check-message",
      },
      { status: 202 },
    ),
  );
  const sender = createMailGatewayEmailSender({
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    gatewayOrigin: "https://mail.example.test",
    key: "A".repeat(43),
    fetch,
    crypto: webcrypto as unknown as Crypto,
    timeoutMilliseconds: 100,
  });

  for (const [to, accepted] of RECIPIENTS) {
    const requestsBefore = fetch.mock.calls.length;
    const sent = await sender
      .send({ kind: "verification", to, url: "https://app.example.test/verify?token=a" })
      .then(
        () => true,
        () => false,
      );
    expect(sent, `customer sender for ${to}`).toBe(accepted);
    expect(fetch.mock.calls.length - requestsBefore, `gateway request for ${to}`).toBe(
      accepted ? 1 : 0,
    );

    const platformAccepts = (() => {
      try {
        validateResendSendInput({
          from: "notify@app.example.test",
          to,
          subject: "Verify your account",
          text: "Verify your account",
          idempotencyKey: "drift-check",
        });
        return true;
      } catch {
        return false;
      }
    })();
    expect(platformAccepts, `platform gateway for ${to}`).toBe(accepted);
  }
});
