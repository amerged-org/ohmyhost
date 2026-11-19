import { afterAll, beforeAll, expect, it } from "vitest";

import { startTestPostgres } from "../../../apps/control-api/test/postgres.js";

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;

beforeAll(async () => {
  postgres = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await postgres?.stop();
}, 60_000);

it("lets every command table carry the rename, next to the commands it already carried", async () => {
  const listed = await postgres.pool.query<{ name: string }>(
    `SELECT conname AS name FROM pg_constraint
      WHERE contype='c' AND position('ProjectHandleChangeRequestedV1' in pg_get_constraintdef(oid)) > 0
      ORDER BY conname`,
  );
  expect(listed.rows.map((row) => row.name)).toEqual([
    "product_command_intents_shape_check",
    "product_provider_mutation_claims_shape_check",
    "product_provider_mutation_observations_shape_check",
    "product_provider_reconciliation_attempts_shape_check",
    "product_workflow_replay_attempts_shape",
    "product_workflow_runs_shape_check",
  ]);
  // Widening added the command; it did not drop the ones that were already listed.
  const runs = await postgres.pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname='product_workflow_runs_shape_check'`,
  );
  for (const event of [
    "SourceLinkRequestedV1",
    "DeploymentRequestedV1",
    "DeploymentRollbackRequestedV1",
    "DeploymentPromotionRequestedV1",
    "ProjectDeletionRequestedV1",
  ])
    expect(runs.rows[0]?.definition).toContain(event);
}, 60_000);

it("stores a rename intent with its address and nothing else", async () => {
  const shape = await postgres.pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname='product_command_intents_shape_check'`,
  );
  const definition = shape.rows[0]?.definition ?? "";
  // The rename carries an address and no deployment locator; every other command carries none.
  expect(definition).toContain("requested_handle");
  expect(definition).toContain("[a-z0-9]+(-[a-z0-9]+){0,4}");
  const columns = await postgres.pool.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name='product_command_intents' AND column_name='requested_handle'`,
  );
  expect(columns.rows).toEqual([{ column_name: "requested_handle", is_nullable: "YES" }]);
}, 60_000);
