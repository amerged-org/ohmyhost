import { createResendProvider } from "@ohmyhost/provider-resend";
import { renderSignupFeedbackEmail } from "./signup-feedback-template.js";

type Claim = { userId: string; claimToken: string; leaseUntil: string };
type State = "pending" | "skipped" | "accepted" | "uncertain";
interface Store {
  claim(input: { now: string }): Promise<Claim[]>;
  begin(input: { userId: string; claimToken: string; now: string }): Promise<boolean>;
  finish(input: {
    userId: string;
    claimToken: string;
    now: string;
    state: State;
    providerMessageId: string | null;
  }): Promise<boolean>;
}
interface Recipients {
  resolve(input: { userId: string; claimToken: string }): Promise<unknown>;
}

/** Private dispatch. Once a send may have begun, uncertainty is terminal rather than replayed. */
export function createSignupFeedbackDispatcher(input: {
  store: Store;
  recipients: Recipients;
  now: () => Date;
  sender: {
    send(input: {
      userId: string;
      email: string;
      firstName: string | null;
    }): Promise<{ messageId: string }>;
  };
}) {
  return {
    async sync() {
      const claims = await input.store.claim({ now: input.now().toISOString() });
      let accepted = 0,
        skipped = 0,
        unresolved = 0;
      for (const claim of claims) {
        const key = { userId: claim.userId, claimToken: claim.claimToken };
        const finish = (state: State, providerMessageId: string | null = null) =>
          input.store.finish({ ...key, state, providerMessageId, now: input.now().toISOString() });
        let recipient: ReturnType<typeof parseRecipient>;
        try {
          recipient = parseRecipient(await input.recipients.resolve(key));
        } catch {
          try {
            await finish("pending");
          } catch {
            /* claim expiry makes a pre-send failure retryable */
          }
          unresolved++;
          continue;
        }
        if (recipient.status !== "eligible") {
          try {
            if (await finish(recipient.status === "unverified" ? "pending" : "skipped")) {
              if (recipient.status === "missing") skipped++;
              else unresolved++;
            } else unresolved++;
          } catch {
            unresolved++;
          }
          continue;
        }
        try {
          if (!(await input.store.begin({ ...key, now: input.now().toISOString() }))) {
            unresolved++;
            continue;
          }
        } catch {
          // begin may have committed; lease expiry must mark this attempt uncertain.
          unresolved++;
          continue;
        }
        try {
          const result = await input.sender.send({
            userId: claim.userId,
            email: recipient.email,
            firstName: recipient.firstName,
          });
          if (!/^[A-Za-z0-9._-]{1,256}$/u.test(result.messageId))
            throw new Error("invalid provider receipt");
          if (await finish("accepted", result.messageId)) accepted++;
          else unresolved++;
        } catch {
          try {
            await finish("uncertain");
          } catch {
            /* expiry preserves ambiguity */
          }
          unresolved++;
        }
      }
      return { claimed: claims.length, accepted, skipped, unresolved };
    },
  };
}

function parseRecipient(
  raw: unknown,
):
  | { status: "eligible"; email: string; firstName: string | null }
  | { status: "missing" | "unverified" } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("recipient_invalid");
  const value = raw as Record<string, unknown>;
  if (
    value["eligible"] === false &&
    Object.keys(value).sort().join(",") === "eligible,reason" &&
    (value["reason"] === "missing" || value["reason"] === "unverified")
  )
    return { status: value["reason"] };
  if (
    value["eligible"] !== true ||
    Object.keys(value).sort().join(",") !== "eligible,email,firstName" ||
    typeof value["email"] !== "string" ||
    value["email"].length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/u.test(value["email"]) ||
    (value["firstName"] !== null &&
      (typeof value["firstName"] !== "string" || value["firstName"].length > 256))
  )
    throw new Error("recipient_invalid");
  return {
    status: "eligible",
    email: value["email"],
    firstName: value["firstName"] as string | null,
  };
}

export function createSignupFeedbackSender(input: {
  apiKey: string;
  platform: "development" | "production";
  replyTo: string;
  senderName: string;
  profileUrl?: string;
  fetch?: typeof globalThis.fetch;
}) {
  const provider = createResendProvider({
    apiKey: input.apiKey,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  return {
    send(notice: { userId: string; email: string; firstName: string | null }) {
      if (!/^user_[A-Za-z0-9_]{1,128}$/u.test(notice.userId))
        throw new TypeError("Invalid user ID");
      const message = renderSignupFeedbackEmail(notice.firstName, {
        name: input.senderName,
        ...(input.profileUrl ? { profileUrl: input.profileUrl } : {}),
      });
      return provider.send({
        from: input.platform === "production" ? "no-reply@ohmyho.st" : "no-reply@dev.ohmyho.st",
        fromName: `${input.senderName} from ohmyho.st`,
        replyTo: input.replyTo,
        to: notice.email,
        ...message,
        idempotencyKey: `signup-feedback:${input.platform}:${notice.userId}`,
      });
    },
  };
}
