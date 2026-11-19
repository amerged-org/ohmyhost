import { createHash } from "node:crypto";
import { parseUlid } from "@ohmyhost/platform";
import { mailWebhookSecret } from "@ohmyhost/provider-resend";
import { createD1MailManagementSession } from "./d1-management-session.js";
import { reconcilePendingResendDomains } from "./resend-runtime.js";
import { reconcileWorkspaceMailDomains } from "./workspace-mail-reconciliation.js";
import { expireUnverifiedWorkspaceMailDomains } from "./workspace-mail-expiry.js";

export type MailManagementOperation =
  | "configure"
  | "get"
  | "prepareWebhook"
  | "verifyWebhook"
  | "rotateWebhook"
  | "disableReceiving"
  | "retire"
  | "ensure"
  | "ensure_pending";
type Session = Awaited<ReturnType<typeof createD1MailManagementSession>>;

/** The actual manager command path, with the original command digest, replay and provider ordering. */
export async function invokeD1ResendManagement(
  env: unknown,
  operation: MailManagementOperation,
  raw: unknown,
  supplied?: Session,
) {
  if (typeof raw !== "object" || raw === null) throw new TypeError("Invalid mail request");
  const r = raw as Record<string, unknown>,
    scope = {
      organizationId: parseUlid(String(r["organizationId"])),
      projectId: parseUlid(String(r["projectId"])),
      environmentId: parseUlid(String(r["environmentId"])),
    },
    session = supplied ?? (await createD1MailManagementSession(env)),
    { commands, resources, legacy: runtime, workspace, clock } = session;
  if (operation !== "get" && operation !== "ensure" && operation !== "ensure_pending") {
    const idempotencyKey = r["idempotencyKey"];
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey))
      throw new TypeError("Invalid mail idempotency key");
    const digest = createHash("sha256")
        .update(
          JSON.stringify({
            operation,
            principalId: r["principalId"],
            domain: r["domain"],
            sending: r["sending"],
            receiving: r["receiving"],
            url: r["url"],
          }),
        )
        .digest(),
      command = await commands.begin(scope, idempotencyKey, digest, () =>
        clock.now().toISOString(),
      );
    if (
      !command.created &&
      !command.response &&
      !(await commands.resume(scope, idempotencyKey, () => clock.now().toISOString()))
    )
      throw new Error("mail_operation_pending");
    if (!command.created && command.response) {
      if (operation === "configure") return runtime.reconcile(scope);
      if (operation === "prepareWebhook") {
        const domain = await resources.read(scope, true);
        if (!domain) throw new Error("mail_domain_required");
        if (domain.webhook_url !== (command.response as Record<string, unknown>)["url"])
          throw new Error("mail_webhook_changed");
        return {
          ...(command.response as Record<string, unknown>),
          signing_secret: mailWebhookSecret(
            (env as Record<string, unknown>)["MAIL_WEBHOOK_SIGNING_KEY"] as string,
            domain.domain_id,
            domain.webhook_secret_generation,
          ),
        };
      }
      if (operation === "rotateWebhook") {
        const domain = await resources.read(scope, true);
        if (!domain) throw new Error("mail_scope_unavailable");
        return {
          ...(command.response as Record<string, unknown>),
          signing_secret: mailWebhookSecret(
            (env as Record<string, unknown>)["MAIL_WEBHOOK_SIGNING_KEY"] as string,
            domain.domain_id,
            domain.webhook_secret_generation,
          ),
        };
      }
      return command.response;
    }
    const result = await execute(),
      safe = { ...(result as Record<string, unknown>) };
    delete safe["signing_secret"];
    await commands.complete(scope, idempotencyKey, safe, () => clock.now().toISOString());
    return result;
  }
  return execute();

  async function execute() {
    if (operation === "ensure_pending") return runtime.reconcile(scope);
    if (operation === "ensure") {
      await session.authorizeParent({
        ...scope,
        operationId: parseUlid(String(r["operationId"])),
        acceptedLifecycleVersion: Number(r["acceptedLifecycleVersion"]),
      });
      const row = await resources.read({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
      });
      if (!row || (!row.sending && !row.receiving)) throw new Error("mail_domain_required");
      const mailScope = { ...scope, environmentId: parseUlid(row.environment_id) };
      if (row.receiving)
        await resources.receivingAdmission(mailScope, () => clock.now().toISOString());
      const workspaceScope = { organizationId: scope.organizationId, domainId: row.domain_id },
        domain =
          row.provider_domain_id && row.sending_status === "ready" && row.sending_key_id
            ? await workspace.sync(workspaceScope)
            : await workspace.ensure(workspaceScope),
        observed = await resources.read(mailScope);
      return (row.sending && domain?.sending === "ready") ||
        (row.receiving && domain?.receiving === "ready")
        ? {
            status: "ready",
            receipt: {
              provider: "resend",
              ...scope,
              domain: row.domain,
              domainId: row.domain_id,
              providerDomainId: observed?.provider_domain_id,
            },
          }
        : { status: "verification_pending" };
    }
    if (operation === "get") return runtime.get(scope);
    if (operation === "prepareWebhook") {
      if (typeof r["url"] !== "string") throw new TypeError("Invalid mail webhook");
      return runtime.prepareWebhook({ ...scope, url: r["url"] });
    }
    if (operation === "verifyWebhook") return runtime.verifyWebhook(scope);
    if (operation === "rotateWebhook") return runtime.rotateWebhook(scope);
    if (operation === "disableReceiving") return runtime.disableReceiving(scope);
    if (operation === "retire")
      return runtime.retire({ ...scope, idempotencyKey: String(r["idempotencyKey"]) });
    if (
      typeof r["domain"] !== "string" ||
      r["sending"] !== true ||
      typeof r["receiving"] !== "boolean" ||
      typeof r["idempotencyKey"] !== "string" ||
      typeof r["principalId"] !== "string"
    )
      throw new TypeError("Invalid domain configuration");
    return runtime.configure({
      ...scope,
      domain: r["domain"],
      sending: r["sending"],
      receiving: r["receiving"],
      idempotencyKey: r["idempotencyKey"],
      principalId: r["principalId"],
    });
  }
}

export async function invokeD1WorkspaceMailManagement(
  env: unknown,
  operation: "ensure" | "sync" | "retire",
  raw: unknown,
) {
  if (typeof raw !== "object" || raw === null) throw new TypeError("Invalid mail request");
  const value = raw as Record<string, unknown>,
    organizationId = parseUlid(String(value["organizationId"])),
    domainId = parseUlid(String(value["domainId"])),
    digest = value["canonicalRequestDigest"],
    idempotencyKey = value["idempotencyKey"],
    principalId = value["principalId"],
    commandOperation = value["commandOperation"];
  if (
    !(digest instanceof Uint8Array) ||
    digest.length !== 32 ||
    typeof idempotencyKey !== "string" ||
    typeof principalId !== "string" ||
    (operation === "ensure"
      ? commandOperation !== "create"
      : operation === "retire"
        ? commandOperation !== "retire"
        : commandOperation !== "bind" && commandOperation !== "detach")
  )
    throw new TypeError("Invalid mail request");
  const { commands, workspace, clock } = await createD1MailManagementSession(env),
    receipt = await commands.readWorkspace({
      organizationId,
      domainId,
      idempotencyKey,
      principalId,
      operation: String(commandOperation),
      requestSha256: digest,
    });
  if (operation === "retire") {
    if (receipt) return receipt;
    if (
      !(await commands.claimWorkspaceRetirement(organizationId, idempotencyKey, () =>
        clock.now().toISOString(),
      ))
    )
      throw new Error("mail_operation_pending");
  }
  const scope = { organizationId, domainId };
  if (operation === "ensure") return workspace.ensure(scope);
  if (operation === "sync") return workspace.sync(scope);
  const expectedRevision = value["expectedRevision"];
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
    throw new TypeError("Invalid mail request");
  return workspace.retire({ ...scope, expectedRevision: Number(expectedRevision) });
}

export async function reconcileD1MailManagement(env: unknown) {
  const session = await createD1MailManagementSession(env),
    result = await reconcilePendingResendDomains(
      session.jobs,
      (scope) => invokeD1ResendManagement(env, "ensure_pending", scope, session),
      () => session.clock.now(),
    ),
    shared = await reconcileWorkspaceMailDomains({
      persistence: session.jobs,
      now: () => session.clock.now(),
      ensure: (scope) => session.workspace.ensure(scope),
      sync: (scope) => session.workspace.sync(scope),
      revalidateApplicationDomainIdentity: (scope) =>
        session.revalidateApplicationDomainIdentity(scope),
    });
  console.info("resend_mail_domain_reconciliation", result);
  console.info("workspace_mail_domain_reconciliation", shared);
  // An unverified reservation that held its name for seven days is retired through the provider path, freeing the name.
  const expired = await expireUnverifiedWorkspaceMailDomains({
    persistence: session.jobs,
    now: () => session.clock.now(),
    retire: (scope) => session.workspace.retire(scope),
  });
  console.info("workspace_mail_unverified_expiry", expired);
  try {
    console.info("scoped_dns_revoked_grant_sweep", await session.sweepRevokedGrants());
  } catch {
    console.error("scoped_dns_revoked_grant_sweep_unavailable");
  }
}
