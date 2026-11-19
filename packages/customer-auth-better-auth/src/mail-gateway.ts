import type { CustomerAuthEmailSender } from "./runtime.js";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export class CustomerAuthEmailDeliveryError extends Error {
  public readonly code = "customer_auth_email_delivery_failed";
  public constructor() {
    super("Customer authentication email delivery failed");
    this.name = "CustomerAuthEmailDeliveryError";
  }
}

export function createMailGatewayEmailSender(input: {
  readonly projectId: string;
  readonly gatewayOrigin: string;
  readonly key: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly crypto: Crypto;
  /** Gateway header timeout: 100–30000 ms, default 8000 ms. */
  readonly timeoutMilliseconds?: number;
}): CustomerAuthEmailSender {
  const projectId = input.projectId;
  if (typeof projectId !== "string" || !ULID_PATTERN.test(projectId))
    throw new TypeError("Invalid canonical ULID");
  const gatewayOrigin = canonicalOrigin(input.gatewayOrigin);
  const fetch = input.fetch;
  const timeoutMilliseconds = input.timeoutMilliseconds ?? 8_000;
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(input.key) ||
    typeof input.fetch !== "function" ||
    typeof input.crypto?.subtle?.digest !== "function" ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 100 ||
    timeoutMilliseconds > 30_000
  ) {
    throw new TypeError("Mail gateway email sender input is invalid");
  }
  return Object.freeze({
    async send(message: Parameters<CustomerAuthEmailSender["send"]>[0]) {
      validateMessage(message);
      const subject =
        message.kind === "verification"
          ? "Verify your account"
          : message.kind === "password-reset"
            ? "Reset your password"
            : "Your password was changed";
      const action = message.kind === "password-changed" ? "Review your account" : subject;
      const body = {
        project_id: projectId,
        to: message.to,
        subject,
        text: `${subject}: ${message.url}`,
        html: `<p><a href="${escapeHtml(message.url)}">${action}</a></p>`,
      };
      // Every password-changed notice links to the same /login page, so each notice gets its own key. A
      // verification or reset link carries a fresh token and keeps its content key, so a retry deduplicates.
      // A caller must not retry a password-changed send: each call takes a fresh key, so a retry sends a second notice.
      const notice = message.kind === "password-changed" ? `\n${input.crypto.randomUUID()}` : "";
      const idempotencyKey = await sha256Hex(
        input.crypto,
        `${message.kind}\n${message.to}\n${message.url}${notice}`,
      );
      let response: Response;
      try {
        response = await fetch(`${gatewayOrigin}/v1/send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.key}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
      } catch {
        throw new CustomerAuthEmailDeliveryError();
      }
      const value = await readJson(response);
      if (
        response.status !== 202 ||
        !isRecord(value) ||
        value["state"] !== "accepted" ||
        typeof value["request_id"] !== "string" ||
        typeof value["message_id"] !== "string"
      ) {
        throw new CustomerAuthEmailDeliveryError();
      }
      if (!ULID_PATTERN.test(value["request_id"])) throw new TypeError("Invalid canonical ULID");
    },
  });
}

function validateMessage(message: Parameters<CustomerAuthEmailSender["send"]>[0]): void {
  if (
    (message.kind !== "verification" &&
      message.kind !== "password-reset" &&
      message.kind !== "password-changed") ||
    // The same recipient rule the platform gateway enforces (requireEmail in packages/provider-resend), so every
    // address Better Auth accepts at sign-up reaches the gateway. Keep the two in step.
    message.to.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/u.test(message.to) ||
    !/^https:\/\//u.test(message.url) ||
    message.url.length > 4_096
  ) {
    throw new CustomerAuthEmailDeliveryError();
  }
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Mail gateway origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Mail gateway origin is invalid");
  }
  return url.origin;
}

async function sha256Hex(crypto: Crypto, value: string): Promise<string> {
  const bytes = Uint8Array.from(new TextEncoder().encode(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > 4_096)) {
    await response.body?.cancel().catch(() => undefined);
    throw new CustomerAuthEmailDeliveryError();
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 4_096) throw new CustomerAuthEmailDeliveryError();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CustomerAuthEmailDeliveryError();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
