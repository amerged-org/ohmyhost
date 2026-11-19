// Standalone PGCF formats 19/20. Released ledger rows and unpublished W24 formats 16/17/18 stay untouched.
const trusted = (sql) =>
  `DO $install$ BEGIN EXECUTE replace($definition$${sql}$definition$, '@S@', quote_ident(current_schema())); END $install$;`;
const fields = [
  "valuationId",
  "organizationId",
  "projectId",
  "environmentId",
  "billingEpochId",
  "sourceKind",
  "sourceReference",
  "observationReference",
  "meter",
  "unit",
  "rateCardId",
  "outcome",
  "quantity",
  "chargeMicros",
  "fundedMicros",
  "providerCostMicros",
  "targetQuantity",
  "targetChargeMicros",
  "targetProviderCostMicros",
  "eventTimeMicros",
  "observedAtMicros",
  "resolvedAtMicros",
];
const sqlFields = `ARRAY[${fields.map((field) => `'${field}'`).join(",")}]::text[]`;
export function up(pgm) {
  pgm.sql(
    trusted(`
    CREATE FUNCTION @S@.pgcf_value_encode(p_format integer,p_proof jsonb) RETURNS bytea
    LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
    DECLARE fields text[]:=${sqlFields}; parts text[]; key text; item jsonb; value text;
      amount bigint; i integer; expected integer; output bytea; digest text;
    BEGIN
      IF p_format IS NULL OR p_format NOT IN (19,20) THEN RAISE EXCEPTION 'unsupported_pgcf_format' USING ERRCODE='BV402'; END IF;
      expected:=cardinality(fields)+CASE WHEN p_format=20 THEN 1 ELSE 0 END;
      IF p_proof IS NULL OR jsonb_typeof(p_proof)<>'object' OR NOT p_proof ?& fields THEN
        RAISE EXCEPTION 'invalid_pgcf_proof' USING ERRCODE='BV401'; END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(p_proof))<>expected OR
        (p_format=20 AND NOT p_proof ? 'terminalDigest') THEN
        RAISE EXCEPTION 'invalid_pgcf_fields' USING ERRCODE='BV401'; END IF;
      parts:=ARRAY['omh.pgcf-financial','2',CASE WHEN p_format=19 THEN 'terminal' ELSE 'observation' END];
      FOR i IN 1..cardinality(fields) LOOP
        key:=fields[i]; item:=p_proof->key; value:=p_proof->>key;
        IF item='null'::jsonb AND key=ANY(ARRAY['environmentId','providerCostMicros','targetProviderCostMicros']) THEN
          parts:=array_append(parts,NULL); CONTINUE;
        END IF;
        IF jsonb_typeof(item)<>'string' THEN RAISE EXCEPTION 'invalid_pgcf_field_type' USING ERRCODE='BV401'; END IF;
        IF i>=13 THEN
          IF value!~'^(0|-?[1-9][0-9]*)$' THEN RAISE EXCEPTION 'invalid_pgcf_integer' USING ERRCODE='BV401'; END IF;
          amount:=value::bigint;
        ELSIF i<=5 THEN
          IF value!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN RAISE EXCEPTION 'invalid_pgcf_identity' USING ERRCODE='BV401'; END IF;
        ELSIF value!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$' THEN
          RAISE EXCEPTION 'invalid_pgcf_identity' USING ERRCODE='BV401';
        END IF;
        parts:=array_append(parts,value);
      END LOOP;
      IF p_proof->>'sourceKind'<>'pgcf' OR p_proof->>'meter'<>'pgcf.memory.active'
        OR p_proof->>'unit'<>'memory_mib_milliseconds' OR p_proof->>'rateCardId'<>'pgcf-memory-2026-10-26-v1'
        OR p_proof->>'outcome' NOT IN ('settled','corrected') THEN
        RAISE EXCEPTION 'invalid_pgcf_scope' USING ERRCODE='BV401'; END IF;
      IF ((p_proof->'providerCostMicros')='null'::jsonb) IS DISTINCT FROM ((p_proof->'targetProviderCostMicros')='null'::jsonb)
        OR (p_proof->>'targetQuantity')::bigint<0 OR (p_proof->>'targetChargeMicros')::bigint<0
        OR (p_proof->>'targetProviderCostMicros')::bigint<0 OR (p_proof->>'eventTimeMicros')::bigint<0
        OR (p_proof->>'observedAtMicros')::bigint<(p_proof->>'eventTimeMicros')::bigint
        OR (p_proof->>'resolvedAtMicros')::bigint<(p_proof->>'observedAtMicros')::bigint THEN
        RAISE EXCEPTION 'invalid_pgcf_basis_or_chronology' USING ERRCODE='BV401'; END IF;
      IF p_proof->>'outcome'='settled' THEN
        IF (p_proof->>'quantity')::bigint<0 OR (p_proof->>'chargeMicros')::bigint<0
          OR (p_proof->>'fundedMicros')::bigint<0 OR (p_proof->>'fundedMicros')::bigint>(p_proof->>'chargeMicros')::bigint
          OR (p_proof->>'providerCostMicros')::bigint<0 THEN
          RAISE EXCEPTION 'invalid_pgcf_settlement' USING ERRCODE='BV401'; END IF;
      ELSE
        IF (p_proof->>'quantity')::bigint>0 OR (p_proof->>'chargeMicros')::bigint>0
          OR (p_proof->>'fundedMicros')::bigint>0 OR (p_proof->>'fundedMicros')::bigint<(p_proof->>'chargeMicros')::bigint
          OR (p_proof->>'providerCostMicros')::bigint>0 THEN
          RAISE EXCEPTION 'invalid_pgcf_correction' USING ERRCODE='BV401'; END IF;
      END IF;
      IF p_format=20 THEN
        digest:=encode(sha256(convert_to('omh.pgcf-financial.v2','UTF8')||decode('00','hex')
          ||@S@.pgcf_value_encode(19,p_proof-'terminalDigest')),'hex');
        IF jsonb_typeof(p_proof->'terminalDigest')<>'string' OR p_proof->>'terminalDigest' IS DISTINCT FROM digest THEN
          RAISE EXCEPTION 'invalid_pgcf_terminal_digest' USING ERRCODE='BV401'; END IF;
        parts:=array_append(parts,digest);
      END IF;
      output:=convert_to(array_to_json(parts)::text,'UTF8');
      IF octet_length(output)>16384 THEN RAISE EXCEPTION 'pgcf_proof_too_large' USING ERRCODE='BV401'; END IF;
      RETURN output;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_pgcf_integer' USING ERRCODE='BV401';
    END $$;

    CREATE FUNCTION @S@.pgcf_value_decode(p_format integer,p_value bytea) RETURNS jsonb
    LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
    DECLARE fields text[]:=${sqlFields}; parts jsonb; proof jsonb:='{}'::jsonb; i integer;
    BEGIN
      IF p_format IS NULL OR p_format NOT IN (19,20) THEN RAISE EXCEPTION 'unsupported_pgcf_format' USING ERRCODE='BV402'; END IF;
      IF p_value IS NULL OR octet_length(p_value)>16384 THEN RAISE EXCEPTION 'invalid_pgcf_value' USING ERRCODE='BV401'; END IF;
      parts:=convert_from(p_value,'UTF8')::jsonb;
      IF jsonb_typeof(parts)<>'array' THEN RAISE EXCEPTION 'invalid_pgcf_envelope' USING ERRCODE='BV401'; END IF;
      IF jsonb_array_length(parts)<>3+cardinality(fields)+(CASE WHEN p_format=20 THEN 1 ELSE 0 END)
        OR parts->>0 IS DISTINCT FROM 'omh.pgcf-financial' OR parts->>1 IS DISTINCT FROM '2'
        OR parts->>2 IS DISTINCT FROM (CASE WHEN p_format=19 THEN 'terminal' ELSE 'observation' END) THEN
        RAISE EXCEPTION 'invalid_pgcf_envelope' USING ERRCODE='BV401'; END IF;
      FOR i IN 1..cardinality(fields) LOOP proof:=proof||jsonb_build_object(fields[i],parts->(i+2)); END LOOP;
      IF p_format=20 THEN proof:=proof||jsonb_build_object('terminalDigest',parts->(3+cardinality(fields))); END IF;
      IF @S@.pgcf_value_encode(p_format,proof)<>p_value THEN RAISE EXCEPTION 'noncanonical_pgcf_value' USING ERRCODE='BV401'; END IF;
      RETURN proof;
    EXCEPTION WHEN invalid_text_representation OR character_not_in_repertoire OR untranslatable_character THEN
      RAISE EXCEPTION 'invalid_pgcf_encoding' USING ERRCODE='BV401';
    END $$;

    CREATE FUNCTION @S@.pgcf_value_check_binding(p_key bytea,p_format integer,p_value bytea) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    DECLARE proof jsonb; expected bytea; parts text[];
    BEGIN
      proof:=@S@.pgcf_value_decode(p_format,p_value);
      parts:=ARRAY['omh.pgcf-financial-key','2',CASE WHEN p_format=19 THEN 'terminal' ELSE 'observation' END,
        proof->>'organizationId',proof->>'projectId'];
      IF p_format=19 THEN parts:=array_append(parts,proof->>'valuationId');
      ELSE parts:=parts||ARRAY[proof->>'billingEpochId',proof->>'sourceKind',proof->>'sourceReference',proof->>'observationReference']; END IF;
      expected:=convert_to(array_to_json(parts)::text,'UTF8');
      IF p_key IS DISTINCT FROM expected THEN RAISE EXCEPTION 'pgcf_tenant_or_source_key_mismatch' USING ERRCODE='BV409'; END IF;
      RETURN jsonb_build_object('organizationId',proof->>'organizationId','projectId',proof->>'projectId',
        'billingEpochId',proof->>'billingEpochId','valuationId',proof->>'valuationId',
        'sourceReference',proof->>'sourceReference','observationReference',proof->>'observationReference',
        'digest',encode(sha256(convert_to('omh.pgcf-financial.v2','UTF8')||decode('00','hex')||p_value),'hex'));
    END $$;
  `),
  );
  pgm.sql(`
    REVOKE ALL ON FUNCTION pgcf_value_encode(integer,jsonb),pgcf_value_decode(integer,bytea),pgcf_value_check_binding(bytea,integer,bytea) FROM PUBLIC;
    DO $$ DECLARE runtime_role text; BEGIN
      FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('control_runtime','metering_runtime') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION pgcf_value_encode(integer,jsonb),pgcf_value_decode(integer,bytea),pgcf_value_check_binding(bytea,integer,bytea) FROM %I',runtime_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION pgcf_value_check_binding(bytea,integer,bytea) TO %I',runtime_role);
      END LOOP;
    END $$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM usage_credit_valuations WHERE target_provider_cost_micros IS NULL) THEN
    RAISE EXCEPTION 'PGCF optional-cost history requires v2 readers'; END IF; END $$;
    DROP FUNCTION pgcf_value_check_binding(bytea,integer,bytea);
    DROP FUNCTION pgcf_value_decode(integer,bytea); DROP FUNCTION pgcf_value_encode(integer,jsonb);`);
}
