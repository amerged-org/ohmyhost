/**
 * The gateway canary: a customer-style project that calls the private mail and storage gateways
 * and the database the way the documented clients do, from a real scheduled invocation under the
 * real dispatch and egress policy, and fails visibly when any of them stops working.
 *
 * - Every five minutes a cheap tick: the mail impossible key, the storage forged claim with the
 *   real key, an unlisted origin and the three database calls (8 subrequests).
 * - Every hour a deep tick: the storage lifecycle through the documented client and one mail send
 *   (8 subrequests).
 * A tick logs one verdict line and, unless the verdict is ok, calls noRetry() and throws, so the
 * scheduler records a failed run (`ohmyhost function runs`) and a retry cannot resend the mail.
 * The meaning of each verdict is in ../verdict.ts.
 *
 * Deployed before the egress Worker relays the gateways, it is the negative control: the storage
 * legs read relay_misconfigured (that egress sends the storage origin to a public host nobody
 * serves) and the mail and database legs read ok. gateway_io_blocked is not part of that signature:
 * it needs a gateway that answers its own closed JSON 503, so it appears only after the relay
 * exists.
 *
 * The project needs a workspace with Paid access, credits and a verified mail sender, and it
 * keeps its database awake on purpose. Create it with region eu (the default is us, and a region
 * cannot be changed later): the storage jurisdiction in ohmyhost.yaml is eu and must equal the
 * region of the project created for it, and the EU host is the only R2 data-plane host with
 * recorded use. It never lists a gateway origin in runtime.egress.allow. The health route calls
 * nothing: the deploy-time probe runs without the egress policy.
 */
import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
  type CustomerDatabaseQuery,
  type CustomerDatabaseQueryResult,
} from "@ohmyhost/customer-runtime/database";
import { createTransactionalMailClient } from "@ohmyhost/customer-runtime/mail";
import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";

import {
  ABSENT_OBJECT_KEY,
  FORGED_PROJECT_ID,
  HEALTH_PATH,
  IMPOSSIBLE_KEY,
  UNLISTED_ORIGIN,
  classifyDatabaseLeg,
  classifyGatewayLeg,
  describeResponse,
  errorCode,
  readConfiguration,
  readsBody,
  summarize,
  tickForCron,
  tickIdentity,
  type CanaryConfiguration,
  type DatabaseLegName,
  type GatewayLegName,
  type GatewayObservation,
  type LegResult,
  type TickIdentity,
  type TickName,
  type Verdict,
} from "../verdict.js";

type Environment = Readonly<Record<string, unknown>> & {
  readonly OHMYHOST_DATABASE: CustomerDatabaseBinding;
};

interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  noRetry(): void;
}

type GatewayFetch = (request: Request) => Promise<Response>;

/**
 * One fetch is cut off after this long. Seven legs of 10 s and one mail send of 30 s keep the deep
 * tick inside the 120 s the scheduler allows a run.
 */
const PROBE_TIMEOUT_MILLISECONDS = 10_000;
/** A mail send can take several seconds; the documented client maximum is 30 s. */
const MAIL_TIMEOUT_MILLISECONDS = 30_000;
const READY_QUERY: CustomerDatabaseQuery = { text: "SELECT $1::int AS ok", values: [1] };

export default {
  fetch(request: Request): Response {
    // The deploy-time probe requests runtime.healthcheck, and the default path answers too.
    const { pathname } = new URL(request.url);
    return pathname === HEALTH_PATH || pathname === "/"
      ? Response.json({ status: "ok" })
      : new Response(null, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Environment): Promise<void> {
    const report = await runTick(controller.cron, controller.scheduledTime, env);
    if (report.verdict === "ok") {
      console.log(JSON.stringify(logLine(report)));
      return;
    }
    console.error(JSON.stringify(logLine(report)));
    // A retry would repeat the legs, and the scheduler would then run a red canary three times.
    controller.noRetry();
    throw new Error(`gateway canary ${report.verdict}: ${redLegs(report)}`);
  },
};

interface Report {
  readonly tick: TickName | null;
  readonly scheduledTime: number;
  readonly verdict: Verdict;
  readonly results: readonly LegResult[];
  /** Why no leg ran, when none did. */
  readonly reason: "unknown_cron" | "invalid_scheduled_time" | "configuration" | null;
  readonly missing: readonly string[];
}

async function runTick(cron: string, scheduledTime: number, env: Environment): Promise<Report> {
  const tick = tickForCron(cron);
  const refused = (reason: NonNullable<Report["reason"]>, missing: readonly string[] = []) =>
    ({
      tick,
      scheduledTime,
      verdict: "canary_misconfigured",
      results: [],
      reason,
      missing,
    }) satisfies Report;
  if (tick === null) return refused("unknown_cron");
  const identity = tickIdentity(scheduledTime);
  if (identity === null) return refused("invalid_scheduled_time");
  const configuration = readConfiguration(env);
  if (!configuration.ok) return refused("configuration", configuration.missing);
  const results =
    tick === "cheap"
      ? await cheapTick(configuration.configuration, identity, env)
      : await deepTick(configuration.configuration, identity);
  return {
    tick,
    scheduledTime,
    verdict: summarize(tick, results),
    results,
    reason: null,
    missing: [],
  };
}

async function cheapTick(
  configuration: CanaryConfiguration,
  identity: TickIdentity,
  env: Environment,
): Promise<LegResult[]> {
  const results: LegResult[] = [];
  const database = () => createPrivateDatabaseClient(env.OHMYHOST_DATABASE);
  // Raw fetches: the documented clients hide the headers the verdicts need.
  await step(results, "mail_unauthorized", (f) => probe(f, mailProbe(configuration, identity)));
  await step(results, "storage_absent_object", (f) =>
    probe(f, storageProbe(configuration, configuration.storageKey)),
  );
  await step(results, "egress_control", (f) => probe(f, controlProbe()));
  results.push(
    await databaseLeg("database_query", async () => {
      expectReady(await database().query(READY_QUERY));
    }),
    await databaseLeg("database_transaction", async () => {
      const answers = await database().transaction([READY_QUERY]);
      if (answers.length !== 1) throw coded("database_response_invalid");
      expectReady(answers[0]);
    }),
    await databaseLeg("database_connection", async () => {
      expectReady(await database().withConnection((connection) => connection.query(READY_QUERY)));
    }),
  );
  return results;
}

async function deepTick(
  configuration: CanaryConfiguration,
  identity: TickIdentity,
): Promise<LegResult[]> {
  const results: LegResult[] = [];
  const payload = new TextEncoder().encode(`gateway canary ${identity.stamp}`);
  await step(results, "storage_unauthorized", (f) =>
    probe(f, storageProbe(configuration, IMPOSSIBLE_KEY)),
  );

  const reserved = await step(results, "storage_reserve", (f) =>
    storageClient(configuration, f).reserveUpload({
      idempotencyKey: identity.uploadKey,
      objectKey: identity.objectKey,
      contentType: "text/plain",
      contentLength: payload.byteLength,
    }),
  );
  let stored = false;
  if (reserved.value?.state === "completed") {
    // A repeat of this run: the name was already uploaded and recorded.
    results.push(repeated("storage_put"), repeated("storage_complete"));
    stored = true;
  } else if (reserved.value?.state === "ready") {
    const { capability, transferId } = reserved.value;
    const put = await step(results, "storage_put", (f) =>
      transfer(
        f,
        new Request(capability.url, {
          method: "PUT",
          headers: capability.requiredHeaders,
          body: payload,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
        }),
      ),
    );
    if (put.result.verdict === "ok") {
      const completed = await step(results, "storage_complete", (f) =>
        storageClient(configuration, f).completeUpload(transferId),
      );
      stored = completed.result.verdict === "ok";
    }
  }
  if (stored) {
    const readable = await step(results, "storage_read_capability", (f) =>
      storageClient(configuration, f).createSignedRead(identity.objectKey),
    );
    if (readable.value !== undefined && readable.result.verdict === "ok") {
      const { url, requiredHeaders } = readable.value;
      await step(results, "storage_read", (f) =>
        transfer(
          f,
          new Request(url, {
            headers: requiredHeaders,
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
          }),
        ),
      );
    }
  }
  // The gateway refuses to erase an object before its upload link has expired, so each deep tick
  // erases the object of the previous hour instead of its own. This does not depend on the upload.
  await step(results, "storage_delete", (f) =>
    storageClient(configuration, f).deleteObject({
      idempotencyKey: identity.previous.deleteKey,
      objectKey: identity.previous.objectKey,
    }),
  );
  await step(results, "mail_send", (f) =>
    createTransactionalMailClient({
      endpoint: configuration.mailGatewayUrl,
      key: configuration.mailKey,
      projectId: configuration.projectId,
      fetch: f,
      timeoutMilliseconds: MAIL_TIMEOUT_MILLISECONDS,
    }).send({
      idempotencyKey: identity.mailKey,
      to: configuration.mailRecipient,
      subject: `Gateway canary ${identity.stamp}`,
      text: `Automated gateway canary ${identity.stamp}. No action is needed.`,
    }),
  );
  return results;
}

function storageClient(configuration: CanaryConfiguration, gatewayFetch: GatewayFetch) {
  return createPrivateStorageClient({
    endpoint: configuration.storageGatewayUrl,
    key: configuration.storageKey,
    projectId: configuration.projectId,
    environmentId: configuration.environmentId,
    fetch: gatewayFetch,
    capabilityFetch: gatewayFetch,
    timeoutMilliseconds: PROBE_TIMEOUT_MILLISECONDS,
  });
}

/** Mail with the key no project has: refused before any provider call. */
function mailProbe(configuration: CanaryConfiguration, identity: TickIdentity): Request {
  return new Request(new URL("/v1/send", configuration.mailGatewayUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${IMPOSSIBLE_KEY}`,
      "content-type": "application/json",
      "idempotency-key": identity.probeKey,
    },
    body: JSON.stringify({
      project_id: configuration.projectId,
      to: configuration.mailRecipient,
      subject: "Gateway canary probe",
      text: "This probe is refused before any mail is sent.",
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
  });
}

/**
 * A storage download of an object that does not exist, carrying a forged project claim. The egress
 * must replace the claim with the dispatcher's, or the entrypoint answers 401 before any lookup.
 * With the real key the lookup succeeds and the answer is 404; with the impossible key it is a 401
 * that carries the stage header.
 */
function storageProbe(configuration: CanaryConfiguration, key: string): Request {
  return new Request(new URL("/v1/downloads", configuration.storageGatewayUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-ohmyhost-egress-project-id": FORGED_PROJECT_ID,
    },
    body: JSON.stringify({
      projectId: configuration.projectId,
      environmentId: configuration.environmentId,
      objectKey: ABSENT_OBJECT_KEY,
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
  });
}

function controlProbe(): Request {
  return new Request(`${UNLISTED_ORIGIN}/`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
  });
}

async function probe(gatewayFetch: GatewayFetch, request: Request): Promise<void> {
  const response = await gatewayFetch(request);
  await response.body?.cancel();
}

async function transfer(gatewayFetch: GatewayFetch, request: Request): Promise<void> {
  const response = await gatewayFetch(request);
  await response.arrayBuffer();
}

interface LegRun<Value> {
  readonly result: LegResult;
  readonly value: Value | undefined;
}

/** Runs one leg, records its result and returns what the leg produced for the legs after it. */
async function step<Value>(
  results: LegResult[],
  leg: GatewayLegName,
  run: (gatewayFetch: GatewayFetch) => Promise<Value>,
): Promise<LegRun<Value>> {
  const outcome = await runLeg(leg, run);
  results.push(outcome.result);
  return outcome;
}

/**
 * Runs one leg and judges the last answer it saw. A throw never decides alone: the answer does,
 * except that a client which refused a healthy-looking answer is a fault too.
 */
async function runLeg<Value>(
  leg: GatewayLegName,
  run: (gatewayFetch: GatewayFetch) => Promise<Value>,
): Promise<LegRun<Value>> {
  const seen: GatewayObservation[] = [];
  let value: Value | undefined;
  let accepted = true;
  try {
    value = await run(observingFetch(seen));
  } catch {
    accepted = false;
  }
  const observation: GatewayObservation = seen.at(-1) ?? { kind: "not_sent" };
  const verdict = classifyGatewayLeg(leg, observation, accepted);
  return { result: { leg, verdict, observation, failure: null }, value };
}

function observingFetch(seen: GatewayObservation[]): GatewayFetch {
  return async (request) => {
    let response: Response;
    try {
      response = await fetch(request);
    } catch (error) {
      seen.push({ kind: "fetch_failed" });
      throw error;
    }
    seen.push(await observe(response));
    return response;
  };
}

async function observe(response: Response): Promise<GatewayObservation> {
  const contentType = response.headers.get("content-type");
  let body = "";
  if (readsBody(contentType)) {
    try {
      body = await response.clone().text();
    } catch {
      return { kind: "fetch_failed" };
    }
  }
  return describeResponse({
    status: response.status,
    contentType,
    body,
    egressOutcome: response.headers.get("x-ohmyhost-egress-outcome"),
    stage: response.headers.get("x-ohmyhost-gateway-stage"),
  });
}

async function databaseLeg(leg: DatabaseLegName, run: () => Promise<void>): Promise<LegResult> {
  let failure: string | null = null;
  try {
    await run();
  } catch (error) {
    failure = errorCode(error);
  }
  return { leg, verdict: classifyDatabaseLeg(failure), observation: null, failure };
}

function expectReady(result: CustomerDatabaseQueryResult | undefined): void {
  if (result?.rows.length !== 1 || result.rows[0]?.["ok"] !== 1) {
    throw coded("database_response_invalid");
  }
}

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A leg whose work an earlier attempt of this run recorded; the log names it as not probed. */
function repeated(leg: GatewayLegName): LegResult {
  return { leg, verdict: "ok", observation: null, failure: null, replayed: true };
}

function redLegs(report: Report): string {
  const names = report.results.filter((result) => result.verdict !== "ok").map(({ leg }) => leg);
  return (names.length > 0 ? names : [report.reason ?? "none"]).join(", ");
}

/** One JSON line: verdicts, statuses and closed-vocabulary tokens only. Never a URL, key or body. */
function logLine(report: Report) {
  const at = new Date(report.scheduledTime);
  const replayed = report.results
    .filter((result) => result.replayed === true)
    .map(({ leg }) => leg);
  return {
    event: "gateway_canary",
    tick: report.tick,
    verdict: report.verdict,
    scheduledAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
    legs: Object.fromEntries(report.results.map(({ leg, verdict }) => [leg, verdict])),
    red: report.results
      .filter((result) => result.verdict !== "ok")
      .map(({ leg, verdict, observation, failure }) => {
        const answer = observation?.kind === "response" ? observation : null;
        return {
          leg,
          verdict,
          observed: observation?.kind ?? null,
          status: answer?.status ?? null,
          code: answer?.code ?? null,
          outcome: answer?.egressOutcome ?? null,
          stage: answer?.stage ?? null,
          failure,
        };
      }),
    ...(replayed.length === 0 ? {} : { replayed }),
    ...(report.reason === null ? {} : { reason: report.reason }),
    ...(report.missing.length === 0 ? {} : { missing: report.missing }),
  };
}
