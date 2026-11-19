import {
  createLegacyProductionCloudflareDomainManagementEntrypoint,
  createCloudflareDomainManagementService,
} from "./worker-main.js";
import type { CloudflareDomainManagementBaseBindings } from "./bindings.js";
import { createLegacyProductionCloudflareRuntime } from "./d1-runtime.js";
import { createLegacyProductionD1MailComponents } from "./d1-mail-components.js";

// This closed source composition is only the bounded existing Production keyring release.
const entrypoint = createLegacyProductionCloudflareDomainManagementEntrypoint({
  runtimeFactory: (bindings) =>
    createLegacyProductionCloudflareRuntime(bindings, createLegacyProductionD1MailComponents),
});
export const CloudflareDomainManagementService =
  createCloudflareDomainManagementService<CloudflareDomainManagementBaseBindings>(entrypoint);
export default { fetch: () => entrypoint.fetch() };
