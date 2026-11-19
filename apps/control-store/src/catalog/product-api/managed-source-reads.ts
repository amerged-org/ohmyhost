import { z } from "zod";
import { readAcceptedApiProductOperation } from "./accepted-operation.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { iso, text, type Row } from "../provisioning/context-values.js";
import { readContextSnapshot } from "../provisioning/context-queries.js";
import {
  MANAGED_AUTH,
  MANAGED_OWNER,
  managedAuthorized,
  managedBindingOf,
  managedConflict,
  managedDelegationGuards,
  managedDelegationOf,
  managedPublicationInput,
  managedPublicationOf,
  managedScopeInput,
  managedWritable,
  managedWriteInput,
  readManagedSnapshot,
  type ManagedScope,
  type ManagedSnapshot,
} from "./managed-source-common.js";
const scope = (i: ManagedScope) => ({
  organizationId: i.organizationId,
  projectId: i.projectId,
  principalId: i.principalId,
});
export async function readApiManagedSourceProjectScope(context: CatalogContext, raw: unknown) {
  const i = managedScopeInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await readManagedSnapshot(db, i);
  if (!managedAuthorized(s, false)) managedConflict("scope");
  return s.owner?.["environment_id"] == null
    ? null
    : {
        environmentId: text(s.owner, "environment_id"),
        region: z.enum(["us", "eu"]).parse(s.owner["region"]),
      };
}
export async function readApiProjectSourceBinding(context: CatalogContext, raw: unknown) {
  const i = managedScopeInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await readManagedSnapshot(db, i);
  if (!managedAuthorized(s, false)) managedConflict("scope");
  return managedBindingOf(s.binding);
}
export async function readApiManagedSourcePublication(context: CatalogContext, raw: unknown) {
  const i = managedPublicationInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await readManagedSnapshot(db, scope(i), i.operationId);
  if (!managedAuthorized(s, false)) managedConflict("scope");
  return managedPublicationOf(s);
}
export const MANAGED_RECIPE = `SELECT recipe.* FROM managed_source_initializations recipe JOIN projects project USING(organization_id,project_id)
 WHERE recipe.organization_id=?1 AND recipe.project_id=?2 AND project.active_billing_epoch_id=recipe.billing_epoch_id AND project.owner_state='active' AND project.lifecycle_state='active' AND(?3 IS NULL OR recipe.parent_operation_id=?3)`;
export function managedInitializationOf(r: Row) {
  return {
    organizationId: text(r, "organization_id"),
    projectId: text(r, "project_id"),
    parentOperationId: text(r, "parent_operation_id"),
    sourceConnectionId: text(r, "source_connection_id"),
    initializationEventId: text(r, "initialization_event_id"),
    principalId: text(r, "principal_id"),
    template: z.enum(["vite-react", "empty"]).parse(r["template"]),
    region: z.enum(["us", "eu"]).parse(r["region"]),
    requestId: text(r, "request_id"),
    billingEpochId: text(r, "billing_epoch_id"),
    state: z.enum(["waiting", "queued", "initializing", "initialized", "failed"]).parse(r["state"]),
    childOperationId: r["child_operation_id"] === null ? null : text(r, "child_operation_id"),
    creationDelegation: managedDelegationOf(r, "projects:create"),
    errorCode: r["error_code"] === null ? null : text(r, "error_code"),
    createdAt: iso(r["created_at"]),
    updatedAt: iso(r["updated_at"]),
  };
}
export async function readApiManagedSourceInitialization(context: CatalogContext, raw: unknown) {
  const i = managedScopeInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    parameters = [i.organizationId, i.projectId];
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await readContextSnapshot(db, [
      { sql: MANAGED_AUTH, parameters: [...parameters, i.principalId] },
      { sql: MANAGED_OWNER, parameters },
      { sql: MANAGED_RECIPE, parameters: [...parameters, null] },
    ]);
    if (rows === null) continue;
    const s: ManagedSnapshot = {
      scope: i,
      auth: rows[0] ?? [],
      owner: rows[1]?.[0] ?? null,
      binding: null,
      publication: null,
      blobs: [],
      reservations: [],
      busy: false,
      revoked: false,
    };
    if (!managedAuthorized(s, false)) throw new Error("managed_source_initialization_scope");
    return rows[2]?.[0] === undefined ? null : managedInitializationOf(rows[2][0]);
  }
  throw new Error("Managed source initialization snapshot changed repeatedly");
}
/** Immediate current-source check before the provider's own Git CAS; it creates no lasting grant. */
export async function authorizeApiManagedSourcePublication(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = managedWriteInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await readManagedSnapshot(db, scope(i), i.operationId);
  managedWritable(s, i.now, "sealed");
  await managedDelegationGuards(db, s, managedDelegationOf(s.publication));
  const p = s.publication;
  if (p === null) managedConflict("scope");
  if (p["mode"] !== "commit" && s.busy) managedConflict("operation");
  const current = managedBindingOf(s.binding);
  if (
    (current?.sourceConnectionId ?? null) !== p["expected_source_connection_id"] ||
    (current?.generation ?? 0) !== p["expected_source_generation"]
  )
    managedConflict("generation");
  if (p["mode"] === "commit" && current?.commitSha !== p["expected_managed_commit"])
    managedConflict("commit");
}

export async function readApiManagedSourceOperation(context: CatalogContext, raw: unknown) {
  const i = managedPublicationInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    snapshot = await readManagedSnapshot(db, scope(i), i.operationId);
  if (!managedAuthorized(snapshot, false)) managedConflict("scope");
  if (snapshot.publication === null) throw new Error("source_scope_unavailable");
  const operation = await readAcceptedApiProductOperation(db, i.organizationId, i.operationId);
  if (operation === null) throw new Error("Accepted source operation is unavailable");
  return operation;
}
