-- W32: original Route53 DKIM history only. No Route53 request, new writer capability or absence seed.
-- name_servers retains one typed scalar: {lowerBound:int4,values:text[4]}. PG array bounds are original data.
-- Checks intentionally follow original indices1..4, including valid non-one lower bounds; no tighter provider assumption.
CREATE TABLE mail_route53_empty_guard_0464(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mail_route53_empty_guard_0464 SELECT 1 WHERE EXISTS(SELECT 1 FROM legacy_aws_mail_receipts);
CREATE TABLE route53_dkim_change_receipts (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 claim_id TEXT NOT NULL CHECK(length(claim_id)=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 accepted_lifecycle_version INTEGER NOT NULL CHECK(accepted_lifecycle_version BETWEEN 1 AND 2147483647),
 domain TEXT NOT NULL UNIQUE CHECK(length(domain) BETWEEN 1 AND 253 AND domain NOT GLOB '*[^a-z0-9.-]*'),
 caller_reference TEXT NOT NULL CHECK(caller_reference='ohmyho-'||project_id),
 hosted_zone_id TEXT NOT NULL CHECK(length(hosted_zone_id) BETWEEN 9 AND 32 AND substr(hosted_zone_id,1,1)='Z' AND substr(hosted_zone_id,2) NOT GLOB '*[^A-Z0-9]*') UNIQUE,
 name_servers TEXT NOT NULL CHECK(json_valid(name_servers)),
 records TEXT NOT NULL CHECK(json_valid(records)),
 change_id TEXT NOT NULL CHECK(length(change_id) BETWEEN 9 AND 32 AND substr(change_id,1,1)='C' AND substr(change_id,2) NOT GLOB '*[^A-Z0-9]*') UNIQUE,
 submitted_at TEXT NOT NULL CHECK(submitted_at GLOB '????-??-??T??:??:??.??????Z'),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id),
 UNIQUE(organization_id,project_id,change_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES ses_project_mail_resource_receipts(organization_id,project_id),
 CHECK(observed_at>=submitted_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER route53_dkim_change_receipts_original_shape BEFORE INSERT ON route53_dkim_change_receipts
BEGIN
  SELECT RAISE(ABORT,'Route53 original domain shape') WHERE EXISTS(
    SELECT 1 FROM json_each(('["'||replace(NEW.domain,'.','","')||'"]')) label
    WHERE json_array_length(('["'||replace(NEW.domain,'.','","')||'"]'))<2
      OR (label.key=json_array_length(('["'||replace(NEW.domain,'.','","')||'"]'))-1 AND
        (length(label.value) NOT BETWEEN 2 AND 63 OR label.value GLOB '*[^a-z]*'))
      OR (label.key<json_array_length(('["'||replace(NEW.domain,'.','","')||'"]'))-1 AND
        (length(label.value) NOT BETWEEN 1 AND 63 OR substr(label.value,1,1) NOT GLOB '[a-z0-9]' OR substr(label.value,-1,1) NOT GLOB '[a-z0-9]')));
  SELECT RAISE(ABORT,'Route53 original nameserver shape') WHERE
    json_type(NEW.name_servers) IS NOT 'object' OR (SELECT count(*) FROM json_each(NEW.name_servers))<>2
    OR EXISTS(SELECT 1 FROM json_each(NEW.name_servers) WHERE key NOT IN('lowerBound','values'))
    OR json_type(NEW.name_servers,'$.lowerBound') IS NOT 'integer'
    OR json_extract(NEW.name_servers,'$.lowerBound') NOT BETWEEN -2147483648 AND 2147483644
    OR json_type(NEW.name_servers,'$.values') IS NOT 'array' OR json_array_length(NEW.name_servers,'$.values')<>4
    OR EXISTS(SELECT 1 FROM json_each(NEW.name_servers,'$.values') value WHERE type<>'text')
    OR EXISTS(SELECT 1 FROM json_each(NEW.name_servers,'$.values') value
      WHERE json_extract(NEW.name_servers,'$.lowerBound')+value.key BETWEEN 1 AND 4 AND NOT (value.value GLOB 'ns-[0-9].awsdns-[0-9].com' OR value.value GLOB 'ns-[0-9].awsdns-[0-9].net' OR value.value GLOB 'ns-[0-9].awsdns-[0-9].org' OR value.value GLOB 'ns-[0-9].awsdns-[0-9].co.uk' OR value.value GLOB 'ns-[0-9].awsdns-[0-9][0-9].com' OR value.value GLOB 'ns-[0-9].awsdns-[0-9][0-9].net' OR value.value GLOB 'ns-[0-9].awsdns-[0-9][0-9].org' OR value.value GLOB 'ns-[0-9].awsdns-[0-9][0-9].co.uk' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9].com' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9].net' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9].org' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9].co.uk' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9][0-9].com' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9][0-9].net' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9][0-9].org' OR value.value GLOB 'ns-[0-9][0-9].awsdns-[0-9][0-9].co.uk' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9].com' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9].net' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9].org' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9].co.uk' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9][0-9].com' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9][0-9].net' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9][0-9].org' OR value.value GLOB 'ns-[0-9][0-9][0-9].awsdns-[0-9][0-9].co.uk' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9].com' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9].net' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9].org' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9].co.uk' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9][0-9].com' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9][0-9].net' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9][0-9].org' OR value.value GLOB 'ns-[0-9][0-9][0-9][0-9].awsdns-[0-9][0-9].co.uk'))
    OR EXISTS(SELECT 1 FROM json_each(NEW.name_servers,'$.values') a JOIN json_each(NEW.name_servers,'$.values') b ON a.key<b.key
      WHERE json_extract(NEW.name_servers,'$.lowerBound')+a.key BETWEEN 1 AND 4
        AND json_extract(NEW.name_servers,'$.lowerBound')+b.key BETWEEN 1 AND 4 AND a.value=b.value);
  SELECT RAISE(ABORT,'Route53 original DKIM record shape') WHERE
    json_type(NEW.records) IS NOT 'array' OR json_array_length(NEW.records)<>3
    OR EXISTS(SELECT 1 FROM json_each(NEW.records) record WHERE record.type<>'object'
      OR (SELECT count(*) FROM json_each(record.value))<>3
      OR EXISTS(SELECT 1 FROM json_each(record.value) field WHERE field.key NOT IN('type','name','value'))
      OR json_type(record.value,'$.type') IS NOT 'text' OR json_type(record.value,'$.name') IS NOT 'text' OR json_type(record.value,'$.value') IS NOT 'text'
      OR json_extract(record.value,'$.type')<>'CNAME'
      OR instr(json_extract(record.value,'$.name'),'.')-1 NOT BETWEEN 32 AND 64
      OR substr(json_extract(record.value,'$.name'),1,instr(json_extract(record.value,'$.name'),'.')-1) GLOB '*[^a-z0-9]*'
      OR substr(json_extract(record.value,'$.name'),instr(json_extract(record.value,'$.name'),'.'),12)<>'._domainkey.'
      OR json_extract(record.value,'$.name') NOT GLOB '*.?domainkey.'||NEW.domain
      OR instr(json_extract(record.value,'$.value'),'.')-1 NOT BETWEEN 32 AND 64
      OR substr(json_extract(record.value,'$.value'),1,instr(json_extract(record.value,'$.value'),'.')-1) GLOB '*[^a-z0-9]*'
      OR substr(json_extract(record.value,'$.value'),instr(json_extract(record.value,'$.value'),'.'))<>'.dkim.amazonses.com')
    OR EXISTS(SELECT 1 FROM json_each(NEW.records) a JOIN json_each(NEW.records) b ON a.key<b.key
      WHERE json_extract(a.value,'$.name')=json_extract(b.value,'$.name'));
END;
CREATE TRIGGER route53_dkim_change_receipts_append_only_update BEFORE UPDATE ON route53_dkim_change_receipts
BEGIN SELECT RAISE(ABORT,'route53_dkim_change_receipts is append-only');END;
CREATE TRIGGER route53_dkim_change_receipts_append_only_delete BEFORE DELETE ON route53_dkim_change_receipts
BEGIN SELECT RAISE(ABORT,'route53_dkim_change_receipts is append-only');END;

CREATE TABLE route53_dkim_receipts (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 change_id TEXT NOT NULL CHECK(length(change_id) BETWEEN 9 AND 32 AND substr(change_id,1,1)='C' AND substr(change_id,2) NOT GLOB '*[^A-Z0-9]*'),
 insync_at TEXT NOT NULL CHECK(insync_at GLOB '????-??-??T??:??:??.??????Z'),
 identity_verified_at TEXT NOT NULL CHECK(identity_verified_at GLOB '????-??-??T??:??:??.??????Z'),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(organization_id,project_id,change_id) REFERENCES route53_dkim_change_receipts(organization_id,project_id,change_id),
 CHECK(observed_at>=insync_at AND observed_at>=identity_verified_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER route53_dkim_receipts_append_only_update BEFORE UPDATE ON route53_dkim_receipts
BEGIN SELECT RAISE(ABORT,'route53_dkim_receipts is append-only');END;
CREATE TRIGGER route53_dkim_receipts_append_only_delete BEFORE DELETE ON route53_dkim_receipts
BEGIN SELECT RAISE(ABORT,'route53_dkim_receipts is append-only');END;
DROP TABLE mail_route53_empty_guard_0464;
