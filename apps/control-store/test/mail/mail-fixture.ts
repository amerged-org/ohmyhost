import { createHash } from "node:crypto";
import { parseUlid, createEnvironmentSecretCipher } from "@ohmyhost/platform";
import { fundOrganization, publishMailPricing } from "../support/mail-events-fixture.js";
import type { TestControl } from "../support/control-d1.js";
import { coreRouter } from "../support/control-d1.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { ensureMailSecret } from "../../src/catalog/runtime-secrets/platform.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
export const MAIL_FIXTURE_CIPHER = Buffer.alloc(32, 0x63).toString("base64");
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const ISO = /^\d{4}-\d{2}-\d{2}T.*Z$/u;
const bindable = (value: unknown) =>
  typeof value === "boolean"
    ? Number(value)
    : value instanceof Date
      ? storedTimestamp(value.toISOString())
      : typeof value === "string" && ISO.test(value)
        ? storedTimestamp(value)
        : typeof value === "object" && value !== null && !(value instanceof Uint8Array)
          ? JSON.stringify(value)
          : value;

/**
 * One real mail project in the Core: a native-custody (`legacy = false`) or original project-owned (`legacy = true`)
 * Resend domain with a really sealed sending key, its project binding and the sealed `OHMYHOST_MAIL_KEY` secret.
 * Every row is written through the real schema; the Core triggers stay enabled.
 */
export async function mailFixture(control: TestControl, legacy = true, frameworkPlan?: unknown) {
  const fixture = await gatewayFixture(
    control,
    frameworkPlan === undefined ? {} : { frameworkPlan },
  );
  const scope = {
      organizationId: parseUlid(fixture.scope.organizationId),
      projectId: parseUlid(fixture.scope.projectId),
      environmentId: parseUlid(fixture.scope.environmentId),
    },
    now = new Date().toISOString(),
    domainId = newUlid(),
    domain = `mail-${domainId.slice(-10).toLowerCase()}.example.com`,
    key = `${newUlid()}${newUlid()}`.slice(0, 43),
    providerKey = `re_fixture_${newUlid()}`;
  if (!legacy)
    await control.core
      .prepare(
        "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'synthetic-mail-fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1,cohort_revision=excluded.cohort_revision,activated_at=excluded.activated_at",
      )
      .bind(storedTimestamp(now))
      .run();
  const cipher = createEnvironmentSecretCipher({
      keyBase64: MAIL_FIXTURE_CIPHER,
      keyVersion: 1,
      crypto: globalThis.crypto,
    }),
    sealed = await cipher.encrypt({ ...scope, name: "RESEND_DOMAIN_SEND_KEY", value: providerKey });
  /** The legacy domain mirrors itself into the workspace row and the project binding; those inserts then keep the mirror. */
  const insert = async (table: string, row: Record<string, unknown>) => {
    const names = Object.keys(row),
      mirrored =
        legacy && ["workspace_mail_domains", "project_mail_domain_bindings"].includes(table);
    await control.core
      .prepare(
        `INSERT INTO ${table}(${names.join(",")})VALUES(${names.map(() => "?").join(",")})${mirrored ? " ON CONFLICT DO NOTHING" : ""}`,
      )
      .bind(...Object.values(row).map(bindable))
      .run();
  };
  if (legacy)
    await insert("resend_mail_domains", {
      ...{
        organization_id: scope.organizationId,
        project_id: scope.projectId,
        environment_id: scope.environmentId,
      },
      domain_id: domainId,
      domain,
      provider_domain_id: `provider_${domainId}`,
      sending_key_id: `key_${domainId}`,
      sending_key_ciphertext: sealed.ciphertext,
      sending_key_nonce: sealed.nonce,
      sending_key_sha256: sealed.valueSha256,
      sending_key_version: sealed.keyVersion,
      sending: true,
      receiving: true,
      receiving_suspended: false,
      sending_status: "ready",
      receiving_status: "ready",
      webhook_url: "https://receiver.example.com/mail",
      webhook_verified_at: now,
      configured_at: now,
    });
  await insert("workspace_mail_domains", {
    domain_id: domainId,
    organization_id: scope.organizationId,
    domain,
    registrable_domain: "example.com",
    legacy_domain_id: legacy ? domainId : null,
    custody_organization_id: scope.organizationId,
    custody_project_id: scope.projectId,
    custody_environment_id: scope.environmentId,
    status: "active",
    sending_status: "ready",
    configured_at: now,
    ...(legacy
      ? {}
      : {
          provider_domain_id: `provider_${domainId}`,
          sending_key_id: `key_${domainId}`,
          sending_key_ciphertext: sealed.ciphertext,
          sending_key_nonce: sealed.nonce,
          sending_key_sha256: sealed.valueSha256,
          sending_key_version: sealed.keyVersion,
        }),
  });
  if (!legacy)
    await insert("project_application_domain_identities", {
      project_id: scope.projectId,
      organization_id: scope.organizationId,
      hostname: "app.example.com",
      registrable_domain: "example.com",
      revision: 1,
      state: "verified",
      challenge_name: "_omh-project.app.example.com",
      challenge_value: "a".repeat(43),
      declared_at: now,
      verified_at: now,
      expires_at: new Date(Date.parse(now) + 86400000).toISOString(),
      idempotency_key_sha256: new Uint8Array(32).fill(1),
      request_sha256: new Uint8Array(32).fill(2),
      actor_id: "user:fixture",
    });
  await insert("project_mail_domain_bindings", {
    project_id: scope.projectId,
    organization_id: scope.organizationId,
    environment_id: scope.environmentId,
    mail_domain_id: domainId,
    revision: 1,
    state: "active",
    sending: true,
    legacy,
    sender_addresses: legacy ? "[]" : JSON.stringify([`hello@${domain}`]),
    default_from: legacy ? null : `hello@${domain}`,
    default_reply_to: null,
    application_identity_revision: legacy ? null : 1,
    configured_at: now,
    updated_at: now,
  });
  const mail = await cipher.encrypt({ ...scope, name: "OHMYHOST_MAIL_KEY", value: key }),
    input = {
      ...scope,
      ...mail,
      name: "OHMYHOST_MAIL_KEY" as const,
      operationId: parseUlid(fixture.accepted.operationId),
      claimId: parseUlid(fixture.accepted.claimId),
      writtenAt: now,
    };
  const context = {
    directory: control.core,
    router: coreRouter(control),
    nativeAuthLaunchPolicy: { mode: "password-general-availability" as const },
  };
  await ensureMailSecret(context, input);
  return {
    scope,
    domainId,
    domain,
    key,
    providerKey,
    sealed,
    cipher,
    fixture,
    now,
    insert,
    context,
    /** Runs one D1 statement with `?n` parameters; ISO timestamps are stored in the stored (microsecond) form. */
    async update(sql: string, params: unknown[]) {
      await control.core
        .prepare(sql)
        .bind(...params.map(bindable))
        .run();
    },
  };
}

/**
 * Paid, with the Resend rate card published and both mail meters activated, and `credits` one-time credits on top of the
 * Free allowance of the month: the state in which an organization can send and receive mail.
 */
export async function fundMailFixture(
  control: TestControl,
  f: Awaited<ReturnType<typeof mailFixture>>,
  credits = 1000,
) {
  await publishMailPricing(control);
  await fundOrganization(control, f.scope.organizationId, f.now, credits);
}

/** One pending received message of the fixture's receiving domain: received now, due now, 72-hour deadline. */
export async function seedReceivedMail(f: Awaited<ReturnType<typeof mailFixture>>) {
  const messageId = parseUlid(newUlid()),
    providerMessageId = `received_${newUlid()}`;
  await f.insert("mail_received_messages", {
    message_id: messageId,
    provider_message_id: providerMessageId,
    domain_id: f.domainId,
    organization_id: f.scope.organizationId,
    project_id: f.scope.projectId,
    environment_id: f.scope.environmentId,
    received_at: f.now,
    expires_at: new Date(Date.parse(f.now) + 72 * 3600000).toISOString(),
    next_attempt_at: f.now,
  });
  return { messageId, providerMessageId };
}

/** The credit account of an organization, as stored. */
export const accountOf = (control: TestControl, organizationId: string) =>
  control.core
    .prepare(
      "SELECT monthly_micros,onetime_micros,reserved_micros,overrun_micros,exhausted_at,paid_until,warned_for_exhausted_at,warning_next_attempt_at FROM credit_account WHERE organization_id=?",
    )
    .bind(organizationId)
    .first<Record<string, number | string | null>>();

/** The credit log rows of an organization whose key starts with `prefix`, oldest first, with the detail parsed. */
export async function creditLog(control: TestControl, organizationId: string, prefix = "") {
  const rows = await control.core
    .prepare(
      "SELECT key,kind,delta_micros,balance_micros,detail FROM credit_log WHERE organization_id=? AND key LIKE ? ORDER BY seq",
    )
    .bind(organizationId, `${prefix}%`)
    .all<{
      key: string;
      kind: string;
      delta_micros: number;
      balance_micros: number;
      detail: string;
    }>();
  return rows.results.map((row) => ({ ...row, detail: JSON.parse(row.detail) as unknown }));
}
