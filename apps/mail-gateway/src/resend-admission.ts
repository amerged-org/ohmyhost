import {
  syncWorkspaceMailCapabilities,
  type WorkspaceMailCapabilityPersistence,
} from "@ohmyhost/database";
import type { ReceivingAdmissionPersistence } from "./receiving-admission-persistence.js";
import { parseUlid, type UlidFactory } from "@ohmyhost/platform";
import { createResendProvider } from "@ohmyhost/provider-resend";
/** Reuse the existing Paid, budget and seven-day grace policy; provider changes are idempotent. */
export async function syncResendReceivingAdmission(input: {
  persistence: ReceivingAdmissionPersistence;
  capabilities: WorkspaceMailCapabilityPersistence;
  apiKey: string;
  ids: UlidFactory;
  now: () => Date;
  fetch?: typeof globalThis.fetch;
}) {
  const persistence = input.persistence;
  const rows = await persistence.list();
  const provider = createResendProvider({
    apiKey: input.apiKey,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  let suspended = 0,
    resumed = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const now = input.now().toISOString();
      const admission = await persistence.admit(() => ({
        organizationId: parseUlid(row.organization_id),
        projectId: parseUlid(row.project_id),
        environmentId: parseUlid(row.environment_id),
        grantId: input.ids.next(),
        now,
      }));
      const denied = !admission.allowed || !admission.paidAllowed;
      if (denied) {
        // Stop local new-message admission before the external disable operation.
        await persistence.change({ domainId: row.domain_id, phase: "disable" });
        await persistence.change({ domainId: row.domain_id, phase: "suspend" });
        await syncWorkspaceMailCapabilities({
          persistence: input.capabilities,
          provider,
          organizationId: row.organization_id,
          domainId: row.domain_id,
          leaseToken: input.ids.next(),
          now: input.now,
        });
        if (!row.receiving_suspended) suspended++;
      } else if (row.receiving_suspended || row.receiving_status === "disabled") {
        // Admission remains disabled until the provider readback below confirms receiving DNS.
        await persistence.change({ domainId: row.domain_id, phase: "resume" });
        await syncWorkspaceMailCapabilities({
          persistence: input.capabilities,
          provider,
          organizationId: row.organization_id,
          domainId: row.domain_id,
          leaseToken: input.ids.next(),
          now: input.now,
        });
        const domain = await provider.getDomain(row.provider_domain_id);
        if (domain.domain !== row.domain) throw new Error("Mail domain mismatch");
        const records = domain.records.filter((r) =>
          r.purpose.toLowerCase().startsWith("receiving"),
        );
        const ready =
          domain.receiving && records.length > 0 && records.every((r) => r.status === "verified");
        await persistence.change({
          domainId: row.domain_id,
          phase: "observed",
          ready,
          now: input.now().toISOString(),
        });
        resumed++;
      }
      await persistence.change({ domainId: row.domain_id, phase: "checked", now });
    } catch {
      failed++;
    }
  }
  return { checked: rows.length, suspended, resumed, failed };
}
