import { createHash } from "node:crypto";
import type {
  authorizeResendMailKey,
  authorizeResendMailSend,
  claimMailSend,
  completeMailSend,
  rejectMailSend,
  readResendSendingKey,
  requireOrganizationPaidPlan,
  settleMailSendAttempt,
} from "@ohmyhost/database";
import {
  createEnvironmentSecretCipher,
  parseUlid,
  type Ulid,
  type UlidFactory,
} from "@ohmyhost/platform";
import {
  createResendProvider,
  ResendRequestError,
  validateResendSendInput,
} from "@ohmyhost/provider-resend";
/** Suppliers are local: clocks, hashes and identities stay inside the caller. */
export interface ResendSendPersistence {
  authorizeKey(
    input: () => Parameters<typeof authorizeResendMailKey>[1],
  ): ReturnType<typeof authorizeResendMailKey>;
  claim(
    input: () => Parameters<typeof claimMailSend>[1],
    paid: () => Parameters<typeof requireOrganizationPaidPlan>[1],
  ): ReturnType<typeof claimMailSend>;
  authorize(
    input: () => Parameters<typeof authorizeResendMailSend>[1],
  ): ReturnType<typeof authorizeResendMailSend>;
  reject(input: () => Parameters<typeof rejectMailSend>[1]): ReturnType<typeof rejectMailSend>;
  readKey(
    input: () => Parameters<typeof readResendSendingKey>[1],
  ): ReturnType<typeof readResendSendingKey>;
  complete(
    input: () => Parameters<typeof completeMailSend>[1],
  ): ReturnType<typeof completeMailSend>;
  settle(
    input: () => Parameters<typeof settleMailSendAttempt>[1],
    refused: boolean,
  ): ReturnType<typeof settleMailSendAttempt>;
}
export function createResendMailSender(input: {
  persistence: ResendSendPersistence;
  sendingKeyEncryptionKey: string;
  ids: UlidFactory;
  now: () => Date;
  fetch?: typeof globalThis.fetch;
}) {
  const sendingKeyCipher = createEnvironmentSecretCipher({
    keyBase64: input.sendingKeyEncryptionKey,
    keyVersion: 1,
    crypto: globalThis.crypto,
  });
  const now = () => input.now().toISOString();
  const persistence = input.persistence;
  return {
    async send(
      request: {
        projectId: string;
        key?: string;
        idempotencyKey: string;
        from?: string;
        replyTo?: string;
        to: string;
        subject: string;
        text: string;
        html?: string;
      },
      trustedProject?: {
        readonly organizationId: Ulid;
        readonly projectId: Ulid;
        readonly environmentId: Ulid;
        readonly domain: string;
      },
    ) {
      // Per-send timing, logged to locate the 5-10 s Dev sends (request 01M37SMVPVZ9SHH8VQEHQPK1NB).
      const timing = {
        started: Date.now(),
        transactions: 0,
        databaseMs: 0,
        providerMs: 0,
        steps: [] as number[],
      };
      const timed = async <T>(work: () => Promise<T>) => {
        const started = Date.now();
        try {
          return await work();
        } finally {
          timing.transactions += 1;
          timing.databaseMs += Date.now() - started;
          timing.steps.push(Date.now() - started);
        }
      };
      const key = request.key ?? "";
      if (
        (trustedProject === undefined && !/^[A-Za-z0-9_-]{43}$/u.test(key)) ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(request.idempotencyKey)
      )
        throw new TypeError("Invalid mail input");
      const project =
        trustedProject ??
        (await timed(() =>
          persistence.authorizeKey(() => ({
            projectId: parseUlid(request.projectId),
            keySha256: hash(key),
          })),
        ));
      if (!project) return { status: "unauthorized" as const };
      if (project.projectId !== request.projectId) return { status: "unauthorized" as const };
      const from = request.from ?? `no-reply@${project.domain}`;
      if (
        from.slice(from.lastIndexOf("@") + 1) !== project.domain ||
        !/^[A-Za-z0-9._%+-]+@/u.test(from) ||
        !/^[^\s<>@]+@[^\s<>@]+$/u.test(request.to) ||
        !request.subject ||
        /[\r\n]/u.test(request.subject) ||
        request.subject.includes(String.fromCharCode(0)) ||
        !request.text
      )
        throw new TypeError("Invalid sender or message");
      validateResendSendInput({
        from,
        to: request.to,
        subject: request.subject,
        text: request.text,
        idempotencyKey: request.idempotencyKey,
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        ...(request.html !== undefined ? { html: request.html } : {}),
      });
      const requestId = input.ids.next(),
        idempotencyKey = createHash("sha256")
          .update(`${project.environmentId}:${request.idempotencyKey}`)
          .digest("hex");
      const claim = await timed(() =>
        persistence.claim(
          () => ({
            ...project,
            provider: "resend",
            requestId,
            reservationEntryId: input.ids.next(),
            idempotencyKey,
            requestSha256: hash(
              JSON.stringify({
                from,
                to: request.to,
                replyTo: request.replyTo ?? null,
                subject: request.subject,
                text: request.text,
                html: request.html ?? null,
              }),
            ),
            recipientSha256: hash(request.to),
            contentSha256: hash(
              JSON.stringify({
                subject: request.subject,
                text: request.text,
                html: request.html ?? null,
              }),
            ),
            requestInputSha256: hash(
              JSON.stringify({
                from: request.from ?? null,
                replyTo: request.replyTo ?? null,
                to: request.to,
                subject: request.subject,
                text: request.text,
                html: request.html ?? null,
              }),
            ),
            sender: {
              ...(request.from !== undefined ? { from: request.from } : {}),
              ...(request.replyTo !== undefined ? { replyTo: request.replyTo } : {}),
            },
            requestedAt: now(),
          }),
          () => ({ organizationId: project.organizationId, now: now() }),
        ),
      );
      // An uncertain replay inside Resend's 24-hour idempotency window resends under the same
      // provider key: Resend returns the original message instead of sending twice (Opus review
      // 2026-09-24: otherwise the request and its credit reservation stayed stuck for good).
      const retry =
        claim.outcome === "uncertain" &&
        claim.providerStarted &&
        Date.parse(now()) - Date.parse(claim.requestedAt) < 23 * 3_600_000;
      if (claim.outcome !== "claimed" && !retry)
        return {
          status: claim.outcome,
          requestId: claim.requestId,
          ...(claim.outcome === "accepted" ? { providerMessageId: claim.providerMessageId } : {}),
        };
      const effectiveFrom = claim.sender?.from ?? from;
      const effectiveReplyTo = claim.sender?.replyTo ?? request.replyTo;
      validateResendSendInput({
        from: effectiveFrom,
        to: request.to,
        subject: request.subject,
        text: request.text,
        idempotencyKey: request.idempotencyKey,
        ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
        ...(request.html !== undefined ? { html: request.html } : {}),
      });
      const scope = { ...project, requestId: claim.requestId };
      if (retry) {
        // A replay may overlap the original attempt (Resend answers it 409
        // concurrent_idempotent_requests) or a provider event. Marking the send uncertain first
        // keeps the original's later refusal from releasing its credit, and a send settled
        // meanwhile answers without calling Resend again.
        const held = await timed(() =>
          persistence.settle(() => ({ ...scope, observedAt: now(), refused: false }), false),
        );
        if (held.state !== "uncertain") return settledOutcome(held, claim.requestId);
      } else if (
        !(await timed(() =>
          persistence.authorize(() => ({ ...scope, idempotencyKey, now: now() })),
        ))
      ) {
        await timed(() => persistence.reject(() => ({ ...scope, rejectedAt: now() })));
        return { status: "rejected" as const, requestId: claim.requestId };
      }
      let provider: ReturnType<typeof createResendProvider>;
      try {
        const encryptedKey = await timed(() =>
          persistence.readKey(() => ({ ...project, now: now() })),
        );
        if (claim.sender && encryptedKey.domainId !== claim.sender.domainId)
          throw new Error("mail_send_scope_unavailable");
        const apiKey = await sendingKeyCipher.decrypt({
          organizationId: encryptedKey.keyOrganizationId,
          projectId: encryptedKey.keyProjectId,
          environmentId: encryptedKey.keyEnvironmentId,
          name: "RESEND_DOMAIN_SEND_KEY",
          ciphertext: encryptedKey.ciphertext,
          nonce: encryptedKey.nonce,
          valueSha256: encryptedKey.valueSha256,
          keyVersion: encryptedKey.keyVersion,
        });
        try {
          provider = createResendProvider({
            apiKey,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          });
        } catch {
          throw new Error("mail_sending_key_invalid");
        }
      } catch (error) {
        // A replay's row is already uncertain: it stays so, and the failure surfaces to the caller.
        if (retry) throw error;
        // A transient D1 or decrypt failure is rethrown, not refused: the reservation stays, and because the
        // authorization already stamped the send's start, a retry with the same idempotency key replays it as
        // uncertain and sends. Only a definite refusal releases the reservation with its charge.
        if (!definiteKeyRefusal(error)) throw error;
        // Nothing reached Resend, so the refused first attempt releases its reservation and charge.
        return settledOutcome(
          await timed(() =>
            persistence.settle(() => ({ ...scope, observedAt: now(), refused: true }), true),
          ),
          claim.requestId,
        );
      }
      const providerStarted = Date.now();
      try {
        const sent = await provider.send({
          from: effectiveFrom,
          to: request.to,
          subject: request.subject,
          text: request.text,
          ...(request.html ? { html: request.html } : {}),
          ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
          idempotencyKey: `${project.projectId}:${claim.requestId}`,
          tags: {
            project_id: project.projectId,
            request_id: claim.requestId,
            environment_id: project.environmentId,
          },
        });
        timing.providerMs = Date.now() - providerStarted;
        await timed(() =>
          persistence.complete(() => ({
            ...scope,
            providerMessageId: sent.messageId,
            completedAt: now(),
          })),
        );
        console.info(
          JSON.stringify({
            event: "mail_send_timing",
            transactions: timing.transactions,
            databaseMs: timing.databaseMs,
            providerMs: timing.providerMs,
            transactionMs: timing.steps,
            totalMs: Date.now() - timing.started,
          }),
        );
        return {
          status: "accepted" as const,
          requestId: claim.requestId,
          providerMessageId: sent.messageId,
        };
      } catch (error) {
        // A replay's 4xx (409 while the original runs, 429 rate limit) does not prove that the
        // original was not sent (https://resend.com/docs/dashboard/emails/idempotency-keys), so
        // only the first attempt's definite refusal can release a still reserved send.
        const refused = !retry && error instanceof ResendRequestError && !error.uncertain;
        return settledOutcome(
          await timed(() =>
            persistence.settle(() => ({ ...scope, observedAt: now(), refused }), refused),
          ),
          claim.requestId,
        );
      }
    },
  };
}
/**
 * Refusals that prove the sending key can never send this request: no key for the project's scope (the Core's
 * mail_scope_unavailable), a sender whose domain no longer matches the key, or a key that is not a Resend key.
 */
const DEFINITE_KEY_REFUSALS = new Set([
  "mail_scope_unavailable",
  "mail_send_scope_unavailable",
  "mail_sending_key_invalid",
]);
function definiteKeyRefusal(error: unknown): boolean {
  return error instanceof Error && DEFINITE_KEY_REFUSALS.has(error.message);
}
function settledOutcome(
  settled: Awaited<ReturnType<ResendSendPersistence["settle"]>>,
  requestId: Ulid,
) {
  if (settled.state === "accepted")
    return {
      status: "accepted" as const,
      requestId,
      providerMessageId: settled.providerMessageId,
    };
  if (settled.state === "rejected") return { status: "rejected" as const, requestId };
  return { status: "uncertain" as const, requestId };
}
function hash(value: string) {
  return new Uint8Array(createHash("sha256").update(value).digest());
}
