// A deleted Paid domain kept its hostname under the table-wide UNIQUE, so no other project could
// ever connect it again (audit B19, 2026-09-27; not observed in a real run). Only a live
// connection holds its hostname now. A connection whose apply never stored its provider receipts
// can be deleted too, so its deleting and deleted rows carry no receipts.

const SHAPE_071 = `(state='pending' AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
      AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL
      AND deleted_at IS NULL)
    OR (state='active' AND jsonb_typeof(custom_hostname_receipt)='object'
      AND jsonb_typeof(worker_route_receipt)='object' AND deleted_at IS NULL)
    OR (state='deleting' AND jsonb_typeof(custom_hostname_receipt)='object'
      AND jsonb_typeof(worker_route_receipt)='object'
      AND octet_length(delete_idempotency_sha256)=32
      AND octet_length(delete_request_sha256)=32 AND deleted_at IS NULL)
    OR (state='deleted' AND jsonb_typeof(custom_hostname_receipt)='object'
      AND jsonb_typeof(worker_route_receipt)='object'
      AND octet_length(delete_idempotency_sha256)=32
      AND octet_length(delete_request_sha256)=32 AND deleted_at IS NOT NULL)`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_hostname_key;
    CREATE UNIQUE INDEX paid_project_domains_live_hostname ON paid_project_domains(hostname)
      WHERE state<>'deleted';
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_check1;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_state_shape CHECK (
      (state='pending' AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
        AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL
        AND deleted_at IS NULL)
      OR (state='active' AND jsonb_typeof(custom_hostname_receipt)='object'
        AND jsonb_typeof(worker_route_receipt)='object' AND deleted_at IS NULL)
      OR (state IN ('deleting','deleted')
        AND ((jsonb_typeof(custom_hostname_receipt)='object'
            AND jsonb_typeof(worker_route_receipt)='object')
          OR (custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL))
        AND octet_length(delete_idempotency_sha256)=32
        AND octet_length(delete_request_sha256)=32
        AND (deleted_at IS NULL)=(state='deleting')))`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM paid_project_domains WHERE custom_hostname_receipt IS NULL
          AND state IN ('deleting','deleted'))
        OR EXISTS (SELECT 1 FROM paid_project_domains GROUP BY hostname HAVING count(*)>1) THEN
        RAISE EXCEPTION 'Reused or receipt-less Paid domain hostnames prevent a lossless downgrade';
      END IF;
    END $$;
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_state_shape;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_check1 CHECK (${SHAPE_071});
    DROP INDEX paid_project_domains_live_hostname;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_hostname_key UNIQUE (hostname);`);
}
