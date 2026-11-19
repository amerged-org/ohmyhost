export { verifyResendWebhook } from "./webhooks.js";

const ORIGIN = "https://api.resend.com";
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const ATTACHMENT_EXPIRY =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
export interface MailDnsRecord {
  readonly type: "MX" | "TXT" | "CNAME";
  readonly name: string;
  readonly value: string;
  readonly priority?: number;
  readonly purpose: string;
  readonly status: string;
}
export interface ResendDomain {
  readonly id: string;
  readonly domain: string;
  readonly status: string;
  readonly sending: boolean;
  readonly receiving: boolean;
  readonly records: readonly MailDnsRecord[];
}
export interface ResendSendInput {
  readonly from: string;
  /** Optional ASCII display name; the address remains separately validated. */
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly idempotencyKey: string;
  readonly tags?: Readonly<Record<string, string>>;
}
export class ResendRequestError extends Error {
  public readonly code = "resend_request_failed";
  public constructor(
    public readonly status: number,
    public readonly uncertain: boolean,
    /** A definite refusal whose cause the platform acts on; the provider body itself never leaves. */
    public readonly reason?: "domain_limit",
  ) {
    super("Resend request failed");
    this.name = "ResendRequestError";
  }
}
/**
 * Resend documents no error code for its plan's domain limit; the observed refusal (log
 * aa13cf65, 2026-09-24) is this exact 403 `validation_error` message, so only that text on a
 * domain creation is classified. Other 403s, such as an already registered domain, stay generic.
 */
async function domainLimitReason(response: Response): Promise<"domain_limit" | undefined> {
  try {
    const body = JSON.parse(await boundedText(response, 4096)) as Record<string, unknown>;
    return body["name"] === "validation_error" &&
      typeof body["message"] === "string" &&
      body["message"].startsWith("You have reached the domain limit of your plan.")
      ? "domain_limit"
      : undefined;
  } catch {
    return undefined;
  }
}
/** Narrow server-only adapter. Provider bodies and keys never become diagnostic error text. */
export function createResendProvider(configuration: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}) {
  if (!/^re_[A-Za-z0-9_-]+$/u.test(configuration.apiKey))
    throw new TypeError("Invalid Resend configuration");
  const fetcher = configuration.fetch ?? globalThis.fetch;
  async function request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${ORIGIN}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${configuration.apiKey}`,
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ResendRequestError(0, true);
    }
    if (!response.ok) {
      const reason =
        response.status === 403 && method === "POST" && path === "/domains"
          ? await domainLimitReason(response)
          : (await response.body?.cancel(), undefined);
      throw new ResendRequestError(
        response.status,
        response.status >= 500 || response.status === 408,
        reason,
      );
    }
    try {
      return JSON.parse(await boundedText(response, 4 * 1024 * 1024));
    } catch {
      throw new ResendRequestError(response.status, true);
    }
  }
  return Object.freeze({
    async send(input: ResendSendInput) {
      validateResendSendInput(input);
      const raw = record(
        await request(
          "POST",
          "/emails",
          {
            from: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
            to: [input.to],
            subject: input.subject,
            text: input.text,
            ...(input.html ? { html: input.html } : {}),
            ...(input.replyTo ? { reply_to: input.replyTo } : {}),
            ...(input.tags
              ? { tags: Object.entries(input.tags).map(([name, value]) => ({ name, value })) }
              : {}),
          },
          input.idempotencyKey,
        ),
      );
      return { messageId: requireId(raw["id"]) };
    },
    async createDomain(input: { domain: string; sending: boolean; receiving: boolean }) {
      if (!DOMAIN.test(input.domain) || (!input.sending && !input.receiving))
        throw new TypeError("Invalid mail domain");
      return parseResendDomain(
        await request("POST", "/domains", {
          name: input.domain,
          region: "us-east-1",
          capabilities: {
            sending: input.sending ? "enabled" : "disabled",
            receiving: input.receiving ? "enabled" : "disabled",
          },
        }),
      );
    },
    async getDomain(id: string) {
      return parseResendDomain(await request("GET", `/domains/${requireId(id)}`));
    },
    async updateDomain(id: string, capabilities: { sending: boolean; receiving: boolean }) {
      if (!capabilities.sending && !capabilities.receiving)
        throw new TypeError("At least one capability is required");
      await request("PATCH", `/domains/${requireId(id)}`, {
        capabilities: {
          sending: capabilities.sending ? "enabled" : "disabled",
          receiving: capabilities.receiving ? "enabled" : "disabled",
        },
      });
    },
    async verifyDomain(id: string) {
      await request("POST", `/domains/${requireId(id)}/verify`);
    },
    async deleteDomain(id: string) {
      await request("DELETE", `/domains/${requireId(id)}`);
    },
    async createDomainSendingKey(input: { domainId: string; name: string }) {
      if (!input.name || input.name.length > 50 || /[\r\n]/u.test(input.name))
        throw new TypeError("Invalid Resend API key name");
      const raw = record(
        await request("POST", "/api-keys", {
          name: input.name,
          permission: "sending_access",
          domain_id: requireId(input.domainId),
        }),
      );
      const token = requireString(raw["token"]);
      if (!/^re_[A-Za-z0-9_-]+$/u.test(token)) throw new ResendRequestError(200, true);
      return { id: requireId(raw["id"]), token };
    },
    async deleteApiKey(id: string) {
      const raw = record(await request("DELETE", `/api-keys/${requireId(id)}`));
      if (raw["id"] !== id || raw["deleted"] !== true) throw new ResendRequestError(200, true);
    },
    async listApiKeys(after?: string) {
      const raw = record(
        await request("GET", `/api-keys?limit=100${after ? `&after=${requireId(after)}` : ""}`),
      );
      if (!Array.isArray(raw["data"]) || typeof raw["has_more"] !== "boolean")
        throw new ResendRequestError(200, true);
      return {
        items: raw["data"].map((item) => {
          const key = record(item);
          return { id: requireId(key["id"]), name: requireString(key["name"]) };
        }),
        hasMore: raw["has_more"],
      };
    },
    async listDomains(after?: string) {
      const raw = record(
        await request("GET", `/domains?limit=100${after ? `&after=${requireId(after)}` : ""}`),
      );
      if (!Array.isArray(raw["data"]) || typeof raw["has_more"] !== "boolean")
        throw new ResendRequestError(200, true);
      return {
        items: raw["data"].map((item) => {
          const value = record(item);
          const createdAt = requireString(value["created_at"]);
          if (!Number.isFinite(Date.parse(createdAt))) throw new ResendRequestError(200, true);
          return {
            id: requireId(value["id"]),
            domain: requireDomain(value["name"]),
            createdAt: new Date(createdAt).toISOString(),
          };
        }),
        hasMore: raw["has_more"],
      };
    },
    async getReceived(id: string) {
      const raw = record(
        await request("GET", `/emails/receiving/${requireId(id)}?html_format=cid`),
      );
      if (requireId(raw["id"]) !== id) throw new ResendRequestError(200, true);
      const attachments = raw["attachments"];
      if (!Array.isArray(attachments)) throw new ResendRequestError(200, true);
      return {
        id,
        from: requireString(raw["from"]),
        to: stringArray(raw["to"]),
        subject: requireString(raw["subject"]),
        text: nullableString(raw["text"]),
        html: nullableString(raw["html"]),
        messageId: requireString(raw["message_id"]),
        attachments: attachments.map((item) => {
          const a = record(item);
          return {
            id: requireId(a["id"]),
            filename: nullableString(a["filename"]),
            contentType: requireString(a["content_type"]),
          };
        }),
      };
    },
    async getAttachment(messageId: string, attachmentId: string) {
      const response = await request(
        "GET",
        `/emails/receiving/${requireId(messageId)}/attachments/${requireId(attachmentId)}`,
      );
      try {
        const raw = record(response);
        if (requireId(raw["id"]) !== attachmentId) throw new ResendRequestError(200, true);
        const size = raw["size"];
        const expiresAt = requireString(raw["expires_at"]);
        if (
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          !ATTACHMENT_EXPIRY.test(expiresAt) ||
          !Number.isFinite(Date.parse(expiresAt)) ||
          new Date(`${expiresAt.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !==
            expiresAt.slice(0, 10)
        )
          throw new ResendRequestError(200, true);
        const url = new URL(requireString(raw["download_url"]));
        // Download hosts are provider-owned; never follow a provider response into the private network.
        if (
          url.protocol !== "https:" ||
          (url.hostname !== "inbound-cdn.resend.com" &&
            !url.hostname.endsWith(".cloudfront.net")) ||
          url.username ||
          url.password ||
          (url.port && url.port !== "443")
        )
          throw new ResendRequestError(200, true);
        return {
          downloadUrl: url.href,
          contentType: requireString(raw["content_type"]),
          filename: nullableString(raw["filename"]),
          size,
          expiresAt,
        };
      } catch {
        throw new ResendRequestError(200, true);
      }
    },
    async createWebhook(url: string, events: readonly string[]) {
      if (new URL(url).protocol !== "https:" || !events.length)
        throw new TypeError("Invalid webhook");
      const raw = record(await request("POST", "/webhooks", { endpoint: url, events }));
      return { id: requireId(raw["id"]), signingSecret: requireString(raw["signing_secret"]) };
    },
    async listWebhooks(after?: string) {
      const raw = record(
        await request("GET", `/webhooks?limit=100${after ? `&after=${requireId(after)}` : ""}`),
      );
      if (!Array.isArray(raw["data"]) || typeof raw["has_more"] !== "boolean")
        throw new ResendRequestError(200, true);
      return {
        items: raw["data"].map((item) => {
          const hook = record(item),
            endpoint = requireString(hook["endpoint"]);
          if (
            !Array.isArray(hook["events"]) ||
            hook["events"].some((event) => typeof event !== "string")
          )
            throw new ResendRequestError(200, true);
          return {
            id: requireId(hook["id"]),
            endpoint,
            events: hook["events"] as string[],
            status: requireString(hook["status"]),
          };
        }),
        hasMore: raw["has_more"],
      };
    },
  });
}
export function parseResendDomain(value: unknown): ResendDomain {
  const raw = record(value),
    domain = requireDomain(raw["name"]),
    capabilities = record(raw["capabilities"]);
  if (!Array.isArray(raw["records"])) throw new TypeError("Invalid domain records");
  const records = raw["records"].map((item): MailDnsRecord => {
    const row = record(item),
      type = row["type"],
      original = requireString(row["name"]).toLowerCase();
    const fqdn = resolveResendRecordName(original, domain);
    if (
      (type !== "MX" && type !== "TXT" && type !== "CNAME") ||
      !(fqdn === domain || fqdn.endsWith(`.${domain}`)) ||
      !/^[a-z0-9_.-]+$/u.test(fqdn)
    )
      throw new TypeError("Invalid domain record scope");
    const priority = row["priority"];
    if (
      type === "MX" &&
      (!Number.isInteger(priority) || Number(priority) < 0 || Number(priority) > 65535)
    )
      throw new TypeError("Invalid MX priority");
    return {
      type,
      name: fqdn,
      value: requireString(row["value"]),
      purpose: requireString(row["record"]),
      status: requireString(row["status"]),
      ...(type === "MX" ? { priority: priority as number } : {}),
    };
  });
  if (
    !["enabled", "disabled"].includes(String(capabilities["sending"])) ||
    !["enabled", "disabled"].includes(String(capabilities["receiving"]))
  )
    throw new TypeError("Invalid domain capabilities");
  return {
    id: requireId(raw["id"]),
    domain,
    status: requireString(raw["status"]),
    sending: capabilities["sending"] === "enabled",
    receiving: capabilities["receiving"] === "enabled",
    records,
  };
}
function resolveResendRecordName(original: string, domain: string): string {
  if (original === "@" || original === "") return domain;
  const name = original.replace(/\.$/u, "");
  if (name === domain || name.endsWith(`.${domain}`) || original.endsWith(".")) return name;
  const rawLabels = name.split("."),
    domainLabels = domain.split(".");
  for (let overlap = Math.min(rawLabels.length, domainLabels.length - 1); overlap >= 1; overlap--) {
    if (rawLabels.slice(-overlap).join(".") === domainLabels.slice(0, overlap).join("."))
      return `${name}.${domainLabels.slice(overlap).join(".")}`;
  }
  return `${name}.${domain}`;
}
export async function boundedText(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new TypeError("Response too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(result);
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid provider response");
  return value as Record<string, unknown>;
}
function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Invalid provider field");
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : requireString(value);
}
function requireId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError("Invalid provider ID");
  return value;
}
function requireDomain(value: unknown): string {
  if (typeof value !== "string" || !DOMAIN.test(value)) throw new TypeError("Invalid domain");
  return value;
}
function requireEmail(value: string): void {
  if (
    value.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/u.test(value)
  )
    throw new TypeError("Invalid email");
}
function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((item) => typeof item === "string")
  )
    throw new TypeError("Invalid recipients");
  return value;
}
export * from "./customer-webhooks.js";

export function validateResendSendInput(input: ResendSendInput): void {
  for (const address of [input.from, input.to, ...(input.replyTo ? [input.replyTo] : [])])
    requireEmail(address);
  if (
    !/^[A-Za-z0-9._:-]{1,256}$/u.test(input.idempotencyKey) ||
    (input.fromName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/u.test(input.fromName)) ||
    !input.subject ||
    Array.from(input.subject).length > 200 ||
    /[\r\n]/u.test(input.subject) ||
    input.subject.includes(String.fromCharCode(0)) ||
    !input.text ||
    new TextEncoder().encode(input.text).length > 65536 ||
    (input.html !== undefined && new TextEncoder().encode(input.html).length > 131072)
  )
    throw new TypeError("Invalid mail input");
}
