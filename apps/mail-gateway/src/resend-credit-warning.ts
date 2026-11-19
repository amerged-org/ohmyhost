import { ORGANIZATION_CREDIT_GRACE_MILLISECONDS } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";
import { createResendProvider } from "@ohmyhost/provider-resend";
export function createResendCreditWarningSender(input: {
  apiKey: string;
  platform: "development" | "production";
  now: () => Date;
  fetch?: typeof globalThis.fetch;
}) {
  const provider = createResendProvider({
    apiKey: input.apiKey,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  if (!["development", "production"].includes(input.platform))
    throw new TypeError("Invalid notification environment");
  return {
    async send(notice: {
      organizationId: string;
      exhaustedAt: string;
      userId: string;
      recipient: string;
    }) {
      parseUlid(notice.organizationId);
      if (
        !Number.isFinite(Date.parse(notice.exhaustedAt)) ||
        Date.parse(notice.exhaustedAt) > input.now().getTime()
      )
        throw new TypeError("Invalid notice time");
      const domain = input.platform === "production" ? "ohmyho.st" : "dev.ohmyho.st";
      const deadline = new Date(
        Date.parse(notice.exhaustedAt) + ORGANIZATION_CREDIT_GRACE_MILLISECONDS,
      ).toISOString();
      const sent = await provider.send({
        from: `no-reply@${domain}`,
        to: notice.recipient,
        subject: `${input.platform === "development" ? "[Development] " : ""}ohmyho.st credit balance warning`,
        text: [
          `Organization ${notice.organizationId} has exhausted its available ohmyho.st credits.`,
          `Your seven-day grace period ends at ${deadline}.`,
          `Your data is not deleted because credits run out. Diagnosis, credit purchase, cancellation and export remain available.`,
          `Return to your agent to check your organization balance and request a secure payment link. No automatic purchase is made.`,
        ].join("\n\n"),
        // The same owner of the same exhaustion is warned once, even when a retry repeats the request.
        idempotencyKey: `warning:${input.platform}:${notice.organizationId}:${notice.exhaustedAt}:${notice.userId}`,
        tags: { organization_id: notice.organizationId, platform: input.platform },
      });
      return { status: "accepted" as const, messageId: sent.messageId };
    },
  };
}
