-- W32: exact ORIGINAL structured historical SES and explicit observed-absence receipts.
-- No AWS/provider call, deletion, made-up absence, data seed or current-owner requirement.
-- A populated folded prototype must not be silently treated as a converted original source.
CREATE TABLE mail_historical_empty_guard_0463(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mail_historical_empty_guard_0463 SELECT 1 WHERE EXISTS(SELECT 1 FROM legacy_aws_mail_receipts);
CREATE TABLE ses_tenant_receipts (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 claim_id TEXT NOT NULL CHECK(length(claim_id)=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 accepted_lifecycle_version INTEGER NOT NULL CHECK(accepted_lifecycle_version BETWEEN 1 AND 2147483647),
 provider TEXT NOT NULL CHECK(provider='aws-ses-v2'),
 region TEXT NOT NULL CHECK((length(region)>=6 AND substr(region,1,2) GLOB '[a-z][a-z]' AND substr(region,3,1)='-' AND substr(region,-2,1)='-' AND substr(region,-1,1) GLOB '[0-9]' AND substr(region,4,1) GLOB '[a-z]' AND substr(region,-3,1) GLOB '[a-z]' AND substr(region,4,length(region)-5) NOT GLOB '*[^a-z-]*' AND instr(region,'--')=0)),
 tenant_name TEXT NOT NULL CHECK((length(tenant_name)=33 AND substr(tenant_name,1,7)='ohmyho-' AND substr(tenant_name,8,1) BETWEEN '0' AND '7' AND substr(tenant_name,8) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
 tenant_id TEXT NOT NULL CHECK((length(tenant_id) BETWEEN 1 AND 128 AND tenant_id NOT GLOB '*[^A-Za-z0-9_-]*')),
 tenant_arn TEXT NOT NULL UNIQUE CHECK((tenant_arn NOT GLOB '*[^A-Za-z0-9:/_-]*' AND json_array_length(('["'||replace(tenant_arn,':','","')||'"]'))=6 AND (json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[0]'),json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[1]'),json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[2]')) IS ('arn','aws','ses') AND (length(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'))>=6 AND substr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),1,2) GLOB '[a-z][a-z]' AND substr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),3,1)='-' AND substr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),-2,1)='-' AND substr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),-1,1) GLOB '[0-9]' AND substr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),4,1) GLOB '[a-z]' AND substr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),-3,1) GLOB '[a-z]' AND substr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),4,length(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'))-5) NOT GLOB '*[^a-z-]*' AND instr(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[3]'),'--')=0) AND length(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[4]'))=12 AND json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[4]') NOT GLOB '*[^0-9]*' AND json_array_length(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'))=3 AND json_extract(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[0]')='tenant' AND (length(json_extract(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'))=33 AND substr(json_extract(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'),1,7)='ohmyho-' AND substr(json_extract(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'),8,1) BETWEEN '0' AND '7' AND substr(json_extract(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'),8) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*') AND (length(json_extract(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[2]')) BETWEEN 1 AND 128 AND json_extract(('["'||replace(json_extract(('["'||replace(tenant_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[2]') NOT GLOB '*[^A-Za-z0-9_-]*'))),
 sending_status TEXT NOT NULL CHECK(sending_status IN('enabled','reinstated','disabled')),
 reputation_policy_arn TEXT NOT NULL CHECK(reputation_policy_arn='arn:aws:ses:'||region||':aws:reputation-policy/standard'),
 aws_managed_status TEXT NOT NULL CHECK(aws_managed_status IN('enabled','reinstated','disabled','unknown')),
 customer_managed_status TEXT NOT NULL CHECK(customer_managed_status IN('enabled','reinstated','disabled','unknown')),
 aggregate_sending_status TEXT NOT NULL CHECK(aggregate_sending_status IN('enabled','reinstated','disabled')),
 provider_created_at TEXT NOT NULL CHECK(provider_created_at GLOB '????-??-??T??:??:??.??????Z'),
 reputation_observed_at TEXT NOT NULL CHECK(reputation_observed_at GLOB '????-??-??T??:??:??.??????Z'),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id),
 UNIQUE(region,tenant_name),
 UNIQUE(region,tenant_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
 CHECK(reputation_observed_at>=provider_created_at AND observed_at>=provider_created_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER ses_tenant_receipts_append_only_update BEFORE UPDATE ON ses_tenant_receipts
BEGIN SELECT RAISE(ABORT,'ses_tenant_receipts is append-only'); END;
CREATE TRIGGER ses_tenant_receipts_append_only_delete BEFORE DELETE ON ses_tenant_receipts
BEGIN SELECT RAISE(ABORT,'ses_tenant_receipts is append-only'); END;

CREATE TABLE ses_project_mail_resource_receipts (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 claim_id TEXT NOT NULL CHECK(length(claim_id)=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 accepted_lifecycle_version INTEGER NOT NULL CHECK(accepted_lifecycle_version BETWEEN 1 AND 2147483647),
 region TEXT NOT NULL CHECK((length(region)>=6 AND substr(region,1,2) GLOB '[a-z][a-z]' AND substr(region,3,1)='-' AND substr(region,-2,1)='-' AND substr(region,-1,1) GLOB '[0-9]' AND substr(region,4,1) GLOB '[a-z]' AND substr(region,-3,1) GLOB '[a-z]' AND substr(region,4,length(region)-5) NOT GLOB '*[^a-z-]*' AND instr(region,'--')=0)),
 configuration_set_name TEXT NOT NULL CHECK((length(configuration_set_name)=33 AND substr(configuration_set_name,1,7)='ohmyho-' AND substr(configuration_set_name,8,1) BETWEEN '0' AND '7' AND substr(configuration_set_name,8) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
 configuration_set_arn TEXT NOT NULL UNIQUE CHECK((configuration_set_arn NOT GLOB '*[^A-Za-z0-9:/_-]*' AND json_array_length(('["'||replace(configuration_set_arn,':','","')||'"]'))=6 AND (json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[0]'),json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[1]'),json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[2]')) IS ('arn','aws','ses') AND (length(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'))>=6 AND substr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),1,2) GLOB '[a-z][a-z]' AND substr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),3,1)='-' AND substr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),-2,1)='-' AND substr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),-1,1) GLOB '[0-9]' AND substr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),4,1) GLOB '[a-z]' AND substr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),-3,1) GLOB '[a-z]' AND substr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),4,length(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'))-5) NOT GLOB '*[^a-z-]*' AND instr(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[3]'),'--')=0) AND length(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[4]'))=12 AND json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[4]') NOT GLOB '*[^0-9]*' AND json_array_length(('["'||replace(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'))=2 AND json_extract(('["'||replace(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[0]')='configuration-set' AND (length(json_extract(('["'||replace(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'))=33 AND substr(json_extract(('["'||replace(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'),1,7)='ohmyho-' AND substr(json_extract(('["'||replace(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'),8,1) BETWEEN '0' AND '7' AND substr(json_extract(('["'||replace(json_extract(('["'||replace(configuration_set_arn,':','","')||'"]'),'$[5]'),'/','","')||'"]'),'$[1]'),8) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'))),
 tenant_name TEXT NOT NULL CHECK(tenant_name=configuration_set_name),
 tenant_id TEXT NOT NULL CHECK((length(tenant_id) BETWEEN 1 AND 128 AND tenant_id NOT GLOB '*[^A-Za-z0-9_-]*')),
 associated_at TEXT NOT NULL CHECK(associated_at GLOB '????-??-??T??:??:??.??????Z'),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES ses_tenant_receipts(organization_id,project_id),
 CHECK(observed_at>=associated_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER ses_project_mail_resource_receipts_append_only_update BEFORE UPDATE ON ses_project_mail_resource_receipts
BEGIN SELECT RAISE(ABORT,'ses_project_mail_resource_receipts is append-only'); END;
CREATE TRIGGER ses_project_mail_resource_receipts_append_only_delete BEFORE DELETE ON ses_project_mail_resource_receipts
BEGIN SELECT RAISE(ABORT,'ses_project_mail_resource_receipts is append-only'); END;

CREATE TABLE ses_event_destination_receipts (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 configuration_set_name TEXT NOT NULL CHECK((length(configuration_set_name)=33 AND substr(configuration_set_name,1,7)='ohmyho-' AND substr(configuration_set_name,8,1) BETWEEN '0' AND '7' AND substr(configuration_set_name,8) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
 event_destination_name TEXT NOT NULL CHECK(event_destination_name='ohmyho-events'),
 event_bus_arn TEXT NOT NULL CHECK((event_bus_arn NOT GLOB '*[^A-Za-z0-9:/_-]*' AND json_array_length(('["'||replace(event_bus_arn,':','","')||'"]'))=6 AND (json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[0]'),json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[1]'),json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[2]')) IS ('arn','aws','events') AND (length(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'))>=6 AND substr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),1,2) GLOB '[a-z][a-z]' AND substr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),3,1)='-' AND substr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),-2,1)='-' AND substr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),-1,1) GLOB '[0-9]' AND substr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),4,1) GLOB '[a-z]' AND substr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),-3,1) GLOB '[a-z]' AND substr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),4,length(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'))-5) NOT GLOB '*[^a-z-]*' AND instr(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[3]'),'--')=0) AND length(json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[4]'))=12 AND json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[4]') NOT GLOB '*[^0-9]*' AND json_extract(('["'||replace(event_bus_arn,':','","')||'"]'),'$[5]')='event-bus/default')),
 matching_event_types TEXT NOT NULL CHECK(json_valid(matching_event_types) AND json_type(matching_event_types)='array' AND json_array_length(matching_event_types)=7 AND (json_extract(matching_event_types,'$[0]'),json_extract(matching_event_types,'$[1]'),json_extract(matching_event_types,'$[2]'),json_extract(matching_event_types,'$[3]'),json_extract(matching_event_types,'$[4]'),json_extract(matching_event_types,'$[5]'),json_extract(matching_event_types,'$[6]')) IS ('BOUNCE','COMPLAINT','DELIVERY','DELIVERY_DELAY','REJECT','RENDERING_FAILURE','SEND')),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES ses_project_mail_resource_receipts(organization_id,project_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER ses_event_destination_receipts_append_only_update BEFORE UPDATE ON ses_event_destination_receipts
BEGIN SELECT RAISE(ABORT,'ses_event_destination_receipts is append-only'); END;
CREATE TRIGGER ses_event_destination_receipts_append_only_delete BEFORE DELETE ON ses_event_destination_receipts
BEGIN SELECT RAISE(ABORT,'ses_event_destination_receipts is append-only'); END;

CREATE TABLE legacy_aws_mail_absence (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 resource_kind TEXT NOT NULL CHECK(resource_kind IN('ses-tenant','ses-configuration-set','ses-event-destination','ses-identity','route53-hosted-zone','route53-dkim-record')),
 locator TEXT NOT NULL CHECK(length(locator) BETWEEN 1 AND 1024),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 evidence_sha256 BLOB NOT NULL CHECK(length(evidence_sha256)=32),
 recorded_by TEXT NOT NULL CHECK(length(recorded_by) BETWEEN 1 AND 256),
 recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(project_id,resource_kind,locator),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
 CHECK(recorded_at>=observed_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER legacy_aws_mail_absence_append_only_update BEFORE UPDATE ON legacy_aws_mail_absence
BEGIN SELECT RAISE(ABORT,'legacy_aws_mail_absence is append-only'); END;
CREATE TRIGGER legacy_aws_mail_absence_append_only_delete BEFORE DELETE ON legacy_aws_mail_absence
BEGIN SELECT RAISE(ABORT,'legacy_aws_mail_absence is append-only'); END;

DROP TABLE mail_historical_empty_guard_0463;
