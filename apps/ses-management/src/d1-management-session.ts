import { createD1WorkspaceMailCapabilityPersistence } from "@ohmyhost/database";
import { createUlidFactory, SystemClock, SystemEntropy } from "@ohmyhost/platform";
import { createD1ResendManagementPersistence } from "./d1-resend-persistence.js";
import { createD1WorkspaceMailManagementPersistence } from "./d1-workspace-persistence.js";
import { createD1MailProjectDeletionPersistence } from "./d1-deletion-persistence.js";
import { createD1MailManagementCommandPersistence } from "./d1-command-persistence.js";
import { createD1MailManagementJobPersistence } from "./d1-job-persistence.js";
import { createResendMailManagement } from "./resend-runtime.js";
import { createWorkspaceMailManagement } from "./workspace-mail-runtime.js";
import { deleteResendMailProject } from "./resend-deletion.js";

export interface MailManagementDnsBinding {
  ensureMailRecords(input: unknown): Promise<unknown>;
  deleteMailRecords(input: unknown): Promise<unknown>;
  ensureWorkspaceMailRecords(input: unknown): Promise<unknown>;
  retireWorkspaceMailRecords(input: unknown): Promise<unknown>;
  revalidateApplicationDomainIdentity(input: {
    organizationId: string;
    projectId: string;
    expectedRevision: number;
  }): Promise<unknown>;
  sweepRevokedGrants(input: Record<string, never>): Promise<unknown>;
}
interface ParentAuthorizationBinding {
  authorizeProductProviderMutation(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    operationId: string;
    acceptedLifecycleVersion: number;
  }): Promise<unknown>;
}
const METHODS = [
  "ensureMailRecords",
  "deleteMailRecords",
  "ensureWorkspaceMailRecords",
  "retireWorkspaceMailRecords",
  "revalidateApplicationDomainIdentity",
  "sweepRevokedGrants",
];
/** Actual D1 manager composition; every capability probes its existing narrow read before credentials/provider construction. */
export async function createD1MailManagementSession(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TypeError("Invalid Mail management configuration");
  const env = raw as Record<string, unknown>;
  if (env["RUNTIME_CONFIGURATION_STATE"] !== "configured")
    throw new Error("Mail management configuration unavailable");
  const dns = env["CLOUDFLARE_DOMAIN_MANAGEMENT"],
    authorization = env["PRODUCT_PROVIDER_AUTHORIZATION_RUNTIME"];
  if (
    !dns ||
    typeof dns !== "object" ||
    METHODS.some((method) => typeof Reflect.get(dns, method) !== "function") ||
    !authorization ||
    typeof authorization !== "object" ||
    typeof Reflect.get(authorization, "authorizeProductProviderMutation") !== "function"
  )
    throw new Error("Mail management dependency binding required");
  // Each resource/command adapter proves its existing real read before credentials or a provider are constructed.
  const [resources, workspaces, deletion, commands, capabilities, jobs] = await Promise.all([
    createD1ResendManagementPersistence(env["MAIL_MANAGEMENT_RUNTIME"]),
    createD1WorkspaceMailManagementPersistence(env["MAIL_WORKSPACE_RUNTIME"]),
    createD1MailProjectDeletionPersistence(env["MAIL_DELETION_RUNTIME"]),
    createD1MailManagementCommandPersistence(env["MAIL_COMMAND_RUNTIME"]),
    createD1WorkspaceMailCapabilityPersistence(env["MAIL_CAPABILITY_RUNTIME"]),
    createD1MailManagementJobPersistence(env["MAIL_MANAGEMENT_JOB_RUNTIME"]),
  ]);
  const apiKey = env["RESEND_API_KEY"],
    signingKey = env["MAIL_WEBHOOK_SIGNING_KEY"],
    cipherKey = env["MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64"];
  if (typeof apiKey !== "string" || typeof signingKey !== "string" || typeof cipherKey !== "string")
    throw new Error("Mail management configuration unavailable");
  const clock = new SystemClock(),
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() }),
    target = dns as unknown as MailManagementDnsBinding,
    legacy = createResendMailManagement({
      persistence: resources,
      capabilityPersistence: capabilities,
      apiKey,
      signingKey,
      sendingKeyEncryptionKey: cipherKey,
      ids,
      now: () => clock.now(),
      dns: target,
    }),
    workspace = createWorkspaceMailManagement({
      persistence: workspaces,
      capabilityPersistence: capabilities,
      apiKey,
      sendingKeyEncryptionKey: cipherKey,
      ids,
      now: () => clock.now(),
      dns: target,
      legacy,
    });
  return Object.freeze({
    clock,
    ids,
    commands,
    resources,
    jobs,
    legacy,
    workspace,
    async authorizeParent(
      input: Parameters<ParentAuthorizationBinding["authorizeProductProviderMutation"]>[0],
    ) {
      const result = await (
        authorization as unknown as ParentAuthorizationBinding
      ).authorizeProductProviderMutation(input);
      if (result !== undefined) throw new Error("Mail parent authorization response invalid");
    },
    deleteProject: (input: unknown) =>
      deleteResendMailProject(
        {
          persistence: deletion,
          capabilityPersistence: capabilities,
          apiKey,
          dns: target,
          now: () => clock.now(),
        },
        input,
      ),
    revalidateApplicationDomainIdentity: (
      input: Parameters<MailManagementDnsBinding["revalidateApplicationDomainIdentity"]>[0],
    ) => target.revalidateApplicationDomainIdentity(input),
    sweepRevokedGrants: () => target.sweepRevokedGrants({}),
  });
}
