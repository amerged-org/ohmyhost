export function up(pgm) {
  pgm.sql(`ALTER TABLE action_confirmations ADD COLUMN source_generation integer CHECK(source_generation>=0);
    UPDATE action_confirmations confirmation SET source_generation=COALESCE((SELECT generation FROM project_source_bindings binding WHERE binding.organization_id=confirmation.organization_id AND binding.project_id=confirmation.project_id),0) WHERE action IN ('promote','rollback');
    ALTER TABLE product_command_intents DROP CONSTRAINT product_command_intents_source_generation_check;
    ALTER TABLE product_command_intents ADD CONSTRAINT product_command_intents_source_generation_check CHECK(source_generation>=0);
    ALTER TABLE product_command_intents DISABLE TRIGGER product_command_intents_append_only;
    UPDATE product_command_intents intent SET source_generation=COALESCE((SELECT generation FROM project_source_bindings binding WHERE binding.organization_id=intent.organization_id AND binding.project_id=intent.project_id),0) WHERE event_type IN ('DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1');
    ALTER TABLE product_command_intents ENABLE TRIGGER product_command_intents_append_only;
    CREATE OR REPLACE FUNCTION pin_deployment_source_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='DeploymentRequestedV1' THEN
        IF NEW.binding_refresh_snapshot IS NOT NULL THEN
          NEW.source_generation:=COALESCE((SELECT generation FROM project_source_bindings WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id),0);
        ELSE
        SELECT plan.source_generation INTO NEW.source_generation FROM deployment_plans plan
          JOIN project_source_bindings binding ON binding.organization_id=plan.organization_id AND binding.project_id=plan.project_id AND binding.source_connection_id=plan.source_connection_id AND binding.generation=plan.source_generation
          WHERE plan.plan_id=NEW.plan_id AND plan.organization_id=NEW.organization_id AND plan.project_id=NEW.project_id AND plan.source_connection_id=NEW.source_connection_id;
        END IF;
        IF NEW.source_generation IS NULL THEN RAISE EXCEPTION 'Deployment source generation changed' USING ERRCODE='23514'; END IF;
      ELSIF NEW.event_type IN ('DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1') THEN
        NEW.source_generation:=COALESCE((SELECT generation FROM project_source_bindings WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id),0);
      ELSIF NEW.event_type='SourceLinkRequestedV1' AND EXISTS(SELECT 1 FROM project_source_bindings WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND provider='managed') THEN
        RAISE EXCEPTION 'Managed source cannot be replaced by a GitHub link' USING ERRCODE='23514';
      END IF; RETURN NEW; END $$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM action_confirmations WHERE source_generation IS NOT NULL) OR EXISTS(SELECT 1 FROM product_command_intents WHERE event_type IN ('DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1') AND source_generation IS NOT NULL) OR EXISTS(SELECT 1 FROM product_command_intents WHERE binding_refresh_snapshot IS NOT NULL AND source_generation=0) THEN RAISE EXCEPTION 'Guarded source-generation history prevents a lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    ALTER TABLE action_confirmations DROP COLUMN source_generation;
    ALTER TABLE product_command_intents DROP CONSTRAINT product_command_intents_source_generation_check;
    ALTER TABLE product_command_intents ADD CONSTRAINT product_command_intents_source_generation_check CHECK(source_generation>0);
    CREATE OR REPLACE FUNCTION pin_deployment_source_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='DeploymentRequestedV1' THEN SELECT plan.source_generation INTO NEW.source_generation FROM deployment_plans plan JOIN project_source_bindings binding ON binding.organization_id=plan.organization_id AND binding.project_id=plan.project_id AND binding.source_connection_id=plan.source_connection_id AND binding.generation=plan.source_generation WHERE plan.plan_id=NEW.plan_id AND plan.organization_id=NEW.organization_id AND plan.project_id=NEW.project_id AND plan.source_connection_id=NEW.source_connection_id;
      IF NEW.source_generation IS NULL THEN RAISE EXCEPTION 'Deployment source generation changed' USING ERRCODE='23514'; END IF; END IF; RETURN NEW; END $$;
  `);
}
