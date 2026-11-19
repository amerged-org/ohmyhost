import { WorkerEntrypoint } from "cloudflare:workers";
import {
  invokeD1ResendManagement,
  invokeD1WorkspaceMailManagement,
  reconcileD1MailManagement,
} from "./d1-management-dispatch.js";
import {
  createD1MailManagementSession,
  type MailManagementDnsBinding,
} from "./d1-management-session.js";

/**
 * The historical `ses-management` Worker name stays, but it manages only Resend: it holds no AWS
 * credential and never calls SES or Route 53. Every Control read and write goes through the
 * private Core service bindings.
 */
interface ResendMailBindings {
  RUNTIME_CONFIGURATION_STATE: "configured";
  RESEND_API_KEY: string;
  MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: string;
  MAIL_WEBHOOK_SIGNING_KEY: string;
  CLOUDFLARE_DOMAIN_MANAGEMENT: MailManagementDnsBinding;
  readonly MAIL_MANAGEMENT_RUNTIME: unknown;
  readonly MAIL_WORKSPACE_RUNTIME: unknown;
  readonly MAIL_CAPABILITY_RUNTIME: unknown;
  readonly MAIL_DELETION_RUNTIME: unknown;
  readonly MAIL_COMMAND_RUNTIME: unknown;
  readonly MAIL_MANAGEMENT_JOB_RUNTIME: unknown;
  readonly PRODUCT_PROVIDER_AUTHORIZATION_RUNTIME: unknown;
}
export class ResendMailManagementService extends WorkerEntrypoint<ResendMailBindings> {
  public ensureWorkspaceMailDomain(input: unknown) {
    return invokeD1WorkspaceMailManagement(this.env, "ensure", input);
  }
  public syncWorkspaceMailDomain(input: unknown) {
    return invokeD1WorkspaceMailManagement(this.env, "sync", input);
  }
  public retireWorkspaceMailDomain(input: unknown) {
    return invokeD1WorkspaceMailManagement(this.env, "retire", input);
  }
  public async deleteMailProject(raw: unknown) {
    return (await createD1MailManagementSession(this.env)).deleteProject(raw);
  }
  public configureMailDomain(input: unknown) {
    return invokeD1ResendManagement(this.env, "configure", input);
  }
  public readMailDomain(input: unknown) {
    return invokeD1ResendManagement(this.env, "get", input);
  }
  public prepareMailWebhook(input: unknown) {
    return invokeD1ResendManagement(this.env, "prepareWebhook", input);
  }
  public verifyMailWebhook(input: unknown) {
    return invokeD1ResendManagement(this.env, "verifyWebhook", input);
  }
  public rotateMailWebhook(input: unknown) {
    return invokeD1ResendManagement(this.env, "rotateWebhook", input);
  }
  public disableMailReceiving(input: unknown) {
    return invokeD1ResendManagement(this.env, "disableReceiving", input);
  }
  public deleteMailDomain(input: unknown) {
    return invokeD1ResendManagement(this.env, "retire", input);
  }
  public ensureMailDomain(input: unknown) {
    return invokeD1ResendManagement(this.env, "ensure", input);
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
  scheduled(_controller: unknown, env: ResendMailBindings) {
    return reconcileD1MailManagement(env);
  },
};
