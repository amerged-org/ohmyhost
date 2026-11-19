export function up(pgm) {
  pgm.sql(`CREATE TABLE customer_feedback (
    feedback_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
    project_id ulid REFERENCES projects(project_id) ON DELETE RESTRICT,
    environment_id ulid,
    operation_id ulid REFERENCES operations(operation_id) ON DELETE RESTRICT,
    report jsonb NOT NULL CHECK (jsonb_typeof(report)='object' AND octet_length(report::text)<=65600),
    submitted_at timestamptz NOT NULL,
    UNIQUE (organization_id, actor_id, idempotency_key),
    CHECK ((environment_id IS NULL AND operation_id IS NULL) OR project_id IS NOT NULL)
  )`);
  pgm.createTrigger("customer_feedback", "customer_feedback_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM customer_feedback) THEN
      RAISE EXCEPTION 'Export retained customer feedback before removing this delivery';
    END IF;
  END $$`);
  pgm.dropTable("customer_feedback");
}
