import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";
import { isAcceptedWorkosWebhookSearch } from "@ohmyhost/workos-auth-contracts";

import { createWorkosWebhookIngress } from "./app.js";
import {
  activeAdditionalWebhookSecrets,
  parseAdditionalWebhookSecrets,
} from "./additional-secrets.js";
import type { Clock, WorkosWebhookEventIdSource } from "./contracts.js";
import { createD1ResendIngressPersistence } from "./d1-resend-persistence.js";
import { createD1WebhookInboxes, requireIngressRuntime } from "./d1-inbox.js";
import { createGithubWebhookIngress } from "./github-app.js";
import { createResendIngress } from "./resend-ingress.js";
import { createStripeWebhookIngress } from "./stripe-app.js";

const WORKOS_WEBHOOK_PATH = "/webhooks/workos";
const GITHUB_WEBHOOK_PATH = "/webhooks/github";
const MAXIMUM_BODY_BYTES = 1024 * 1024;
// GitHub sends a push body of up to 25 MB, so the GitHub route bounds the body at that size instead.
const GITHUB_MAXIMUM_BODY_BYTES = 25 * 1024 * 1024;
const SIGNATURE_TOLERANCE_MILLISECONDS = 5 * 60 * 1000;
const MAXIMUM_ATTEMPTS = 10;
const GITHUB_EXTERNAL_OPERATION_TIMEOUT_MILLISECONDS = 9_000;

export interface WorkosWebhookWorkerRawBindings {
  readonly CONTROL_RUNTIME?: unknown;
  readonly RESEND_INGRESS_RUNTIME?: unknown;
  readonly RESEND_WEBHOOK_SECRET?: string | undefined;
  readonly GITHUB_WEBHOOK_SECRET?: unknown;
  readonly GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON?: unknown;
  readonly WORKOS_WEBHOOK_SECRET?: unknown;
  readonly WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON?: unknown;
  readonly STRIPE_WEBHOOK_SECRET?: unknown;
  readonly STRIPE_ACCOUNT_ID?: unknown;
  readonly STRIPE_MODE?: unknown;
}

interface WorkosWebhookWorkerDependencies {
  readonly clockFactory: () => Clock;
  readonly eventIdsFactory: (clock: Clock) => WorkosWebhookEventIdSource;
}

export function createWorkosWebhookWorkerEntrypoint(dependencies: WorkosWebhookWorkerDependencies) {
  return {
    async fetch(request: Request, rawBindings: WorkosWebhookWorkerRawBindings): Promise<Response> {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        (url.pathname !== WORKOS_WEBHOOK_PATH &&
          url.pathname !== GITHUB_WEBHOOK_PATH &&
          url.pathname !== "/webhooks/stripe" &&
          url.pathname !== "/webhooks/resend") ||
        (url.search !== "" &&
          !(url.pathname === WORKOS_WEBHOOK_PATH && isAcceptedWorkosWebhookSearch(url.search)))
      ) {
        return notFound();
      }

      if (url.pathname === "/webhooks/resend") {
        // Mail receipt/domain/delivery has its own Core capability; it is not a global inbox record.
        if (!rawBindings.RESEND_WEBHOOK_SECRET) return unavailable();
        try {
          const clock = dependencies.clockFactory();
          return await createResendIngress({
            persistence: createD1ResendIngressPersistence(rawBindings.RESEND_INGRESS_RUNTIME),
            clock,
            ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
            secret: rawBindings.RESEND_WEBHOOK_SECRET,
          }).fetch(request);
        } catch {
          return unavailable();
        }
      }
      let inboxes: ReturnType<typeof createD1WebhookInboxes>;
      try {
        inboxes = createD1WebhookInboxes(requireIngressRuntime(rawBindings));
      } catch {
        return unavailable();
      }
      if (url.pathname === "/webhooks/stripe") {
        const secret = parseWebhookSecret(rawBindings.STRIPE_WEBHOOK_SECRET);
        const accountId = rawBindings.STRIPE_ACCOUNT_ID,
          mode = rawBindings.STRIPE_MODE;
        if (
          !secret?.startsWith("whsec_") ||
          typeof accountId !== "string" ||
          !/^acct_[A-Za-z0-9_]{1,128}$/u.test(accountId) ||
          (mode !== "test" && mode !== "live")
        )
          return unavailable();
        try {
          const clock = dependencies.clockFactory();
          return await createStripeWebhookIngress({
            inbox: inboxes.stripe,
            configuration: { accountId, mode },
            secret,
            clock,
            ids: dependencies.eventIdsFactory(clock),
          }).fetch(request);
        } catch {
          return unavailable();
        }
      }
      const isGithubWebhook = url.pathname === GITHUB_WEBHOOK_PATH;
      const secret = parseWebhookSecret(
        isGithubWebhook ? rawBindings.GITHUB_WEBHOOK_SECRET : rawBindings.WORKOS_WEBHOOK_SECRET,
      );
      if (secret === null) return unavailable();

      try {
        const additional = parseAdditionalWebhookSecrets(
          isGithubWebhook
            ? rawBindings.GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON
            : rawBindings.WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON,
          secret,
        );
        const clock = dependencies.clockFactory();
        if (isGithubWebhook) {
          const app = createGithubWebhookIngress({
            secretReference: {
              kind: "secret-reference",
              provider: "github",
              purpose: "webhook-verification",
              reference: "cloudflare-secret://GITHUB_WEBHOOK_SECRET",
            },
            secretResolver: {
              resolve: async () => new TextEncoder().encode(secret),
              resolveAdditional: (_reference, now) =>
                activeAdditionalWebhookSecrets(additional, now).map((key) =>
                  new TextEncoder().encode(key),
                ),
            },
            inbox: inboxes.github,
            eventIds: dependencies.eventIdsFactory(clock),
            clock,
            maximumBodyBytes: GITHUB_MAXIMUM_BODY_BYTES,
            maximumAttempts: MAXIMUM_ATTEMPTS,
            externalOperationTimeoutMs: GITHUB_EXTERNAL_OPERATION_TIMEOUT_MILLISECONDS,
          });
          return await app.fetch(request);
        }

        const app = createWorkosWebhookIngress({
          secretReference: {
            kind: "secret-reference",
            provider: "workos",
            purpose: "webhook-verification",
            reference: "cloudflare-secret://WORKOS_WEBHOOK_SECRET",
          },
          secretResolver: {
            resolve: async () => secret,
            resolveAdditional: (_reference, now) => activeAdditionalWebhookSecrets(additional, now),
          },
          inbox: inboxes.workos,
          eventIds: dependencies.eventIdsFactory(clock),
          clock,
          maximumBodyBytes: MAXIMUM_BODY_BYTES,
          signatureToleranceMs: SIGNATURE_TOLERANCE_MILLISECONDS,
          maximumAttempts: MAXIMUM_ATTEMPTS,
        });
        return await app.fetch(request);
      } catch {
        return unavailable();
      }
    },
  };
}

function parseWebhookSecret(value: unknown): string | null {
  return typeof value === "string" && /^[\x21-\x7e]{1,512}$/u.test(value) ? value : null;
}

export function createSystemWebhookClock(): Clock {
  return new SystemClock();
}

export function createSystemWebhookEventIds(clock: Clock): WorkosWebhookEventIdSource {
  return createUlidFactory({ clock, entropy: new SystemEntropy() });
}

function unavailable(): Response {
  return Response.json(
    { error: "webhook_ingress_unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

const worker = createWorkosWebhookWorkerEntrypoint({
  clockFactory: createSystemWebhookClock,
  eventIdsFactory: createSystemWebhookEventIds,
});

export default worker;
