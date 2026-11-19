/* global structuredClone */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { originalControlFixture, repositoryRoot } from "./support/control-conversion-fixture.mjs";
import {
  PUBLIC_BETA_SOURCE_DEFINITION,
  qualifySourceViews,
  readPublicBetaSources,
} from "../scripts/control-d1-view-readers.mjs";
import { buildPlan, openLocalTarget, importPlan } from "../scripts/control-d1-migration.mjs";
import { tableProof } from "../scripts/control-d1-codec.mjs";

let fixture, image, plan;
const sourceId = "view-predicate-native";
before(
  async () => {
    fixture = await originalControlFixture("view-readers");
    await fixture.pool.query(
      "INSERT INTO signup_sources(source_id,active,admits_beta,bonus_micros) VALUES($1,true,true,0)",
      [sourceId],
    );
    image = await fixture.image("source-views");
    plan = await fixture.import(image, "source-views");
  },
  { timeout: 240_000 },
);
after(async () => fixture?.dispose());

async function compare(db) {
  const columns = image.manifest.tables
      .find((table) => table.name === "signup_sources")
      .columns.filter((column) => column.name === "source_id"),
    original = (await fixture.pool.query("SELECT source_id FROM public_beta_sources")).rows,
    target = await readPublicBetaSources(db);
  assert.deepEqual(
    tableProof(
      columns,
      target.map((row) => [row.source_id]),
    ),
    tableProof(
      columns,
      original.map((row) => [row.source_id]),
    ),
  );
}

test("only the exact original110 public-beta reader qualifies and native source/readback/second restore agree", async () => {
  assert.deepEqual(plan.gaps, []);
  assert.equal(plan.verdict, "MAPPED_QUALIFICATION_ONLY");
  // The effective-WFP reader qualifies through its mapped parents next to the public-beta reader; the views of the
  // removed usage tables are declared removed and have no reader.
  assert.equal(plan.qualifiedViews.length, 2);
  assert.equal(
    plan.qualifiedViews.some((reader) => reader.sourceName === "public_beta_sources"),
    true,
  );
  assert.equal(plan.unhandledViews.length, 0);
  assert.equal(
    image.manifest.views.find((view) => view.name === "public_beta_sources").definition,
    PUBLIC_BETA_SOURCE_DEFINITION,
  );
  await compare(fixture.db);
  const restore = await openLocalTarget({ repositoryRoot });
  try {
    await importPlan({
      db: restore.db,
      plan,
      key: fixture.key,
      targetId: "public-beta-restore",
      journal: join(fixture.directory, "view-restore.journal"),
      currentPin: image.manifest.targetPin,
    });
    await compare(restore.db);
  } finally {
    await restore.dispose();
  }
});

test("the original native boolean predicate agrees for every subsequent active/admission combination", async () => {
  for (const active of [false, true])
    for (const admits of [false, true]) {
      await fixture.pool.query(
        "UPDATE signup_sources SET active=$2,admits_beta=$3 WHERE source_id=$1",
        [sourceId, active, admits],
      );
      await fixture.db
        .prepare("UPDATE signup_sources SET active=?,admits_beta=? WHERE source_id=?")
        .bind(active ? 1 : 0, admits ? 1 : 0, sourceId)
        .run();
      await compare(fixture.db);
      assert.equal(
        (await readPublicBetaSources(fixture.db)).some((row) => row.source_id === sourceId),
        active && admits,
      );
    }
});

test("unknown or changed view bytes, duplicate identity and unqualified physical parents remain explicit blockers", () => {
  const original = image.manifest.views.find((view) => view.name === "public_beta_sources"),
    parents = new Set(["signup_sources"]);
  assert.deepEqual(qualifySourceViews({ manifest: { views: [] } }, new Set()), {
    readers: [],
    gaps: [],
  });
  assert.equal(
    qualifySourceViews({ manifest: { views: [] } }, parents).gaps[0].code,
    "CONTROL_D1_VIEW_REQUIRED",
  );
  for (const views of [
    [{ ...original, definition: `${original.definition} ` }],
    [original, original],
  ]) {
    const result = qualifySourceViews({ manifest: { views } }, parents);
    assert.deepEqual(result.readers, []);
    assert.equal(result.gaps[0].code, "CONTROL_D1_VIEW_DEFINITION_UNQUALIFIED");
  }
  assert.equal(
    qualifySourceViews(image, new Set()).gaps[0].code,
    "CONTROL_D1_VIEW_PARENT_UNQUALIFIED",
  );
  const damaged = structuredClone(image.manifest);
  damaged.views.find((view) => view.name === "public_beta_sources").definition += " ";
  const result = buildPlan({ ...image, manifest: damaged }, damaged.targetPin, {
    role: "postgres",
    database: "postgres",
  });
  assert.equal(result.unhandledViews.includes("public_beta_sources"), true);
  assert.equal(
    result.qualifiedViews.some((reader) => reader.sourceName === "public_beta_sources"),
    false,
  );
  assert.equal(result.verdict, "INCOMPLETE");
  const absent = structuredClone(image.manifest);
  absent.views = absent.views.filter((view) => view.name !== "public_beta_sources");
  const missing = buildPlan({ ...image, manifest: absent }, absent.targetPin, {
    role: "postgres",
    database: "postgres",
  });
  assert.equal(missing.verdict, "INCOMPLETE");
  assert.equal(
    missing.gaps.some((gap) => gap.code === "CONTROL_D1_VIEW_REQUIRED"),
    true,
  );
  const missingParent = structuredClone(image.manifest);
  missingParent.tables.find((table) => table.name === "signup_sources").columns.pop();
  const unsupported = buildPlan({ ...image, manifest: missingParent }, missingParent.targetPin, {
    role: "postgres",
    database: "postgres",
  });
  assert.equal(unsupported.unhandledViews.includes("public_beta_sources"), true);
  assert.equal(
    unsupported.gaps.some((gap) => gap.code === "CONTROL_D1_VIEW_PARENT_UNQUALIFIED"),
    true,
  );
});
