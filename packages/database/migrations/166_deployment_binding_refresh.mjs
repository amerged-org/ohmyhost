// Private metadata cutover reuses verified artifact custody, never a build or a public command.
export function up(pgm) {
  pgm.sql(`CREATE FUNCTION valid_binding_refresh_snapshot(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE keys text[]:=ARRAY['sourceDeploymentId','sourceRevisionId','sourceCandidateReceiptId',
      'sourceArtifactId','sourcePlanId','sourceBuildExecutionId','sourceArtifactSha256',
      'sourceNamespace','sourceScriptName','sourceProviderTag','expectedHeadVersion',
      'expectedGatewayRevision','dataEnvironmentId','assignmentVersion','registrationVersion'];
      key text; counter numeric;
    BEGIN
      IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT(value ?& keys)
        OR value-keys<>'{}'::jsonb THEN RETURN false; END IF;
      FOREACH key IN ARRAY ARRAY['sourceDeploymentId','sourceRevisionId','sourceCandidateReceiptId',
        'sourceArtifactId','sourcePlanId','sourceBuildExecutionId','dataEnvironmentId'] LOOP
        IF jsonb_typeof(value->key) IS DISTINCT FROM 'string'
          OR value->>key !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN RETURN false; END IF;
      END LOOP;
      FOREACH key IN ARRAY ARRAY['sourceArtifactSha256','sourceNamespace','sourceScriptName','sourceProviderTag'] LOOP
        IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      END LOOP;
      IF value->>'sourceArtifactSha256' !~ '^[a-f0-9]{64}$'
        OR value->>'sourceNamespace' !~ '^[a-z0-9-]{1,64}$'
        OR value->>'sourceScriptName' !~ '^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'
        OR value->>'sourceProviderTag' !~ '^[a-f0-9]{32}$' THEN RETURN false; END IF;
      FOREACH key IN ARRAY ARRAY['expectedHeadVersion','expectedGatewayRevision','assignmentVersion','registrationVersion'] LOOP
        IF jsonb_typeof(value->key) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        counter:=(value->>key)::numeric;
        IF counter<>trunc(counter) OR counter < (CASE WHEN key='registrationVersion' THEN 0 ELSE 1 END)
          OR counter>9007199254740991 THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    END $$;
    ALTER TABLE product_command_intents ADD COLUMN binding_refresh_snapshot jsonb;
    ALTER TABLE product_command_intents ADD CONSTRAINT product_binding_refresh_snapshot_check CHECK ((
      binding_refresh_snapshot IS NULL OR (event_type='DeploymentRequestedV1'
        AND valid_binding_refresh_snapshot(binding_refresh_snapshot)
        AND binding_refresh_snapshot->>'sourcePlanId'=plan_id::text
        AND binding_refresh_snapshot->>'sourceDeploymentId'<>deployment_id::text)
    ) IS TRUE);
    CREATE UNIQUE INDEX product_binding_refresh_snapshot_key ON product_command_intents
      (organization_id,project_id,environment_id,binding_refresh_snapshot)
      WHERE binding_refresh_snapshot IS NOT NULL;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM product_command_intents WHERE binding_refresh_snapshot IS NOT NULL) THEN
      RAISE EXCEPTION 'Recorded binding refresh custody prevents lossless downgrade' USING ERRCODE='23514';
    END IF;
  END $$;
  DROP INDEX product_binding_refresh_snapshot_key;
  ALTER TABLE product_command_intents DROP CONSTRAINT product_binding_refresh_snapshot_check;
  ALTER TABLE product_command_intents DROP COLUMN binding_refresh_snapshot;
  DROP FUNCTION valid_binding_refresh_snapshot(jsonb);`);
}
