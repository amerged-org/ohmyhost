import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  CreditCore,
  CreditLogBucket,
  CreditServiceEnvironment,
  Dependencies,
  LogRow,
  PgcfUsagePort,
  R2UsagePort,
  UsageLogsBucket,
} from "./port.js";
import { runPgcf } from "./pgcf.js";
import { runR2 } from "./r2.js";
import { readUsage } from "./report.js";
import { runResources } from "./resources.js";
import { rotateCreditLog, type RotationReport } from "./rotation.js";
import { POST_ATTEMPTS, REPLAY_LIMIT, type SourceReport } from "./source.js";
import { runWfp } from "./wfp.js";

/*
 * The Credit Service: a private Worker with no public route. The usage cron (minutes 27 and 57) turns the usage of the
 * finished windows into charges and posts them to the Core, then disables the schedules of the projects whose stop
 * budget is reached; the first pass after the provider finalized an hour bills it and the second pass, thirty minutes
 * later, is the retry. The 00:00 UTC cron rotates the credit log to R2. Every step is idempotent through the Core's
 * keys, cursors and the schedules' enabled flag, so a failed pass is simply repeated by the next one.
 * `CreditServiceRuntime` is the Control API's read of the customer usage report.
 */
export const USAGE_CRON = "27,57 * * * *";
export const ROTATION_CRON = "0 0 * * *";

export class CreditServiceError extends Error {
  public constructor(code: string) {
    super(`credit_service_${code}`);
    this.name = "CreditServiceError";
  }
}

const hasMethods = (binding: unknown, methods: readonly string[]): boolean =>
  typeof binding === "object" &&
  binding !== null &&
  methods.every((method) => typeof Reflect.get(binding, method) === "function");

const CORE_METHODS = [
  "postUsage",
  "recordUsageFailure",
  "replayUsageFailures",
  "readCursor",
  "advanceCursor",
  "resolveScripts",
  "readRates",
  "readLogPage",
  "deleteLogThrough",
  "cursorsThrough",
  "readLogsToday",
  "resolvePgcfDatabases",
  "readPendingNativeDatabaseCreates",
  "listR2Buckets",
  "readResources",
  "listStopBudgetProjects",
  "listCreditDeniedProjects",
];

/** The bindings are checked once per invocation; a Worker without all of them cannot bill anything. */
export function readEnvironment(raw: unknown): CreditServiceEnvironment {
  const value = Object(raw) as Record<string, unknown>;
  const environment = value["CREDIT_ENVIRONMENT"];
  const namespace = value["WFP_USAGE_NAMESPACE"];
  if (
    (environment !== "local" && environment !== "development" && environment !== "production") ||
    typeof namespace !== "string" ||
    !/^[a-z0-9-]{1,64}$/u.test(namespace) ||
    !hasMethods(value["USAGE_LOGS"], ["list", "get"]) ||
    !hasMethods(value["CREDIT_LOG"], ["put", "get"]) ||
    !hasMethods(value["CREDIT_RUNTIME"], CORE_METHODS) ||
    !hasMethods(value["NEON_USAGE"], ["collectUsage", "stopSchedules"]) ||
    !hasMethods(value["R2_USAGE"], ["collectUsage"])
  )
    throw new CreditServiceError("configuration_invalid");
  return {
    CREDIT_ENVIRONMENT: environment,
    WFP_USAGE_NAMESPACE: namespace,
    USAGE_LOGS: value["USAGE_LOGS"] as UsageLogsBucket,
    CREDIT_LOG: value["CREDIT_LOG"] as CreditLogBucket,
    CREDIT_RUNTIME: value["CREDIT_RUNTIME"] as CreditCore,
    NEON_USAGE: value["NEON_USAGE"] as PgcfUsagePort,
    R2_USAGE: value["R2_USAGE"] as R2UsagePort,
  };
}

export const consoleLog = (event: Readonly<Record<string, unknown>>): void => {
  const line = JSON.stringify(event);
  if (event["level"] === "error") console.error(line);
  else console.info(line);
};

export const dependenciesOf = (
  environment: CreditServiceEnvironment,
  now: () => number = Date.now,
  log: Dependencies["log"] = consoleLog,
): Dependencies => ({
  core: environment.CREDIT_RUNTIME,
  usageLogs: environment.USAGE_LOGS,
  creditLog: environment.CREDIT_LOG,
  neon: environment.NEON_USAGE,
  r2: environment.R2_USAGE,
  namespace: environment.WFP_USAGE_NAMESPACE,
  now,
  log,
});

const reason = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 200) : "unknown";

/** Rotation is attempted by both crons; a rotation that must wait for the cursors is routine, not a failure. */
export async function runRotation(deps: Dependencies): Promise<RotationReport> {
  const report = await rotateCreditLog(deps);
  const failed = report.problems.length > 0;
  deps.log({ event: "credit_log_rotation", level: failed ? "error" : "info", ...report });
  if (failed) throw new CreditServiceError("rotation_problem");
  return report;
}

const SOURCES: readonly (readonly [string, (deps: Dependencies) => Promise<SourceReport>])[] = [
  ["wfp", runWfp],
  ["pgcf", runPgcf],
  ["r2", runR2],
  ["resources", runResources],
];

/**
 * One usage pass: the four usage sources, each isolated from the failure of the others, then the replay of the
 * postings that failed for good (the invocation fails while one is still open), then a rotation attempt (it only
 * proceeds once every cursor has passed midnight). The invocation fails if anything failed.
 */
export async function runUsage(deps: Dependencies): Promise<void> {
  const failed: string[] = [];
  for (const [name, run] of SOURCES) {
    try {
      const report = await run(deps);
      const problem = report.problems.length > 0;
      deps.log({ event: "credit_usage_source", level: problem ? "error" : "info", ...report });
      if (problem) failed.push(name);
    } catch (error) {
      deps.log({
        event: "credit_usage_source",
        level: "error",
        source: name,
        error: reason(error),
      });
      failed.push(name);
    }
  }
  try {
    const replay = await deps.core.replayUsageFailures({
      minAttempts: POST_ATTEMPTS,
      limit: REPLAY_LIMIT,
    });
    const open = replay.remaining > 0;
    if (replay.replayed > 0 || open)
      deps.log({ event: "credit_usage_replay", level: open ? "error" : "info", ...replay });
    if (open) failed.push("replay");
  } catch (error) {
    deps.log({ event: "credit_usage_replay", level: "error", error: reason(error) });
    failed.push("replay");
  }
  try {
    await runRotation(deps);
  } catch (error) {
    deps.log({ event: "credit_log_rotation", level: "error", error: reason(error) });
    failed.push("rotation");
  }
  if (failed.length > 0) throw new CreditServiceError(`incomplete:${failed.join(",")}`);
}

/** The Control API's private binding: the usage report of one organization from the rotated log and today's rows. */
export class CreditServiceRuntime extends WorkerEntrypoint<CreditServiceEnvironment> {
  public async readUsage(input: unknown): Promise<LogRow[]> {
    return readUsage(dependenciesOf(readEnvironment(this.env)), input);
  }
}

export default {
  fetch(): Response {
    return new Response(JSON.stringify({ code: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
  async scheduled(controller: { readonly cron: string }, env: unknown): Promise<void> {
    const deps = dependenciesOf(readEnvironment(env));
    if (controller.cron === USAGE_CRON) await runUsage(deps);
    else if (controller.cron === ROTATION_CRON) await runRotation(deps);
    else throw new CreditServiceError("cron_unknown");
  },
};
