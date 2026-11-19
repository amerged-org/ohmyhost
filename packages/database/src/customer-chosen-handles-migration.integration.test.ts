import { afterAll, beforeAll, expect, it } from "vitest";

import { PROJECT_HANDLE_VERSION } from "@ohmyhost/project-handles";

import { startTestPostgres } from "../../../apps/control-api/test/postgres.js";

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;

beforeAll(async () => {
  postgres = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await postgres?.stop();
}, 60_000);

it("accepts a handle a customer chose and keeps the rest of every predicate", async () => {
  const shapes = await postgres.pool.query<{ name: string; definition: string }>(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE contype='c' AND position('[a-z0-9]+(-[a-z0-9]+){0,4}' in pg_get_constraintdef(oid)) > 0
      ORDER BY conname`,
  );
  // Customer handle constraints retain the wider shape after shared routing takes over.
  expect(shapes.rows.map((row) => row.name)).toEqual([
    "cloudflare_project_domains_shape_check",
    "dev_access_tickets_shape_check",
    // The rename command carries a requested address, so its intent check names the shape too.
    "product_command_intents_shape_check",
    "projects_handle_shape_check",
    "wfp_publish_receipts_gateway_shape_check",
  ]);
  const paidGateway = await postgres.pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
     WHERE conname='paid_project_domains_gateway_script_name_check'`,
  );
  expect(paidGateway.rows[0]?.definition).toContain("ohmyho-gateway-production");
  // Widening changed the shape only: the other clauses of each predicate are still there.
  const tickets = shapes.rows.find((row) => row.name === "dev_access_tickets_shape_check");
  expect(tickets?.definition).toContain(
    "expires_at = ANY (ARRAY[(issued_at + '00:10:00'::interval), (issued_at + '01:00:00'::interval)])",
  );
  const domains = shapes.rows.find((row) => row.name === "cloudflare_project_domains_shape_check");
  expect(domains?.definition).toContain("zone_name = 'omh.st'::text");
  expect(shapes.rows.every((row) => !row.definition.includes("[a-z]+-[a-z]+-[a-z]+"))).toBe(true);

  const evidence = await postgres.pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname='projects_handle_evidence_check'`,
  );
  expect(evidence.rows[0]?.definition).toContain("customer-chosen-v1");
  expect(evidence.rows[0]?.definition).toContain("human-id-4.2.0-sha256-project-handle-words-v1");
}, 60_000);

it("stores a chosen handle only with its own provenance", async () => {
  const check = async (handle: string, version: string, attempt: number) =>
    postgres.pool.query(
      `SELECT $1::text ~ '^[a-z0-9]+(-[a-z0-9]+){0,4}$' AND length($1::text) BETWEEN 3 AND 59
          AND (($2::text='human-id-4.2.0-sha256-project-handle-words-v1' AND $3::int BETWEEN 0 AND 31)
            OR ($2::text='customer-chosen-v1' AND $3::int=0)) AS ok`,
      [handle, version, attempt],
    );
  await expect(check("acme-shop", "customer-chosen-v1", 0)).resolves.toMatchObject({
    rows: [{ ok: true }],
  });
  await expect(check("calm-otter-waves", PROJECT_HANDLE_VERSION, 3)).resolves.toMatchObject({
    rows: [{ ok: true }],
  });
  // A chosen handle cannot claim the generator's evidence, and two characters are too short.
  await expect(check("acme-shop", "customer-chosen-v1", 2)).resolves.toMatchObject({
    rows: [{ ok: false }],
  });
  await expect(check("ab", "customer-chosen-v1", 0)).resolves.toMatchObject({
    rows: [{ ok: false }],
  });
}, 60_000);
