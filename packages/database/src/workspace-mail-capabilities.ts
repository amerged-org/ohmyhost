export interface WorkspaceMailCapabilityScope {
  organizationId: string;
  domainId: string;
  now: () => Date;
}
export interface WorkspaceMailDesiredCapabilities {
  provider_domain_id: string | null;
  sending: boolean;
  receiving: boolean;
}
/** Local persistence port only. Clock suppliers are evaluated by each adapter; none crosses RPC. */
export interface WorkspaceMailCapabilityPersistence {
  claim(input: WorkspaceMailCapabilityScope & { leaseToken: string }): Promise<boolean>;
  read(input: WorkspaceMailCapabilityScope): Promise<WorkspaceMailDesiredCapabilities | null>;
  confirm(
    input: WorkspaceMailCapabilityScope & {
      leaseToken: string;
      desired: WorkspaceMailDesiredCapabilities;
    },
  ): Promise<boolean>;
  release(input: { organizationId: string; domainId: string; leaseToken: string }): Promise<void>;
}

/** One provider-domain capability writer across original owners, consumers and lifecycle jobs. */
export async function syncWorkspaceMailCapabilities(input: {
  persistence: WorkspaceMailCapabilityPersistence;
  provider: {
    updateDomain(
      id: string,
      capabilities: { sending: boolean; receiving: boolean },
    ): Promise<unknown>;
  };
  organizationId: string;
  domainId: string;
  leaseToken: string;
  now: () => Date;
}) {
  const { persistence } = input;
  if (!(await persistence.claim(input))) throw new Error("mail_operation_pending");
  let settled = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const desired = await persistence.read(input);
      if (!desired?.provider_domain_id) {
        settled = true;
        return null;
      }
      await input.provider.updateDomain(desired.provider_domain_id, {
        // Resend requires one enabled capability; no authorized sender is still zero send access.
        sending: desired.sending || !desired.receiving,
        receiving: desired.receiving,
      });
      if (await persistence.confirm({ ...input, desired })) {
        settled = true;
        return desired;
      }
    }
    throw new Error("mail_operation_pending");
  } finally {
    if (settled) await persistence.release(input);
  }
}
