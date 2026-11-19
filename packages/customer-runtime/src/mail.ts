import { CustomerRuntimeGatewayError } from "./errors.js";
import {
  exactRecord,
  invalidResponse,
  postGatewayJson,
  requireConfiguredUlid,
  validateGatewayConnection,
  throwGatewayRelayError,
  type GatewayConnection,
} from "./http.js";

/** The gateway's own payment codes and the action that clears each; none clears on a retry. */
const PAYMENT_REQUIRED = Object.freeze({
  paid_plan_required:
    "sending mail needs Paid access; the organization Owner starts Paid in billing, and top-ups do not.",
  insufficient_organization_credits: "the organization has no credits for this send; add credits.",
  project_budget_exceeded:
    "this project's Stop budget is used up; raise it or switch it to continue.",
});

export interface TransactionalMailInput {
  readonly from?: string;
  readonly replyTo?: string;
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export type TransactionalMailResult =
  | {
      readonly state: "accepted";
      readonly requestId: string;
      readonly messageId: string;
    }
  | {
      readonly state: "uncertain";
      readonly requestId: string;
    };

/** Server-only transactional mail over the injected gateway URL and global fetch. */
export function createTransactionalMailClient(
  configuration: GatewayConnection & { readonly projectId: string },
) {
  const connection = validateGatewayConnection(configuration);
  const projectId = requireConfiguredUlid(
    configuration.projectId,
    "projectId",
    "OHMYHOST_PROJECT_ID",
  );
  return Object.freeze({
    async send(input: TransactionalMailInput): Promise<TransactionalMailResult> {
      validateMailInput(input);
      const response = await postGatewayJson(
        connection,
        "/v1/send",
        {
          project_id: projectId,
          ...(input.from ? { from: input.from } : {}),
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
          to: input.to,
          subject: input.subject,
          text: input.text,
          ...(input.html !== undefined ? { html: input.html } : {}),
        },
        256 * 1024,
        input.idempotencyKey,
      );
      if (response.status !== 202) throwMailError(response.status, response.body);
      const raw = response.body as Record<string, unknown>;
      const stateRecord = exactRecord(
        response.body,
        raw?.["state"] === "accepted"
          ? ["state", "request_id", "message_id"]
          : ["state", "request_id"],
        response.status,
      );
      const requestId = requireUlid(stateRecord["request_id"], response.status);
      if (stateRecord["state"] === "uncertain") {
        return Object.freeze({ state: "uncertain" as const, requestId });
      }
      if (
        stateRecord["state"] !== "accepted" ||
        typeof stateRecord["message_id"] !== "string" ||
        !/^[A-Za-z0-9._-]{1,256}$/u.test(stateRecord["message_id"])
      ) {
        invalidResponse(response.status);
      }
      return Object.freeze({
        state: "accepted" as const,
        requestId,
        messageId: stateRecord["message_id"],
      });
    },
  });
}

function validateMailInput(input: TransactionalMailInput): void {
  if (
    !validIdempotencyKey(input.idempotencyKey) ||
    (input.from !== undefined && !validEmail(input.from)) ||
    (input.replyTo !== undefined && !validEmail(input.replyTo)) ||
    !validEmail(input.to) ||
    !validContent(input.subject, 200, 998, false) ||
    !validContent(input.text, 65_536, 65_536, true) ||
    (input.html !== undefined && !validContent(input.html, 131_072, 131_072, true))
  ) {
    throw new CustomerRuntimeGatewayError("gateway_request_invalid", null, false);
  }
}

function throwMailError(status: number, body: unknown): never {
  throwGatewayRelayError(status, body);
  const raw = body as Record<string, unknown>;
  const record = exactRecord(
    body,
    raw?.["request_id"] === undefined ? ["code"] : ["code", "request_id"],
    status,
  );
  const code = record["code"];
  if (record["request_id"] !== undefined) requireUlid(record["request_id"], status);
  if (status === 400 && code === "invalid_request") {
    throw new CustomerRuntimeGatewayError("gateway_request_invalid", status, false);
  }
  if (status === 401 && code === "unauthorized") {
    throw new CustomerRuntimeGatewayError("unauthorized", status, false);
  }
  if (status === 402 && typeof code === "string" && Object.hasOwn(PAYMENT_REQUIRED, code)) {
    const paymentCode = code as keyof typeof PAYMENT_REQUIRED;
    throw new CustomerRuntimeGatewayError(
      paymentCode,
      status,
      false,
      PAYMENT_REQUIRED[paymentCode],
    );
  }
  if (status === 409 && code === "mail_send_conflict") {
    throw new CustomerRuntimeGatewayError("mail_send_conflict", status, false);
  }
  if (status === 423 && code === "mail_reputation_suspended") {
    throw new CustomerRuntimeGatewayError("mail_reputation_suspended", status, false);
  }
  if (status === 429 && code === "mail_send_daily_limit") {
    throw new CustomerRuntimeGatewayError("mail_send_limit_exceeded", status, true);
  }
  if (status === 502 && code === "mail_rejected") {
    throw new CustomerRuntimeGatewayError("mail_rejected", status, false);
  }
  if (status === 503 && typeof code === "string") {
    throw new CustomerRuntimeGatewayError("gateway_unavailable", status, true);
  }
  return invalidResponse(status);
}

function requireUlid(value: unknown, status: number | null = null): string {
  if (typeof value !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value))
    invalidResponse(status);
  return value;
}

function validIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

/** The mail provider's own address rule, so the client never refuses what it would send. */
function validEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/u.test(value)
  );
}

function validContent(
  value: string,
  maximumCharacters: number,
  maximumBytes: number,
  allowLineBreaks: boolean,
): boolean {
  const characters = [...value];
  const invalidControl = characters.some((character) => {
    const code = character.codePointAt(0);
    return (
      code === undefined ||
      code === 127 ||
      (code < 32 && (!allowLineBreaks || (code !== 9 && code !== 10 && code !== 13)))
    );
  });
  return (
    characters.length > 0 &&
    characters.length <= maximumCharacters &&
    new TextEncoder().encode(value).byteLength <= maximumBytes &&
    !invalidControl
  );
}
