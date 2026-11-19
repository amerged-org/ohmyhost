export const archivedDevProofSql = (alias: string) =>
  `${alias}.name='retired-dev-'||${alias}.environment_id AND EXISTS(SELECT 1 FROM dev_environment_restorations boundary WHERE boundary.organization_id=${alias}.organization_id AND boundary.project_id=${alias}.project_id AND boundary.previous_environment_id=${alias}.environment_id)`;

/** Gateway receipts use the original role only inside an actually accepted whole-project deletion. */
export const deletionGatewayEnvironmentNameSql = (alias: string) =>
  `CASE WHEN ${archivedDevProofSql(alias)} AND EXISTS(SELECT 1 FROM projects deletion_project JOIN product_command_intents deletion_intent USING(organization_id,project_id) JOIN operations deletion_operation ON deletion_operation.organization_id=deletion_intent.organization_id AND deletion_operation.project_id=deletion_intent.project_id AND deletion_operation.operation_id=deletion_intent.operation_id WHERE deletion_project.organization_id=${alias}.organization_id AND deletion_project.project_id=${alias}.project_id AND deletion_project.owner_state='active' AND deletion_project.lifecycle_state='deleting' AND deletion_intent.event_type='ProjectDeletionRequestedV1' AND deletion_operation.state IN('queued','running')) THEN 'dev' ELSE ${alias}.name END`;

/** Full deletion retains actual historical IDs; only the immutable restoration boundary supplies the original Dev role. */
export function deletionEnvironmentRowsSql(historicalCondition = "1"): string {
  return `SELECT e.environment_id,
 CASE WHEN e.name IN('dev','prod') THEN e.name WHEN ${archivedDevProofSql("e")} THEN 'dev' ELSE NULL END name,
 e.name persisted_name,e.head_version,e.active_deployment_id,e.active_revision_id
 FROM environments e WHERE e.organization_id=?1 AND e.project_id=?2 AND(e.name IN('dev','prod') OR(${historicalCondition}))
 ORDER BY CASE WHEN e.name='prod' THEN 1 ELSE 0 END,e.environment_id`;
}

export function validDeletionEnvironmentSet(rows: readonly Record<string, unknown>[]): boolean {
  return (
    rows.length > 0 &&
    rows.filter((row) => row["name"] === "prod").length === 1 &&
    rows.at(-1)?.["name"] === "prod" &&
    rows.every((row) => row["name"] === "dev" || row["name"] === "prod") &&
    new Set(rows.map((row) => row["environment_id"])).size === rows.length
  );
}
