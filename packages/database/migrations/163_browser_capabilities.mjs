// Declared browser origins belong to the immutable artifact and every route revision.
export function up(pgm) {
  pgm.sql(`CREATE FUNCTION valid_browser_policy(policy jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE category text; origins jsonb; item jsonb; origin text; previous text; hostname text; port text;
    BEGIN
      IF policy IS NULL OR jsonb_typeof(policy)<>'object'
        OR NOT(policy ?& ARRAY['connect','scripts','styles','images','fonts','frames','frameAncestors','workers','cors'])
        OR policy-ARRAY['connect','scripts','styles','images','fonts','frames','frameAncestors','workers','cors']<>'{}'
        OR jsonb_typeof(policy->'workers')<>'object'
        OR NOT(policy->'workers' ?& ARRAY['self','blob'])
        OR (policy->'workers')-ARRAY['self','blob']<>'{}'
        OR jsonb_typeof(policy->'workers'->'self')<>'boolean'
        OR jsonb_typeof(policy->'workers'->'blob')<>'boolean'
        OR jsonb_typeof(policy->'cors')<>'object'
        OR NOT(policy->'cors' ?& ARRAY['origins','credentials'])
        OR (policy->'cors')-ARRAY['origins','credentials']<>'{}'
        OR jsonb_typeof(policy->'cors'->'credentials')<>'boolean' THEN RETURN false; END IF;
      FOREACH category IN ARRAY ARRAY['connect','scripts','styles','images','fonts','frames','frameAncestors','cors'] LOOP
        origins := CASE WHEN category='cors' THEN policy->'cors'->'origins' ELSE policy->category END;
        IF origins IS NULL OR jsonb_typeof(origins)<>'array' OR jsonb_array_length(origins)>16 THEN RETURN false; END IF;
        previous := NULL;
        FOR item IN SELECT jsonb_array_elements(origins) LOOP
          IF jsonb_typeof(item)<>'string' THEN RETURN false; END IF;
          origin := item #>> '{}';
          IF length(origin)>256 OR origin!~'^(https|wss)://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$'
            OR (category<>'connect' AND origin!~'^https://') OR origin~':443$'
            OR (previous IS NOT NULL AND previous>=origin) THEN RETURN false; END IF;
          hostname := split_part(regexp_replace(origin,'^(https|wss)://',''),':',1);
          IF position('.' in hostname)=0 OR hostname~'\\.(local|internal)$'
            OR hostname~'^[0-9]+(\\.[0-9]+){3}$'
            OR EXISTS(SELECT 1 FROM unnest(string_to_array(hostname,'.')) label
              WHERE label!~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') THEN RETURN false; END IF;
          port := split_part(regexp_replace(origin,'^(https|wss)://',''),':',2);
          IF port<>'' AND port::integer>65535 THEN RETURN false; END IF;
          previous := origin;
        END LOOP;
      END LOOP;
      RETURN true;
    EXCEPTION WHEN OTHERS THEN RETURN false;
    END $$;
    ALTER TABLE shared_gateway_route_revisions ADD COLUMN browser_policy jsonb;
    ALTER TABLE shared_gateway_route_revisions ADD CONSTRAINT shared_gateway_browser_policy_check
      CHECK(browser_policy IS NULL OR valid_browser_policy(browser_policy));`);
  pgm.sql(`DO $$ DECLARE previous_definition text; updated_definition text; BEGIN
    SELECT pg_get_functiondef('valid_runtime_policy(jsonb)'::regprocedure) INTO previous_definition;
    updated_definition := replace(previous_definition,
      'policy-ARRAY[''healthCheckPath'',''egressAllowedOrigins'']',
      'policy-ARRAY[''healthCheckPath'',''egressAllowedOrigins'',''browser'']');
    updated_definition := replace(updated_definition,
      'FOR origin IN SELECT jsonb_array_elements_text(policy->''egressAllowedOrigins'') LOOP',
      'IF policy IS NULL OR (policy ? ''browser'' AND NOT valid_browser_policy(policy->''browser'')) THEN RETURN false; END IF;
       FOR origin IN SELECT jsonb_array_elements_text(policy->''egressAllowedOrigins'') LOOP');
    IF updated_definition=previous_definition THEN RAISE EXCEPTION 'Runtime policy definition could not be extended'; END IF;
    EXECUTE updated_definition;
    EXECUTE format('COMMENT ON FUNCTION valid_runtime_policy(jsonb) IS %L','pre-browser:'||previous_definition);
  END $$`);
}

export function down(pgm) {
  pgm.sql(`DO $$ DECLARE previous_definition text; BEGIN
    IF EXISTS(SELECT 1 FROM deployment_plans WHERE framework_plan->'runtimePolicy' ? 'browser')
      OR EXISTS(SELECT 1 FROM shared_gateway_route_revisions WHERE browser_policy IS NOT NULL) THEN
      RAISE EXCEPTION 'Declared browser policy history prevents a lossless downgrade';
    END IF;
    SELECT obj_description('valid_runtime_policy(jsonb)'::regprocedure,'pg_proc') INTO previous_definition;
    IF previous_definition NOT LIKE 'pre-browser:%' THEN RAISE EXCEPTION 'Previous runtime policy definition is unavailable'; END IF;
    EXECUTE substring(previous_definition from length('pre-browser:')+1);
  END $$;
    ALTER TABLE shared_gateway_route_revisions DROP COLUMN browser_policy;
    DROP FUNCTION valid_browser_policy(jsonb);`);
}
