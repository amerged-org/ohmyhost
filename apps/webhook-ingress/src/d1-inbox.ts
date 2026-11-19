import type { GithubWebhookInboxRecorder, WorkosWebhookInboxRecorder } from "./contracts.js";
import type { StripeWebhookInboxRecorder } from "./stripe-app.js";

interface IngressRuntime {
  recordWorkosWebhook(input: unknown): Promise<unknown>;
  recordGithubWebhook(input: unknown): Promise<unknown>;
  recordStripeWebhook(input: unknown): Promise<unknown>;
}

function recordOutcome(value: unknown): "created" | "existing" {
  if (value !== "created" && value !== "existing")
    throw new TypeError("Webhook inbox result is invalid");
  return value;
}

function digest(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The ingress routes read this code to answer 409; the message names the provider only. */
class WebhookEventIdentityConflictError extends Error {
  readonly code = "webhook_event_identity_conflict" as const;

  constructor(provider: "WorkOS" | "GitHub") {
    super(`${provider} webhook event identity conflicts with durable inbox content`);
    this.name = "WebhookEventIdentityConflictError";
  }
}

function contentConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  return (value.code ?? value.message) === "webhook_inbox_content_conflict";
}

/** Ingress holds only its dedicated Core capability, never the Core database or a legacy shard binding. */
export function requireIngressRuntime(bindings: object): IngressRuntime {
  const raw = bindings as Record<string, unknown>;
  const runtime = raw["CONTROL_RUNTIME"];
  if (
    runtime === null ||
    (typeof runtime !== "object" && typeof runtime !== "function") ||
    Reflect.ownKeys(bindings).some(
      (key) =>
        typeof key === "string" &&
        /^(?:CONTROL_CORE|CONTROL_GLOBAL|CONTROL_SHARD_\d{4})$/u.test(key),
    )
  ) {
    throw new TypeError("Webhook ingress bindings are incomplete");
  }
  return runtime as IngressRuntime;
}

/** Only already verified/minimized facts cross this capability. Secrets and raw signed bodies remain in ingress. */
export function createD1WebhookInboxes(runtime: IngressRuntime): {
  workos: WorkosWebhookInboxRecorder;
  github: GithubWebhookInboxRecorder;
  stripe: StripeWebhookInboxRecorder;
} {
  return {
    workos: {
      async record(input, projection) {
        const auth =
          projection === undefined
            ? undefined
            : projection.kind === "membership-barrier"
              ? projection
              : {
                  ...projection,
                  kind:
                    projection.kind === "session-revocation"
                      ? "session"
                      : projection.kind === "user-revocation"
                        ? "user"
                        : "organization",
                };
        try {
          return recordOutcome(
            await runtime.recordWorkosWebhook({
              ...input,
              bodyDigest: digest(input.bodyDigest),
              ...(auth === undefined ? {} : { projection: auth }),
            }),
          );
        } catch (error) {
          if (contentConflict(error)) throw new WebhookEventIdentityConflictError("WorkOS");
          throw error;
        }
      },
    },
    github: {
      async record(input, signal) {
        if (signal.aborted) throw new Error("GitHub inbox write deadline exceeded");
        try {
          const result = await runtime.recordGithubWebhook({
            ...input,
            bodyDigest: digest(input.bodyDigest),
          });
          if (signal.aborted) throw new Error("GitHub inbox write deadline exceeded");
          return recordOutcome(result);
        } catch (error) {
          if (contentConflict(error)) throw new WebhookEventIdentityConflictError("GitHub");
          throw error;
        }
      },
    },
    stripe: {
      async record(input) {
        try {
          return recordOutcome(await runtime.recordStripeWebhook(input));
        } catch (error) {
          if (contentConflict(error)) throw new Error("stripe_inbox_identity_conflict");
          throw error;
        }
      },
    },
  };
}
