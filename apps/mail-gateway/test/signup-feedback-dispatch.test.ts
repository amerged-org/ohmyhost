import { expect, it, vi } from "vitest";
import {
  createSignupFeedbackDispatcher,
  createSignupFeedbackSender,
} from "../src/signup-feedback-dispatch.js";
import { renderSignupFeedbackEmail } from "../src/signup-feedback-template.js";
import { createD1SignupFeedbackPersistence } from "../src/d1-signup-feedback-persistence.js";

const now = () => new Date("2026-11-13T12:00:00.000Z");
const token = "00000000-0000-4000-8000-000000000001";

it("renders escaped personal content and sends the same template with the approved reply address", async () => {
  const identity = { name: "Avery", profileUrl: "https://example.com/contact" };
  const message = renderSignupFeedbackEmail("<Avery>", identity);
  expect(message.text).toBe(
    [
      "Hey <Avery>, Avery here, the builder behind ohmyho.st.",
      "I have one question, and one line is enough to answer it:",
      "What's the one thing that annoyed you so far?",
      'Just hit reply. Or tell your agent: "send feedback to ohmyho.st".',
      "I personally read every reply and answer each one. What you tell me decides what I build or fix next.",
      "Happy building,\nAvery (https://example.com/contact)",
      "P.S. The ten best replies per month get a year of Paid, free. Honest beats polite.",
      "—\nohmyho.st\nHosting for vibe-coded apps.",
    ].join("\n\n"),
  );
  expect(message.subject).toBe("<Avery>, one question");
  expect(message.html).toContain("Hey &lt;Avery&gt;, Avery here, the builder behind ohmyho.st.");
  expect(message.html).toContain(
    '<p style="margin:0 0 20px">Happy building,<br><a href="https://example.com/contact">Avery</a></p>',
  );
  expect(message.html).toContain(
    '<p style="margin:0 0 20px"><strong>What&#39;s the one thing that annoyed you so far?</strong></p>',
  );
  expect(message.html).toContain(
    "<u>I personally</u> read every reply and answer each one. What you tell me decides what I build or fix next.",
  );
  expect(message.html).toContain(
    '<p style="margin:0 0 20px"><strong>P.S. The ten best replies per month get a year of Paid, free. Honest beats polite.</strong></p>',
  );
  expect(message.html).toContain("/brand/assets/omega-dark.png");
  expect(message.html).not.toContain("<blockquote");
  expect(renderSignupFeedbackEmail(null).subject).toBe("One question");
  expect(renderSignupFeedbackEmail(null, identity).text).toMatch(
    /^Hey, Avery here, the builder behind ohmyho\.st\./u,
  );
  expect(renderSignupFeedbackEmail("A\r\nB").subject).toBe("A  B, one question");
  let request: Request | undefined;
  const sender = createSignupFeedbackSender({
    apiKey: "re_test",
    platform: "production",
    replyTo: "support@example.com",
    senderName: identity.name,
    profileUrl: identity.profileUrl,
    fetch: async (url, init) => {
      request = new Request(url, init);
      return Response.json({ id: "message-1" });
    },
  });
  expect(
    await sender.send({ userId: "user_123", email: "person@example.com", firstName: "<Avery>" }),
  ).toEqual({ messageId: "message-1" });
  expect(request?.headers.get("idempotency-key")).toBe("signup-feedback:production:user_123");
  expect(await request?.json()).toMatchObject({
    ...message,
    from: "Avery from ohmyho.st <no-reply@ohmyho.st>",
    to: ["person@example.com"],
    reply_to: "support@example.com",
  });
});

it("handles verified, unverified, deleted and uncertain recipients without repeating a send", async () => {
  const users = ["ok", "unverified", "missing", "uncertain", "lookup"].map((name) => ({
    userId: `user_${name}`,
    claimToken: token,
    leaseUntil: "2026-11-13T12:05:00.000Z",
  }));
  const finishes: { userId: string; state: string }[] = [];
  const send = vi.fn(async ({ userId }: { userId: string }) => {
    if (userId === "user_uncertain") throw new Error("provider response unknown");
    return { messageId: "message-1" };
  });
  const worker = createSignupFeedbackDispatcher({
    now,
    store: {
      claim: async () => users,
      begin: async () => true,
      finish: async (row) => {
        finishes.push(row);
        return true;
      },
    },
    recipients: {
      resolve: async ({ userId }) => {
        if (userId === "user_lookup") throw new Error("transient");
        if (userId === "user_unverified") return { eligible: false, reason: "unverified" };
        if (userId === "user_missing") return { eligible: false, reason: "missing" };
        return { eligible: true, email: "person@example.com", firstName: "Avery" };
      },
    },
    sender: { send },
  });
  expect(await worker.sync()).toEqual({ claimed: 5, accepted: 1, skipped: 1, unresolved: 3 });
  expect(finishes).toEqual([
    expect.objectContaining({
      userId: "user_ok",
      state: "accepted",
      providerMessageId: "message-1",
    }),
    expect.objectContaining({ userId: "user_unverified", state: "pending" }),
    expect.objectContaining({ userId: "user_missing", state: "skipped" }),
    expect.objectContaining({ userId: "user_uncertain", state: "uncertain" }),
    expect.objectContaining({ userId: "user_lookup", state: "pending" }),
  ]);
  expect(send).toHaveBeenCalledTimes(2);
});

it("requires an active claim before sending and validates private Core replies", async () => {
  const send = vi.fn();
  const raw = {
    claim: async () => [
      { userId: "user_123", claimToken: token, leaseUntil: "2026-11-13T12:05:00.000Z" },
    ],
    begin: async () => false,
    finish: async () => true,
  };
  const store = createD1SignupFeedbackPersistence(raw);
  const worker = createSignupFeedbackDispatcher({
    now,
    store,
    recipients: {
      resolve: async () => ({ eligible: true, email: "person@example.com", firstName: null }),
    },
    sender: { send },
  });
  expect(await worker.sync()).toEqual({ claimed: 1, accepted: 0, skipped: 0, unresolved: 1 });
  expect(send).not.toHaveBeenCalled();
  await expect(
    createD1SignupFeedbackPersistence({
      ...raw,
      claim: async () => [{ userId: "not-a-user" }],
    }).claim({ now: now().toISOString() }),
  ).rejects.toThrow();
  expect(() => createD1SignupFeedbackPersistence({})).toThrow();
});
