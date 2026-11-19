import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

/**
 * Reads the Core schema the way a Worker sees it: replays the checked-in Core migrations on one real local D1 database
 * and derives, from sqlite_master and PRAGMA foreign_key_list, which object references which other object. The plan
 * helpers turn a set of tables to remove into the exact, ordered DROP statements, so a migration that removes a schema
 * area is generated from the schema instead of remembered.
 *
 * scripts/core-credit-drop.mjs is the command line over this module.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const CORE_MIGRATIONS = join(repositoryRoot, "apps/control-store/migrations/core");

/** Splits a migration into statements; a `;` ends one outside strings, comments and BEGIN/CASE ... END blocks. */
export function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let depth = 0;
  let index = 0;
  const flush = (end) => {
    const text = sql.slice(start, end).trim();
    if (text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, "").trim() !== "") statements.push(text);
    start = end + 1;
  };
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      index += 1;
      while (index < sql.length && !(sql[index] === character && sql[index + 1] !== character))
        index += sql[index] === character ? 2 : 1;
      index += 1;
    } else if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
    } else if (character === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
    } else if (/[A-Za-z_]/u.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/u.test(sql[end])) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      if (word === "BEGIN" || word === "CASE") depth += 1;
      else if (word === "END" && depth > 0) depth -= 1;
      index = end;
    } else {
      if (character === ";" && depth === 0) flush(index);
      index += 1;
    }
  }
  flush(sql.length);
  return statements;
}

/** Core migration file names in apply order, optionally only those whose 4-digit number is <= `through`. */
export async function coreMigrationNames({ through } = {}) {
  return (await readdir(CORE_MIGRATIONS))
    .filter(
      (name) => name.endsWith(".sql") && (through === undefined || name.slice(0, 4) <= through),
    )
    .sort();
}

/** Replays the Core migrations on a fresh real D1 database. The caller disposes. */
export async function replayCore({ through, before } = {}) {
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script: "export default {fetch(){return new Response('unserved',{status:503})}}",
      d1Databases: { CONTROL_CORE: "schema-graph" },
    }),
  });
  try {
    const db = await runtime.getD1Database("CONTROL_CORE");
    for (const name of await coreMigrationNames({ through })) {
      if (before !== undefined && name.slice(0, 4) >= before) continue;
      const sql = await readFile(join(CORE_MIGRATIONS, name), "utf8");
      await db.batch(splitStatements(sql).map((statement) => db.prepare(statement)));
    }
    return { db, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/** SQL tokens without comments and string literals; quoted identifiers keep their unquoted value. */
export function tokenize(sql) {
  const tokens = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (/\s/u.test(character)) index += 1;
    else if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
    } else if (character === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
    } else if (character === "'") {
      index += 1;
      while (index < sql.length && !(sql[index] === "'" && sql[index + 1] !== "'"))
        index += sql[index] === "'" ? 2 : 1;
      index += 1;
      tokens.push({ kind: "string", value: "" });
    } else if (character === '"' || character === "`" || character === "[") {
      const close = character === "[" ? "]" : character;
      let value = "";
      index += 1;
      while (index < sql.length && !(sql[index] === close && sql[index + 1] !== close)) {
        if (sql[index] === close) index += 1;
        value += sql[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: "id", value });
    } else if (/[A-Za-z_]/u.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end])) end += 1;
      tokens.push({ kind: "word", value: sql.slice(index, end) });
      index = end;
    } else if (/[0-9]/u.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[0-9A-Za-z_.]/u.test(sql[end])) end += 1;
      tokens.push({ kind: "number", value: sql.slice(index, end) });
      index = end;
    } else {
      tokens.push({ kind: "punct", value: character });
      index += 1;
    }
  }
  return tokens;
}

const LIST_END = new Set([
  "WHERE",
  "GROUP",
  "ORDER",
  "LIMIT",
  "HAVING",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "WINDOW",
  "SET",
  "VALUES",
  "RETURNING",
  "SELECT",
]);

/**
 * Names of `known` objects that `sql` mentions. `positional` holds the mentions in a table position (after FROM,
 * JOIN, INTO, UPDATE, REFERENCES, TABLE or a comma of a FROM list); `loose` holds every identifier equal to a known
 * name, so a column that shares a name with a table shows up there only and gets a manual look.
 */
export function referencedObjects(sql, known) {
  const lower = new Map([...known].map((name) => [name.toLowerCase(), name]));
  const loose = new Set();
  const positional = new Set();
  const tokens = tokenize(sql);
  const lists = []; // active FROM lists: { depth, expect }
  let depth = 0;
  let afterKeyword = null; // the keyword that makes the next identifier a table
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const upper = token.kind === "word" ? token.value.toUpperCase() : null;
    if (token.kind === "punct") {
      if (token.value === "(") {
        const list = lists.at(-1);
        if (list !== undefined && list.depth === depth && list.expect) list.expect = false;
        depth += 1;
      } else if (token.value === ")") {
        depth -= 1;
        while (lists.length > 0 && lists.at(-1).depth > depth) lists.pop();
      } else if (token.value === ",") {
        const list = lists.at(-1);
        if (list !== undefined && list.depth === depth) list.expect = true;
      }
      afterKeyword = null;
      continue;
    }
    if (token.kind === "word" || token.kind === "id") {
      const name = lower.get(token.value.toLowerCase());
      const list = lists.at(-1);
      const inList = list !== undefined && list.depth === depth && list.expect;
      if (name !== undefined) {
        loose.add(name);
        if (
          (token.kind === "id" || !LIST_END.has(upper ?? "")) &&
          (afterKeyword !== null || inList)
        )
          positional.add(name);
      }
      if (token.kind === "word") {
        if (upper === "FROM" || upper === "JOIN") {
          while (lists.length > 0 && lists.at(-1).depth > depth) lists.pop();
          if (upper === "FROM" || list === undefined || list.depth !== depth)
            lists.push({ depth, expect: true });
          else list.expect = true;
          afterKeyword = upper;
          continue;
        }
        if (LIST_END.has(upper) && list !== undefined && list.depth === depth) lists.pop();
        if (upper === "INTO" || upper === "REFERENCES" || upper === "TABLE") {
          afterKeyword = upper;
          continue;
        }
        if (upper === "UPDATE") {
          afterKeyword = upper;
          if (tokens[index + 1]?.kind === "word" && tokens[index + 1].value.toUpperCase() === "OR")
            index += 2;
          continue;
        }
      }
      if (inList) list.expect = false;
      afterKeyword = null;
      continue;
    }
    afterKeyword = null;
  }
  return { loose, positional };
}

/** Every table, view, trigger and index with the foreign keys of each table. */
export async function readSchema(db) {
  const objects = (
    await db
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name",
      )
      .all()
  ).results;
  const tables = objects.filter((object) => object.type === "table").map((object) => object.name);
  const foreignKeys = [];
  const columns = new Map();
  for (const table of tables) {
    columns.set(
      table,
      (
        await db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").bind(table).all()
      ).results.map((row) => row.name),
    );
    const rows = (
      await db
        .prepare(
          `SELECT id, "table" AS parent, "from" AS child, "to" AS target, on_delete AS onDelete FROM pragma_foreign_key_list(?)`,
        )
        .bind(table)
        .all()
    ).results;
    for (const row of rows) foreignKeys.push({ table, ...row });
  }
  return { objects, foreignKeys, columns };
}

/** Dependency graph: for each table/view/trigger/index, the tables and views it names. */
export function buildGraph({ objects, foreignKeys }) {
  const known = new Set(
    objects
      .filter((object) => object.type === "table" || object.type === "view")
      .map((o) => o.name),
  );
  const nodes = new Map();
  for (const object of objects) {
    const { loose, positional } = referencedObjects(object.sql ?? "", known);
    loose.delete(object.name);
    positional.delete(object.name);
    const references = new Set(positional);
    if (object.type !== "table") references.add(object.tableName);
    for (const key of foreignKeys)
      if (key.table === object.name && key.parent !== object.name) references.add(key.parent);
    references.delete(object.name);
    // identifiers that equal a known object but sit in no table position: columns, aliases, or a missed reference
    const looseOnly = [...loose].filter(
      (name) => !positional.has(name) && name !== object.tableName,
    );
    nodes.set(`${object.type}:${object.name}`, {
      ...object,
      references: [...references].sort(),
      looseOnly: looseOnly.sort(),
    });
  }
  return { nodes, known };
}

/**
 * The drop plan for removing `roots`. Triggers and views that name a removed object go too, wherever they live; a
 * surviving table whose foreign key names a removed table cannot simply stay and is reported as `rebuild`.
 */
export function planDrop(graph, foreignKeys, roots) {
  const tables = new Set(roots);
  for (const root of roots)
    if (!graph.known.has(root))
      throw new Error(`drop root ${root} is not a table or view of the schema`);
  const views = new Set();
  const triggers = new Map(); // name -> { tableName, references }
  const removedNames = () => new Set([...tables, ...views]);
  for (let changed = true; changed; ) {
    changed = false;
    const removed = removedNames();
    for (const node of graph.nodes.values()) {
      if (node.type === "view" && !views.has(node.name)) {
        const hit = node.references.filter((name) => removed.has(name));
        if (hit.length > 0) {
          views.add(node.name);
          changed = true;
        }
      } else if (node.type === "trigger" && !triggers.has(node.name)) {
        const hit = node.references.filter((name) => removed.has(name));
        if (hit.length > 0) {
          triggers.set(node.name, { tableName: node.tableName, references: hit });
          changed = true;
        }
      }
    }
  }
  // every view among the roots is also a view to drop
  for (const name of [...tables])
    if (graph.nodes.get(`view:${name}`) !== undefined) {
      tables.delete(name);
      views.add(name);
    }
  const rebuild = new Map(); // surviving table -> its foreign keys into removed tables
  for (const key of foreignKeys)
    if (tables.has(key.parent) && !tables.has(key.table)) {
      rebuild.set(key.table, [...(rebuild.get(key.table) ?? []), key]);
    }
  const surviving = [...graph.nodes.values()].filter(
    (node) => node.type === "table" && !tables.has(node.name),
  );
  const reviews = [...triggers.entries()]
    .filter(([, trigger]) => !tables.has(trigger.tableName) && !rebuild.has(trigger.tableName))
    .map(([name, trigger]) => ({ name, ...trigger }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const group = rebuildGroup(foreignKeys, tables, [...rebuild.keys()]);
  const steps = dropSteps([...tables], group, foreignKeys);
  return {
    tables: steps.filter((step) => step !== REBUILD),
    steps,
    views: dropViewOrder([...views], graph),
    triggers: [...triggers.keys()].sort(),
    triggersOnSurvivors: reviews,
    rebuild: [...rebuild.entries()].map(([table, keys]) => ({ table, keys })),
    rebuildGroup: parentsFirst([...group], foreignKeys),
    survivingTables: surviving.map((node) => node.name).sort(),
  };
}

/** Marks the place of the rebuild of the surviving tables inside the order of dropped tables. */
export const REBUILD = Symbol("rebuild");

/**
 * The surviving tables that must be rebuilt together: SQLite cannot drop a table whose children still reference it
 * (RESTRICT acts at once), so the rebuilt tables carry every table whose foreign key names one of them.
 */
export function rebuildGroup(foreignKeys, removed, seeds) {
  const group = new Set(seeds);
  for (let changed = seeds.length > 0; changed; ) {
    changed = false;
    for (const key of foreignKeys)
      if (group.has(key.parent) && !group.has(key.table) && !removed.has(key.table)) {
        group.add(key.table);
        changed = true;
      }
  }
  return group;
}

function parentsFirst(tables, foreignKeys) {
  const set = new Set(tables);
  const waits = new Map(tables.map((name) => [name, new Set()]));
  for (const key of foreignKeys)
    if (set.has(key.table) && set.has(key.parent) && key.table !== key.parent)
      waits.get(key.table).add(key.parent);
  return topological(tables, waits);
}

/**
 * Children before parents. The rebuild of the group sits after every dropped table that references one of its
 * tables and before every dropped table the old group referenced, so neither side meets a dangling reference.
 * Ties are alphabetical, so the order is deterministic.
 */
function dropSteps(tables, group, foreignKeys) {
  const set = new Set(tables);
  const waits = new Map(tables.map((name) => [name, new Set()]));
  if (group.size > 0) waits.set(REBUILD, new Set());
  for (const key of foreignKeys) {
    if (key.table === key.parent) continue;
    if (set.has(key.table) && set.has(key.parent)) waits.get(key.parent).add(key.table);
    if (set.has(key.table) && group.has(key.parent)) waits.get(REBUILD).add(key.table);
    if (group.has(key.table) && set.has(key.parent)) waits.get(key.parent).add(REBUILD);
  }
  return topological(group.size > 0 ? [...tables, REBUILD] : tables, waits);
}

function dropViewOrder(views, graph) {
  const set = new Set(views);
  const waits = new Map(views.map((name) => [name, new Set()]));
  for (const name of views)
    for (const reference of graph.nodes.get(`view:${name}`).references)
      if (set.has(reference)) waits.get(reference).add(name); // a view waits for the views that read it
  return topological(views, waits);
}

const byName = (a, b) => String(a.description ?? a).localeCompare(String(b.description ?? b));

/** `waits.get(x)` are the names that must come before x. Cycles keep the remaining names in alphabetical order. */
function topological(names, waits) {
  const remaining = new Set(names);
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => [...(waits.get(name) ?? [])].every((other) => !remaining.has(other)))
      .sort(byName);
    const next = ready.length > 0 ? ready : [[...remaining].sort(byName)[0]];
    for (const name of next) {
      remaining.delete(name);
      order.push(name);
    }
  }
  return order;
}

/** The DROP statements of a plan: triggers, views, tables. */
export function dropStatements(plan) {
  return [
    ...plan.triggers.map((name) => `DROP TRIGGER ${quote(name)};`),
    ...plan.views.map((name) => `DROP VIEW ${quote(name)};`),
    ...plan.tables.map((name) => `DROP TABLE ${quote(name)};`),
  ];
}

function quote(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/** Tables left after a plan, plus every remaining object that still names a missing table. */
export function danglingReferences(graph, plan) {
  const gone = new Set([...plan.tables, ...plan.views]);
  const goneTriggers = new Set(plan.triggers);
  const result = [];
  for (const node of graph.nodes.values()) {
    if (gone.has(node.name) && (node.type === "table" || node.type === "view")) continue;
    if (node.type === "trigger" && goneTriggers.has(node.name)) continue;
    if (node.type === "index" && gone.has(node.tableName)) continue;
    if (node.type === "trigger" && gone.has(node.tableName)) continue;
    const hit = node.references.filter((name) => gone.has(name));
    if (hit.length > 0) result.push({ type: node.type, name: node.name, references: hit });
  }
  return result;
}
