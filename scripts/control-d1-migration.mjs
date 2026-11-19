/* global process */
import { Buffer } from "node:buffer";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { canonical, fail, sha256, tableProof } from "./control-d1-codec.mjs";
import {
  capture,
  openCapture,
  appendJournal,
  readPrivate,
  writeExclusive,
} from "./control-d1-artifacts.mjs";
import { archiveNdjson, archiveGzip } from "./control-d1-dispositions.mjs";
import { buildPlan } from "./control-d1-mappings.mjs";
import { CLOUDFLARE_COLUMNS } from "./control-d1-cloudflare-mappings.mjs";
import { readCloudflarePages, readCloudflareFacts } from "./control-d1-cloudflare-readback.mjs";
import { proveFixedProjectionPages } from "./control-d1-readback-pages.mjs";
import { MAIL_COLUMNS, MAIL_RETIRED_COLUMNS } from "./control-d1-mail-mappings.mjs";
import { readMailSourceFacts } from "./control-d1-mail-readback.mjs";
import { GENERIC_COLUMNS, readGenericSourceFacts } from "./control-d1-generic-mappings.mjs";
import { R2_STORAGE_COLUMNS } from "./control-d1-r2-storage-mappings.mjs";
import { readR2StoragePages, readR2StorageFacts } from "./control-d1-r2-storage-readback.mjs";
import {
  targetPin,
  openLocalTarget,
  importPlan,
  compareRecords,
  compareSequences,
  comparePhase,
  compareDispositions,
  importOverlay,
} from "./control-d1-target.mjs";
import {
  finalTables,
  phasePlan,
  preloadContent,
  readInsertDependencies,
  roundContent,
} from "./control-d1-phases.mjs";
import { comparePages, importApiBulk, importApiClient, restQuery } from "./control-d1-bulk.mjs";
import { observeFixedCore, openFixedCoreTarget } from "./control-core-operator.mjs";
import {
  activateAuthority,
  closeImport,
  readActivation,
  recordComparison,
} from "./control-d1-activation.mjs";

export {
  capture,
  openCapture,
  appendJournal,
  buildPlan,
  targetPin,
  openLocalTarget,
  importPlan,
  compareRecords,
  compareSequences,
  readCloudflarePages,
  readCloudflareFacts,
  readMailSourceFacts,
  readR2StoragePages,
  readR2StorageFacts,
};

/** Full original typed count/multiset proof, independent from the mapper's compatibility projection. */
export async function compareCloudflareSourceProofs(db, image, mapped) {
  const mismatches = [];
  for (const table of Object.keys(CLOUDFLARE_COLUMNS)) {
    if (!mapped.includes(table)) continue;
    const source = image.manifest.tables.find((entry) => entry.name === table);
    if (!source) fail("CLOUDFLARE_SOURCE_COLUMNS");
    const actual = await proveFixedProjectionPages(source.columns, readCloudflarePages(db, table));
    if (actual.rows !== source.rows || actual.sha256 !== source.sha256) mismatches.push(table);
  }
  return mismatches;
}

/**
 * Closed original Mail framing; current live census is small, and no row/value is truncated. A table with retired
 * columns is proven over the columns the Core keeps, from the captured rows.
 */
export async function compareMailSourceProofs(db, image, mapped) {
  if (!Object.keys(MAIL_COLUMNS).some((name) => mapped.includes(name))) return [];
  const facts = await readMailSourceFacts(db),
    mismatches = [];
  for (const table of Object.keys(MAIL_COLUMNS)) {
    if (!mapped.includes(table)) continue;
    const source = image.manifest.tables.find((entry) => entry.name === table);
    if (!source) fail("MAIL_SOURCE_FORMAT_UNHANDLED");
    const retired = MAIL_RETIRED_COLUMNS[table] ?? [],
      columns = source.columns.filter((column) => !retired.includes(column.name)),
      expected =
        retired.length === 0
          ? source
          : tableProof(
              columns,
              image.rows.get(table).map((row) => columns.map((column) => row[column.name])),
            ),
      actual = tableProof(
        columns,
        facts.get(table).map((row) => columns.map((column) => row[column.name])),
      );
    if (actual.rows !== expected.rows || actual.sha256 !== expected.sha256) mismatches.push(table);
  }
  return mismatches;
}

/** Generic 1:1 families: the independent original-format readback must reproduce the captured multiset proof. */
export async function compareGenericSourceProofs(db, image, mapped) {
  const names = Object.keys(GENERIC_COLUMNS).filter((name) => mapped.includes(name));
  if (names.length === 0) return [];
  const facts = await readGenericSourceFacts(db),
    mismatches = [];
  for (const table of names) {
    const source = image.manifest.tables.find((entry) => entry.name === table);
    if (!source) fail("GENERIC_SOURCE_REQUIRED");
    const actual = tableProof(
      source.columns,
      facts.get(table).map((row) => source.columns.map((column) => row[column.name])),
    );
    if (actual.rows !== source.rows || actual.sha256 !== source.sha256) mismatches.push(table);
  }
  return mismatches;
}

/** Six original R2/Storage families; preserved infinity tags and marker bytes enter the original proof frame. */
export async function compareR2StorageSourceProofs(db, image, mapped) {
  const mismatches = [];
  for (const table of Object.keys(R2_STORAGE_COLUMNS)) {
    if (!mapped.includes(table)) continue;
    const source = image.manifest.tables.find((entry) => entry.name === table);
    if (!source) fail("R2_STORAGE_SOURCE_REQUIRED");
    const actual = await proveFixedProjectionPages(source.columns, readR2StoragePages(db, table));
    if (actual.rows !== source.rows || actual.sha256 !== source.sha256) mismatches.push(table);
  }
  return mismatches;
}

/**
 * One round of the two-phase import (`--phase preload|final`). `previousCaptureDirectories` are the captures of the
 * earlier rounds, oldest first: the last one is what the target already holds, the first one opened the import context.
 */
async function derivePhase(plan, phase, config, key, pin) {
  const previous = config.previousCaptureDirectories ?? [];
  const probe = await openLocalTarget({ repositoryRoot: config.repositoryRoot });
  try {
    const overlay = await importOverlay(probe.db, config.repositoryRoot, pin);
    const closed = finalTables(
      await readInsertDependencies(
        probe.db,
        new Set(overlay.triggers.map((trigger) => trigger.name)),
      ),
    );
    let identity = { captureId: plan.captureId, manifestSha256: plan.manifestSha256 };
    if (previous.length > 0) {
      const index = JSON.parse(
        (await readPrivate(join(previous[0], "capture-index.json"))).toString(),
      );
      identity = { captureId: index.captureId, manifestSha256: index.sha256 };
    }
    let baseline;
    if (previous.length > 0) {
      const earlier = await openCapture({ directory: previous.at(-1), key });
      baseline = preloadContent(
        buildPlan(earlier, pin, config.source, { archiveTables: config.archiveTables }),
        closed,
      );
    }
    return {
      plan: phasePlan(plan, { phase, baseline, closed, identity }),
      content: () => roundContent(plan, { phase, closed }),
    };
  } finally {
    await probe.dispose();
  }
}

/**
 * The last two operator steps of the import, after `compare-remote --phase final`. Neither needs the capture or its key:
 * `close-import` is confirmed by the comparison digest that command printed (and found as its receipt in the Core),
 * `activate` by the environment name. An activated Core still answers the activation readback, so a repeat is a replay.
 */
async function runAuthority(command, flags, config, dependencies) {
  const environment = config.remote?.environment;
  const confirmed =
    command === "close-import"
      ? /^[a-f0-9]{64}$/u.test(flags.get("--comparison") ?? "")
      : typeof environment === "string" && flags.get("--confirm") === environment;
  if (!confirmed) fail("CONFIRMATION");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const queryFor = (databaseId) =>
    (dependencies.remoteQuery ?? restQuery)({ accountId, databaseId });
  if (command === "activate") {
    const core = await (dependencies.observeCore ?? observeFixedCore)({ accountId, environment });
    const activated = await readActivation(queryFor(core.databaseId));
    if (activated !== null) return { ...activated, environment, replayed: true };
  }
  const target = await (dependencies.openRemote ?? openFixedCoreTarget)({
    accountId,
    environment,
    custody: config.remote?.custody,
    repositoryRoot: config.repositoryRoot,
  });
  try {
    return command === "close-import"
      ? await closeImport(target.db, { comparisonSha256: flags.get("--comparison") })
      : { ...(await activateAuthority(target.db)), environment };
  } finally {
    await target.dispose();
  }
}

/** Operator-only local CLI. The resolver is an explicitly hash-pinned trusted module, never a customer binding. */
export async function runCli(args, dependencies = {}) {
  const [command, ...rest] = args;
  const flags = new Map();
  for (let position = 0; position < rest.length; position += 2) {
    if (
      !/^--[a-z-]+$/u.test(rest[position]) ||
      rest[position + 1] === undefined ||
      flags.has(rest[position])
    )
      fail("ARGUMENT");
    flags.set(rest[position], rest[position + 1]);
  }
  if (
    ![
      "capture",
      "plan",
      "archive",
      "import-local",
      "compare",
      "resume",
      "status",
      "import-remote",
      "compare-remote",
      "close-import",
      "activate",
    ].includes(command)
  )
    fail("COMMAND");
  const authority = command === "close-import" || command === "activate";
  const allowed = authority
    ? ["--config", "--comparison", "--confirm"]
    : ["--config", "--key-fd", "--phase"];
  if ([...flags.keys()].some((flag) => !allowed.includes(flag))) fail("ARGUMENT");
  const config = JSON.parse(
    (await readPrivate(resolve(flags.get("--config") ?? fail("CONFIG")))).toString(),
  );
  if (authority) return runAuthority(command, flags, config, dependencies);
  const descriptor = Number(flags.get("--key-fd"));
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1024) fail("KEY_FD");
  const key = Buffer.from((dependencies.readKey ?? readFileSync)(descriptor));
  if (key.byteLength !== 32) fail("KEY");
  try {
    const pin = await targetPin(config.repositoryRoot);
    if (command === "capture") {
      if (
        typeof config.operatorModule !== "string" ||
        !/^[a-f0-9]{64}$/u.test(config.operatorSha256)
      )
        fail("OPERATOR");
      const modulePath = resolve(config.operatorModule);
      if (sha256(await readFile(modulePath)) !== config.operatorSha256) fail("OPERATOR_PIN");
      const moduleUrl = pathToFileURL(modulePath);
      moduleUrl.searchParams.set("sha256", config.operatorSha256);
      const resolver = await import(moduleUrl.href);
      const source = await resolver.resolveSource(config.source);
      try {
        return await capture({
          ...source,
          expectedSource: config.source,
          targetPin: pin,
          output: config.captureDirectory,
          key,
          schema: config.source.schema ?? "public",
        });
      } finally {
        await source.close();
      }
    }
    const image = await openCapture({ directory: config.captureDirectory, key });
    if (image.manifest.sourceSchemaSha256 !== config.sourceSchemaSha256) fail("SOURCE_SCHEMA_PIN");
    let plan = buildPlan(image, pin, config.source, { archiveTables: config.archiveTables });
    let content = () => plan.records;
    if (flags.has("--phase"))
      ({ plan, content } = await derivePhase(plan, flags.get("--phase"), config, key, pin));
    const summary = {
      captureId: plan.captureId,
      verdict: plan.verdict,
      qualificationOnly: true,
      digest: plan.digest,
      records: plan.records.length,
      ...(plan.phaseInfo === undefined ? {} : { phase: plan.phaseInfo }),
      mapped: plan.mapped,
      unhandled: plan.unhandled,
      unhandledViews: plan.unhandledViews,
      unhandledSequences: plan.unhandledSequences,
      dispositions: plan.dispositions,
      runtimeGates: plan.runtimeGates,
      sequences: plan.sequenceRestores.length,
      gaps: plan.gaps,
    };
    if (command === "plan" || command === "status") return summary;
    if (command === "archive") {
      // The R2 upload is a separate operator step; this only materializes the exact verified objects.
      const directory = resolve(config.archiveDirectory ?? fail("ARCHIVE_DIRECTORY"));
      await mkdir(directory, { mode: 0o700 });
      const archives = [];
      for (const entry of plan.dispositions.filter((item) => item.kind === "archive")) {
        const definition = image.manifest.tables.find((table) => table.name === entry.table);
        const ndjson = archiveNdjson(entry.table, definition, image.rows.get(entry.table));
        const gzip = archiveGzip(ndjson);
        if (sha256(ndjson) !== entry.ndjsonSha256 || sha256(gzip) !== entry.gzipSha256)
          fail("ARCHIVE_DIGEST");
        await writeExclusive(join(directory, `${entry.table}.ndjson.gz`), gzip);
        archives.push({
          table: entry.table,
          archiveKey: entry.archiveKey,
          rows: entry.rows,
          bytes: gzip.byteLength,
          ndjsonSha256: entry.ndjsonSha256,
          gzipSha256: entry.gzipSha256,
        });
      }
      return { captureId: plan.captureId, planDigest: plan.digest, archives };
    }
    // The remote Core takes its files through the D1 import API and is compared by whole-table page scans.
    const remote = command === "import-remote" || command === "compare-remote";
    const local = remote
      ? await (dependencies.openRemote ?? openFixedCoreTarget)({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          environment: config.remote?.environment,
          custody: config.remote?.custody,
          repositoryRoot: config.repositoryRoot,
        })
      : await openLocalTarget({
          repositoryRoot: config.repositoryRoot,
          persistence: config.localTargetDirectory,
        });
    const query = remote
      ? (dependencies.remoteQuery ?? restQuery)({
          accountId: local.accountId,
          databaseId: local.databaseId,
        })
      : undefined;
    try {
      const journal = join(config.journalDirectory, "control-d1-import.jsonl");
      if (command === "import-local" || command === "resume" || command === "import-remote")
        return await importPlan({
          db: local.db,
          plan,
          targetId: config.targetId,
          key,
          journal,
          currentPin: pin,
          repositoryRoot: config.repositoryRoot,
          ...(config.batchRows === undefined ? {} : { batchRows: config.batchRows }),
          ...(remote
            ? {
                bulk: importApiBulk({
                  apply: (dependencies.remoteApply ?? importApiClient)({
                    accountId: local.accountId,
                    databaseId: local.databaseId,
                  }),
                  query,
                  compareOnImport: config.remote?.compareOnImport !== false,
                  onFile: (file) => process.stderr.write(`${canonical({ file })}\n`),
                }),
              }
            : {}),
        });
      const proofs = [];
      const mismatches = remote
        ? await comparePages(local.db, content(), {
            query,
            exact: true,
            report: (proof) => proofs.push(proof),
          })
        : await compareRecords(local.db, plan.records);
      // The source proofs cover whole families, so they belong to the round that completes the import.
      const complete = plan.phaseInfo?.phase !== "preload";
      if (
        mismatches.length > 0 ||
        (await comparePhase(local.db, plan, config.targetId)).length > 0 ||
        (await compareSequences(local.db, plan.sequenceRestores)).length > 0 ||
        (await compareDispositions(local.db, plan, config.targetId)).length > 0 ||
        (complete &&
          (await compareCloudflareSourceProofs(local.db, image, plan.mapped)).length > 0) ||
        (complete && (await compareMailSourceProofs(local.db, image, plan.mapped)).length > 0) ||
        (complete &&
          (await compareR2StorageSourceProofs(local.db, image, plan.mapped)).length > 0) ||
        (complete && (await compareGenericSourceProofs(local.db, image, plan.mapped)).length > 0)
      )
        fail("IMPORT_COMPARISON");
      await appendJournal(journal, key, {
        phase: "compared",
        captureId: plan.captureId,
        targetId: config.targetId,
        digest: plan.digest,
      });
      const comparisonSha256 = remote
        ? sha256(
            Buffer.from(
              canonical(proofs.map(({ table, rows, sha256: digest }) => ({ table, rows, digest }))),
            ),
          )
        : undefined;
      // The comparison that completes the import leaves the receipt `close-import` consumes.
      if (remote && complete)
        await recordComparison(local.db, {
          captureId: plan.captureId,
          targetId: config.targetId,
          planDigest: plan.digest,
          comparisonSha256,
          tables: proofs.length,
        });
      return {
        ...summary,
        compared: true,
        ...(remote ? { tables: proofs.length, comparisonSha256 } : {}),
      };
    } finally {
      await local.dispose();
    }
  } finally {
    key.fill(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(`${canonical(result)}\n`);
    if (result.verdict === "INCOMPLETE") process.exitCode = 2;
  } catch (error) {
    const code = /^CONTROL_D1_[A-Z_]+$/u.test(error.message) ? error.message : "CONTROL_D1_FAILED";
    process.stderr.write(
      `${canonical({ code, ...(error.detail === undefined ? {} : { detail: error.detail }) })}\n`,
    );
    process.exitCode = 1;
  }
}
