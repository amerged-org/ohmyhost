import { afterAll, beforeAll, expect, it } from "vitest";

import { migrationsThrough, startTestPostgres } from "../../../apps/control-api/test/postgres.js";

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;

beforeAll(async () => {
  postgres = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await postgres?.stop();
}, 60_000);

it("grants the restricted runtime role exactly the Resend statements the Workers issue", async () => {
  await postgres.pool.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN CREATE ROLE control_runtime NOLOGIN; END IF; END $$",
  );
  await postgres.migrate("down", await migrationsThrough("147_resend_runtime_grants"));
  await postgres.migrate("up");
  const privileges = await postgres.pool.query<{ table_name: string; allowed: string }>(
    `SELECT t AS table_name, string_agg(p, ',' ORDER BY p) AS allowed
     FROM unnest(ARRAY['resend_mail_domains','mail_received_messages','resend_mail_commands','resend_event_receipts']) t,
       unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
     WHERE has_table_privilege('control_runtime', t, p)
     GROUP BY t ORDER BY t`,
  );
  expect(privileges.rows).toEqual([
    { table_name: "mail_received_messages", allowed: "INSERT,SELECT,UPDATE" },
    { table_name: "resend_event_receipts", allowed: "INSERT,SELECT" },
    { table_name: "resend_mail_commands", allowed: "INSERT,SELECT,UPDATE" },
    { table_name: "resend_mail_domains", allowed: "INSERT,SELECT,UPDATE" },
  ]);
  await postgres.migrate("down", await migrationsThrough("147_resend_runtime_grants"));
  expect(
    (
      await postgres.pool.query(
        "SELECT has_table_privilege('control_runtime','resend_mail_domains','SELECT') AS granted",
      )
    ).rows,
  ).toEqual([{ granted: false }]);
  await postgres.migrate("up");
});
