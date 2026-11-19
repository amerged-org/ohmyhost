/* global console, process, URL */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_MIGRATIONS,
  REBUILD,
  buildGraph,
  danglingReferences,
  dropStatements,
  planDrop,
  readSchema,
  replayCore,
} from "./core-schema-graph.mjs";

/**
 * W33 simple credits: the Core tables that hold credit, metering, usage or billing history are replaced by the six
 * W33 tables of migration 0600 (credit_account, project_credit, credit_reservation, credit_grant, usage_cursor,
 * credit_log). These are the tables migration 0601 removes, spelled out one by one so a review reads each decision;
 * scripts/core-schema-graph.mjs derives every trigger, view and rebuild that follows from them. A table that is not
 * listed here stays: configuration (published_credit_rate_cards, usage_meter_activations), user relations
 * (user_signup, signup_sources, stripe_billing_customers, stripe_recharge_policies, webhook_inbox) and every other
 * identity, deployment, mail, database and storage table.
 */
export const CREDIT_DROP_ROOTS = [
  // wallet, lots, holds, refunds and the effects that moved them; balances live on in credit_account (0600)
  "credit_wallets",
  "credit_lots",
  "credit_holds",
  "credit_hold_lots",
  "credit_refunds",
  "credit_effects",
  "credit_lot_adjustments",
  "credit_lot_expirations",
  "credit_topup_origins",
  "credit_paid_access",
  "credit_paid_access_events",
  "credit_paid_periods",
  "credit_subscription_ends",
  "credit_grace_periods",
  "project_credit_budgets",
  // credit projections, expiry builds, usage reporting and source custody
  "credit_expiry_builds",
  "credit_expiry_lots",
  "credit_expiry_state",
  "credit_lot_totals",
  "credit_maintenance_bootstrap",
  "credit_maintenance_due",
  "credit_maintenance_notices",
  "credit_org_exposure",
  "credit_project_outstanding",
  "credit_project_period_totals",
  "credit_projection_build_applied",
  "credit_projection_builds",
  "credit_projection_state",
  "credit_source_build_applied",
  "credit_source_builds",
  "credit_source_custody",
  "credit_source_grant_allocations",
  "credit_source_heads",
  "credit_usage_dimension_sequence",
  "credit_usage_dimensions",
  "credit_usage_project_holds",
  "credit_usage_project_months",
  "credit_usage_reporting_build_applied",
  "credit_usage_reporting_builds",
  "credit_usage_reporting_state",
  "credit_usage_visibility_hot",
  // measured usage, valuations, metering work, hints and discovery
  "billing_environment_scopes",
  "control_source_wallet_presence",
  "financial_reservation_identities",
  "measured_credit_movements",
  "measured_credit_reservations",
  "measured_credit_resolutions",
  "usage_sources",
  "usage_valuations",
  "metering_cohort_work",
  "metering_discovery_backfills",
  "metering_lane_owner",
  "metering_owner_activation_receipts",
  "metering_projection_apply",
  "metering_projection_cursors",
  "metering_runtime_identity",
  "organization_metering_work",
  "lifetime_day_hints",
  "lifetime_dirty_notices",
  "lifetime_discovery_bootstrap",
  "lifetime_resource_sources",
  "lifetime_resource_work",
  "provider_hint_bootstrap",
  "provider_collection_cursors",
  "neon_consumption_observations",
  "neon_metering_source_hints",
  "r2_consumption_observations",
  "r2_metering_source_hints",
  "pgcf_collection_cursors",
  "pgcf_collection_page_receipts",
  "pgcf_collection_runs",
  "pgcf_usage_hours",
  "wfp_usage_batches",
  "wfp_usage_events",
  "wfp_batch_discovery",
  "wfp_discovery_cohort_plan",
  // payments, refunds, disputes, checkouts, recharge attempts and consents, tax issues
  "stripe_checkout_requests",
  "stripe_credit_payments",
  "stripe_refund_observations",
  "stripe_dispute_movements",
  "stripe_billing_tax_issues",
  "stripe_recharge_attempts",
  "stripe_recharge_consents",
  "stripe_recharge_reversal_observations",
  // mail credit history, warnings and referral observations
  "mail_credit_accounts",
  "mail_credit_ledger",
  "organization_credit_warnings",
  "referral_observations",
];

/** The migration this plan produces and the last migration it is computed on. */
export const MIGRATION_NAME = "0601_credit_drop_old.sql";
export const COMPUTED_THROUGH = "0600";

const MAIL_REQUESTS = "mail_send_requests";
const MAIL_CREDIT_COLUMNS = [
  "credit_charge_micros",
  "credit_reservation_id",
  "credit_rate_card_id",
  "credit_meter",
  "credit_provider_cost_micros",
];

/** Removes exactly one match of `pattern` from `sql`; anything else means the schema is not what this plan read. */
function removeOnce(sql, pattern, what) {
  const matches = [
    ...sql.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)),
  ];
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${what}, found ${matches.length}`);
  return sql.replace(pattern, "");
}

/**
 * The changes a plain DROP cannot express, all derived from the DDL that is in the database:
 *  - triggers on surviving tables that guard more than a removed table: the same trigger without that clause;
 *  - mail_send_requests, whose credit_* columns sit in a CHECK, a UNIQUE and two foreign keys, so SQLite can only drop
 *    them by rebuilding the table. Its children (the send events and outcomes and the reputation tables) reference it
 *    with ON DELETE RESTRICT and so are rebuilt with it, byte for byte except where an edit below says otherwise.
 */
const TRIGGER_REPLACEMENTS = new Map(
  ["user_signup_shape_insert", "user_signup_shape_update"].map((name) => [
    name,
    (sql) =>
      removeOnce(
        sql,
        /\n {2}OR \(NEW\.credit_grant_id IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM credit_lots WHERE grant_id = NEW\.credit_grant_id\)\)/u,
        `credit_lots clause of ${name}`,
      ),
  ]),
);

const REMOVED_COLUMNS = new Map([[MAIL_REQUESTS, MAIL_CREDIT_COLUMNS]]);

const TABLE_EDITS = new Map([
  [
    MAIL_REQUESTS,
    (sql) => {
      for (const column of MAIL_CREDIT_COLUMNS)
        sql = removeOnce(sql, new RegExp(`^ ${column} [^\\n]*,\\n`, "mu"), `${column} column`);
      sql = removeOnce(
        sql,
        /^ FOREIGN KEY\(organization_id,project_id,credit_reservation_id\) REFERENCES credit_holds\([^\n]*\),\n/mu,
        "credit_holds foreign key",
      );
      return removeOnce(
        sql,
        /^ CHECK\(\(credit_reservation_id IS NULL[^\n]*\n {2}\(credit_reservation_id IS NOT NULL[^\n]*\)\),\n/mu,
        "credit_* CHECK",
      );
    },
  ],
]);

const TRIGGER_EDITS = new Map([
  [
    "mail_send_requests_guard",
    (sql) =>
      removeOnce(
        sql,
        /NEW\.credit_charge_micros IS NOT OLD\.credit_charge_micros OR /u,
        "credit_charge_micros clause of mail_send_requests_guard",
      ),
  ],
]);

/**
 * Rebuilds `group` (parents first) in one atomic batch: stage every row, drop the tables children first, create them
 * again, restore the rows, and only then create indexes and triggers, so no append-only guard sees the restore.
 */
function rebuildStatements({ objects, columns }, group) {
  const copy = (table) => `${table}_copy_0601`;
  const kept = (table) =>
    columns.get(table).filter((c) => !(REMOVED_COLUMNS.get(table) ?? []).includes(c));
  const statements = [];
  for (const table of group)
    statements.push(
      `CREATE TABLE ${copy(table)} AS SELECT ${kept(table).join(", ")} FROM ${table}`,
    );
  for (const table of [...group].reverse()) statements.push(`DROP TABLE ${table}`);
  for (const table of group) {
    const original = objects.find((o) => o.type === "table" && o.name === table).sql;
    const next = (TABLE_EDITS.get(table) ?? ((sql) => sql))(original);
    if (REMOVED_COLUMNS.has(table) && /credit_/u.test(next))
      throw new Error(`${table} still names a credit column`);
    statements.push(next);
  }
  for (const table of group)
    statements.push(
      `INSERT INTO ${table}(${kept(table).join(", ")}) SELECT ${kept(table).join(", ")} FROM ${copy(table)}`,
    );
  for (const table of group) statements.push(`DROP TABLE ${copy(table)}`);
  for (const table of group) {
    const own = objects.filter(
      (o) => o.tableName === table && o.sql !== null && o.type !== "table",
    );
    for (const o of own.filter((o) => o.type === "index")) statements.push(o.sql);
    for (const o of own.filter((o) => o.type === "trigger")) {
      const edit = TRIGGER_EDITS.get(o.name);
      const next = edit === undefined ? o.sql : edit(o.sql);
      if (REMOVED_COLUMNS.has(table) && /credit_/u.test(next))
        throw new Error(`${o.name} still names a credit column`);
      statements.push(next);
    }
  }
  return statements;
}

/** The text of the migration: triggers, replaced guards, views, then the tables (with the rebuild in its place). */
export function renderMigration(schema, plan) {
  const rebuilt = plan.rebuild.map((entry) => entry.table);
  if (rebuilt.length !== 1 || rebuilt[0] !== MAIL_REQUESTS)
    throw new Error(
      `unplanned rebuild of ${rebuilt.join(", ")}: add it to scripts/core-credit-drop.mjs`,
    );
  const dropped = new Set(plan.triggers);
  const replaced = [...TRIGGER_REPLACEMENTS.keys()].map((name) => {
    if (!dropped.has(name))
      throw new Error(`replacement trigger ${name} is not dropped by the plan`);
    const original = schema.objects.find((o) => o.type === "trigger" && o.name === name);
    return TRIGGER_REPLACEMENTS.get(name)(original.sql);
  });
  const section = (title, statements) =>
    `-- ${title}\n${statements.map((s) => `${s};`).join("\n")}\n`;
  const tableSteps = plan.steps.flatMap((step) =>
    step === REBUILD
      ? ["\n", ...rebuildStatements(schema, plan.rebuildGroup)]
      : [`DROP TABLE ${step}`],
  );
  const header =
    `-- W33 simple credits (lane DROP): the old credit, metering, usage and billing schema is removed; balances and user\n` +
    `-- relations live on in the six tables of 0600. GENERATED by \`node scripts/core-credit-drop.mjs --write\` from the\n` +
    `-- schema of migrations 0001..${COMPUTED_THROUGH} and the table list of scripts/core-credit-drop.mjs; tests/core-credit-drop.node-test.mjs\n` +
    `-- fails when this file differs from a fresh generation.\n` +
    `-- ${plan.triggers.length} triggers, ${plan.views.length} views, ${plan.tables.length} tables are dropped; ${plan.rebuildGroup.join(", ")}\n` +
    `-- are rebuilt (mail_send_requests loses its credit_* columns, the others keep their rows and guards unchanged).\n` +
    `PRAGMA defer_foreign_keys=ON;\n`;
  return [
    header,
    section(
      "Triggers first: every trigger that names a removed table, including those on surviving tables",
      plan.triggers.map((name) => `DROP TRIGGER ${name}`),
    ),
    section(
      "Guards of surviving tables that also checked a removed table: the same guard without that clause",
      replaced,
    ),
    section(
      "Views over removed tables",
      plan.views.map((name) => `DROP VIEW ${name}`),
    ),
    `-- Tables, children before parents; the rebuild of the mail send tables sits after the tables that referenced them and\n` +
      `-- before the tables they referenced\n` +
      tableSteps.map((statement) => (statement === "\n" ? "" : `${statement};`)).join("\n") +
      "\n",
  ].join("\n");
}

/** Replays the Core through the last migration this plan is computed on and returns its schema, graph and plan. */
export async function computePlan() {
  const { db, dispose } = await replayCore({ through: COMPUTED_THROUGH });
  try {
    const schema = await readSchema(db);
    const graph = buildGraph(schema);
    return {
      schema,
      graph,
      plan: planDrop(graph, schema.foreignKeys, CREDIT_DROP_ROOTS),
    };
  } finally {
    await dispose();
  }
}

/** The graph of every object with what it names, the drop plan and what it leaves, as text. */
function report({ schema, graph, plan }) {
  const lines = [];
  const counts = (type) => schema.objects.filter((object) => object.type === type).length;
  lines.push(
    `schema after ${COMPUTED_THROUGH}: ${counts("table")} tables, ${counts("view")} views, ${counts("trigger")} triggers, ${counts("index")} indexes`,
  );
  for (const node of graph.nodes.values())
    lines.push(
      `${node.type} ${node.name}${node.type === "table" ? "" : ` ON ${node.tableName}`} -> ${node.references.join(", ")}${node.looseOnly.length > 0 ? `  [name only: ${node.looseOnly.join(", ")}]` : ""}`,
    );
  lines.push(
    "",
    `DROP ORDER (${plan.triggers.length} triggers, ${plan.views.length} views, ${plan.tables.length} tables)`,
    ...dropStatements(plan),
    "",
    `rebuilt together (parents first): ${plan.rebuildGroup.join(", ")}`,
    `triggers of surviving tables that are dropped or rewritten: ${plan.triggersOnSurvivors.length}`,
    ...plan.triggersOnSurvivors.map(
      (trigger) => `  ${trigger.name} ON ${trigger.tableName} -> ${trigger.references.join(", ")}`,
    ),
    `objects still naming a removed table: ${JSON.stringify(danglingReferences(graph, plan))}`,
    `surviving tables (${plan.survivingTables.length}): ${plan.survivingTables.join(" ")}`,
  );
  return lines.join("\n");
}

/**
 * Entrypoints, table lists and bindings of the old credit stack that name or enumerate the removed tables. A name that
 * lives on, rewritten onto the credit account (PublicCreditRuntime, GatewayCreditRuntime, RuntimeCreditService,
 * CreditWarningRecipientsService), is not listed; BillingRuntime stays until the Stripe lane has rewritten it.
 */
export const OLD_CREDIT_SYMBOLS = [
  "BillingRuntime",
  "MeteringRuntime",
  "MeteringOwnerRuntime",
  "PgcfCollectionRuntime",
  "CONTROL_METERING_RUNTIME",
  "READINESS_TABLES",
  "TWINS",
  ...MAIL_CREDIT_COLUMNS,
];

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|sql|jsonc?)$/u;
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "generated",
  "coverage",
  "migrations",
]);

/**
 * Source files under apps/ and packages/ that still name a removed table or view, or an old credit entrypoint or table
 * list: the deletion and rewrite checklist for the waves that follow. Migration history is not a consumer.
 */
export async function findConsumers(repositoryRoot, names) {
  const pattern = new RegExp(`\\b(?:${[...names].sort().join("|")})\\b`, "gu");
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(join(directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path);
      } else if (SOURCE_EXTENSIONS.test(entry.name)) {
        const text = await readFile(path, "utf8");
        const counts = new Map();
        for (const match of text.matchAll(pattern))
          counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
        if (counts.size > 0) found.push({ file: path.slice(repositoryRoot.length + 1), counts });
      }
    }
  };
  for (const top of ["apps", "packages"]) await walk(join(repositoryRoot, top));
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/** The consumer area of a file: the app or package, split further where one app holds many areas. */
export function consumerArea(file) {
  const parts = file.split("/");
  const test = parts.includes("test") || /\.(?:test|integration\.test)\.[cm]?[jt]sx?$/u.test(file);
  const root = `${parts[0]}/${parts[1]}`;
  const inner = parts.findIndex((part) => part === "catalog" || part === "test");
  const detail =
    root === "apps/control-store" &&
    inner !== -1 &&
    parts[inner + 1] !== undefined &&
    !parts[inner + 1].includes(".")
      ? `/${parts.slice(inner, inner + 2).join("/")}`
      : "";
  return `${root}${detail} (${test ? "tests" : "source"})`;
}

/** The names a consumer scan looks for: removed tables and views plus the old entrypoints and table lists. */
export function consumerNames(plan) {
  return new Set([...CREDIT_DROP_ROOTS, ...plan.views, ...OLD_CREDIT_SYMBOLS]);
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  const computed = await computePlan();
  if (flags.has("--write")) {
    await writeFile(
      join(CORE_MIGRATIONS, MIGRATION_NAME),
      renderMigration(computed.schema, computed.plan),
    );
  } else if (flags.has("--migration")) {
    process.stdout.write(renderMigration(computed.schema, computed.plan));
  } else if (flags.has("--consumers")) {
    const consumers = await findConsumers(repositoryRoot, consumerNames(computed.plan));
    const areas = new Map();
    for (const consumer of consumers) {
      const area = consumerArea(consumer.file);
      areas.set(area, [...(areas.get(area) ?? []), consumer]);
    }
    for (const [area, files] of [...areas].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${area}: ${files.length} files`);
      for (const { file, counts } of files)
        console.log(`  ${file}: ${[...counts].map(([name, n]) => `${name}x${n}`).join(" ")}`);
    }
    console.log(`\n${consumers.length} files in ${areas.size} areas`);
  } else if (flags.has("--json")) {
    console.log(JSON.stringify({ ...computed.plan, steps: undefined }, null, 2));
  } else {
    console.log(report(computed));
  }
}
