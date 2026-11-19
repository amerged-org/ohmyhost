import type {
  MailScope,
  readReceivedMail,
  claimReceivedMailAttempt,
  completeReceivedMailAttempt,
  listDueReceivedMail,
  expireReceivedMail,
  listReceivedMail,
} from "@ohmyhost/database";
import { parseUlid, mailDeliveryDecision, type Ulid } from "@ohmyhost/platform";
import {
  createResendProvider,
  mailWebhookSecret,
  mailWebhookHeaders,
  requirePublicMailWebhook,
} from "@ohmyhost/provider-resend";
import {
  streamMailAttachment,
  MailContentExpiredError,
  MailAttachmentScopeUnavailableError,
} from "./mail-attachment-stream.js";
export { MailContentExpiredError, MailAttachmentTooLargeError } from "./mail-attachment-stream.js";
/** Local suppliers keep the callback clocks; no callback or SQL crosses Core RPC. */
export interface InboundMailPersistence {
  read(input: () => Parameters<typeof readReceivedMail>[1]): ReturnType<typeof readReceivedMail>;
  claim(
    input: () => Parameters<typeof claimReceivedMailAttempt>[1],
  ): ReturnType<typeof claimReceivedMailAttempt>;
  complete(
    input: () => Parameters<typeof completeReceivedMailAttempt>[1],
  ): ReturnType<typeof completeReceivedMailAttempt>;
  list(input: () => Parameters<typeof listReceivedMail>[1]): ReturnType<typeof listReceivedMail>;
  due(now: () => string): ReturnType<typeof listDueReceivedMail>;
  defer(
    input: () => {
      organizationId: Ulid;
      projectId: Ulid;
      environmentId: Ulid;
      messageId: Ulid;
      attempt: number;
      now: string;
    },
  ): Promise<void>;
  expire(now: () => string): ReturnType<typeof expireReceivedMail>;
}
interface DeliveryRetryResult {
  attempted: boolean;
  delivered?: boolean;
}
interface DeliveryCommandScope {
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
  key: string;
}
export interface DeliveryCommandPersistence {
  accept(
    input: () => DeliveryCommandScope & { digest: Uint8Array; now: string },
  ): Promise<{ created: boolean; response: unknown; claimedAttempt: number | null }>;
  resume(input: () => DeliveryCommandScope & { now: string }): Promise<boolean>;
  complete(
    input: () => DeliveryCommandScope & { response: DeliveryRetryResult; now: string },
  ): Promise<void>;
}
export function createInboundMailDelivery(input: {
  persistence: InboundMailPersistence;
  apiKey: string;
  signingKey: string;
  now: () => Date;
  fetch?: typeof globalThis.fetch;
  publicTarget?: typeof requirePublicMailWebhook;
  maximumAttachmentBytes?: number;
  signal?: AbortSignal | undefined;
}) {
  const maximumAttachmentBytes = input.maximumAttachmentBytes ?? 50 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maximumAttachmentBytes) ||
    maximumAttachmentBytes < 1 ||
    maximumAttachmentBytes > 50 * 1024 * 1024
  )
    throw new TypeError("Invalid mail attachment limit");
  const rawFetcher = input.fetch ?? globalThis.fetch;
  const signal = input.signal;
  const fetcher: typeof globalThis.fetch =
    signal === undefined
      ? rawFetcher
      : (request, init) =>
          rawFetcher(request, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          });
  const provider = createResendProvider({ apiKey: input.apiKey, fetch: fetcher });
  const publicTarget = input.publicTarget ?? requirePublicMailWebhook;
  const persistence = input.persistence;
  async function read(scope: MailScope & { messageId: string }) {
    const messageId = parseUlid(scope.messageId);
    const row = await persistence.read(() => ({
      ...scope,
      messageId,
      now: input.now().toISOString(),
    }));
    if (!row) return null;
    if (row.state === "expired") throw new MailContentExpiredError();
    return row;
  }
  async function content(scope: MailScope & { messageId: string }) {
    const row = await read(scope);
    if (!row) return null;
    const message = await provider.getReceived(row.provider_message_id);
    // Recheck after external I/O: revocation and the deadline can occur during the provider call.
    if (!(await read(scope))) return null;
    return {
      id: row.message_id,
      domain: row.domain,
      received_at: row.received_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
      from: message.from,
      to: message.to.filter((to) => to.slice(to.lastIndexOf("@") + 1).toLowerCase() === row.domain),
      subject: message.subject,
      text: message.text,
      html: message.html,
      message_id: message.messageId,
      attachments: message.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        content_type: a.contentType,
        download_path: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/mail/messages/${scope.messageId}/attachments/${a.id}`,
      })),
    };
  }
  async function deliver(
    scope: MailScope & { messageId: string; manual?: boolean; commandKey?: string },
  ) {
    let before: Awaited<ReturnType<typeof read>>;
    try {
      before = await read(scope);
    } catch (error) {
      if (error instanceof MailContentExpiredError) return { attempted: false };
      throw error;
    }
    if (!before) return { attempted: false };
    const decision = mailDeliveryDecision({
      receivedAt: before.received_at.getTime(),
      firstAttemptAt: before.first_attempt_at?.getTime() ?? null,
      attempts: before.attempts,
      delivered: before.state === "delivered",
      now: input.now().getTime(),
    });
    if (
      decision.state === "delivered" ||
      decision.state === "expired" ||
      decision.state === "delivery_failed" ||
      (decision.state === "waiting" && !scope.manual) ||
      (before.lease_until && before.lease_until.getTime() > input.now().getTime())
    )
      return { attempted: false };
    // Fetching content and checking DNS are prerequisites, not customer webhook attempts. A failed prerequisite
    // defers the automatic retry so the message leaves the head of the due queue; a manual retry is not deferred.
    const attempts = before.attempts;
    let url: URL;
    let message: Awaited<ReturnType<typeof content>>;
    try {
      url = await publicTarget(before.webhook_url);
      message = await content(scope);
    } catch (error) {
      if (!scope.manual)
        await persistence.defer(() => ({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          messageId: parseUlid(scope.messageId),
          attempt: attempts,
          now: input.now().toISOString(),
        }));
      throw error;
    }
    if (!message) return { attempted: false };
    const claim = await persistence.claim(() => ({
      ...scope,
      messageId: parseUlid(scope.messageId),
      now: input.now().toISOString(),
      ...(scope.manual ? { manual: true } : {}),
      ...(scope.commandKey ? { commandKey: scope.commandKey } : {}),
    }));
    if (!claim) return { attempted: false };
    let status: number | null = null;
    try {
      const current = await read(scope);
      if (
        !current ||
        current.webhook_url !== before.webhook_url ||
        current.webhook_secret_generation !== before.webhook_secret_generation ||
        current.attempts !== claim.attempts ||
        current.state !== "delivering" ||
        !current.lease_until ||
        current.lease_until.getTime() <= input.now().getTime()
      )
        return { attempted: false };
      const body = JSON.stringify({
        id: claim.message_id,
        type: "email.received",
        project_id: scope.projectId,
        environment_id: scope.environmentId,
        data: message,
      });
      const response = await fetcher(url.href, {
        method: "POST",
        redirect: "manual",
        headers: mailWebhookHeaders(
          body,
          claim.message_id,
          mailWebhookSecret(input.signingKey, claim.domain_id, claim.webhook_secret_generation),
          input.now(),
        ),
        body,
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(15000, claim.expires_at.getTime() - input.now().getTime())),
        ),
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      status = null;
    } finally {
      await persistence.complete(() => ({
        messageId: parseUlid(scope.messageId),
        attempt: claim.attempts,
        now: input.now().toISOString(),
        status,
      }));
    }
    return { attempted: true, delivered: status !== null && status >= 200 && status < 300 };
  }

  return {
    content,
    deliver,
    async list(scope: MailScope & { after?: string }) {
      return persistence.list(() => ({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        now: input.now().toISOString(),
        ...(scope.after ? { after: parseUlid(scope.after) } : {}),
      }));
    },
    async attachment(scope: MailScope & { messageId: string; attachmentId: string }) {
      const row = await read(scope);
      if (!row) return null;
      const info = await provider.getAttachment(row.provider_message_id, scope.attachmentId);
      if (!(await read(scope))) return null;
      try {
        return await streamMailAttachment({
          fetch: fetcher,
          url: info.downloadUrl,
          size: info.size,
          maximumBytes: maximumAttachmentBytes,
          providerExpiresAt: info.expiresAt,
          messageExpiresAt: row.expires_at,
          now: input.now,
          checkScope: async () => (await read(scope)) !== null,
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof MailAttachmentScopeUnavailableError) return null;
        throw error;
      }
    },
    async sync() {
      await persistence.expire(() => input.now().toISOString());
      const due = await persistence.due(() => input.now().toISOString());
      let attempted = 0,
        failed = 0;
      for (const scope of due) {
        try {
          const result = await deliver(scope);
          if (result.attempted) attempted++;
        } catch {
          failed++;
        }
      }
      return { attempted, failed };
    },
  };
}
