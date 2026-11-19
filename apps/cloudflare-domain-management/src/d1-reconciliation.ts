import type { CloudflareDomainReconciliationPersistence } from "./reconciliation.js";
import { decodeGeneralCloudflareGrant } from "./d1-general-dns.js";
export interface CloudflareReconciliationRuntimeBinding {
  readReconciliation(
    input: Parameters<CloudflareDomainReconciliationPersistence["read"]>[0],
  ): ReturnType<CloudflareDomainReconciliationPersistence["read"]>;
  rotateGrant(
    input: Parameters<CloudflareDomainReconciliationPersistence["rotateGrant"]>[0],
  ): Promise<unknown>;
}
export function createD1CloudflareDomainReconciliationPersistence(
  binding: CloudflareReconciliationRuntimeBinding,
): CloudflareDomainReconciliationPersistence {
  return Object.freeze<CloudflareDomainReconciliationPersistence>({
    read: (input) => binding.readReconciliation(input),
    rotateGrant: async (input) => decodeGeneralCloudflareGrant(await binding.rotateGrant(input)),
  });
}
