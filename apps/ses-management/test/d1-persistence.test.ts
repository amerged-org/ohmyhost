import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrganizationCreditError, ResendMailScopeError } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";
import {
  MailCommandRuntime,
  MailDeletionRuntime,
  MailManagementJobRuntime,
  MailManagementRuntime,
  MailWorkspaceRuntime,
} from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import {
  seedDeletionIntent,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import {
  fundMail,
  publishMailRates,
  seedReadyMailDomain,
  seedNativeWorkspaceDomain,
} from "../../control-store/test/support/mail-domain.js";
import { seam } from "../../control-store/test/support/wire.js";
import { createD1MailManagementCommandPersistence } from "../src/d1-command-persistence.js";
import { createD1MailManagementJobPersistence } from "../src/d1-job-persistence.js";
import { createD1MailProjectDeletionPersistence } from "../src/d1-deletion-persistence.js";
import { createD1ResendManagementPersistence } from "../src/d1-resend-persistence.js";
import { createD1WorkspaceMailManagementPersistence } from "../src/d1-workspace-persistence.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const NOW = "2026-10-29T10:00:00.000Z";
const later = (milliseconds: number) => new Date(Date.parse(NOW) + milliseconds).toISOString();
const now = () => NOW;
let control: TestControl;
const entry = <T>(Runtime: new (context: never, environment: never) => T): T =>
  new Runtime({} as never, control.bindings as never);
beforeAll(async () => {
  control = await createTestControl();
  await publishMailRates(control);
}, 60_000);
afterAll(async () => control.dispose());

describe("legacy resource, command and retirement persistence", () => {
  it("replays idempotent commands, resumes an abandoned one and retires a project domain through its legacy custody", async () => {
    const project = await seedProject(control),
      domain = await seedReadyMailDomain(control, project),
      org = project.organizationId;
    await fundMail(control, org);
    const commandWire = seam(entry(MailCommandRuntime)),
      commands = await createD1MailManagementCommandPersistence(commandWire.binding),
      resources = await createD1ResendManagementPersistence(entry(MailManagementRuntime)),
      digest = Buffer.alloc(32, 7);

    expect(await commands.begin(domain.scope, "retire-1", digest, now)).toEqual({
      created: true,
      response: null,
    });
    expect(await commands.begin(domain.scope, "retire-1", digest, now)).toEqual({
      created: false,
      response: null,
    });
    expect(await commands.resume(domain.scope, "retire-1", now)).toBe(false);
    expect(await commands.resume(domain.scope, "retire-1", () => later(180_000))).toBe(true);
    await expect(
      commands.begin(domain.scope, "retire-1", Buffer.alloc(32, 8), now),
    ).rejects.toThrow("idempotency_key_reused");

    expect(await resources.liveName(domain.domain)).toBe(true);
    expect(await resources.liveName("absent.example.com")).toBe(false);
    expect(await resources.receivingOwner(domain.scope, domain.domainId)).toBe(true);
    expect(await resources.workspaceStatus(domain.domainId)).toBe("active");
    expect(await resources.workspaceStatus(newUlid())).toBeNull();
    expect(await resources.read(domain.scope)).toMatchObject({ domain_id: domain.domainId });
    expect(
      await resources.custody({ organizationId: org, domainId: domain.domainId }),
    ).toMatchObject({ domain: domain.domain });
    await resources.requirePaid(org, now);
    await resources.receivingAdmission(domain.scope, now);

    // Retirement closes admission first and leaves the workspace row retiring until its provider cleanup finishes.
    expect(
      await resources.retire({ ...domain.scope, idempotencyKey: "retire-1" }, now),
    ).toMatchObject({ domain_id: domain.domainId });
    expect(await resources.workspaceStatus(domain.domainId)).toBe("retiring");
    expect(
      await resources.change({ action: "finishRetirement", domainId: domain.domainId }, now),
    ).toBe(true);
    expect(await resources.workspaceStatus(domain.domainId)).toBe("retired");
    await commands.complete(domain.scope, "retire-1", { status: "deleted" }, now);
    expect(await commands.begin(domain.scope, "retire-1", digest, now)).toEqual({
      created: false,
      response: { status: "deleted" },
    });

    // The shared workspace commands are read by their exact receipt and retired under one lease.
    await control.core
      .prepare(
        "INSERT INTO workspace_mail_commands(organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,created_at) VALUES(?1,'ws-retire-1',?2,'retire','user:owner',?3,?4)",
      )
      .bind(org, domain.domainId, digest, STORED_NOW)
      .run();
    const receipt = {
      organizationId: org,
      domainId: domain.domainId,
      idempotencyKey: "ws-retire-1",
      principalId: "user:owner",
      operation: "retire",
      requestSha256: digest,
    };
    expect(await commands.readWorkspace(receipt)).toBeNull();
    expect(await commands.claimWorkspaceRetirement(org, "ws-retire-1", now)).toBe(true);
    expect(await commands.claimWorkspaceRetirement(org, "ws-retire-1", now)).toBe(false);

    // Core refusals map to the closed set; an unlisted text never leaks; corrupt answers are refused.
    commandWire.refuse("resume", "SQLITE_ERROR: private");
    await expect(commands.resume(domain.scope, "retire-1", now)).rejects.toThrow(
      "mail_command_unavailable",
    );
    commandWire.refuse("complete", "mail.completeManagementCommand: store_outcome_unknown");
    await expect(
      commands.complete(domain.scope, "retire-1", { status: "deleted" }, now),
    ).rejects.toMatchObject({ code: "store_outcome_unknown" });
    commandWire.refuse("begin", "mail_scope_unavailable");
    await expect(commands.begin(domain.scope, "x", digest, now)).rejects.toThrow(
      "mail_scope_unavailable",
    );
    for (const [name, reply, call] of [
      [
        "begin",
        { created: "yes", response: null },
        () => commands.begin(domain.scope, "k", digest, now),
      ],
      ["resume", "yes", () => commands.resume(domain.scope, "k", now)],
      ["complete", "done", () => commands.complete(domain.scope, "k", {}, now)],
      ["claimWorkspaceRetirement", 1, () => commands.claimWorkspaceRetirement(org, "k", now)],
    ] as const) {
      commandWire.reply(name, reply);
      await expect(call()).rejects.toThrow("mail_command_response_invalid");
    }
    await expect(createD1MailManagementCommandPersistence({})).rejects.toThrow(
      "mail_command_binding_required",
    );
    const foreign = seam(entry(MailCommandRuntime));
    foreign.reply("read", { requestSha256: "a".repeat(64), response: null });
    await expect(createD1MailManagementCommandPersistence(foreign.binding)).rejects.toThrow(
      "mail_command_response_invalid",
    );
  });

  it("configures a project domain once and answers its replay from the stored resource", async () => {
    const project = await seedProject(control),
      resources = await createD1ResendManagementPersistence(entry(MailManagementRuntime)),
      scope = {
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        environmentId: parseUlid(project.prodEnvironmentId),
      },
      domainId = parseUlid(newUlid()),
      domain = `configured-${domainId.slice(-8).toLowerCase()}.example.com`,
      input = () => ({
        ...scope,
        domainId,
        domain,
        sending: true,
        receiving: false,
        webhookUrl: null,
      });
    await fundMail(control, project.organizationId);
    const created = await resources.configure(input, now);
    expect(created).toMatchObject({ domain_id: domainId, domain, sending: true, receiving: false });
    expect(await resources.configure(input, now)).toMatchObject({ domain_id: domainId });
    expect(await resources.liveName(domain)).toBe(true);
  });

  it("maps resource refusals and refuses corrupt resource answers", async () => {
    const project = await seedProject(control),
      domain = await seedReadyMailDomain(control, project),
      wire = seam(entry(MailManagementRuntime)),
      resources = await createD1ResendManagementPersistence(wire.binding);
    for (const [message, expected] of [
      ["paid_plan_required", OrganizationCreditError],
      ["mail_scope_unavailable", ResendMailScopeError],
      ["store_busy", Error],
      ["SQLITE_ERROR: private detail", Error],
    ] as const) {
      wire.refuse("requirePaid", message);
      const failure = await resources.requirePaid(project.organizationId, now).catch((e) => e);
      expect(failure).toBeInstanceOf(expected);
      if (message.startsWith("SQLITE")) expect(failure.message).toBe("mail_management_unavailable");
    }
    for (const [name, reply, call] of [
      ["requirePaid", "paid", () => resources.requirePaid(project.organizationId, now)],
      ["hasLiveName", "yes", () => resources.liveName(domain.domain)],
      ["readWorkspaceStatus", 7, () => resources.workspaceStatus(domain.domainId)],
      ["readDomain", { domain_id: domain.domainId }, () => resources.read(domain.scope)],
    ] as const) {
      wire.reply(name, reply);
      await expect(call()).rejects.toThrow("mail_management_response_invalid");
    }
    await expect(createD1ResendManagementPersistence({})).rejects.toThrow(
      "mail_management_binding_required",
    );
  });
});

describe("workspace resource persistence", () => {
  it("claims and releases the capability lease, stores the sealed key, and retires a native sender", async () => {
    const project = await seedProject(control),
      native = await seedNativeWorkspaceDomain(control, project),
      org = project.organizationId,
      wire = seam(entry(MailWorkspaceRuntime)),
      workspace = await createD1WorkspaceMailManagementPersistence(wire.binding),
      scope = { organizationId: org, domainId: native.domainId },
      lease = newUlid();
    await fundMail(control, org);
    await workspace.requirePaid(org, now);
    expect(await workspace.load(scope)).toMatchObject({
      domain_id: native.domainId,
      status: "active",
    });
    expect(await workspace.view(scope)).toMatchObject({ domain: native.domain, bindings_count: 0 });
    expect(await workspace.change(scope, { action: "claimDns", leaseToken: lease }, now)).toBe(
      true,
    );
    expect(await workspace.change(scope, { action: "releaseDns", leaseToken: lease }, now)).toBe(
      true,
    );
    expect(await workspace.change(scope, { action: "claimKey" }, now)).toBe(true);
    expect(
      await workspace.change(
        scope,
        {
          action: "saveKey",
          keyId: "key_native",
          ciphertext: new Uint8Array(34).fill(1),
          nonce: new Uint8Array(12).fill(2),
          valueSha256: new Uint8Array(32).fill(3),
          keyVersion: 1,
        },
        now,
      ),
    ).toBe(true);
    expect(
      (
        await control.core
          .prepare("SELECT sending_key_id k FROM workspace_mail_domains WHERE domain_id=?")
          .bind(native.domainId)
          .first<{ k: string }>()
      )?.k,
    ).toBe("key_native");
    const resources = await createD1ResendManagementPersistence(entry(MailManagementRuntime)),
      legacy = await seedReadyMailDomain(control, project, { receiving: false }),
      legacyScope = { organizationId: org, domainId: legacy.domainId };
    // A project-owned domain is released from its legacy custody only after the workspace row is retiring.
    expect(await resources.legacy(legacyScope, "retiring")).toBeNull();
    await control.core
      .prepare("UPDATE project_mail_domain_bindings SET state='detached' WHERE mail_domain_id=?")
      .bind(legacy.domainId)
      .run();
    await workspace.beginRetirement({ ...legacyScope, expectedRevision: 1 }, () => new Date(NOW));
    expect(await resources.legacy(legacyScope, "retiring")).toMatchObject({
      domain_id: legacy.domainId,
    });
    expect(await resources.retireLegacy(legacyScope, now)).toMatchObject({
      domain_id: legacy.domainId,
    });
    expect(await resources.liveName(legacy.domain)).toBe(false);
    const begun = await workspace.beginRetirement(
      { ...scope, expectedRevision: 1 },
      () => new Date(NOW),
    );
    expect(begun).toMatchObject({ domain_id: native.domainId });
    await workspace.finishRetirement(scope, now);
    expect((await workspace.load(scope)).status).toBe("retired");

    wire.refuse("requirePaid", "mail_domain_in_use");
    await expect(workspace.requirePaid(org, now)).rejects.toThrow("mail_domain_in_use");
    wire.refuse("requirePaid", "insufficient_organization_credits");
    await expect(workspace.requirePaid(org, now)).rejects.toBeInstanceOf(OrganizationCreditError);
    wire.refuse("requirePaid", "store_busy");
    await expect(workspace.requirePaid(org, now)).rejects.toMatchObject({ code: "store_busy" });
    wire.refuse("requirePaid", "SQLITE_ERROR: private");
    await expect(workspace.requirePaid(org, now)).rejects.toThrow("workspace_mail_unavailable");
    wire.restore();
    for (const [name, reply, call] of [
      ["requirePaid", "paid", () => workspace.requirePaid(org, now)],
      ["change", "yes", () => workspace.change(scope, { action: "claimKey" }, now)],
      ["readResource", { domain_id: native.domainId }, () => workspace.load(scope)],
      ["readView", { domain_id: native.domainId }, () => workspace.view(scope)],
    ] as const) {
      wire.reply(name, reply);
      await expect(call()).rejects.toThrow("workspace_mail_response_invalid");
    }
    await expect(createD1WorkspaceMailManagementPersistence({})).rejects.toThrow(
      "workspace_mail_binding_required",
    );
  });
});

describe("scheduled cohorts and project deletion", () => {
  it("lists and claims the fixed reconciliation cohorts of an isolated Core", async () => {
    const isolated = await createTestControl();
    try {
      const project = await seedProject(isolated),
        pending = await seedReadyMailDomain(isolated, project, {
          receiving: false,
          sendingStatus: "pending",
        }),
        runtime = new MailManagementJobRuntime({}, isolated.bindings),
        wire = seam(runtime),
        jobs = await createD1MailManagementJobPersistence(wire.binding);

      expect(await jobs.listPendingLegacy()).toEqual([
        {
          domain_id: pending.domainId,
          organization_id: project.organizationId,
          project_id: project.projectId,
          environment_id: project.prodEnvironmentId,
        },
      ]);
      expect(await jobs.claimLegacy(pending.domainId, NOW)).toBe(true);
      expect(await jobs.claimLegacy(pending.domainId, NOW)).toBe(false);
      expect(await jobs.listPendingWorkspaces(NOW)).toEqual([
        {
          organization_id: project.organizationId,
          domain_id: pending.domainId,
          provisioning: true,
        },
      ]);
      expect(await jobs.claimWorkspace(project.organizationId, pending.domainId, NOW)).toBe(true);
      expect(await jobs.claimDueIdentityRevalidation(NOW)).toEqual([]);
      await jobs.suspendExpiredBindings(NOW);

      wire.refuse("claimWorkspace", "store_outcome_unknown");
      await expect(
        jobs.claimWorkspace(project.organizationId, pending.domainId, NOW),
      ).rejects.toMatchObject({
        code: "store_outcome_unknown",
      });
      wire.refuse("claimLegacy", "SQLITE_ERROR: private");
      await expect(jobs.claimLegacy(pending.domainId, NOW)).rejects.toThrow("mail_job_unavailable");
      wire.restore();
      for (const [name, reply, call] of [
        ["listPendingLegacy", [{ domain_id: "x" }], () => jobs.listPendingLegacy()],
        ["claimLegacy", "yes", () => jobs.claimLegacy(pending.domainId, NOW)],
        [
          "claimDueIdentity",
          [{ organization_id: "x", project_id: "y", revision: "0" }],
          () => jobs.claimDueIdentityRevalidation(NOW),
        ],
        ["suspendExpiredBindings", 1, () => jobs.suspendExpiredBindings(NOW)],
        [
          "listPendingWorkspaces",
          [{ organization_id: "x", domain_id: "y", provisioning: 1 }],
          () => jobs.listPendingWorkspaces(NOW),
        ],
      ] as const) {
        wire.reply(name, reply);
        await expect(call()).rejects.toThrow("mail_job_response_invalid");
      }
      await expect(createD1MailManagementJobPersistence({})).rejects.toThrow(
        "mail_job_binding_required",
      );
    } finally {
      await isolated.dispose();
    }
  });

  it("freezes the deletion scope, records a found provider domain and finishes the resource", async () => {
    const project = await seedProject(control),
      domain = await seedReadyMailDomain(control, project, { receiving: false }),
      operationId = await seedOperation(project),
      wire = seam(entry(MailDeletionRuntime)),
      deletion = await createD1MailProjectDeletionPersistence(wire.binding),
      scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId,
      };
    await seedDeletionIntent(project, project.prodEnvironmentId, operationId);
    await expect(deletion.prepare(scope)).rejects.toThrow("Mail deletion scope unavailable");
    await control.core
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .run();
    // A project-owned domain that never reached a shared workspace stays a plain domain row of the deletion.
    await control.core.batch([
      control.core.prepare("PRAGMA defer_foreign_keys=ON"),
      control.core
        .prepare("DELETE FROM project_mail_domain_bindings WHERE project_id=?")
        .bind(project.projectId),
      control.core
        .prepare("DELETE FROM workspace_mail_domains WHERE legacy_domain_id=?")
        .bind(domain.domainId),
    ]);
    const prepared = await deletion.prepare(scope);
    expect(prepared).toMatchObject({ inventory: [], legacy: [], retained: [] });
    expect(prepared.domains).toEqual([
      expect.objectContaining({ domain_id: domain.domainId, domain: domain.domain }),
    ]);
    await deletion.recordFound(domain.domainId, domain.providerDomainId);
    await deletion.finish(domain.domainId, () => new Date(NOW));
    expect(
      (
        await control.core
          .prepare("SELECT deleted_at d FROM resend_mail_domains WHERE domain_id=?")
          .bind(domain.domainId)
          .first<{ d: string | null }>()
      )?.d,
    ).toBe("2026-10-29T10:00:00.000000Z");

    wire.refuse("prepare", "legacy_aws_mail_absence_missing");
    await expect(deletion.prepare(scope)).rejects.toMatchObject({
      name: "LegacyAwsMailAbsenceError",
    });
    wire.refuse("prepare", "store_busy");
    await expect(deletion.prepare(scope)).rejects.toMatchObject({ code: "store_busy" });
    wire.refuse("prepare", "Mail domain receipt conflict");
    await expect(deletion.prepare(scope)).rejects.toThrow("Mail domain receipt conflict");
    wire.refuse("prepare", "SQLITE_ERROR: private");
    await expect(deletion.prepare(scope)).rejects.toThrow("mail_deletion_unavailable");
    wire.restore();
    const valid = {
      inventory: ["a".repeat(64)],
      legacy: [
        { provider: "aws", resourceKind: "ses-tenant", locator: "arn", outcome: "not_found" },
      ],
      retained: [{ domain_id: domain.domainId, provider_domain_id: "p", sending: true }],
      domains: [] as unknown[],
    };
    const row = {
      domain_id: domain.domainId,
      provider_domain_id: null,
      sending_key_id: null,
      sending_key_claimed_at: null,
      provider_claimed_at: "2026-10-29T10:00:00.123456Z",
      provider_preflight_at: null,
      domain: domain.domain,
      retirement_completed: false,
    };
    wire.reply("prepare", { ...valid, domains: [row] });
    expect((await deletion.prepare(scope)).domains[0]).toMatchObject({
      provider_claimed_at: new Date("2026-10-29T10:00:00.123Z"),
    });
    for (const corrupt of [
      { ...valid, inventory: ["short"] },
      { ...valid, legacy: [{ ...valid.legacy[0], outcome: "removed" }] },
      {
        ...valid,
        retained: [{ domain_id: domain.domainId, provider_domain_id: 1, sending: true }],
      },
      { ...valid, domains: [{ ...row, provider_claimed_at: "yesterday" }] },
      { ...valid, domains: [{ ...row, sending_key_id: 7 }] },
      "nothing",
    ]) {
      wire.reply("prepare", corrupt);
      await expect(deletion.prepare(scope)).rejects.toThrow("mail_deletion_response_invalid");
    }
    wire.reply("recordFound", "ok");
    await expect(deletion.recordFound(domain.domainId, "p")).rejects.toThrow(
      "mail_deletion_response_invalid",
    );
    await expect(createD1MailProjectDeletionPersistence({})).rejects.toThrow(
      "mail_deletion_binding_required",
    );
    const foreign = seam(entry(MailDeletionRuntime));
    foreign.reply("readScope", true);
    await expect(createD1MailProjectDeletionPersistence(foreign.binding)).rejects.toThrow(
      "mail_deletion_response_invalid",
    );
  });
});
