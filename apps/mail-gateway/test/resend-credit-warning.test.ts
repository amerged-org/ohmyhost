import { describe, expect, it } from "vitest";
import { createResendCreditWarningSender } from "../src/resend-credit-warning.js";

const notice = {
  organizationId: "01H00000000000000000000601",
  userId: "user_owner",
  exhaustedAt: "2026-09-22T09:00:00.000Z",
  recipient: "owner@example.net",
};
describe("scoped Resend platform warning sender", () => {
  it.each([
    ["development", "no-reply@dev.ohmyho.st", "[Development] ohmyho.st credit balance warning"],
    ["production", "no-reply@ohmyho.st", "ohmyho.st credit balance warning"],
  ] as const)(
    "sends one bounded %s notice from its own verified domain",
    async (platform, from, subject) => {
      const requests: Request[] = [];
      const sender = createResendCreditWarningSender({
        apiKey: "re_scoped_warning",
        platform,
        now: () => new Date("2026-09-22T10:00:00.000Z"),
        fetch: async (url, init) => {
          requests.push(new Request(url, init));
          return Response.json({ id: "provider-notice-1" });
        },
      });
      expect(await sender.send(notice)).toEqual({
        status: "accepted",
        messageId: "provider-notice-1",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer re_scoped_warning");
      // One owner of one exhaustion has one key, so a retry of the same warning is the same email.
      expect(requests[0]?.headers.get("idempotency-key")).toBe(
        `warning:${platform}:${notice.organizationId}:${notice.exhaustedAt}:${notice.userId}`,
      );
      expect(await requests[0]?.json()).toMatchObject({
        from,
        to: [notice.recipient],
        subject,
        tags: [
          { name: "organization_id", value: notice.organizationId },
          { name: "platform", value: platform },
        ],
      });
      await expect(
        sender.send({ ...notice, exhaustedAt: "2026-09-23T10:00:00.000Z" }),
      ).rejects.toThrow("Invalid notice time");
      expect(requests).toHaveLength(1);
    },
  );
});
