import { z } from "zod";
import { classifyCustomerMailDomain } from "@ohmyhost/platform";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { mailInput, mailScope } from "./auth.js";
import { readMailDomainProjection } from "./management.js";
import { mailMetadataJsonb } from "./metadata-jsonb.js";
import { unknownOutcome } from "../unknown-outcome.js";

const workspaceScope = z.strictObject({ organizationId: ulid, mailDomainId: ulid }),
  NOW = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
export async function readCfWorkspaceMailDnsRequirements(context: CatalogContext, raw: unknown) {
  const input = mailInput(workspaceScope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(
        `SELECT w.domain,w.custody_project_id,COALESCE(d.records,w.records) records FROM workspace_mail_domains w LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id
 WHERE w.organization_id=?1 AND w.domain_id=?2 AND w.status='active' AND COALESCE(d.provider_domain_id,w.provider_domain_id) IS NOT NULL
 AND(w.capabilities_lease_until>${NOW} OR EXISTS(SELECT 1 FROM workspace_mail_commands command WHERE command.organization_id=w.organization_id AND command.domain_id=w.domain_id AND command.response IS NULL AND command.lease_until>${NOW}))`,
      )
      .bind(input.organizationId, input.mailDomainId)
      .first();
  if (!row) throw new Error("Workspace mail DNS resource is unavailable");
  classifyCustomerMailDomain(String(row["domain"]));
  return row;
}
export async function readCfLegacyMailDnsRequirements(context: CatalogContext, raw: unknown) {
  const input = mailInput(mailScope, raw),
    row = await readMailDomainProjection(context, input);
  if (row !== null) classifyCustomerMailDomain(String(row["domain"]));
  return row === null
    ? null
    : {
        domain_id: row["domain_id"],
        provider_domain_id: row["provider_domain_id"],
        domain: row["domain"],
        records: row["records"],
        project_id: row["project_id"],
      };
}
export async function readCfMailDnsDeletionRequirements(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      z.strictObject({ organizationId: ulid, projectId: ulid, operationId: ulid, domainId: ulid }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(
        "SELECT d.domain,d.dns_receipts FROM resend_mail_domains d JOIN projects p ON p.project_id=d.project_id AND p.lifecycle_state='deleting' JOIN product_command_intents i ON i.organization_id=d.organization_id AND i.project_id=d.project_id AND i.operation_id=?3 AND i.event_type='ProjectDeletionRequestedV1' JOIN operations o ON o.organization_id=i.organization_id AND o.operation_id=i.operation_id AND o.state IN('queued','running') WHERE d.organization_id=?1 AND d.project_id=?2 AND d.domain_id=?4",
      )
      .bind(input.organizationId, input.projectId, input.operationId, input.domainId)
      .first();
  if (!row) throw new Error("Mail deletion unavailable");
  return row;
}
const receipt = z
  .record(z.string(), z.unknown())
  .refine(
    (value) =>
      !["accessToken", "refreshToken", "access_token", "refresh_token"].some((key) =>
        Object.hasOwn(value, key),
      ),
  );
export async function saveCfWorkspaceMailDnsReceipt(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(workspaceScope.extend({ receipt }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    text = mailMetadataJsonb(input.receipt);
  await runCommand(db, {
    name: "cf.saveWorkspaceMailDnsReceipt",
    input,
    lookup: unknownOutcome("cf.saveWorkspaceMailDnsReceipt"),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE workspace_mail_domains SET dns_receipts=?3 WHERE organization_id=?1 AND domain_id=?2 AND status='active'",
          )
          .bind(input.organizationId, input.mailDomainId, text),
      ],
      result: () => undefined,
    }),
  });
}
export async function saveCfLegacyMailDnsReceipt(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(z.strictObject({ domainId: ulid, receipt }), raw);
  await context.router.assertLayout();
  const owner = await context.directory
    .prepare("SELECT organization_id FROM resend_mail_domains WHERE domain_id=?")
    .bind(input.domainId)
    .first<{ organization_id: string }>();
  if (!owner) return;
  const { db } = await routeOrganization(context, owner.organization_id),
    text = mailMetadataJsonb(input.receipt);
  await runCommand(db, {
    name: "cf.saveLegacyMailDnsReceipt",
    input,
    lookup: unknownOutcome("cf.saveLegacyMailDnsReceipt"),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE resend_mail_domains SET dns_receipts=?2 WHERE domain_id=?1 AND deleted_at IS NULL",
          )
          .bind(input.domainId, text),
      ],
      result: () => undefined,
    }),
  });
}
