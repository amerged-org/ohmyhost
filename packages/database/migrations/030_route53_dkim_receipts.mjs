const evidenceShape = `accepted_lifecycle_version>=1
  AND domain~'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
  AND caller_reference='ohmyho-'||project_id::text
  AND hosted_zone_id~'^Z[A-Z0-9]{8,31}$'
  AND cardinality(name_servers)=4
  AND array_position(name_servers,NULL) IS NULL
  AND name_servers[1]~'^ns-[0-9]{1,4}\\.awsdns-[0-9]{1,2}\\.(com|net|org|co\\.uk)$'
  AND name_servers[2]~'^ns-[0-9]{1,4}\\.awsdns-[0-9]{1,2}\\.(com|net|org|co\\.uk)$'
  AND name_servers[3]~'^ns-[0-9]{1,4}\\.awsdns-[0-9]{1,2}\\.(com|net|org|co\\.uk)$'
  AND name_servers[4]~'^ns-[0-9]{1,4}\\.awsdns-[0-9]{1,2}\\.(com|net|org|co\\.uk)$'
  AND name_servers[1]<>ALL(name_servers[2:4])
  AND name_servers[2]<>ALL(name_servers[3:4])
  AND name_servers[3]<>name_servers[4]
  AND jsonb_typeof(records)='array' AND jsonb_array_length(records)=3
  AND (records->0)?&ARRAY['type','name','value']
  AND (records->1)?&ARRAY['type','name','value']
  AND (records->2)?&ARRAY['type','name','value']
  AND (records->0)-ARRAY['type','name','value']='{}'::jsonb
  AND (records->1)-ARRAY['type','name','value']='{}'::jsonb
  AND (records->2)-ARRAY['type','name','value']='{}'::jsonb
  AND jsonb_typeof(records->0->'type')='string'
  AND jsonb_typeof(records->0->'name')='string'
  AND jsonb_typeof(records->0->'value')='string'
  AND jsonb_typeof(records->1->'type')='string'
  AND jsonb_typeof(records->1->'name')='string'
  AND jsonb_typeof(records->1->'value')='string'
  AND jsonb_typeof(records->2->'type')='string'
  AND jsonb_typeof(records->2->'name')='string'
  AND jsonb_typeof(records->2->'value')='string'
  AND records->0->>'type'='CNAME' AND records->1->>'type'='CNAME'
  AND records->2->>'type'='CNAME'
  AND records->0->>'name'~'^[a-z0-9]{32,64}\\._domainkey\\.'
  AND records->1->>'name'~'^[a-z0-9]{32,64}\\._domainkey\\.'
  AND records->2->>'name'~'^[a-z0-9]{32,64}\\._domainkey\\.'
  AND records->0->>'name' LIKE '%._domainkey.'||domain
  AND records->1->>'name' LIKE '%._domainkey.'||domain
  AND records->2->>'name' LIKE '%._domainkey.'||domain
  AND records->0->>'value'~'^[a-z0-9]{32,64}\\.dkim\\.amazonses\\.com$'
  AND records->1->>'value'~'^[a-z0-9]{32,64}\\.dkim\\.amazonses\\.com$'
  AND records->2->>'value'~'^[a-z0-9]{32,64}\\.dkim\\.amazonses\\.com$'
  AND records->0->>'name'<>records->1->>'name'
  AND records->0->>'name'<>records->2->>'name'
  AND records->1->>'name'<>records->2->>'name'
  AND change_id~'^C[A-Z0-9]{8,31}$'
  AND observed_at>=submitted_at`;

export function up(pgm) {
  pgm.createTable("project_mail_domains", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    domain: { type: "text", notNull: true },
    configured_by: { type: "text", notNull: true },
    configured_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("project_mail_domains", "project_mail_domains_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("project_mail_domains", "project_mail_domains_domain_key", {
    unique: ["domain"],
  });
  pgm.addConstraint("project_mail_domains", "project_mail_domains_ownership_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_mail_domains", "project_mail_domains_shape", {
    check: `domain~'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
      AND length(configured_by) BETWEEN 1 AND 255`,
  });
  pgm.createTrigger("project_mail_domains", "project_mail_domains_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("project_mail_domain_requests", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    idempotency_key: { type: "text", notNull: true },
    request_sha256: { type: "bytea", notNull: true },
    domain: { type: "text", notNull: true },
    response: { type: "jsonb" },
    requested_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" },
  });
  pgm.addConstraint("project_mail_domain_requests", "project_mail_domain_requests_pkey", {
    primaryKey: ["organization_id", "project_id", "idempotency_key"],
  });
  pgm.addConstraint("project_mail_domain_requests", "project_mail_domain_requests_ownership_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_mail_domain_requests", "project_mail_domain_requests_shape", {
    check: `length(idempotency_key) BETWEEN 1 AND 128
      AND octet_length(request_sha256)=32
      AND domain~'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
      AND ((response IS NULL AND completed_at IS NULL)
        OR (jsonb_typeof(response)='object' AND completed_at IS NOT NULL AND completed_at>=requested_at))`,
  });

  pgm.createTable("route53_dkim_change_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    accepted_lifecycle_version: { type: "integer", notNull: true },
    domain: { type: "text", notNull: true },
    caller_reference: { type: "text", notNull: true },
    hosted_zone_id: { type: "text", notNull: true },
    name_servers: { type: "text[]", notNull: true },
    records: { type: "jsonb", notNull: true },
    change_id: { type: "text", notNull: true },
    submitted_at: { type: "timestamptz", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("route53_dkim_change_receipts", "route53_dkim_change_receipts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("route53_dkim_change_receipts", "route53_dkim_change_receipts_identity_key", {
    unique: ["organization_id", "project_id", "change_id"],
  });
  pgm.addConstraint("route53_dkim_change_receipts", "route53_dkim_change_receipts_domain_key", {
    unique: ["domain"],
  });
  pgm.addConstraint("route53_dkim_change_receipts", "route53_dkim_change_receipts_zone_key", {
    unique: ["hosted_zone_id"],
  });
  pgm.addConstraint("route53_dkim_change_receipts", "route53_dkim_change_receipts_change_key", {
    unique: ["change_id"],
  });
  pgm.addConstraint("route53_dkim_change_receipts", "route53_dkim_change_receipts_mail_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "ses_project_mail_resource_receipts (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("route53_dkim_change_receipts", "route53_dkim_change_receipts_shape", {
    check: evidenceShape,
  });
  pgm.createTrigger("route53_dkim_change_receipts", "route53_dkim_change_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("route53_dkim_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    change_id: { type: "text", notNull: true },
    insync_at: { type: "timestamptz", notNull: true },
    identity_verified_at: { type: "timestamptz", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("route53_dkim_receipts", "route53_dkim_receipts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("route53_dkim_receipts", "route53_dkim_receipts_change_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "change_id"],
      references: "route53_dkim_change_receipts (organization_id, project_id, change_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("route53_dkim_receipts", "route53_dkim_receipts_shape", {
    check: `change_id~'^C[A-Z0-9]{8,31}$'
      AND observed_at>=insync_at AND observed_at>=identity_verified_at`,
  });
  pgm.createTrigger("route53_dkim_receipts", "route53_dkim_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM route53_dkim_receipts)
       OR EXISTS (SELECT 1 FROM route53_dkim_change_receipts)
       OR EXISTS (SELECT 1 FROM project_mail_domain_requests)
       OR EXISTS (SELECT 1 FROM project_mail_domains) THEN
      RAISE EXCEPTION 'Route 53 DKIM evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("route53_dkim_receipts");
  pgm.dropTable("route53_dkim_change_receipts");
  pgm.dropTable("project_mail_domain_requests");
  pgm.dropTable("project_mail_domains");
}
