/* global structuredClone */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import path from "node:path";

import {
  inspectArchitectureInterfaces,
  readPlanDocuments,
  readDecisionDocuments,
  validateArchitectureCoverage,
  parsePlanGates,
  parsePlanTasks,
  currentArchitectureErrors,
  validatePlanStructure,
} from "../scripts/check-plan-structure.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const architectureText = readDecisionDocuments(rootDir);

test("the public source validates current interface coverage independently of archived plans", () => {
  assert.deepEqual(currentArchitectureErrors(rootDir), []);
});

test("archive validation retains all task and gate IDs and rejects missing or invalid rows", (context) => {
  const archive = mkdtempSync(path.join(tmpdir(), "omh-plan-fixture-"));
  context.after(() => rmSync(archive, { recursive: true, force: true }));
  const plan = path.join(archive, "docs/plan");
  mkdirSync(path.join(plan, "history"), { recursive: true });
  writeFileSync(path.join(plan, "history/ohmyhost.md"), "Historical fixture\n");
  const tasks = Array.from(
    { length: 38 },
    (_, index) => `| P${String(index + 1).padStart(2, "0")} | DONE | Scope | Evidence | Criteria |`,
  );
  const gates = ["AUTH", "HEADLESS-CONTRACT", "HEADLESS", "HOSTING-POC", "P02"].map(
    (id) => `| GATE-${id} | OPEN | Criteria |`,
  );
  writeFileSync(path.join(plan, "index.md"), gates.join("\n") + "\n");
  writeFileSync(path.join(plan, "completed.md"), tasks.join("\n") + "\n");
  const planText = readPlanDocuments(archive);
  const validate = (text) =>
    validatePlanStructure({ rootDir: archive, planText: text, architectureText });
  assert.deepEqual(validate(planText), []);
  assert.equal(parsePlanTasks(planText).length, 38);
  assert.equal(parsePlanGates(planText).length, 5);
  for (const candidate of [
    planText.replace("| P01 | DONE |", "| P01 | BLOCKED |"),
    planText.replace("| P02 | DONE |", "| P01 | DONE |"),
    planText.replace(/\n\| P02 .*$/m, ""),
    planText.replace("GATE-AUTH", "GATE-P02"),
  ]) {
    assert.notEqual(candidate, planText);
    assert.notDeepEqual(validate(candidate), []);
  }
  assert.deepEqual(validate(planText.split("\n").reverse().join("\n")), []);
});

const coverageManifest = JSON.parse(
  readFileSync(path.join(rootDir, "docs/architecture/coverage.json"), "utf8"),
);
const activeInterfaces = inspectArchitectureInterfaces(rootDir);
const inspectCoverage = (coverage, text = architectureText, interfaces = activeInterfaces) =>
  validateArchitectureCoverage({ rootDir, architectureText: text, coverage, interfaces });

test("architecture coverage matches active interfaces and rejects omitted or stale mappings", () => {
  for (const kind of [
    "source-inspect",
    "source-read",
    "source-publish",
    "source-complete",
    "source-initialize",
    "source-restore",
  ])
    assert.ok(activeInterfaces.cliKinds.includes(kind), `Referenced command alias omitted ${kind}`);
  assert.deepEqual(inspectCoverage(coverageManifest), []);
  const missing = structuredClone(coverageManifest);
  missing.features.find((feature) => feature.rest?.length).rest.pop();
  assert.ok(inspectCoverage(missing).some((error) => error.startsWith("unmapped rest:")));
  const stale = structuredClone(coverageManifest);
  stale.features[0].rest.push("removedOperation");
  assert.ok(inspectCoverage(stale).some((error) => error === "obsolete rest: removedOperation"));
  const duplicate = structuredClone(activeInterfaces);
  duplicate.cliKinds.push(duplicate.cliKinds[0]);
  assert.ok(
    inspectCoverage(coverageManifest, architectureText, duplicate).some((error) =>
      error.includes("duplicate names"),
    ),
  );
});

test("architecture coverage rejects nonexistent and duplicate decision references", () => {
  const missing = structuredClone(coverageManifest);
  missing.features[0].decisions = ["D000"];
  assert.ok(inspectCoverage(missing).some((error) => error.includes("decision IDs")));
  const duplicate = structuredClone(coverageManifest);
  duplicate.features[0].decisions.push(duplicate.features[0].decisions[0]);
  assert.ok(inspectCoverage(duplicate).some((error) => error.includes("decision IDs")));
  const duplicatedRow = architectureText.split("\n").find((line) => line.startsWith("| D001 |"));
  assert.ok(
    inspectCoverage(coverageManifest, `${architectureText}\n${duplicatedRow}`).some((error) =>
      error.includes("decisions must"),
    ),
  );
});

test("architecture coverage validates exact code links and explicit private-job anchors", () => {
  const badLink = architectureText.replace(/#L\d+/u, "#L999999999");
  assert.ok(
    inspectCoverage(coverageManifest, badLink).some((error) => error.includes("code line")),
  );
  const missingFile = structuredClone(coverageManifest);
  missingFile.manualBoundaries[0].file = "missing-source-file.ts";
  assert.ok(
    inspectCoverage(missingFile).some((error) => error.includes("unavailable architecture code")),
  );
  const invalidLine = structuredClone(coverageManifest);
  invalidLine.manualBoundaries[0].line = 0;
  assert.ok(
    inspectCoverage(invalidLine).some((error) => error.includes("invalid architecture code")),
  );
});
