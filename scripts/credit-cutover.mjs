#!/usr/bin/env node
/* global console, process */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readStopTime } from "./control-core-cutover.mjs";
import { openFixedCoreTarget } from "./control-core-operator.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import { inspectRehearsalRepository } from "./release-rehearse.mjs";

/**
 * The one credit step of the cutover that no migration or Worker performs: the four `usage_cursor` rows. The credit
 * service only advances a cursor that exists, so a source without a row is not billed. `wfp` and `pgcf` start at the
 * UTC hour of the technical write stop and `r2` and `resources` at 00:00 UTC of the stop day (the current day is billed
 * after it ends). The stop time is read from the cutover journal in the private custody directory, the rows are written
 * through the operator's certified remote binding of the fixed Core, and only non-secret metadata is printed.
 */
const ACCOUNT = /^[a-f0-9]{32}$/u;
const usage =
  "usage: credit-cutover init-cursors --environment development|production --custody <private-directory> --confirm <environment>";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const USAGE_SOURCES = Object.freeze(["wfp", "pgcf", "r2", "resources"]);
const fail = (code, detail) => {
  throw Object.assign(new Error(code), detail === undefined ? {} : { detail });
};

/** The Core's stored form of an instant: `2026-10-30T09:00:00.000000Z`. */
const stored = (milliseconds) => `${new Date(milliseconds).toISOString().slice(0, 23)}000Z`;

/** The cursor of every source for a stop that completed at `stoppedAt` (an ISO instant). */
export function usageCursorValues(stoppedAt) {
  const at = Date.parse(stoppedAt);
  if (Number.isNaN(at)) fail("CREDIT_STOP_TIME");
  const [hour, day] = [HOUR_MS, DAY_MS].map((unit) => stored(Math.floor(at / unit) * unit));
  return { wfp: hour, pgcf: hour, r2: day, resources: day };
}

const cursorsOf = async (db) =>
  new Map(
    (await db.prepare("SELECT source, through FROM usage_cursor").all()).results.map(
      ({ source, through }) => [source, through],
    ),
  );

/**
 * Inserts the missing cursor rows of the cutover, idempotently. A row that exists with another value (the service
 * already advanced it, or an earlier stop wrote it) is never overwritten: the whole command refuses and writes nothing.
 */
export async function initUsageCursors(
  { accountId, environment, custody, repositoryRoot },
  dependencies = {},
) {
  // The stop time is read before the provider is touched, so a missing or foreign journal costs no remote session.
  const stoppedAt = await readStopTime({ custody, environment, repositoryRoot });
  const wanted = usageCursorValues(stoppedAt);
  const target = await openFixedCoreTarget(
    { accountId, environment, custody, repositoryRoot, upgrade: true },
    dependencies,
  );
  try {
    const found = await cursorsOf(target.db);
    const differing = USAGE_SOURCES.filter(
      (source) => found.has(source) && found.get(source) !== wanted[source],
    );
    if (differing.length > 0) fail("CREDIT_CURSOR_CONFLICT", differing);
    const missing = USAGE_SOURCES.filter((source) => !found.has(source));
    if (missing.length > 0)
      await target.db.batch(
        missing.map((source) =>
          target.db
            .prepare("INSERT INTO usage_cursor(source, through) VALUES (?, ?)")
            .bind(source, wanted[source]),
        ),
      );
    const after = await cursorsOf(target.db);
    if (USAGE_SOURCES.some((source) => after.get(source) !== wanted[source]))
      fail("CREDIT_CURSOR_READBACK");
    return Object.freeze({
      environment,
      stoppedAt,
      cursors: wanted,
      inserted: missing,
      unchanged: USAGE_SOURCES.filter((source) => !missing.includes(source)),
    });
  } finally {
    await target.dispose();
  }
}

export function parseCreditArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!["--environment", "--custody", "--confirm"].includes(flag) || !value || flag in options)
      throw new Error(usage);
    options[flag] = value;
  }
  const environment = options["--environment"];
  if (
    command !== "init-cursors" ||
    !Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment) ||
    !options["--custody"] ||
    options["--confirm"] !== environment
  )
    throw new Error(usage);
  return { command, environment, custody: options["--custody"] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { environment, custody } = parseCreditArguments(process.argv.slice(2));
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!ACCOUNT.test(accountId ?? "")) fail("CREDIT_ACCOUNT_REQUIRED");
    const repositoryRoot = (await inspectRehearsalRepository({ cwd: process.cwd() }))
      .repositoryRoot;
    console.log(
      JSON.stringify(await initUsageCursors({ accountId, environment, custody, repositoryRoot })),
    );
  } catch (error) {
    // Provider bodies and credentials never reach the output: only fixed tool codes and the usage line.
    const message = String(error?.message ?? "");
    console.error(
      JSON.stringify(
        message === usage
          ? { usage }
          : /^(?:CREDIT|CUTOVER|CONTROL_CORE|TARGET)_[A-Z_]+$/u.test(message)
            ? { code: message, ...(error.detail === undefined ? {} : { detail: error.detail }) }
            : { code: "CREDIT_CUTOVER_FAILED" },
      ),
    );
    process.exitCode = 1;
  }
}
