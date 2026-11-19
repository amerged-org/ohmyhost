import type { Ulid } from "@ohmyhost/platform";
import type { CloudflareCustomerDnsRecord } from "@ohmyhost/provider-cloudflare";

interface MailScope {
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
}
interface MailDnsRequirements {
  domain: string;
  custody_project_id: string;
  records: unknown[];
}
export interface MailDnsDeletionRequirements {
  domain: string;
  dns_receipts: {
    zoneId?: string;
    zoneName?: string;
    records?: CloudflareCustomerDnsRecord[];
  };
}
interface LegacyMailDnsDomain {
  domain_id: string;
  provider_domain_id: string | null;
  domain: string;
  records: unknown[];
  project_id: string;
}
export interface MailDnsPersistence {
  workspace(input: { organizationId: string; mailDomainId: string }): Promise<MailDnsRequirements>;
  legacy(input: MailScope): Promise<LegacyMailDnsDomain | null>;
  deletion(input: {
    organizationId: string;
    projectId: string;
    operationId: string;
    domainId: string;
  }): Promise<MailDnsDeletionRequirements>;
  requirePaid(organizationId: string, now: () => string): Promise<void>;
  saveWorkspace(
    input: { organizationId: string; mailDomainId: string },
    receipt: unknown,
  ): Promise<void>;
  saveLegacy(domainId: string, receipt: unknown): Promise<void>;
}
