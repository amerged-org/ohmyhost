#!/usr/bin/env node
/* global console, process */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openFixedCoreTarget } from "./control-core-operator.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import {
  applyPlan,
  cardDigest,
  fail,
  hourInstant,
  parseRateCard,
  planActivate,
  planPublish,
  planSwitch,
  publicInstant,
  readState,
  renderPlan,
  renderState,
  storedInstant,
} from "./credit-prices-model.mjs";
import { readProtected, writeProtected } from "./pgcf-maintenance.mjs";
import { inspectRehearsalRepository } from "./release-rehearse.mjs";
import { requirePrivateReleaseDirectory } from "./release-rehearsal-artifacts.mjs";

/**
 * The operator command for the credit price list of the fixed Core: list the cards and the price of every meter over
 * time, publish a new rate card, and activate a card for one meter or for all its meters from a future hour. A dry run
 * is the default and shows the price difference; `--apply` writes it as one atomic D1 batch of INSERTs (rows are never
 * updated or deleted), journals it in the private custody directory and reads it back. The rules live in
 * credit-prices-model.mjs; docs/architecture/billing-and-pricing.md#changing-prices-and-adding-priced-features is the
 * runbook. Opening the Core is the certified remote binding of the operator (the same as `credit:cutover`), which also
 * writes its attestation row and applies migrations the checked-in commit has beyond the Core, so Production needs
 * `--confirm production` even for `list` and a dry run.
 */
const ACCOUNT = /^[a-f0-9]{32}$/u;
const MAX_CARD_FILE_BYTES = 1_048_576;
const usage = [
  "usage: credit-prices list    --environment development|production --custody <private-directory> [--confirm production]",
  "       credit-prices publish --environment <env> --custody <dir> --card <card.json> [--apply] [--confirm production]",
  "       credit-prices activate --environment <env> --custody <dir> --meter <meter> --card <card-id> --starts-at <UTC hour> [--apply] [--confirm production]",
  "       credit-prices switch  --environment <env> --custody <dir> --card <card-id> --starts-at <UTC hour> [--apply] [--confirm production]",
].join("\n");

const COMMON = ["--environment", "--custody", "--confirm"];
const COMMANDS = {
  list: { allowed: COMMON, required: [] },
  publish: { allowed: [...COMMON, "--card", "--apply"], required: ["--card"] },
  activate: {
    allowed: [...COMMON, "--meter", "--card", "--starts-at", "--apply"],
    required: ["--meter", "--card", "--starts-at"],
  },
  switch: {
    allowed: [...COMMON, "--card", "--starts-at", "--apply"],
    required: ["--card", "--starts-at"],
  },
};

/**
 * @param {string[]} argv
 */
export function parsePriceArguments(argv) {
  const [command, ...rest] = argv;
  const spec = Object.hasOwn(COMMANDS, String(command))
    ? COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)]
    : undefined;
  if (spec === undefined) throw new Error(usage);
  /** @type {Record<string, string | boolean>} */
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = String(rest[index]);
    if (!spec.allowed.includes(flag) || flag in options) throw new Error(usage);
    if (flag === "--apply") {
      options[flag] = true;
      continue;
    }
    const value = rest[(index += 1)];
    if (value === undefined || value.startsWith("--")) throw new Error(usage);
    options[flag] = value;
  }
  const environment = options["--environment"];
  if (
    typeof environment !== "string" ||
    !Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment) ||
    typeof options["--custody"] !== "string" ||
    spec.required.some((flag) => !(flag in options))
  )
    throw new Error(usage);
  // Opening the Core writes the attestation and may upgrade its schema: Production always asks for the word.
  const confirm = options["--confirm"];
  if ((environment === "production" || confirm !== undefined) && confirm !== environment)
    throw new Error(usage);
  return {
    command: /** @type {"list" | "publish" | "activate" | "switch"} */ (command),
    environment,
    custody: options["--custody"],
    cardFile: command === "publish" ? String(options["--card"]) : undefined,
    cardId: command === "activate" || command === "switch" ? String(options["--card"]) : undefined,
    meter: typeof options["--meter"] === "string" ? options["--meter"] : undefined,
    startsAt: typeof options["--starts-at"] === "string" ? options["--starts-at"] : undefined,
    apply: options["--apply"] === true,
  };
}

/**
 * Appends one entry to the price journal of the environment in the private custody directory: what was applied and
 * when, never a credential. An entry is written before the batch is sent and finished after the read-back.
 *
 * @param {string} directory
 * @param {string} environment
 */
async function openJournal(directory, environment) {
  const path = join(directory, `credit-prices-${environment}.json`);
  const found = await readProtected(path, true).catch(() => fail("CREDIT_PRICES_JOURNAL"));
  const journal = found ?? { schemaVersion: "omh.credit-prices/v1", environment, entries: [] };
  if (
    journal.schemaVersion !== "omh.credit-prices/v1" ||
    journal.environment !== environment ||
    !Array.isArray(journal.entries)
  )
    fail("CREDIT_PRICES_JOURNAL");
  return {
    /** @param {Record<string, unknown>} entry */
    async begin(entry) {
      const record = { id: randomUUID(), ...entry, status: "applying" };
      journal.entries.push(record);
      await writeProtected(path, journal);
      return {
        /** @param {Record<string, unknown>} outcome */
        finish: async (outcome) => {
          Object.assign(record, outcome);
          await writeProtected(path, journal);
        },
      };
    },
  };
}

/**
 * Runs one command against the fixed Core. Input that needs no provider (the card file, the instants, the custody) is
 * validated before the Core is opened, so a typo costs no remote session.
 *
 * @param {{ accountId: string, environment: string, custody: string, repositoryRoot: string, command: "list" | "publish" | "activate" | "switch", cardFile?: string | undefined, cardId?: string | undefined, meter?: string | undefined, startsAt?: string | undefined, apply?: boolean }} input
 * @param {Record<string, any>} [dependencies]
 */
export async function runPrices(input, dependencies = {}) {
  const { accountId, environment, custody, repositoryRoot, command } = input;
  const nowMs = (dependencies["now"] ?? (() => new Date()))().getTime();
  const card =
    command === "publish" ? parseRateCard(await readCardFile(String(input.cardFile))) : null;
  const startsAtMs =
    command === "activate" || command === "switch"
      ? hourInstant(input.startsAt, "--starts-at")
      : null;
  const directory = await requirePrivateReleaseDirectory(resolve(custody), repositoryRoot).catch(
    () => fail("CREDIT_PRICES_CUSTODY"),
  );
  const target = await openFixedCoreTarget(
    { accountId, environment, custody, repositoryRoot, upgrade: true },
    dependencies,
  );
  try {
    const state = await readState(target.db);
    if (command === "list")
      return Object.freeze({
        environment,
        command,
        applied: false,
        unchanged: false,
        text: renderState(state, nowMs),
      });
    const plan =
      card !== null
        ? planPublish(state, card, nowMs)
        : command === "switch"
          ? planSwitch(
              state,
              { cardId: String(input.cardId), startsAtMs: Number(startsAtMs) },
              nowMs,
            )
          : planActivate(
              state,
              {
                meter: String(input.meter),
                cardId: String(input.cardId),
                startsAtMs: Number(startsAtMs),
              },
              nowMs,
            );
    const head = `${environment}: ${renderPlan(plan)}`;
    const unchanged = plan.status === "unchanged";
    if (unchanged || input.apply !== true)
      return Object.freeze({
        environment,
        command,
        applied: false,
        unchanged,
        text: [
          head,
          unchanged
            ? "Nothing to write."
            : `Dry run: nothing written. Add --apply to write ${plan.writes.length === 1 ? "this row" : `these ${String(plan.writes.length)} rows`} as one batch.`,
        ].join("\n"),
      });
    const journal = await openJournal(directory, environment);
    const entry = await journal.begin({
      at: new Date(nowMs).toISOString(),
      command,
      cardId: plan.cardId,
      startsAt: plan.startsAt === null ? null : publicInstant(plan.startsAt),
      meters: plan.changes.map((change) => change.meter),
      ...(card === null
        ? {}
        : {
            effectiveFrom: publicInstant(card.effectiveFrom),
            publishedAt: publicInstant(storedInstant(nowMs)),
            digest: cardDigest(card),
          }),
    });
    try {
      await applyPlan(target.db, plan);
    } catch (error) {
      await entry.finish({
        status: "failed",
        code: error instanceof Error ? error.message : "CREDIT_PRICES_FAILED",
      });
      throw error;
    }
    await entry.finish({ status: "applied", readBack: true });
    return Object.freeze({
      environment,
      command,
      applied: true,
      unchanged: false,
      text: [head, "Written as one batch and read back from the Core."].join("\n"),
    });
  } finally {
    await target.dispose();
  }
}

/** @param {string} path */
async function readCardFile(path) {
  const bytes = await readFile(path).catch(() =>
    fail("CREDIT_PRICES_CARD_FILE", "the card file cannot be read"),
  );
  if (bytes.length > MAX_CARD_FILE_BYTES)
    fail("CREDIT_PRICES_CARD_FILE", "the card file is too large");
  return bytes.toString("utf8");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parsePriceArguments(process.argv.slice(2));
    const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
    if (!ACCOUNT.test(accountId ?? "")) fail("CREDIT_PRICES_ACCOUNT_REQUIRED");
    const repositoryRoot = (await inspectRehearsalRepository({ cwd: process.cwd() }))
      .repositoryRoot;
    const result = await runPrices({
      ...options,
      accountId: String(accountId),
      repositoryRoot,
    });
    console.log(result.text);
  } catch (error) {
    // Provider bodies and credentials never reach the output: only fixed tool codes, their price detail and the usage.
    const message = String(error?.message ?? "");
    console.error(
      JSON.stringify(
        message === usage
          ? { usage }
          : /^(?:CREDIT|CUTOVER|CONTROL_CORE|TARGET)_[A-Z_]+$/u.test(message)
            ? { code: message, ...(error.detail === undefined ? {} : { detail: error.detail }) }
            : { code: "CREDIT_PRICES_FAILED" },
      ),
    );
    process.exitCode = 1;
  }
}
