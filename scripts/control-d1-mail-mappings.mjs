import { fail, integerText, canonical, sha256 } from "./control-d1-codec.mjs";
import { Buffer } from "node:buffer";
import { postgresArrayToJson, postgresArrayText } from "./control-d1-identity-mappings.mjs";

/** Closed selected Mail facts; additional census families/formats remain explicit central UNHANDLED. */
export const MAIL_COLUMNS = Object.freeze({
  infrastructure_alert_receipts:
    "event_id,request_sha256,first_attempt_at,lease_until,provider_message_id,accepted_at",
  legacy_aws_mail_absence:
    "organization_id,project_id,resource_kind,locator,observed_at,evidence_sha256,recorded_by,recorded_at",
  mail_gateway_keys: "organization_id,project_id,key_version,key_sha256,created_at",
  mail_received_messages:
    "message_id,provider_message_id,domain_id,organization_id,project_id,environment_id,received_at,expires_at,state,attempts,first_attempt_at,lease_until,next_attempt_at,last_http_status,billed_at",
  mail_reputation_decisions:
    "decision_id,organization_id,project_id,action,reason,triggering_event_id,eligible_send_count,hard_bounce_count,complaint_count,actor_id,evidence_sha256,occurred_at",
  mail_reputation_states:
    "organization_id,project_id,state,warmup_started_at,suspended_at,suspension_reason,triggering_event_id,version,updated_at",
  mail_send_events:
    "provider_event_id,organization_id,project_id,request_id,provider_message_id,event_type,outcome,detail_sha256,occurred_at,sent_at,received_at,reputation_kind",
  mail_send_outcomes:
    "organization_id,project_id,request_id,outcome,provider_event_id,occurred_at,version,updated_at",
  mail_send_requests:
    "request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,credit_charge_micros,state,provider_started_at,provider_message_id,requested_at,updated_at,credit_reservation_id,credit_rate_card_id,credit_meter,credit_provider_cost_micros,mail_provider,mail_domain_id,mail_binding_revision,effective_from,effective_reply_to,request_input_sha256",
  project_application_domain_identities:
    "project_id,organization_id,hostname,registrable_domain,revision,state,challenge_name,challenge_value,declared_at,verified_at,expires_at,revoked_at,automatic_revalidation_attempted_at,idempotency_key_sha256,request_sha256,actor_id",
  project_application_identity_action_commands:
    "organization_id,project_id,actor_id,action,idempotency_key_sha256,request_sha256,response",
  project_application_identity_commands:
    "organization_id,project_id,idempotency_key_sha256,request_sha256,response",
  project_mail_domain_bindings:
    "project_id,organization_id,environment_id,mail_domain_id,revision,state,sending,legacy,sender_addresses,default_from,default_reply_to,application_identity_revision,configured_at,updated_at",
  project_mail_domain_requests:
    "organization_id,project_id,idempotency_key,request_sha256,domain,response,requested_at,completed_at",
  project_mail_domains:
    "organization_id,project_id,domain,configured_by,configured_at,declaration_generation",
  resend_event_receipts: "event_id,event_type,provider_message_id,payload_sha256,received_at",
  resend_mail_commands:
    "organization_id,project_id,environment_id,idempotency_key,request_sha256,response,created_at,completed_at,lease_until,claimed_attempt,domain_id",
  resend_mail_domains:
    "domain_id,organization_id,project_id,environment_id,domain,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending,receiving,receiving_suspended,last_entitlement_check_at,last_reconcile_at,sending_status,receiving_status,records,dns_receipts,webhook_url,webhook_verified_at,configured_at,observed_at,deleted_at",
  ses_project_mail_resource_receipts:
    "organization_id,project_id,environment_id,operation_id,claim_id,accepted_lifecycle_version,region,configuration_set_name,configuration_set_arn,tenant_name,tenant_id,associated_at,observed_at,created_at",
  shared_mail_capabilities: "capability,enabled,cohort_revision,activated_at",
  workspace_mail_commands:
    "organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,response,created_at,completed_at,lease_until,claimed_attempt",
  workspace_mail_domains:
    "domain_id,organization_id,domain,registrable_domain,legacy_domain_id,custody_organization_id,custody_project_id,custody_environment_id,revision,status,reputation_state,reputation_suspended_at,reputation_suspension_reason,reputation_triggering_event_id,reputation_version,capabilities_lease_until,capabilities_lease_token,last_reconcile_at,capabilities_dirty,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending_status,receiving_status,records,dns_receipts,configured_at,observed_at,retired_at",
  workspace_mail_reputation_decisions:
    "decision_id,domain_id,organization_id,project_id,action,reason,triggering_event_id,eligible_send_count,hard_bounce_count,complaint_count,actor_id,evidence_sha256,occurred_at",
  ses_tenant_receipts:
    "organization_id,project_id,environment_id,operation_id,claim_id,accepted_lifecycle_version,provider,region,tenant_name,tenant_id,tenant_arn,sending_status,reputation_policy_arn,aws_managed_status,customer_managed_status,aggregate_sending_status,provider_created_at,reputation_observed_at,observed_at,created_at",
  ses_event_destination_receipts:
    "organization_id,project_id,configuration_set_name,event_destination_name,event_bus_arn,matching_event_types,observed_at",
  route53_dkim_change_receipts:
    "organization_id,project_id,environment_id,operation_id,claim_id,accepted_lifecycle_version,domain,caller_reference,hosted_zone_id,name_servers,records,change_id,submitted_at,observed_at,created_at",
  route53_dkim_receipts:
    "organization_id,project_id,change_id,insync_at,identity_verified_at,observed_at,created_at",
});
/** Source columns the Core no longer has (W33 simple credits): checked on the source, never carried into the Core. */
export const MAIL_RETIRED_COLUMNS = Object.freeze({
  mail_send_requests: [
    "credit_charge_micros",
    "credit_reservation_id",
    "credit_rate_card_id",
    "credit_meter",
    "credit_provider_cost_micros",
  ],
});
export const MAIL_KINDS = Object.freeze({
  infrastructure_alert_receipts: {
    event_id: "text",
    request_sha256: "text",
    first_attempt_at: "timestamp",
    lease_until: "timestamp",
    provider_message_id: "text",
    accepted_at: "timestamp",
  },
  legacy_aws_mail_absence: {
    organization_id: "text",
    project_id: "text",
    resource_kind: "text",
    locator: "text",
    observed_at: "timestamp",
    evidence_sha256: "bytea",
    recorded_by: "text",
    recorded_at: "timestamp",
  },
  mail_gateway_keys: {
    organization_id: "text",
    project_id: "text",
    key_version: "integer",
    key_sha256: "bytea",
    created_at: "timestamp",
  },
  mail_received_messages: {
    message_id: "text",
    provider_message_id: "text",
    domain_id: "text",
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    received_at: "timestamp",
    expires_at: "timestamp",
    state: "text",
    attempts: "integer",
    first_attempt_at: "timestamp",
    lease_until: "timestamp",
    next_attempt_at: "timestamp",
    last_http_status: "integer",
    billed_at: "timestamp",
  },
  mail_reputation_decisions: {
    decision_id: "text",
    organization_id: "text",
    project_id: "text",
    action: "text",
    reason: "text",
    triggering_event_id: "text",
    eligible_send_count: "integer",
    hard_bounce_count: "integer",
    complaint_count: "integer",
    actor_id: "text",
    evidence_sha256: "bytea",
    occurred_at: "timestamp",
  },
  mail_reputation_states: {
    organization_id: "text",
    project_id: "text",
    state: "text",
    warmup_started_at: "timestamp",
    suspended_at: "timestamp",
    suspension_reason: "text",
    triggering_event_id: "text",
    version: "integer",
    updated_at: "timestamp",
  },
  mail_send_events: {
    provider_event_id: "text",
    organization_id: "text",
    project_id: "text",
    request_id: "text",
    provider_message_id: "text",
    event_type: "text",
    outcome: "text",
    detail_sha256: "bytea",
    occurred_at: "timestamp",
    sent_at: "timestamp",
    received_at: "timestamp",
    reputation_kind: "text",
  },
  mail_send_outcomes: {
    organization_id: "text",
    project_id: "text",
    request_id: "text",
    outcome: "text",
    provider_event_id: "text",
    occurred_at: "timestamp",
    version: "integer",
    updated_at: "timestamp",
  },
  mail_send_requests: {
    request_id: "text",
    organization_id: "text",
    project_id: "text",
    idempotency_key: "text",
    request_sha256: "bytea",
    recipient_sha256: "bytea",
    content_sha256: "bytea",
    credit_charge_micros: "integer",
    state: "text",
    provider_started_at: "timestamp",
    provider_message_id: "text",
    requested_at: "timestamp",
    updated_at: "timestamp",
    credit_reservation_id: "text",
    credit_rate_card_id: "text",
    credit_meter: "text",
    credit_provider_cost_micros: "integer",
    mail_provider: "text",
    mail_domain_id: "text",
    mail_binding_revision: "integer",
    effective_from: "text",
    effective_reply_to: "text",
    request_input_sha256: "bytea",
  },
  project_application_domain_identities: {
    project_id: "text",
    organization_id: "text",
    hostname: "text",
    registrable_domain: "text",
    revision: "integer",
    state: "text",
    challenge_name: "text",
    challenge_value: "text",
    declared_at: "timestamp",
    verified_at: "timestamp",
    expires_at: "timestamp",
    revoked_at: "timestamp",
    automatic_revalidation_attempted_at: "timestamp",
    idempotency_key_sha256: "bytea",
    request_sha256: "bytea",
    actor_id: "text",
  },
  project_application_identity_action_commands: {
    organization_id: "text",
    project_id: "text",
    actor_id: "text",
    action: "text",
    idempotency_key_sha256: "bytea",
    request_sha256: "bytea",
    response: "text",
  },
  project_application_identity_commands: {
    organization_id: "text",
    project_id: "text",
    idempotency_key_sha256: "bytea",
    request_sha256: "bytea",
    response: "text",
  },
  project_mail_domain_bindings: {
    project_id: "text",
    organization_id: "text",
    environment_id: "text",
    mail_domain_id: "text",
    revision: "integer",
    state: "text",
    sending: "boolean",
    legacy: "boolean",
    sender_addresses: "text",
    default_from: "text",
    default_reply_to: "text",
    application_identity_revision: "integer",
    configured_at: "timestamp",
    updated_at: "timestamp",
  },
  project_mail_domain_requests: {
    organization_id: "text",
    project_id: "text",
    idempotency_key: "text",
    request_sha256: "bytea",
    domain: "text",
    response: "text",
    requested_at: "timestamp",
    completed_at: "timestamp",
  },
  project_mail_domains: {
    organization_id: "text",
    project_id: "text",
    domain: "text",
    configured_by: "text",
    configured_at: "timestamp",
    declaration_generation: "text",
  },
  resend_event_receipts: {
    event_id: "text",
    event_type: "text",
    provider_message_id: "text",
    payload_sha256: "bytea",
    received_at: "timestamp",
  },
  resend_mail_commands: {
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    idempotency_key: "text",
    request_sha256: "bytea",
    response: "text",
    created_at: "timestamp",
    completed_at: "timestamp",
    lease_until: "timestamp",
    claimed_attempt: "integer",
    domain_id: "text",
  },
  resend_mail_domains: {
    domain_id: "text",
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    domain: "text",
    provider_domain_id: "text",
    provider_claimed_at: "timestamp",
    provider_preflight_at: "timestamp",
    verify_requested_at: "timestamp",
    sending_key_id: "text",
    sending_key_claimed_at: "timestamp",
    sending_key_ciphertext: "bytea",
    sending_key_nonce: "bytea",
    sending_key_sha256: "bytea",
    sending_key_version: "integer",
    sending: "boolean",
    receiving: "boolean",
    receiving_suspended: "boolean",
    last_entitlement_check_at: "timestamp",
    last_reconcile_at: "timestamp",
    sending_status: "text",
    receiving_status: "text",
    records: "text",
    dns_receipts: "text",
    webhook_url: "text",
    webhook_verified_at: "timestamp",
    configured_at: "timestamp",
    observed_at: "timestamp",
    deleted_at: "timestamp",
  },
  ses_project_mail_resource_receipts: {
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    accepted_lifecycle_version: "integer",
    region: "text",
    configuration_set_name: "text",
    configuration_set_arn: "text",
    tenant_name: "text",
    tenant_id: "text",
    associated_at: "timestamp",
    observed_at: "timestamp",
    created_at: "timestamp",
  },
  shared_mail_capabilities: {
    capability: "text",
    enabled: "boolean",
    cohort_revision: "text",
    activated_at: "timestamp",
  },
  workspace_mail_commands: {
    organization_id: "text",
    idempotency_key: "text",
    domain_id: "text",
    operation: "text",
    principal_id: "text",
    request_sha256: "bytea",
    response: "text",
    created_at: "timestamp",
    completed_at: "timestamp",
    lease_until: "timestamp",
    claimed_attempt: "integer",
  },
  workspace_mail_domains: {
    domain_id: "text",
    organization_id: "text",
    domain: "text",
    registrable_domain: "text",
    legacy_domain_id: "text",
    custody_organization_id: "text",
    custody_project_id: "text",
    custody_environment_id: "text",
    revision: "integer",
    status: "text",
    reputation_state: "text",
    reputation_suspended_at: "timestamp",
    reputation_suspension_reason: "text",
    reputation_triggering_event_id: "text",
    reputation_version: "integer",
    capabilities_lease_until: "timestamp",
    capabilities_lease_token: "text",
    last_reconcile_at: "timestamp",
    capabilities_dirty: "boolean",
    provider_domain_id: "text",
    provider_claimed_at: "timestamp",
    provider_preflight_at: "timestamp",
    verify_requested_at: "timestamp",
    sending_key_id: "text",
    sending_key_claimed_at: "timestamp",
    sending_key_ciphertext: "bytea",
    sending_key_nonce: "bytea",
    sending_key_sha256: "bytea",
    sending_key_version: "integer",
    sending_status: "text",
    receiving_status: "text",
    records: "text",
    dns_receipts: "text",
    configured_at: "timestamp",
    observed_at: "timestamp",
    retired_at: "timestamp",
  },
  workspace_mail_reputation_decisions: {
    decision_id: "text",
    domain_id: "text",
    organization_id: "text",
    project_id: "text",
    action: "text",
    reason: "text",
    triggering_event_id: "text",
    eligible_send_count: "integer",
    hard_bounce_count: "integer",
    complaint_count: "integer",
    actor_id: "text",
    evidence_sha256: "bytea",
    occurred_at: "timestamp",
  },
  ses_tenant_receipts: {
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    accepted_lifecycle_version: "integer",
    provider: "text",
    region: "text",
    tenant_name: "text",
    tenant_id: "text",
    tenant_arn: "text",
    sending_status: "text",
    reputation_policy_arn: "text",
    aws_managed_status: "text",
    customer_managed_status: "text",
    aggregate_sending_status: "text",
    provider_created_at: "timestamp",
    reputation_observed_at: "timestamp",
    observed_at: "timestamp",
    created_at: "timestamp",
  },
  ses_event_destination_receipts: {
    organization_id: "text",
    project_id: "text",
    configuration_set_name: "text",
    event_destination_name: "text",
    event_bus_arn: "text",
    matching_event_types: "text",
    observed_at: "timestamp",
  },
  route53_dkim_change_receipts: {
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    accepted_lifecycle_version: "integer",
    domain: "text",
    caller_reference: "text",
    hosted_zone_id: "text",
    name_servers: "array",
    records: "text",
    change_id: "text",
    submitted_at: "timestamp",
    observed_at: "timestamp",
    created_at: "timestamp",
  },
  route53_dkim_receipts: {
    organization_id: "text",
    project_id: "text",
    change_id: "text",
    insync_at: "timestamp",
    identity_verified_at: "timestamp",
    observed_at: "timestamp",
    created_at: "timestamp",
  },
});
export const MAIL_PRIMARY_KEYS = Object.freeze({
  infrastructure_alert_receipts: ["event_id"],
  legacy_aws_mail_absence: ["project_id", "resource_kind", "locator"],
  mail_gateway_keys: ["organization_id", "project_id"],
  mail_received_messages: ["message_id"],
  mail_reputation_decisions: ["decision_id"],
  mail_reputation_states: ["organization_id", "project_id"],
  mail_send_events: ["provider_event_id"],
  mail_send_outcomes: ["organization_id", "project_id", "request_id"],
  mail_send_requests: ["request_id"],
  project_application_domain_identities: ["project_id"],
  project_application_identity_action_commands: [
    "organization_id",
    "project_id",
    "actor_id",
    "action",
    "idempotency_key_sha256",
  ],
  project_application_identity_commands: [
    "organization_id",
    "project_id",
    "idempotency_key_sha256",
  ],
  project_mail_domain_bindings: ["project_id"],
  project_mail_domain_requests: ["organization_id", "project_id", "idempotency_key"],
  project_mail_domains: ["organization_id", "project_id"],
  resend_event_receipts: ["event_id"],
  resend_mail_commands: ["organization_id", "project_id", "environment_id", "idempotency_key"],
  resend_mail_domains: ["domain_id"],
  ses_project_mail_resource_receipts: ["organization_id", "project_id"],
  shared_mail_capabilities: ["capability"],
  workspace_mail_commands: ["organization_id", "idempotency_key"],
  workspace_mail_domains: ["domain_id"],
  workspace_mail_reputation_decisions: ["decision_id", "domain_id"],
  ses_tenant_receipts: ["organization_id", "project_id"],
  ses_event_destination_receipts: ["organization_id", "project_id"],
  route53_dkim_change_receipts: ["organization_id", "project_id"],
  route53_dkim_receipts: ["organization_id", "project_id"],
});
export const MAIL_REQUIRED_MIGRATIONS = Object.freeze({
  "0460_mail_original_receipts.sql":
    "df78ece8253d6af47cbd6b5e1c3cc6408138c17564537beff22d4601dca44438",
  "0461_mail_send_original_facts.sql":
    "a3f1658ee248e14bb32cc03679b6c992cb3f020d23ed353ced5f93e7ab53c947",
  "0463_mail_historical_ses_receipts.sql":
    "878357e68309fe234be1b035e93e8037df334df30e762db26746914fdbc98e6f",
  "0464_mail_historical_route53_receipts.sql":
    "3cbc11678680dd351530a56be72c54428769c263f7338ec04cb3ebf03cd1fc30",
  "0466_mail_original_management.sql":
    "df9c9b9959ff42f09b01c657c38c1f033d247e98cc6ebe6af79c894068adc86e",
  "0470_mail_received_original_facts.sql":
    "3603aac7347d05c1175ef5a11550263f7d19f03dd721cc766b7bd58bf3a21951",
  "0480_paid_domain_native_integrity.sql":
    "4f874a39325ae9b605300c755654c0c286d3902c08ed2decafde14dd379bfcd4",
  "0491_mail_website_identity_invalidation.sql":
    "4e4e30bd34f027b2cb6976a47601d5ad3079f4b739fee9bb714f263be0274484",
});
/** Fixed final-native FK order; root identity parents load first. No Mail SCC or derived rows. */
export const MAIL_LOAD_ORDER = Object.freeze([
  "shared_mail_capabilities",
  "project_mail_domains",
  "project_mail_domain_requests",
  "resend_mail_domains",
  "project_application_domain_identities",
  "project_application_identity_commands",
  "project_application_identity_action_commands",
  "workspace_mail_domains",
  "project_mail_domain_bindings",
  "resend_mail_commands",
  "workspace_mail_commands",
  "mail_gateway_keys",
  "mail_send_requests",
  "mail_send_events",
  "mail_reputation_states",
  "mail_reputation_decisions",
  "mail_send_outcomes",
  "workspace_mail_reputation_decisions",
  "mail_received_messages",
  "ses_tenant_receipts",
  "ses_project_mail_resource_receipts",
  "ses_event_destination_receipts",
  "route53_dkim_change_receipts",
  "route53_dkim_receipts",
  "legacy_aws_mail_absence",
  "resend_event_receipts",
  "infrastructure_alert_receipts",
]);
/** Exact original PostgreSQL type identities/base types from the retained final Dev/Prod schema audit. */
export const MAIL_SOURCE_TYPES = Object.freeze({
  infrastructure_alert_receipts: {
    event_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    request_sha256: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    first_attempt_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    lease_until: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    provider_message_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    accepted_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  legacy_aws_mail_absence: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    resource_kind: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    locator: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    evidence_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    recorded_by: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    recorded_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  mail_gateway_keys: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    key_version: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    key_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  mail_received_messages: {
    message_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    provider_message_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    received_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    expires_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    state: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    attempts: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    first_attempt_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    lease_until: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    next_attempt_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    last_http_status: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    billed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  mail_reputation_decisions: {
    decision_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    action: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    reason: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    triggering_event_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    eligible_send_count: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    hard_bounce_count: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    complaint_count: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    actor_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    evidence_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    occurred_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  mail_reputation_states: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    state: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    warmup_started_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    suspended_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    suspension_reason: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    triggering_event_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    version: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    updated_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  mail_send_events: {
    provider_event_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    request_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    provider_message_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    event_type: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    outcome: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    detail_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    occurred_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    sent_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    received_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    reputation_kind: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
  },
  mail_send_outcomes: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    request_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    outcome: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    provider_event_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    occurred_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    version: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    updated_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  mail_send_requests: {
    request_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    idempotency_key: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    request_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    recipient_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    content_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    credit_charge_micros: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    state: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    provider_started_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    provider_message_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    requested_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    updated_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    credit_reservation_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    credit_rate_card_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    credit_meter: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    credit_provider_cost_micros: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    mail_provider: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    mail_domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    mail_binding_revision: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    effective_from: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    effective_reply_to: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    request_input_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
  },
  project_application_domain_identities: {
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    hostname: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    registrable_domain: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    revision: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    state: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    challenge_name: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    challenge_value: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    declared_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    verified_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    expires_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    revoked_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    automatic_revalidation_attempted_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    idempotency_key_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    request_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    actor_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
  },
  project_application_identity_action_commands: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    actor_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    action: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    idempotency_key_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    request_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    response: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
  },
  project_application_identity_commands: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    idempotency_key_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    request_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    response: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
  },
  project_mail_domain_bindings: {
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    mail_domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    revision: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    state: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    sending: {
      pgType: "boolean",
      sourceType: "boolean",
      kind: "text",
    },
    legacy: {
      pgType: "boolean",
      sourceType: "boolean",
      kind: "text",
    },
    sender_addresses: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    default_from: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    default_reply_to: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    application_identity_revision: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    configured_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    updated_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  project_mail_domain_requests: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    idempotency_key: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    request_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    domain: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    response: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    requested_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    completed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  project_mail_domains: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    domain: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    configured_by: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    configured_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    declaration_generation: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
  },
  resend_event_receipts: {
    event_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    event_type: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    provider_message_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    payload_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    received_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  resend_mail_commands: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    idempotency_key: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    request_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    response: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    completed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    lease_until: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    claimed_attempt: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
  },
  resend_mail_domains: {
    domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    domain: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    provider_domain_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    provider_claimed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    provider_preflight_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    verify_requested_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    sending_key_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    sending_key_claimed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    sending_key_ciphertext: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    sending_key_nonce: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    sending_key_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    sending_key_version: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    sending: {
      pgType: "boolean",
      sourceType: "boolean",
      kind: "text",
    },
    receiving: {
      pgType: "boolean",
      sourceType: "boolean",
      kind: "text",
    },
    receiving_suspended: {
      pgType: "boolean",
      sourceType: "boolean",
      kind: "text",
    },
    last_entitlement_check_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    last_reconcile_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    sending_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    receiving_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    records: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    dns_receipts: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    webhook_url: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    webhook_verified_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    configured_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    deleted_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  ses_project_mail_resource_receipts: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    operation_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    claim_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    accepted_lifecycle_version: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    region: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    configuration_set_name: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    configuration_set_arn: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    tenant_name: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    tenant_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    associated_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  shared_mail_capabilities: {
    capability: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    enabled: {
      pgType: "boolean",
      sourceType: "boolean",
      kind: "text",
    },
    cohort_revision: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    activated_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  workspace_mail_commands: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    idempotency_key: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    operation: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    principal_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    request_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    response: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    completed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    lease_until: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    claimed_attempt: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
  },
  workspace_mail_domains: {
    domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    domain: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    registrable_domain: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    legacy_domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    custody_organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    custody_project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    custody_environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    revision: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    reputation_state: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    reputation_suspended_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    reputation_suspension_reason: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    reputation_triggering_event_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    reputation_version: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    capabilities_lease_until: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    capabilities_lease_token: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    last_reconcile_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    capabilities_dirty: {
      pgType: "boolean",
      sourceType: "boolean",
      kind: "text",
    },
    provider_domain_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    provider_claimed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    provider_preflight_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    verify_requested_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    sending_key_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    sending_key_claimed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    sending_key_ciphertext: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    sending_key_nonce: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    sending_key_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    sending_key_version: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    sending_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    receiving_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    records: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    dns_receipts: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    configured_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    retired_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  workspace_mail_reputation_decisions: {
    decision_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    domain_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    action: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    reason: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    triggering_event_id: {
      pgType: "uuid",
      sourceType: "uuid",
      kind: "text",
    },
    eligible_send_count: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    hard_bounce_count: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    complaint_count: {
      pgType: "bigint",
      sourceType: "bigint",
      kind: "integer",
    },
    actor_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    evidence_sha256: {
      pgType: "bytea",
      sourceType: "bytea",
      kind: "bytea",
    },
    occurred_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  ses_tenant_receipts: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    operation_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    claim_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    accepted_lifecycle_version: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    provider: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    region: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    tenant_name: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    tenant_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    tenant_arn: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    sending_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    reputation_policy_arn: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    aws_managed_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    customer_managed_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    aggregate_sending_status: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    provider_created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    reputation_observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  ses_event_destination_receipts: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    configuration_set_name: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    event_destination_name: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    event_bus_arn: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    matching_event_types: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  route53_dkim_change_receipts: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    environment_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    operation_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    claim_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    accepted_lifecycle_version: {
      pgType: "integer",
      sourceType: "integer",
      kind: "integer",
    },
    domain: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    caller_reference: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    hosted_zone_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    name_servers: {
      pgType: "text[]",
      sourceType: "text[]",
      kind: "array",
    },
    records: {
      pgType: "jsonb",
      sourceType: "jsonb",
      kind: "text",
    },
    change_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    submitted_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
  route53_dkim_receipts: {
    organization_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    project_id: {
      pgType: "text",
      sourceType: "ulid",
      kind: "text",
    },
    change_id: {
      pgType: "text",
      sourceType: "text",
      kind: "text",
    },
    insync_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    identity_verified_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    observed_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
    created_at: {
      pgType: "timestamp with time zone",
      sourceType: "timestamp with time zone",
      kind: "timestamp",
    },
  },
});
export const MAIL_TARGETS = Object.freeze(Object.keys(MAIL_COLUMNS));

const bool = (value) => {
  if (value !== "true" && value !== "false") fail("MAIL_BOOLEAN_UNREPRESENTABLE");
  return value === "true" ? "1" : "0";
};
export function route53Nameservers(value) {
  if (typeof value !== "string") fail("MAIL_ROUTE53_ARRAY_UNREPRESENTABLE");
  const match = /^\[(-?\d+):(-?\d+)\]=/u.exec(value),
    lower = match ? Number(match[1]) : 1,
    body = match ? value.slice(match[0].length) : value,
    values = JSON.parse(postgresArrayToJson(body));
  if (
    !Number.isInteger(lower) ||
    lower < -2147483648 ||
    lower > 2147483644 ||
    values.length !== 4 ||
    values.some((v) => typeof v !== "string") ||
    (match && Number(match[2]) !== lower + 3)
  )
    fail("MAIL_ROUTE53_ARRAY_UNREPRESENTABLE");
  return JSON.stringify({ lowerBound: lower, values });
}
export function route53NameserversText(value) {
  const row = JSON.parse(value);
  if (!row || !Number.isInteger(row.lowerBound) || !Array.isArray(row.values))
    fail("MAIL_ROUTE53_ARRAY_UNREPRESENTABLE");
  return (
    (row.lowerBound === 1 ? "" : `[${row.lowerBound}:${row.lowerBound + 3}]=`) +
    postgresArrayText(row.values)
  );
}
/** Original captured strings remain verbatim except exact boolean/array physical encodings. No current-owner relabel. */
export function mapMail(rows, manifest, capture) {
  void capture;
  for (const [name, hash] of Object.entries(MAIL_REQUIRED_MIGRATIONS))
    if (!manifest.targetPin.migrations.some((m) => m.name === name && m.sha256 === hash))
      fail("MAIL_NATIVE_PREREQUISITE");
  const records = [];
  for (const table of MAIL_LOAD_ORDER) {
    const columns = MAIL_COLUMNS[table];
    const expected = columns.split(","),
      descriptor = manifest.tables.find((t) => t.name === table);
    if (
      !descriptor ||
      descriptor.columns.map((c) => c.name).join(",") !== columns ||
      !rows.has(table) ||
      !Array.isArray(rows.get(table))
    )
      fail("MAIL_SOURCE_FORMAT_UNHANDLED");
    for (const column of descriptor.columns) {
      const expectedType = MAIL_SOURCE_TYPES[table][column.name];
      if (
        column.pgType !== expectedType.pgType ||
        column.sourceType !== expectedType.sourceType ||
        column.kind !== expectedType.kind
      )
        fail("MAIL_SOURCE_TYPE_UNHANDLED");
    }
    for (const original of rows.get(table)) {
      if (Object.keys(original).sort().join(",") !== [...expected].sort().join(","))
        fail("MAIL_SOURCE_ROW_UNHANDLED");
      const row = { ...original };
      for (const [column, kind] of Object.entries(MAIL_KINDS[table])) {
        const value = row[column];
        if (value === null) continue;
        if (typeof value !== "string") fail("MAIL_SOURCE_VALUE_UNHANDLED");
        if (kind === "integer") integerText(value);
        if (kind === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value))
          fail("MAIL_SOURCE_BINARY_UNHANDLED");
        if (
          kind === "timestamp" &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString() !== value.slice(0, 23) + "Z")
        )
          fail("MAIL_SOURCE_TIMESTAMP_UNHANDLED");
        if (kind === "boolean") row[column] = bool(value);
        if (kind === "array")
          row[column] =
            table === "route53_dkim_change_receipts" && column === "name_servers"
              ? route53Nameservers(value)
              : postgresArrayToJson(value);
      }
      const retired = MAIL_RETIRED_COLUMNS[table] ?? [];
      records.push({
        table,
        row: Object.fromEntries(
          Object.entries(row).filter(([column]) => !retired.includes(column)),
        ),
        atomicGroup: `mail.original:${table}:${sha256(Buffer.from(canonical(MAIL_PRIMARY_KEYS[table].map((key) => original[key]))))}`,
      });
    }
  }
  return records;
}
