import { createHash } from "node:crypto";
import { SystemClock, type Clock } from "@ohmyhost/platform";
import type { PublicEntryDataPort } from "./public-entry-persistence.js";
import { shouldLogMissingSource, sourceBucket } from "./public-entry-source.js";

const FEATURES = ["eu", "iso27001", "soc2"] as const;
type Feature = (typeof FEATURES)[number];
type VoteChoice = "up" | "down" | null;
interface FeatureVotes {
  votes: { feature: Feature; choice: VoteChoice }[];
}
const VOTER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function voterDigest(voter: string): Buffer {
  return createHash("sha256")
    .update("omh-feature-voter\0" + voter.toLowerCase())
    .digest();
}
export interface PublicEntryPort {
  contact(input: {
    name: string;
    email: string;
    company: string;
    message: string;
    idempotency_key: string;
    bucket: number | null;
  }): Promise<boolean>;
  vote(
    feature: Feature,
    choice: VoteChoice,
    key: string,
    voter: string,
    bucket: number | null,
  ): Promise<boolean>;
  votes(voter: string): Promise<FeatureVotes>;
  stats(): Promise<{ deploys_7d: number; observed_at: string }>;
}

/** Public projections are aggregate or browser-scoped only and expose no customer identities. */
export function createPublicEntry(
  persistence: Pick<PublicEntryDataPort, "contact" | "vote" | "votes" | "stats">,
  clock: Clock,
): PublicEntryPort {
  return {
    contact: async (input) =>
      persistence.contact({
        requestId: input.idempotency_key,
        payloadSha256: createHash("sha256")
          .update(JSON.stringify([input.name, input.email, input.company, input.message]))
          .digest("hex"),
        name: input.name,
        email: input.email,
        company: input.company,
        message: input.message,
        now: clock.now().toISOString(),
        sourceBucket: input.bucket,
      }),
    vote: async (feature, choice, key, voter, bucket) =>
      persistence.vote({
        feature,
        choice,
        key,
        voterSha256: voterDigest(voter).toString("hex"),
        now: clock.now().toISOString(),
        sourceBucket: bucket,
      }),
    async votes(voter) {
      const rows = await persistence.votes({
        voterSha256: voterDigest(voter).toString("hex"),
        now: clock.now().toISOString(),
      });
      for (const row of rows)
        if (
          !FEATURES.includes(row.feature as Feature) ||
          ![null, "up", "down"].includes(row.choice as VoteChoice)
        )
          throw new Error("Invalid feature vote projection");
      return {
        votes: FEATURES.map((feature) => ({
          feature,
          choice: (rows.find((row) => row.feature === feature)?.choice ?? null) as VoteChoice,
        })),
      };
    },
    async stats() {
      const now = clock.now(),
        count = await persistence.stats({ now: now.toISOString() });
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
        throw new Error("Invalid public aggregate");
      return { deploys_7d: count, observed_at: now.toISOString() };
    },
  };
}

/** Pre-authentication entry only; this grants no project, account or payment authority. */
export async function handlePublicEntry(
  request: Request,
  port?: PublicEntryPort,
  clock: Clock = new SystemClock(),
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  // The same request id as the rest of the control API: a valid caller id is kept, otherwise one is generated.
  const supplied = request.headers.get("x-request-id");
  const requestId =
    supplied !== null && supplied.length >= 1 && supplied.length <= 128 && !/\p{Cc}/u.test(supplied)
      ? supplied
      : `req_${crypto.randomUUID()}`;
  const error = (code: string, status: number, wait?: { seconds: number; detail: string }) =>
    Response.json(
      {
        type: `https://ohmyho.st/api/errors/${code.replaceAll("_", "-")}`,
        title: "Request could not be completed",
        status,
        ...(wait === undefined ? {} : { detail: wait.detail }),
        code,
        request_id: requestId,
        retryable: status === 503 || status === 429,
        ...(wait === undefined ? {} : { retry_after_seconds: wait.seconds }),
        suggested_action:
          status === 503 || status === 429
            ? "Retry this request later."
            : "Check the submitted fields and try again.",
      },
      {
        status,
        headers: {
          "content-type": "application/problem+json",
          "cache-control": "no-store",
          "x-request-id": requestId,
          ...(wait === undefined ? {} : { "retry-after": String(wait.seconds) }),
        },
      },
    );
  const url = new URL(request.url);
  if (url.pathname === "/v1/site/contact") return error("resource_not_found", 404);
  const route =
    url.pathname === "/v1/contact-requests" ? "contact" : url.pathname.slice("/v1/site/".length);
  if (!port) return error("service_unavailable", 503);
  try {
    if (route === "stats" && request.method === "GET") return json(await port.stats());
    const voter = request.headers.get("x-ohmyho-voter");
    if (route === "feature-interests") {
      if (url.search !== "" || voter === null || !VOTER_PATTERN.test(voter))
        return error("invalid_request", 400);
      if (request.method === "GET") return json(await port.votes(voter));
    }
    if (!["feature-interests", "contact"].includes(route)) return error("resource_not_found", 404);
    if (request.method !== "POST") return error("invalid_request", 405);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== "https://ohmyho.st") return error("forbidden", 403);
    // The intake share of this caller comes from its address, never from the body. Without a usable address the store
    // applies the shared pool only, and one fixed line a minute tells the owner that the header is missing.
    const bucket = sourceBucket(request.headers.get("cf-connecting-ip"));
    if (bucket === null && shouldLogMissingSource(clock.now().getTime()))
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "control-api",
          code: "public_intake_source_missing",
          route,
        }),
      );
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      return error("invalid_request", 400);
    const maxBytes = route === "contact" ? 32768 : 2048;
    if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
      return error("payload_too_large", 413);
    const reader = request.body?.getReader();
    if (!reader) return error("invalid_request", 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          return error("payload_too_large", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return error("invalid_request", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return error("invalid_request", 400);
    const input = body as Record<string, unknown>;
    if (route === "contact") {
      if (
        Object.keys(input).sort().join(",") !== "company,email,idempotency_key,message,name" ||
        typeof input["name"] !== "string" ||
        typeof input["email"] !== "string" ||
        typeof input["company"] !== "string" ||
        typeof input["message"] !== "string" ||
        typeof input["idempotency_key"] !== "string"
      )
        return error("invalid_request", 400);
      const name = input["name"].trim(),
        email = input["email"].trim().toLowerCase(),
        company = input["company"].trim(),
        message = input["message"].trim();
      if (
        [name, email, company, message].some((value) => value.includes("\0")) ||
        !name ||
        name.length > 120 ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email) ||
        company.length > 200 ||
        !message ||
        message.length > 8000 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          input["idempotency_key"],
        )
      )
        return error("invalid_request", 400);
      if (
        !(await port.contact({
          name,
          email,
          company,
          message,
          idempotency_key: input["idempotency_key"],
          bucket,
        }))
      )
        return error("idempotency_key_reused", 409);
      return json({ accepted: true }, 202);
    }
    if (
      Object.keys(input).sort().join(",") !== "choice,feature,idempotency_key" ||
      ![null, "up", "down"].includes(input["choice"] as VoteChoice) ||
      typeof input["feature"] !== "string" ||
      !["eu", "iso27001", "soc2"].includes(input["feature"]) ||
      typeof input["idempotency_key"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        input["idempotency_key"],
      )
    )
      return error("invalid_request", 400);
    if (
      voter === null ||
      !(await port.vote(
        input["feature"] as Feature,
        input["choice"] as VoteChoice,
        input["idempotency_key"],
        voter,
        bucket,
      ))
    )
      return error("idempotency_key_reused", 409);
    return json({ accepted: true, ...(await port.votes(voter)) }, 202);
  } catch (cause) {
    // The store refuses a new row once the caller's bucket or the shared pool has spent its day or total budget. A
    // stored request still replays. Workers RPC keeps the message of a thrown Error. One fixed line tells the owner.
    const spent =
      cause instanceof Error ? /^public_intake_(day|total)_full$/u.exec(cause.message) : null;
    if (spent !== null) {
      console.warn(
        JSON.stringify({ level: "warn", service: "control-api", code: spent[0], route }),
      );
      // The day budget returns at 00:00 UTC. The total returns only as retention or an operator frees rows.
      if (spent[1] === "total")
        return error("service_unavailable", 503, {
          seconds: 86_400,
          detail: "Public intake is at its capacity and frees only as stored entries expire.",
        });
      const now = clock.now();
      return error("rate_limited", 429, {
        seconds: Math.ceil(
          (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) -
            now.getTime()) /
            1000,
        ),
        detail: "The public intake share for today is used up; it resets at 00:00 UTC.",
      });
    }
    return error("service_unavailable", 503);
  }
}
