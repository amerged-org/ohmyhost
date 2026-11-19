/*
 * The OpenAI-shaped responses of the gateway. Every response, success or refusal, carries no-store and nosniff, and
 * an error names only a closed code, a generic message and the type of its status.
 */

export const AI_ERROR_STATUS = {
  invalid_api_key: 401,
  paid_plan_required: 402,
  insufficient_organization_credits: 402,
  project_budget_exceeded: 429,
  model_outside_jurisdiction: 403,
  model_not_found: 404,
  invalid_request: 400,
  request_too_large: 413,
  ai_rate_limited: 429,
  ai_upstream_unavailable: 502,
  ai_unavailable: 503,
  not_found: 404,
} as const;

export type AiErrorCode = keyof typeof AI_ERROR_STATUS;

/** A refusal raised while a request is handled; the gateway answers it with the error response of its code. */
export class AiFailure extends Error {
  public readonly code: AiErrorCode;
  public readonly headers: Readonly<Record<string, string>>;

  public constructor(
    code: AiErrorCode,
    message: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "AiFailure";
    this.code = code;
    this.headers = headers;
  }
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** A JSON response of the given text; the text is passed on unchanged. */
export function aiResponse(
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...headers },
  });
}

function errorType(status: number): string {
  switch (status) {
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 429:
      return "rate_limit_error";
    default:
      return status >= 500 ? "server_error" : "invalid_request_error";
  }
}

export function aiError(
  code: AiErrorCode,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const status = AI_ERROR_STATUS[code];
  return aiResponse(
    status,
    JSON.stringify({ error: { message, type: errorType(status), code } }),
    headers,
  );
}

/**
 * An orq answer passed on: its status and content type, its body streamed unchanged (JSON, Server-Sent Events, audio
 * or images alike). No other header of orq is copied.
 */
export function aiPassThrough(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
): Response {
  const headers: Record<string, string> = { ...SECURITY_HEADERS };
  if (contentType !== null) headers["content-type"] = contentType;
  return new Response(body, { status, headers });
}
