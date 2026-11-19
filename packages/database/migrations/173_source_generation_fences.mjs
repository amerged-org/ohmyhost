export function up(pgm) {
  pgm.sql(`
    INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at)
      SELECT DISTINCT ON(grant_record.organization_id,grant_record.project_id) grant_record.organization_id,grant_record.project_id,grant_record.source_connection_id,'github',1,NULL,grant_record.granted_at
      FROM repository_grants grant_record WHERE grant_record.provider='github'
      ORDER BY grant_record.organization_id,grant_record.project_id,grant_record.granted_at DESC,grant_record.grant_id DESC
      ON CONFLICT(organization_id,project_id) DO NOTHING;
    CREATE FUNCTION bind_verified_github_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE connection_id ulid;
      BEGIN
        IF NEW.provider<>'github' THEN RETURN NEW; END IF;
        IF TG_TABLE_NAME='project_sources' THEN
          IF NEW.state<>'ready' THEN RETURN NEW; END IF;
          SELECT source_connection_id INTO connection_id FROM repository_grants WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND grant_id=NEW.grant_id;
        ELSE connection_id:=NEW.source_connection_id; END IF;
        INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at)
          VALUES(NEW.organization_id,NEW.project_id,connection_id,'github',1,NULL,clock_timestamp())
          ON CONFLICT(organization_id,project_id) DO UPDATE SET
            source_connection_id=EXCLUDED.source_connection_id,
            generation=CASE WHEN project_source_bindings.source_connection_id=EXCLUDED.source_connection_id THEN project_source_bindings.generation ELSE project_source_bindings.generation+1 END,
            updated_at=EXCLUDED.updated_at
          WHERE project_source_bindings.provider='github' AND (TG_TABLE_NAME='project_sources' OR project_source_bindings.source_connection_id=EXCLUDED.source_connection_id);
        RETURN NEW;
      END $$;
    CREATE TRIGGER github_grant_bind_source AFTER INSERT ON repository_grants FOR EACH ROW EXECUTE FUNCTION bind_verified_github_source();
    CREATE TRIGGER github_ready_bind_source AFTER INSERT OR UPDATE OF state ON project_sources FOR EACH ROW EXECUTE FUNCTION bind_verified_github_source();

    ALTER TABLE deployment_plans ADD COLUMN source_generation integer NOT NULL DEFAULT 1 CHECK(source_generation>0);
    ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_append_only;
    UPDATE deployment_plans plan SET source_generation=binding.generation FROM project_source_bindings binding
      WHERE binding.organization_id=plan.organization_id AND binding.project_id=plan.project_id AND binding.source_connection_id=plan.source_connection_id;
    ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_append_only;
    ALTER TABLE product_command_intents ADD COLUMN source_generation integer CHECK(source_generation>0);
    ALTER TABLE product_command_intents DISABLE TRIGGER product_command_intents_append_only;
    UPDATE product_command_intents intent SET source_generation=plan.source_generation FROM deployment_plans plan
      WHERE intent.plan_id=plan.plan_id AND intent.event_type='DeploymentRequestedV1';
    ALTER TABLE product_command_intents ENABLE TRIGGER product_command_intents_append_only;
    CREATE FUNCTION pin_deployment_source_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='DeploymentRequestedV1' THEN
        SELECT plan.source_generation INTO NEW.source_generation FROM deployment_plans plan
          JOIN project_source_bindings binding ON binding.organization_id=plan.organization_id AND binding.project_id=plan.project_id
            AND binding.source_connection_id=plan.source_connection_id AND binding.generation=plan.source_generation
          WHERE plan.plan_id=NEW.plan_id AND plan.organization_id=NEW.organization_id AND plan.project_id=NEW.project_id AND plan.source_connection_id=NEW.source_connection_id;
        IF NEW.source_generation IS NULL THEN RAISE EXCEPTION 'Deployment source generation changed' USING ERRCODE='23514'; END IF;
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER deployment_intent_source_generation BEFORE INSERT ON product_command_intents FOR EACH ROW EXECUTE FUNCTION pin_deployment_source_generation();
    CREATE TABLE operation_mcp_delegations (
      operation_id ulid PRIMARY KEY REFERENCES operations(operation_id), organization_id ulid NOT NULL, project_id ulid NOT NULL,
      environment_id ulid NOT NULL, billing_epoch_id ulid NOT NULL, principal_id text NOT NULL,
      grant_id uuid NOT NULL REFERENCES mcp_client_grants(grant_id),client_id text NOT NULL,
      consent_hash text NOT NULL CHECK(consent_hash~'^[0-9a-f]{64}$'),requires_publication boolean NOT NULL,
      event_type text NOT NULL, created_at timestamptz NOT NULL,
      FOREIGN KEY(organization_id,project_id,operation_id,billing_epoch_id) REFERENCES operations(organization_id,project_id,operation_id,billing_epoch_id),
      FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id)
    );
    CREATE TRIGGER operation_mcp_delegations_immutable BEFORE UPDATE OR DELETE ON operation_mcp_delegations FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM operation_mcp_delegations) OR EXISTS(SELECT 1 FROM deployment_plans WHERE source_generation<>1) THEN RAISE EXCEPTION 'Source/delegation history prevents a lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TABLE operation_mcp_delegations;
    DROP TRIGGER deployment_intent_source_generation ON product_command_intents;
    DROP FUNCTION pin_deployment_source_generation();
    ALTER TABLE product_command_intents DROP COLUMN source_generation;
    ALTER TABLE deployment_plans DROP COLUMN source_generation;
    DROP TRIGGER github_ready_bind_source ON project_sources;
    DROP TRIGGER github_grant_bind_source ON repository_grants;
    DROP FUNCTION bind_verified_github_source();
  `);
}
