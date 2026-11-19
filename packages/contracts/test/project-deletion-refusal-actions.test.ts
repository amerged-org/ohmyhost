import { expect, it } from "vitest";

import { PROBLEM_POLICY } from "../src/problem-policy.js";

/** A deletion refused while a SQL export is captured answers project_operation_in_progress, so only that code's next action names the export. */
it("names the SQL export capture in project_operation_in_progress, not in the confirmation refusal", () => {
  const capture = "A deletion is also refused while a SQL export of the project is being captured";
  const { action, restAction } = PROBLEM_POLICY.confirmation_invalid;
  expect(action).not.toContain("SQL export");
  expect(restAction).not.toContain("SQL export");
  const inProgress = PROBLEM_POLICY.project_operation_in_progress.action;
  expect(inProgress).toContain(capture);
  // The CLI reads a suggested action of at most 500 characters.
  expect(inProgress.length).toBeLessThanOrEqual(500);
});
