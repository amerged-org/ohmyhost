import type { ReauthorizationInput } from "./contracts.js";

/** The physical data environment a logical environment points at now (`current_data_environment`). */
export const currentDataEnvironment = (org: string, project: string, environment: string) =>
  `(SELECT assignment.data_environment_id FROM environment_data_assignments assignment WHERE assignment.organization_id = ${org} AND assignment.project_id = ${project} AND assignment.environment_id = ${environment} ORDER BY assignment.assignment_version DESC LIMIT 1)`;

/** Current mutation authority always belongs to the owner's still-open epoch; historical receipt reads do not use this predicate. */
export const CURRENT_OPERATION_EPOCH = `op.billing_epoch_id = p.active_billing_epoch_id AND EXISTS (SELECT 1 FROM billing_epochs current_epoch WHERE current_epoch.organization_id=p.organization_id AND current_epoch.project_id=p.project_id AND current_epoch.billing_epoch_id=p.active_billing_epoch_id AND current_epoch.ended_at IS NULL)`;

/** The original live claim without its Paid prerequisite: observation may outlive Paid, never the claim fence. */
export const OBSERVABLE_CLAIM_SQL = `SELECT 1 FROM product_provider_mutation_claims c
  JOIN projects p ON p.organization_id = c.organization_id AND p.project_id = c.project_id
  JOIN operations op ON op.organization_id = c.organization_id AND op.project_id = c.project_id AND op.operation_id = c.operation_id
 WHERE c.organization_id = ?1 AND c.project_id = ?2
   AND EXISTS(SELECT 1 FROM environments current_environment WHERE current_environment.organization_id=c.organization_id AND current_environment.project_id=c.project_id AND current_environment.environment_id=c.environment_id AND current_environment.name IN('dev','prod'))
   AND ${currentDataEnvironment("c.organization_id", "c.project_id", "c.environment_id")} = ?3
   AND c.operation_id = ?4 AND c.claim_id = ?5 AND c.accepted_lifecycle_version = p.lifecycle_version
   AND p.owner_state = 'active' AND op.state IN ('queued', 'running') AND p.lifecycle_state IN ('active', 'deleting')
   AND c.billing_epoch_id=op.billing_epoch_id AND ${CURRENT_OPERATION_EPOCH}`;

/** The accepted provider mutation claim. Parameters: ?1 organization, ?2 project, ?3 physical environment, ?4 operation, ?5 claim. */
export const CLAIM_SQL = OBSERVABLE_CLAIM_SQL;

export interface ClaimScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
  readonly operationId: string;
  readonly claimId: string;
}

export const claimParams = (input: ClaimScope): string[] => [
  input.organizationId,
  input.projectId,
  input.physicalEnvironmentId,
  input.operationId,
  input.claimId,
];

/**
 * Deletion authority of `database.delete`: the claim id is the operation id and the frozen deletion inventory names
 * this exact database. Parameters: ?1..?4 as above, ?5 the claim id (= operation), ?6 database id, ?7 cleanup locator.
 */
export const DELETE_AUTHORITY_SQL = `SELECT 1 FROM product_command_intents i
  JOIN cleanup_runs c ON c.organization_id = i.organization_id AND c.project_id = i.project_id AND c.cleanup_run_id = i.cleanup_run_id AND c.operation_id = i.operation_id
  JOIN operations op ON op.organization_id = i.organization_id AND op.project_id = i.project_id AND op.operation_id = i.operation_id
  JOIN projects p ON p.organization_id = i.organization_id AND p.project_id = i.project_id
  JOIN database_provider_target_heads h ON h.organization_id = i.organization_id AND h.project_id = i.project_id AND h.physical_environment_id = ?3
  JOIN database_provider_target_revisions r ON r.organization_id = h.organization_id AND r.project_id = h.project_id AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version
 WHERE i.organization_id = ?1 AND i.project_id = ?2 AND i.operation_id = ?4 AND ?5 = ?4
   AND i.billing_epoch_id=op.billing_epoch_id AND c.state = 'running' AND op.state IN ('queued', 'running') AND p.owner_state = 'active' AND ${CURRENT_OPERATION_EPOCH}
   AND r.provider = 'pgcf' AND r.database_id = ?6
   AND ((i.event_type = 'ProjectDeletionRequestedV1' AND p.lifecycle_state = 'deleting')
     OR (i.event_type = 'ProjectDataChangeRequestedV1' AND p.lifecycle_state = 'active'
       AND EXISTS (SELECT 1 FROM product_provider_mutation_claims claim WHERE claim.organization_id = i.organization_id AND claim.project_id = i.project_id AND claim.operation_id = i.operation_id AND claim.event_type = i.event_type AND claim.accepted_lifecycle_version = p.lifecycle_version AND claim.billing_epoch_id = p.active_billing_epoch_id)
       AND NOT EXISTS (SELECT 1 FROM environments e WHERE e.organization_id = i.organization_id AND e.project_id = i.project_id AND e.name IN('dev','prod') AND ${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")} = ?3)))
   AND EXISTS (SELECT 1 FROM run_resource_inventory inventory WHERE inventory.organization_id = i.organization_id AND inventory.project_id = i.project_id AND inventory.operation_id = i.operation_id AND inventory.provider = 'pgcf' AND inventory.resource_kind = 'database' AND inventory.cleanup_locator = ?7)`;

/** Boolean expression over ?1..?7: the claim fence or the deletion fence holds. */
export const DELETE_AUTHORIZED = `(EXISTS (${CLAIM_SQL}) OR EXISTS (${DELETE_AUTHORITY_SQL}))`;

export function deleteAuthorityParams(
  input: {
    organizationId: string;
    projectId: string;
    physicalEnvironmentId: string;
    operationId: string;
    databaseId: string;
  },
  locator: string,
): string[] {
  return [
    input.organizationId,
    input.projectId,
    input.physicalEnvironmentId,
    input.operationId,
    input.operationId,
    input.databaseId,
    locator,
  ];
}

/** The active target of a physical environment under an active owner. Parameters: ?1 organization, ?2 project, ?3 physical. */
export const ACTIVE_TARGET_SQL = `SELECT r.target_version, r.provider, r.provider_project_id, r.database_id, r.branch_id, r.region_id, r.size_class_id, r.runtime_role, r.credential_reference, h.activated_at
  FROM database_provider_target_heads h
  JOIN database_provider_target_revisions r ON r.organization_id = h.organization_id AND r.project_id = h.project_id AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version
  JOIN projects p ON p.organization_id = h.organization_id AND p.project_id = h.project_id
 WHERE h.organization_id = ?1 AND h.project_id = ?2 AND h.physical_environment_id = ?3 AND h.state = 'active' AND p.owner_state = 'active'`;

/** Original173 data_change is the exact TEXT change name;0451 restores that storage contract. */
const CHANGE = "intent.data_change";
const ON_PHYSICAL = (alias: string) =>
  currentDataEnvironment(
    `${alias}.organization_id`,
    `${alias}.project_id`,
    `${alias}.environment_id`,
  );

/**
 * The data-change reauthorization fence. Parameters: ?1 organization, ?2 project, ?3 environment, ?4 operation,
 * ?5 claim, ?6 physical environment, ?7 1 when every environment is revoked, ?8 the sorted wanted ids as JSON.
 */
export const REAUTHORIZATION_SQL = `SELECT 1 FROM (
  SELECT (SELECT json_group_array(listed.environment_id) FROM (
            SELECT environment.environment_id FROM environments environment
             WHERE environment.organization_id = claim.organization_id AND environment.project_id = claim.project_id AND environment.name IN('dev','prod')
               AND CASE ${CHANGE}
                 WHEN 'isolate_prod_keeps_data' THEN environment.name = 'prod' AND ${ON_PHYSICAL("environment")} = ?6
                 WHEN 'isolate_dev_keeps_data' THEN environment.name = 'dev' AND ${ON_PHYSICAL("environment")} = ?6
                 WHEN 'share_prod_keeps_data' THEN ${ON_PHYSICAL("environment")} = ?6
                 ELSE 0 END
             ORDER BY environment.environment_id) listed) AS authorized_environment_ids
    FROM product_provider_mutation_claims claim
    JOIN product_command_intents intent ON intent.organization_id = claim.organization_id AND intent.project_id = claim.project_id AND intent.operation_id = claim.operation_id
    JOIN operations operation ON operation.organization_id = claim.organization_id AND operation.operation_id = claim.operation_id
    JOIN projects project ON project.organization_id = claim.organization_id AND project.project_id = claim.project_id
    JOIN database_provider_target_heads placement ON placement.organization_id = claim.organization_id AND placement.project_id = claim.project_id AND placement.physical_environment_id = ?6
   WHERE claim.organization_id = ?1 AND claim.project_id = ?2 AND claim.environment_id = ?3 AND claim.operation_id = ?4 AND claim.claim_id = ?5
     AND claim.event_type = 'ProjectDataChangeRequestedV1' AND intent.event_type = claim.event_type
     AND project.lifecycle_state = 'active' AND project.owner_state = 'active' AND project.lifecycle_version = claim.accepted_lifecycle_version
     AND operation.state IN ('queued', 'running') AND claim.billing_epoch_id=operation.billing_epoch_id AND operation.billing_epoch_id=project.active_billing_epoch_id
     AND EXISTS(SELECT 1 FROM billing_epochs current_epoch WHERE current_epoch.organization_id=project.organization_id AND current_epoch.project_id=project.project_id AND current_epoch.billing_epoch_id=project.active_billing_epoch_id AND current_epoch.ended_at IS NULL)
     AND (?7 = 1 OR ${CHANGE} <> 'share_prod_keeps_data'
       OR (SELECT count(*) FROM environments environment WHERE environment.organization_id = claim.organization_id AND environment.project_id = claim.project_id AND environment.name IN('dev','prod') AND ${ON_PHYSICAL("environment")} = ?6) = 2)
     AND (?7 = 0 OR (${CHANGE} IN ('reset_dev', 'share_prod_keeps_data')
       AND json_extract(intent.data_change_snapshot, '$.transition.before.dev.dataEnvironmentId') = ?6
       AND EXISTS (SELECT 1 FROM environments production WHERE production.organization_id = claim.organization_id AND production.project_id = claim.project_id AND production.name = 'prod' AND ${ON_PHYSICAL("production")} <> ?6)
       AND (EXISTS (SELECT 1 FROM environments development WHERE development.organization_id = claim.organization_id AND development.project_id = claim.project_id AND development.name = 'dev' AND ${ON_PHYSICAL("development")} = ?6)
         OR (EXISTS (SELECT 1 FROM environments development WHERE development.organization_id = claim.organization_id AND development.project_id = claim.project_id AND development.name = 'dev'
                AND (SELECT assignment.operation_id FROM environment_data_assignments assignment WHERE assignment.organization_id = development.organization_id AND assignment.project_id = development.project_id AND assignment.environment_id = development.environment_id ORDER BY assignment.assignment_version DESC LIMIT 1) = claim.operation_id)
           AND (EXISTS (SELECT 1 FROM project_database_registration_reservations reserved WHERE reserved.organization_id = claim.organization_id AND reserved.project_id = claim.project_id AND reserved.physical_environment_id = ?6 AND reserved.operation_id = claim.operation_id AND json_extract(reserved.metadata, '$.status') = 'revoked')
             OR EXISTS (SELECT 1 FROM project_database_registration_receipts receipt WHERE receipt.organization_id = claim.organization_id AND receipt.project_id = claim.project_id AND receipt.physical_environment_id = ?6 AND receipt.operation_id = claim.operation_id AND receipt.status = 'revoked')
             OR (EXISTS (SELECT 1 FROM json_each(intent.data_change_snapshot, '$.registrationGenerations') generation WHERE json_extract(generation.value, '$.dataEnvironmentId') = ?6 AND CAST(json_extract(generation.value, '$.registrationVersion') AS TEXT) = '0')
               AND NOT EXISTS (SELECT 1 FROM project_database_registration_reservations reserved WHERE reserved.organization_id = claim.organization_id AND reserved.project_id = claim.project_id AND reserved.physical_environment_id = ?6)
               AND NOT EXISTS (SELECT 1 FROM project_database_registration_receipts receipt WHERE receipt.organization_id = claim.organization_id AND receipt.project_id = claim.project_id AND receipt.physical_environment_id = ?6)))))))
) fenced WHERE ?7 = 1 OR fenced.authorized_environment_ids = ?8`;

export function reauthorizationParams(input: ReauthorizationInput): (string | number)[] {
  const wanted = [...input.authorizedEnvironmentIds].sort();
  return [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.operationId,
    input.claimId,
    input.physicalEnvironmentId,
    wanted.length === 0 ? 1 : 0,
    JSON.stringify(wanted),
  ];
}
