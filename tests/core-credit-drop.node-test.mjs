import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  CORE_MIGRATIONS,
  REBUILD,
  buildGraph,
  danglingReferences,
  dropStatements,
  planDrop,
  referencedObjects,
  splitStatements,
} from "../scripts/core-schema-graph.mjs";
import {
  CREDIT_DROP_ROOTS,
  MIGRATION_NAME,
  computePlan,
  renderMigration,
} from "../scripts/core-credit-drop.mjs";

const table = (name, sql = `CREATE TABLE ${name} (x INTEGER)`) => ({
  type: "table",
  name,
  tableName: name,
  sql,
});
const trigger = (name, on, body) => ({
  type: "trigger",
  name,
  tableName: on,
  sql: `CREATE TRIGGER ${name} AFTER INSERT ON ${on} BEGIN ${body}; END`,
});
const view = (name, select) => ({
  type: "view",
  name,
  tableName: name,
  sql: `CREATE VIEW ${name} AS ${select}`,
});
const key = (child, parent, onDelete = "NO ACTION") => ({
  table: child,
  id: 0,
  parent,
  child: "x",
  target: "x",
  onDelete,
});
const plan = (objects, foreignKeys, roots) =>
  planDrop(buildGraph({ objects, foreignKeys }), foreignKeys, roots);

test("a name counts as referenced in a table position and is only noted when it is a bare identifier", () => {
  const known = new Set(["lots", "wallets", "notes", "audit"]);
  const { positional, loose } = referencedObjects(
    `CREATE TRIGGER t AFTER INSERT ON audit
     WHEN EXISTS (SELECT 1 FROM "lots" l, wallets WHERE l.notes = 'wallets' /* notes */)
     BEGIN UPDATE OR IGNORE wallets SET notes = 1; INSERT INTO lots(x) SELECT 1 FROM audit; END`,
    known,
  );
  assert.deepEqual([...positional].sort(), ["audit", "lots", "wallets"]);
  // `notes` is a column here: seen, but not in a table position; the string and the comment are ignored
  assert.deepEqual([...loose].sort(), ["audit", "lots", "notes", "wallets"]);
});

test("a plan drops the triggers and views that name a removed table, wherever they live, children before parents", () => {
  const objects = [
    table("organizations"),
    table("lots"),
    table("holds"),
    table("hold_lots"),
    table("receipts"),
    trigger("organizations_wallet", "organizations", "INSERT INTO lots(x) VALUES (1)"),
    trigger("lots_guard", "lots", "SELECT RAISE(ABORT, 'x')"),
    trigger("receipts_guard", "receipts", "SELECT RAISE(ABORT, 'x')"),
    view("open_lots", "SELECT * FROM lots"),
    view("open_lots_2", "SELECT * FROM open_lots"),
    view("receipts_view", "SELECT * FROM receipts"),
  ];
  const foreignKeys = [key("holds", "lots"), key("hold_lots", "holds"), key("hold_lots", "lots")];
  const result = plan(objects, foreignKeys, ["lots", "holds", "hold_lots"]);
  assert.deepEqual(result.tables, ["hold_lots", "holds", "lots"]);
  assert.deepEqual(result.triggers, ["lots_guard", "organizations_wallet"]);
  assert.deepEqual(result.views, ["open_lots_2", "open_lots"]);
  assert.deepEqual(result.survivingTables, ["organizations", "receipts"]);
  assert.deepEqual(
    result.triggersOnSurvivors.map((entry) => entry.name),
    ["organizations_wallet"],
  );
  assert.deepEqual(dropStatements(result).slice(0, 3), [
    "DROP TRIGGER lots_guard;",
    "DROP TRIGGER organizations_wallet;",
    "DROP VIEW open_lots_2;",
  ]);
  assert.deepEqual(result.rebuild, []);
  assert.deepEqual(danglingReferences(buildGraph({ objects, foreignKeys }), result), []);
});

test("a surviving table with a foreign key into a removed table is rebuilt together with the tables that restrict it", () => {
  const objects = [
    "credit_holds",
    "mail_requests",
    "mail_events",
    "mail_outcomes",
    "children_of_holds",
  ]
    .map((name) => table(name))
    .concat([table("hold_children")]);
  const foreignKeys = [
    key("mail_requests", "credit_holds"),
    key("mail_events", "mail_requests", "RESTRICT"),
    key("mail_outcomes", "mail_events", "RESTRICT"),
    key("hold_children", "mail_requests"),
    key("children_of_holds", "credit_holds"),
  ];
  const result = plan(objects, foreignKeys, ["credit_holds", "hold_children", "children_of_holds"]);
  assert.deepEqual(
    result.rebuild.map((entry) => entry.table),
    ["mail_requests"],
  );
  assert.deepEqual(result.rebuildGroup, ["mail_requests", "mail_events", "mail_outcomes"]);
  // the dropped child of the rebuilt table goes first, the rebuild next, the dropped parent it referenced last
  assert.deepEqual(result.steps, ["children_of_holds", "hold_children", REBUILD, "credit_holds"]);
});

test("the statement splitter keeps trigger bodies whole", () => {
  assert.equal(
    splitStatements(
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END; SELECT 3; END;\nDROP TABLE b; -- done",
    ).length,
    2,
  );
});

test("the checked-in drop migration is exactly what the schema through 0600 and the table list generate", async () => {
  const computed = await computePlan();
  const generated = renderMigration(computed.schema, computed.plan);
  assert.equal(await readFile(join(CORE_MIGRATIONS, MIGRATION_NAME), "utf8"), generated);

  // Every removed table exists; only the rebuilt mail send request table still names a removed table, and it is
  // rebuilt without that reference; every trigger on a surviving table that is dropped is a notice or a rewritten guard.
  assert.equal(new Set(CREDIT_DROP_ROOTS).size, CREDIT_DROP_ROOTS.length);
  assert.deepEqual(
    danglingReferences(computed.graph, computed.plan).map((entry) => entry.name),
    ["mail_send_requests"],
  );
  assert.deepEqual(computed.plan.rebuildGroup, [
    "mail_send_requests",
    "mail_send_events",
    "mail_reputation_states",
    "mail_send_outcomes",
    "mail_reputation_decisions",
  ]);
  for (const entry of computed.plan.triggersOnSurvivors)
    assert.match(
      entry.name,
      /_lifetime_notice(_update)?$|^maintenance_notice_|^organizations_(credit_|projection_|original_wallet)|^environments_billing_scope$|^user_signup_shape_(insert|update)$/u,
      entry.name,
    );
  // the generated statements are valid whole statements
  for (const statement of splitStatements(generated))
    assert.match(statement.replace(/^(--[^\n]*\n)+/u, ""), /^(CREATE|DROP|INSERT|PRAGMA)\b/u);
  assert.match(generated, /^PRAGMA defer_foreign_keys=ON;$/mu);
});
