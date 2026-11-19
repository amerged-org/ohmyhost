import { beforeEach, describe, expect, it } from "vitest";
import { CloudflareCustomerDnsConflictError } from "@ohmyhost/provider-cloudflare";
import type {
  MailDnsDeletionRequirements,
  MailDnsPersistence,
} from "../src/mail-dns-persistence.js";
import { createResendDns } from "../src/resend-dns.js";

const ids = {
  organization: "01H00000000000000000000601",
  project: "01H00000000000000000000603",
  environment: "01H00000000000000000000606",
  domain: "01H0000000000000000000060A",
  operation: "01H0000000000000000000060B",
};
const zone = { zoneId: "a".repeat(32), zoneName: "customer.example" };
const state = {
  row: null as Record<string, unknown> | null,
  authorized: true,
  records: [] as unknown[],
  saves: 0,
};
const persistence: MailDnsPersistence = {
  workspace: async () => {
    throw new Error("Mail setup never reads a workspace resource");
  },
  legacy: async () => state.row as Awaited<ReturnType<MailDnsPersistence["legacy"]>>,
  deletion: async () => {
    if (!state.authorized) throw new Error("Mail deletion unavailable");
    return {
      domain: String(state.row?.["domain"]),
      dns_receipts: state.row?.["dns_receipts"] as MailDnsDeletionRequirements["dns_receipts"],
    };
  },
  requirePaid: async () => undefined,
  saveWorkspace: async () => {
    throw new Error("Mail setup never saves a workspace receipt");
  },
  saveLegacy: async (_domainId, receipt) => {
    state.saves += 1;
    state.records = (receipt as { records: unknown[] }).records;
  },
};
const unusedDeletionAccess = async (): Promise<never> => {
  throw new Error("Mail setup never uses deletion access");
};
const scope = {
  organizationId: ids.organization,
  projectId: ids.project,
  environmentId: ids.environment,
  domainId: ids.domain,
};
beforeEach(() => {
  state.authorized = true;
  state.records = [];
  state.saves = 0;
  state.row = {
    domain_id: ids.domain,
    organization_id: ids.organization,
    project_id: ids.project,
    environment_id: ids.environment,
    domain: "mail.customer.example",
    provider_domain_id: "provider-domain",
    records: [
      {
        type: "TXT",
        name: "resend._domainkey.mail.customer.example",
        value: "p=test",
        purpose: "DKIM",
        status: "pending",
      },
      {
        type: "MX",
        name: "mail.customer.example",
        value: "inbound-smtp.us-east-1.amazonaws.com",
        purpose: "Receiving",
        status: "pending",
        priority: 10,
      },
    ],
    dns_receipts: {},
  };
});

describe("Resend DNS capability", () => {
  it("publishes only exact provider records after authorized Cloudflare access and stores receipts", async () => {
    const desired: unknown[] = [];
    const dns = {
      loadAccess: async () => ({ status: "ready", ...zone, accessToken: "dns-token" }),
      reconcileRecords: async (_token: string, input: { records: unknown[] }) => {
        desired.push(...input.records);
        return {
          status: "applied",
          records: input.records.map((record, index) => ({
            ...(record as object),
            id: String(index + 1).repeat(32),
          })),
        };
      },
      deleteRecords: async () => ({ status: "deleted", recordIds: [] }),
    };
    const service = createResendDns({
      persistence,
      clock: { now: () => new Date("2026-09-22T00:00:00.000Z") },
      dns: dns as never,
      deletionAccess: unusedDeletionAccess,
    });
    expect(await service.ensureMailRecords(scope)).toMatchObject({ status: "configured" });
    expect(desired).toMatchObject([
      {
        type: "TXT",
        name: "resend._domainkey.mail.customer.example",
        comment: `ohmyhost:${ids.project}:mail:v1`,
      },
      {
        type: "MX",
        name: "mail.customer.example",
        priority: 10,
        content: "inbound-smtp.us-east-1.amazonaws.com",
      },
    ]);
    expect(state.records).toHaveLength(2);
    expect(state.saves).toBe(1);
  });
  it("returns manual DNS actions and a real conflict without writing any receipt", async () => {
    let reconciled = 0;
    const dns = {
      loadAccess: async () => ({ status: "not_authorized" }),
      reconcileRecords: async () => {
        reconciled++;
        throw new CloudflareCustomerDnsConflictError();
      },
      deleteRecords: async () => ({ status: "deleted", recordIds: [] }),
    };
    const service = createResendDns({
      persistence,
      clock: { now: () => new Date() },
      dns: dns as never,
      deletionAccess: unusedDeletionAccess,
    });
    expect(await service.ensureMailRecords(scope)).toMatchObject({ status: "action_required" });
    dns.loadAccess = async () => ({ status: "ready", ...zone, accessToken: "dns-token" });
    expect(await service.ensureMailRecords(scope)).toMatchObject({ status: "conflict" });
    expect(reconciled).toBe(1);
    expect(state.records).toEqual([]);
  });
  it("deletes only the stored record identities for an authorized project deletion", async () => {
    const receipt = {
      type: "TXT",
      name: "resend._domainkey.mail.customer.example",
      content: "p=test",
      ttl: 300,
      proxied: false,
      comment: `ohmyhost:${ids.project}:mail:v1`,
      id: "a".repeat(32),
    };
    state.row = { ...state.row, dns_receipts: { ...zone, records: [receipt] } };
    const deleted: unknown[] = [];
    const dns = {
      loadAccess: async () => {
        throw new Error("Deletion never uses ordinary DNS access");
      },
      deleteRecords: async (_token: string, input: unknown) => {
        deleted.push(input);
        return { status: "deleted", recordIds: [receipt.id] };
      },
      reconcileRecords: async () => ({}),
    };
    let deletionZone = zone;
    const opened: unknown[] = [];
    const service = createResendDns({
      persistence,
      clock: { now: () => new Date() },
      dns: dns as never,
      deletionAccess: async (deletionScope) => {
        opened.push(deletionScope);
        return { ...deletionZone, accessToken: "dns-token" };
      },
    });
    expect(await service.deleteMailRecords({ ...scope, operationId: ids.operation })).toMatchObject(
      { recordIds: [receipt.id] },
    );
    expect(deleted).toEqual([{ ...zone, records: [receipt] }]);
    expect(opened).toEqual([
      { organizationId: ids.organization, projectId: ids.project, operationId: ids.operation },
    ]);
    // Access to any zone other than the stored receipt's never deletes anything.
    deletionZone = { ...zone, zoneId: "b".repeat(32) };
    await expect(
      service.deleteMailRecords({ ...scope, operationId: ids.operation }),
    ).rejects.toThrow("requires original zone access");
    expect(deleted).toHaveLength(1);
    state.authorized = false;
    await expect(
      service.deleteMailRecords({ ...scope, operationId: ids.operation }),
    ).rejects.toThrow("Mail deletion unavailable");
    expect(deleted).toHaveLength(1);
  });
});
