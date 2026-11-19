export function up(pgm) {
  pgm.sql(`
    ALTER TABLE organization_credit_grants ADD CONSTRAINT organization_credit_grants_scope_key
      UNIQUE (organization_id,grant_id);
    CREATE TABLE organization_credit_reservations (
      reservation_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      billing_epoch_id ulid NOT NULL,
      kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
      source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 256),
      amount_micros bigint NOT NULL CHECK (amount_micros>=0),
      reserved_at timestamptz NOT NULL,
      UNIQUE (kind,source_reference),
      UNIQUE (organization_id,reservation_id),
      FOREIGN KEY (organization_id,project_id,environment_id)
        REFERENCES environments(organization_id,project_id,environment_id),
      FOREIGN KEY (billing_epoch_id,project_id,organization_id)
        REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id)
    );
    CREATE INDEX organization_credit_reservations_project_idx
      ON organization_credit_reservations(organization_id,project_id);
    CREATE TABLE organization_credit_resolutions (
      reservation_id ulid PRIMARY KEY REFERENCES organization_credit_reservations(reservation_id),
      outcome text NOT NULL CHECK (outcome IN ('settled','released')),
      charge_micros bigint NOT NULL CHECK (charge_micros>=0),
      funded_micros bigint NOT NULL CHECK (funded_micros BETWEEN 0 AND charge_micros),
      provider_cost_micros bigint NOT NULL CHECK (provider_cost_micros>=0),
      rate_card_id text,
      meter text,
      unit text,
      quantity bigint CHECK (quantity>=0),
      event_time timestamptz,
      resolved_at timestamptz NOT NULL,
      CHECK ((outcome='released' AND charge_micros=0 AND funded_micros=0 AND provider_cost_micros=0
        AND rate_card_id IS NULL AND meter IS NULL AND unit IS NULL AND quantity IS NULL AND event_time IS NULL)
        OR (outcome='settled' AND rate_card_id IS NOT NULL AND meter IS NOT NULL AND unit IS NOT NULL
          AND length(rate_card_id) BETWEEN 1 AND 128
          AND length(meter) BETWEEN 1 AND 128 AND length(unit) BETWEEN 1 AND 64
          AND quantity IS NOT NULL AND event_time IS NOT NULL))
    );
    CREATE TABLE organization_credit_movements (
      organization_id ulid NOT NULL,
      reservation_id ulid NOT NULL,
      grant_id ulid NOT NULL,
      phase text NOT NULL CHECK (phase IN ('reserve','resolve')),
      reserved_micros bigint NOT NULL,
      spent_micros bigint NOT NULL CHECK (spent_micros>=0),
      PRIMARY KEY (reservation_id,grant_id,phase),
      FOREIGN KEY (organization_id,reservation_id)
        REFERENCES organization_credit_reservations(organization_id,reservation_id),
      FOREIGN KEY (organization_id,grant_id)
        REFERENCES organization_credit_grants(organization_id,grant_id),
      CHECK ((phase='reserve' AND reserved_micros>0 AND spent_micros=0)
        OR (phase='resolve' AND reserved_micros<=0 AND (reserved_micros<0 OR spent_micros>0)))
    );
    CREATE INDEX organization_credit_movements_grant_idx
      ON organization_credit_movements(organization_id,grant_id);
    CREATE TABLE project_credit_budgets (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      amount_micros bigint CHECK (amount_micros>=0),
      mode text NOT NULL CHECK (mode IN ('continue','stop')),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (organization_id,project_id),
      FOREIGN KEY (organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id),
      CHECK (amount_micros IS NOT NULL OR mode='continue')
    );
    CREATE TRIGGER organization_credit_reservations_append_only BEFORE UPDATE OR DELETE
      ON organization_credit_reservations FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TRIGGER organization_credit_resolutions_append_only BEFORE UPDATE OR DELETE
      ON organization_credit_resolutions FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TRIGGER organization_credit_movements_append_only BEFORE UPDATE OR DELETE
      ON organization_credit_movements FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM organization_credit_reservations)
      OR EXISTS (SELECT 1 FROM project_credit_budgets) THEN
      RAISE EXCEPTION 'Organization credit accounting must be retained before downgrade';
    END IF;
  END $$;`);
  pgm.dropTable("project_credit_budgets");
  pgm.dropTable("organization_credit_movements");
  pgm.dropTable("organization_credit_resolutions");
  pgm.dropTable("organization_credit_reservations");
  pgm.dropConstraint("organization_credit_grants", "organization_credit_grants_scope_key");
}
