/**
 * The pure half of the gateway canary: what every observed answer means.
 *
 * Customer Workers reach the private mail and storage gateways with the ordinary global fetch.
 * The platform's egress policy Worker answers that fetch and relays it to the gateway over its own
 * private binding. In October 2026 Cloudflare made a Worker reached through a service binding
 * inherit the customer's egress interception, which silently broke the older service-binding path.
 * This canary calls the documented path on a schedule and names what is wrong instead of leaving a
 * customer to find out.
 *
 * Verdicts, most severe first. A tick reports the most severe verdict of its legs:
 * - policy_not_enforced: an origin the project never listed was not refused, or its fetch failed
 *   because no egress policy is attached. A security fault.
 * - gateway_io_blocked: a gateway itself answered with its closed JSON 503, so its own network or
 *   database access failed. This is the signature of the Cloudflare regression inside a gateway
 *   that the relay reaches, that is, of a recurrence after the relay exists. A run against the
 *   egress Worker from before the relay does not read it (see below).
 * - relay_misconfigured: the chain between the customer fetch and the gateway entrypoint does not
 *   answer as contracted: an egress outcome header, an egress-made text answer, a storage 401
 *   without the stage header, an unexpected status or shape (an HTML page from a public host that
 *   nobody serves is one), or a fetch that threw.
 * - database_unavailable: the database binding failed.
 * - canary_misconfigured: the canary's own configuration, request or account is what was refused.
 *   A gateway that answers a well-formed JSON 4xx proves the whole chain works.
 *
 * Before the relay exists, the egress Worker hands the storage origin to a public fetch of the
 * gateway's workers.dev host, which has no listener. A run against that egress is the negative
 * control: every storage leg that runs reads relay_misconfigured (the signed legs need a
 * reservation and do not run), and the mail legs, the database legs and the unlisted-origin
 * control read ok, because that egress already relays mail and the database calls work under the
 * policy. No gateway answers there, so gateway_io_blocked cannot appear.
 *
 * This file imports nothing and uses only erasable TypeScript, so the repository test imports it
 * directly.
 */

export const VERDICTS = [
  "ok",
  "relay_misconfigured",
  "gateway_io_blocked",
  "policy_not_enforced",
  "database_unavailable",
  "canary_misconfigured",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The most subrequests one run plans. A customer invocation may make ten; two stay in reserve. */
export const SUBREQUEST_BUDGET = 8;

/** The two crons of ohmyhost.yaml. The deep one avoids the minutes the cheap one runs. */
export const CHEAP_CRON = "*/5 * * * *";
export const DEEP_CRON = "3 * * * *";
export const HEALTH_PATH = "/health";

/**
 * A syntactically valid gateway key that no gateway ever issues. It is deliberately low entropy:
 * it is public, and a high-entropy constant would be reported by the secret scan.
 */
export const IMPOSSIBLE_KEY = "0".repeat(43);
/** A canonical ULID that is no project. The relay must replace it with the real project. */
export const FORGED_PROJECT_ID = "0".repeat(26);
/** A name the canary never uploads. */
export const ABSENT_OBJECT_KEY = "gateway-canary/absent-probe";
/** An origin no project lists. The reserved .invalid top-level domain never resolves. */
export const UNLISTED_ORIGIN = "https://unlisted.gateway-canary.invalid";

export type TickName = "cheap" | "deep";

export type GatewayLegName =
  | "mail_unauthorized"
  | "storage_unauthorized"
  | "storage_absent_object"
  | "egress_control"
  | "storage_reserve"
  | "storage_put"
  | "storage_complete"
  | "storage_read_capability"
  | "storage_read"
  | "storage_delete"
  | "mail_send";
export type DatabaseLegName = "database_query" | "database_transaction" | "database_connection";
export type LegName = GatewayLegName | DatabaseLegName;

export interface PlannedLeg {
  readonly leg: LegName;
  /** Fetches or binding calls the leg makes. A held database connection is open, query and close. */
  readonly subrequests: number;
}

/**
 * The cheap tick proves the request path every five minutes: the mail impossible key, the storage
 * forged claim with the real key (header overwrite, relay, entrypoint, database TCP, key lookup
 * and scope lock), the egress allow-list and the three database calls.
 *
 * The deep tick proves what needs provider IO every hour: the full storage lifecycle and one mail
 * send. The gateway refuses to erase an object before its upload link expired (five minutes plus a
 * drain), so each deep tick erases the previous hour's object instead of its own.
 */
export const TICK_PLANS = {
  cheap: [
    { leg: "mail_unauthorized", subrequests: 1 },
    { leg: "storage_absent_object", subrequests: 1 },
    { leg: "egress_control", subrequests: 1 },
    { leg: "database_query", subrequests: 1 },
    { leg: "database_transaction", subrequests: 1 },
    { leg: "database_connection", subrequests: 3 },
  ],
  deep: [
    { leg: "storage_unauthorized", subrequests: 1 },
    { leg: "storage_reserve", subrequests: 1 },
    { leg: "storage_put", subrequests: 1 },
    { leg: "storage_complete", subrequests: 1 },
    { leg: "storage_read_capability", subrequests: 1 },
    { leg: "storage_read", subrequests: 1 },
    { leg: "storage_delete", subrequests: 1 },
    { leg: "mail_send", subrequests: 1 },
  ],
} as const satisfies Readonly<Record<TickName, readonly PlannedLeg[]>>;

export function plannedSubrequests(tick: TickName): number {
  const plan: readonly PlannedLeg[] = TICK_PLANS[tick];
  return plan.reduce((total, { subrequests }) => total + subrequests, 0);
}

export function tickForCron(cron: string): TickName | null {
  if (cron === CHEAP_CRON) return "cheap";
  return cron === DEEP_CRON ? "deep" : null;
}

const HOUR_MILLISECONDS = 3_600_000;
const LAST_MILLISECOND = 253_402_300_799_999;

export interface TickIdentity {
  readonly stamp: string;
  readonly probeKey: string;
  readonly objectKey: string;
  readonly uploadKey: string;
  readonly mailKey: string;
  /** The object the previous hourly deep tick uploaded, which this tick erases. */
  readonly previous: Readonly<{ stamp: string; objectKey: string; deleteKey: string }>;
}

/**
 * Every name and idempotency key derives from the scheduled time, which a retry keeps. A repeated
 * run therefore repeats its requests instead of sending a second mail or reserving a second name.
 * Null when the time cannot name an object.
 */
export function tickIdentity(scheduledTime: number): TickIdentity | null {
  if (
    !Number.isSafeInteger(scheduledTime) ||
    scheduledTime < HOUR_MILLISECONDS ||
    scheduledTime > LAST_MILLISECOND
  ) {
    return null;
  }
  const stamp = stampOf(scheduledTime);
  const previous = stampOf(scheduledTime - HOUR_MILLISECONDS);
  return {
    stamp,
    probeKey: `gateway-canary-probe-${stamp}`,
    objectKey: `gateway-canary/${stamp}`,
    uploadKey: `gateway-canary-upload-${stamp}`,
    mailKey: `gateway-canary-mail-${stamp}`,
    previous: {
      stamp: previous,
      objectKey: `gateway-canary/${previous}`,
      deleteKey: `gateway-canary-delete-${previous}`,
    },
  };
}

function stampOf(time: number): string {
  return new Date(time).toISOString().replace(/[-:.]/gu, "");
}

/** What the canary read from one answer. The SDK hides headers, so the canary reads them itself. */
export interface ResponseObservation {
  readonly kind: "response";
  readonly status: number;
  /** The media type without parameters, lower case. */
  readonly contentType: string | null;
  /** The code of a JSON body, as a closed-vocabulary token. */
  readonly code: string | null;
  /** The x-ohmyhost-egress-outcome token. Only answers the egress made itself carry it. */
  readonly egressOutcome: string | null;
  /** The x-ohmyhost-gateway-stage token the storage entrypoint adds to a post-lookup 401. */
  readonly stage: string | null;
  /** Whether a text/plain body is the egress policy's own denial of an origin. */
  readonly egressDenied: boolean;
}

export type GatewayObservation =
  | ResponseObservation
  /** The canary or its client refused to send the request. */
  | Readonly<{ kind: "not_sent" }>
  /** The fetch rejected: there is no answer at all. */
  | Readonly<{ kind: "fetch_failed" }>;

export interface ResponseDigest {
  readonly status: number;
  readonly contentType: string | null;
  /** Read only for JSON and text/plain answers. */
  readonly body: string;
  readonly egressOutcome: string | null;
  readonly stage: string | null;
}

const MAXIMUM_JSON_CHARACTERS = 8192;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/u;

export function describeResponse(digest: ResponseDigest): ResponseObservation {
  const type = mediaType(digest.contentType);
  return {
    kind: "response",
    status: digest.status,
    contentType: type,
    code: type === "application/json" ? jsonCode(digest.body) : null,
    egressOutcome: token(digest.egressOutcome),
    stage: token(digest.stage),
    egressDenied: type === "text/plain" && digest.body.startsWith("Egress denied:"),
  };
}

/** Whether the canary reads the body of an answer with this content type. */
export function readsBody(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return type === "application/json" || type === "text/plain";
}

function mediaType(contentType: string | null): string | null {
  const type = (contentType?.split(";", 1)[0] ?? "").trim().toLowerCase();
  return type === "" ? null : type;
}

function jsonCode(body: string): string | null {
  if (body.length > MAXIMUM_JSON_CHARACTERS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed === "object" && parsed !== null && "code" in parsed) {
    return typeof parsed.code === "string" ? sanitized(parsed.code) : null;
  }
  return null;
}

/** Only a short identifier is ever logged; anything else is reported as unrecognized. */
function sanitized(value: string): string {
  return TOKEN.test(value) ? value : "unrecognized";
}

function token(value: string | null): string | null {
  return value === null ? null : sanitized(value);
}

/** The code of a thrown error, or "unknown". Never its message, which may carry a value. */
export function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return sanitized(error.code);
  }
  return "unknown";
}

interface HealthyAnswer {
  readonly status: number;
  /** The JSON code, or null for a success document and for answers that are not JSON. */
  readonly code: string | null;
  readonly stage?: "key_lookup";
  /** The documented client throws on this answer by design, so the throw is no fault. */
  readonly clientThrows?: true;
}

interface GatewayLeg {
  readonly family: "mail" | "storage" | "r2";
  /** The leg presents the canary's real key, so a 401 means the key is wrong. */
  readonly keyed: boolean;
  readonly healthy: readonly HealthyAnswer[];
}

const GATEWAY_LEGS = {
  mail_unauthorized: {
    family: "mail",
    keyed: false,
    healthy: [{ status: 401, code: "unauthorized" }],
  },
  storage_unauthorized: {
    family: "storage",
    keyed: false,
    healthy: [{ status: 401, code: "unauthorized", stage: "key_lookup" }],
  },
  storage_absent_object: {
    family: "storage",
    keyed: true,
    healthy: [{ status: 404, code: "object_not_found" }],
  },
  storage_reserve: { family: "storage", keyed: true, healthy: [{ status: 200, code: null }] },
  storage_put: {
    family: "r2",
    keyed: false,
    // 412: a create-only PUT that an earlier attempt of this run already stored.
    healthy: [
      { status: 200, code: null },
      { status: 412, code: null },
    ],
  },
  storage_complete: { family: "storage", keyed: true, healthy: [{ status: 200, code: null }] },
  storage_read_capability: {
    family: "storage",
    keyed: true,
    healthy: [{ status: 200, code: null }],
  },
  storage_read: { family: "r2", keyed: false, healthy: [{ status: 200, code: null }] },
  storage_delete: {
    family: "storage",
    keyed: true,
    // The previous hour's object may not exist (first run, or its tick failed early), and the
    // provider may still be settling. Both prove the gateway answered; neither is a fault.
    healthy: [
      { status: 200, code: null },
      { status: 409, code: "storage_gateway_conflict", clientThrows: true },
      { status: 409, code: "storage_delete_pending", clientThrows: true },
    ],
  },
  mail_send: { family: "mail", keyed: true, healthy: [{ status: 202, code: null }] },
} as const satisfies Readonly<Record<Exclude<GatewayLegName, "egress_control">, GatewayLeg>>;

/** Statuses with which a gateway refuses the canary's own request, account or data state. */
const CANARY_REFUSALS: readonly number[] = [400, 402, 409, 413, 423, 429];

export function classifyGatewayLeg(
  leg: GatewayLegName,
  observed: GatewayObservation,
  clientAccepted = true,
): Verdict {
  if (observed.kind === "not_sent") return "canary_misconfigured";
  if (leg === "egress_control") return classifyPolicyControl(observed);
  if (observed.kind === "fetch_failed") return "relay_misconfigured";
  if (observed.egressOutcome !== null) return "relay_misconfigured";
  const spec: GatewayLeg = GATEWAY_LEGS[leg];
  const healthy = spec.healthy.find((answer) => isHealthy(spec, answer, observed));
  if (healthy !== undefined) {
    return healthy.clientThrows === true || clientAccepted ? "ok" : "relay_misconfigured";
  }
  if (spec.family !== "r2" && observed.contentType === "application/json") {
    if (observed.status === 503 && observed.code === `${spec.family}_gateway_unavailable`) {
      return "gateway_io_blocked";
    }
    if (refusesCanary(spec, observed)) return "canary_misconfigured";
  }
  return "relay_misconfigured";
}

function isHealthy(
  spec: GatewayLeg,
  answer: HealthyAnswer,
  observed: ResponseObservation,
): boolean {
  return (
    answer.status === observed.status &&
    answer.code === observed.code &&
    (answer.stage === undefined || answer.stage === observed.stage) &&
    (spec.family === "r2" || observed.contentType === "application/json")
  );
}

function refusesCanary(spec: GatewayLeg, observed: ResponseObservation): boolean {
  if (CANARY_REFUSALS.includes(observed.status)) return true;
  if (observed.status === 502 && observed.code === "mail_rejected") return true;
  // A 401 after the key lookup, or from the mail gateway, means the canary's own key is wrong. A
  // storage 401 without the stage header was refused before any lookup, which is the relay's fault.
  return (
    observed.status === 401 &&
    spec.keyed &&
    (spec.family === "mail" || observed.stage === "key_lookup")
  );
}

/** An unlisted origin must be refused with the egress policy's own denial. */
function classifyPolicyControl(
  observed: ResponseObservation | Readonly<{ kind: "fetch_failed" }>,
): Verdict {
  if (observed.kind === "fetch_failed") return "policy_not_enforced";
  if (observed.egressOutcome !== null) return "relay_misconfigured";
  if (observed.status === 403 && observed.egressDenied) return "ok";
  // The egress cannot parse its context and fails closed: no leak, but a relay fault.
  if (observed.status === 503 && observed.contentType === "text/plain") {
    return "relay_misconfigured";
  }
  return "policy_not_enforced";
}

const CANARY_DATABASE_FAILURES: readonly string[] = [
  "database_binding_missing",
  "database_query_invalid",
];

/** The code of the error a database call threw, or null when it succeeded. */
export function classifyDatabaseLeg(failure: string | null): Verdict {
  if (failure === null) return "ok";
  return CANARY_DATABASE_FAILURES.includes(failure)
    ? "canary_misconfigured"
    : "database_unavailable";
}

export interface LegResult {
  readonly leg: LegName;
  readonly verdict: Verdict;
  readonly observation: GatewayObservation | null;
  /** The error code of a failed database leg. */
  readonly failure: string | null;
  /** The leg was not probed: an earlier attempt of the same run had already done its work. */
  readonly replayed?: true;
}

const SEVERITY = [
  "policy_not_enforced",
  "gateway_io_blocked",
  "relay_misconfigured",
  "database_unavailable",
  "canary_misconfigured",
] as const satisfies readonly Verdict[];

/**
 * The headline of a tick: its most severe red leg. A tick is green only when every planned leg ran
 * and passed, so skipping a leg can never turn it green. A red leg explains the legs it skipped.
 */
export function summarize(tick: TickName, results: readonly LegResult[]): Verdict {
  const red = SEVERITY.find((verdict) => results.some((result) => result.verdict === verdict));
  if (red !== undefined) return red;
  const plan: readonly PlannedLeg[] = TICK_PLANS[tick];
  const complete = plan.every(({ leg }) => results.some((result) => result.leg === leg));
  return complete ? "ok" : "canary_misconfigured";
}

export interface CanaryConfiguration {
  readonly projectId: string;
  readonly environmentId: string;
  readonly mailGatewayUrl: string;
  readonly mailKey: string;
  readonly mailRecipient: string;
  readonly storageGatewayUrl: string;
  readonly storageKey: string;
}

export type ConfigurationResult =
  | Readonly<{ ok: true; configuration: CanaryConfiguration }>
  | Readonly<{ ok: false; missing: readonly string[] }>;

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const KEY = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The values the platform injects when ohmyhost.yaml enables mail and storage. On a mismatch it
 * names the variables, never their values.
 */
export function readConfiguration(env: Readonly<Record<string, unknown>>): ConfigurationResult {
  const checks: readonly (readonly [string, (value: unknown) => boolean])[] = [
    [
      "GATEWAY_CANARY_RECIPIENT",
      (value) =>
        typeof value === "string" &&
        /^[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(value),
    ],
    ["OHMYHOST_PROJECT_ID", isUlid],
    ["OHMYHOST_ENVIRONMENT_ID", isUlid],
    ["OHMYHOST_MAIL_GATEWAY_URL", isGatewayOrigin],
    ["OHMYHOST_MAIL_KEY", isKey],
    ["OHMYHOST_STORAGE_GATEWAY_URL", isGatewayOrigin],
    ["OHMYHOST_STORAGE_KEY", isKey],
  ];
  const missing = checks.filter(([name, valid]) => !valid(env[name])).map(([name]) => name);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    configuration: {
      projectId: String(env["OHMYHOST_PROJECT_ID"]),
      environmentId: String(env["OHMYHOST_ENVIRONMENT_ID"]),
      mailGatewayUrl: String(env["OHMYHOST_MAIL_GATEWAY_URL"]),
      mailKey: String(env["OHMYHOST_MAIL_KEY"]),
      mailRecipient: String(env["GATEWAY_CANARY_RECIPIENT"]),
      storageGatewayUrl: String(env["OHMYHOST_STORAGE_GATEWAY_URL"]),
      storageKey: String(env["OHMYHOST_STORAGE_KEY"]),
    },
  };
}

function isUlid(value: unknown): boolean {
  return typeof value === "string" && ULID.test(value);
}

function isKey(value: unknown): boolean {
  return typeof value === "string" && KEY.test(value);
}

function isGatewayOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
