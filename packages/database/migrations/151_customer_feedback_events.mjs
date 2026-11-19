/**
 * User request 2026-09-24 (D345): agents read the status of their feedback receipt and our reply.
 * The original report stays untouched; operators append status changes, customer-visible replies
 * and internal notes. The Control runtime may only read these events; operator scripts write them.
 */
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE customer_feedback_events (
    event_id ulid PRIMARY KEY,
    feedback_id ulid NOT NULL REFERENCES customer_feedback(feedback_id) ON DELETE RESTRICT,
    visibility text NOT NULL CHECK (visibility IN ('customer','internal')),
    status text CHECK (status IN ('in_review','planned','in_progress','resolved','closed')),
    release text CHECK (release ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$'),
    body text CHECK (char_length(body) BETWEEN 1 AND 2000),
    actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
    recorded_at timestamptz NOT NULL,
    CHECK (status IS NULL OR visibility='customer'),
    CHECK (status IS NOT NULL OR body IS NOT NULL),
    CHECK ((status IS NOT DISTINCT FROM 'resolved') = (release IS NOT NULL)),
    CHECK (status IS NULL OR status NOT IN ('resolved','closed') OR body IS NOT NULL)
  )`);
  pgm.sql(
    "CREATE INDEX customer_feedback_events_history ON customer_feedback_events(feedback_id,recorded_at,event_id)",
  );
  pgm.createTrigger("customer_feedback_events", "customer_feedback_events_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      REVOKE ALL ON customer_feedback_events FROM control_runtime;
      GRANT SELECT ON customer_feedback_events TO control_runtime;
    END IF;
  END $$`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM customer_feedback_events) THEN
      RAISE EXCEPTION 'Export retained feedback status history before removing this delivery';
    END IF;
  END $$`);
  pgm.dropTable("customer_feedback_events");
}
