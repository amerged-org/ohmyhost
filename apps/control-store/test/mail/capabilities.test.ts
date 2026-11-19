import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { mailFixture } from "./mail-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import type { D1Database } from "../../src/d1-types.js";
import { MailCapabilityRuntime } from "../../src/worker-main.js";
import {
  claimWorkspaceMailCapabilities,
  readWorkspaceMailCapabilities,
  confirmWorkspaceMailCapabilities,
  releaseWorkspaceMailCapabilities,
} from "../../src/catalog/mail/capabilities.js";
import {
  syncWorkspaceMailCapabilities,
  createD1WorkspaceMailCapabilityPersistence,
} from "../../../../packages/database/src/index.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());

it("runs the one-resource provider capability loop, live sender proof and exact post-provider recheck across legacy and native custody", async () => {
  for (const legacy of [true, false]) {
    const f = await mailFixture(control, legacy),
      scope = {
        organizationId: f.scope.organizationId,
        domainId: f.domainId,
        now: () => new Date(f.now),
      },
      providerDomainId = `provider_${f.domainId}`,
      target = await createD1WorkspaceMailCapabilityPersistence(
        new MailCapabilityRuntime({}, control.bindings),
      );
    // A native sender has no project-owned receiving resource, so it can only send.
    expect(await target.read(scope)).toEqual({
      provider_domain_id: providerDomainId,
      sending: true,
      receiving: legacy,
    });
    const calls: { id: string; sending: boolean; receiving: boolean }[] = [];
    let first = true;
    const result = await syncWorkspaceMailCapabilities({
      ...scope,
      leaseToken: newUlid(),
      persistence: target,
      provider: {
        updateDomain: async (id, flags) => {
          calls.push({ id, ...flags });
          // The sender is revoked while the first provider call is in flight: the confirm must notice and loop once more.
          if (first) {
            first = false;
            await f.update(
              "UPDATE project_mail_domain_bindings SET sending=0,revision=revision+1,updated_at=?1 WHERE project_id=?2",
              [f.now, f.scope.projectId],
            );
          }
        },
      },
    });
    expect(result).toEqual({
      provider_domain_id: providerDomainId,
      sending: false,
      receiving: legacy,
    });
    // Resend requires one enabled capability: with neither sending nor receiving authorized, sending stays enabled.
    expect(calls).toEqual([
      { id: providerDomainId, sending: true, receiving: legacy },
      { id: providerDomainId, sending: !legacy, receiving: legacy },
    ]);
    expect(
      await control.core
        .prepare(
          "SELECT capabilities_lease_token,capabilities_lease_until,capabilities_dirty FROM workspace_mail_domains WHERE domain_id=?",
        )
        .bind(f.domainId)
        .first(),
    ).toEqual({
      capabilities_lease_token: null,
      capabilities_lease_until: null,
      capabilities_dirty: 0,
    });
    const current = { ...scope, leaseToken: newUlid() };
    expect(await target.claim(current)).toBe(true);
    expect(await target.claim({ ...current, leaseToken: newUlid() })).toBe(false);
    await target.release(current);
    await f.update(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE project_id=?1",
      [f.scope.projectId],
    );
    expect(await target.read(scope)).toEqual({
      provider_domain_id: providerDomainId,
      sending: false,
      receiving: false,
    });
    const foreign = { ...scope, organizationId: newUlid() };
    expect(await target.read(foreign)).toBeNull();
    expect(await target.claim({ ...foreign, leaseToken: newUlid() })).toBe(false);
  }
});

it("retains unknown provider leases, aborts unknown committed claim permission and rolls back a late metadata failure as one Core effect", async () => {
  const f = await mailFixture(control),
    now = () => new Date(f.now),
    scope = { organizationId: f.scope.organizationId, domainId: f.domainId, now },
    leaseToken = newUlid();
  let lose = true,
    providerCalls = 0;
  const db: D1Database = {
    prepare: (sql) => control.core.prepare(sql),
    batch: async (statements) => {
      const result = await control.core.batch(statements);
      if (lose && result.some((row) => Number(row.meta?.changes ?? 0) > 0)) {
        lose = false;
        throw new Error("Network connection lost");
      }
      return result;
    },
  };
  const context = { directory: db, router: new SharedCoreRouter(db) },
    unknown = await createD1WorkspaceMailCapabilityPersistence({
      claim: (input: unknown) => claimWorkspaceMailCapabilities(context, input),
      read: (input: unknown) => readWorkspaceMailCapabilities(context, input),
      confirm: (input: unknown) => confirmWorkspaceMailCapabilities(context, input),
      release: (input: unknown) => releaseWorkspaceMailCapabilities(context, input),
    });
  await expect(
    syncWorkspaceMailCapabilities({
      ...scope,
      leaseToken,
      persistence: unknown,
      provider: {
        updateDomain: async () => {
          providerCalls++;
        },
      },
    }),
  ).rejects.toThrow("store_outcome_unknown");
  expect(providerCalls).toBe(0);
  expect(await unknown.claim({ ...scope, leaseToken: newUlid() })).toBe(false);
  const retained = await control.core
    .prepare(
      "SELECT capabilities_lease_token token,capabilities_lease_until until_at FROM workspace_mail_domains WHERE domain_id=?",
    )
    .bind(f.domainId)
    .first();
  expect(retained?.["token"]).toBe(leaseToken);
  const normal = await createD1WorkspaceMailCapabilityPersistence(
    new MailCapabilityRuntime({}, control.bindings),
  );
  await normal.release({ ...scope, leaseToken });
  await expect(
    syncWorkspaceMailCapabilities({
      ...scope,
      leaseToken,
      persistence: normal,
      provider: {
        updateDomain: async () => {
          throw new Error("provider outcome unknown");
        },
      },
    }),
  ).rejects.toThrow("provider outcome unknown");
  expect(
    (
      await control.core
        .prepare(
          "SELECT capabilities_lease_token token FROM workspace_mail_domains WHERE domain_id=?",
        )
        .bind(f.domainId)
        .first()
    )?.["token"],
  ).toBe(leaseToken);
  await normal.release({ ...scope, leaseToken });
  await f.update("UPDATE resend_mail_domains SET receiving=0 WHERE domain_id=?1", [f.domainId]);
  await f.update(
    "UPDATE project_mail_domain_bindings SET sending=0,revision=revision+1,updated_at=?1 WHERE project_id=?2",
    [f.now, f.scope.projectId],
  );
  const desired = await normal.read(scope);
  if (!desired) throw new Error("Missing desired capabilities");
  expect(await normal.claim({ ...scope, leaseToken })).toBe(true);
  await control.core
    .prepare(
      "CREATE TRIGGER synthetic_mail_capability_late BEFORE UPDATE OF capabilities_dirty ON workspace_mail_domains BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END",
    )
    .run();
  await expect(normal.confirm({ ...scope, leaseToken, desired })).rejects.toThrow();
  expect(
    (
      await control.core
        .prepare("SELECT sending FROM resend_mail_domains WHERE domain_id=?")
        .bind(f.domainId)
        .first()
    )?.["sending"],
  ).toBe(1);
  await control.core.prepare("DROP TRIGGER synthetic_mail_capability_late").run();
  lose = true;
  await expect(unknown.confirm({ ...scope, leaseToken, desired })).rejects.toThrow(
    "store_outcome_unknown",
  );
  expect(await normal.confirm({ ...scope, leaseToken, desired })).toBe(true);
  expect(
    await normal.confirm({ ...scope, leaseToken, desired: { ...desired, sending: true } }),
  ).toBe(false);
  await normal.release({ ...scope, leaseToken });
  await expect(
    claimWorkspaceMailCapabilities(f.context, {
      organizationId: "bad",
      domainId: f.domainId,
      leaseToken,
      now: f.now,
    }),
  ).rejects.toThrow("Invalid mail input");
  const releasedAfterUnknown = newUlid();
  expect(await normal.claim({ ...scope, leaseToken: releasedAfterUnknown })).toBe(true);
  lose = true;
  await expect(unknown.release({ ...scope, leaseToken: releasedAfterUnknown })).rejects.toThrow(
    "store_outcome_unknown",
  );
  expect(
    (
      await control.core
        .prepare(
          "SELECT capabilities_lease_token token FROM workspace_mail_domains WHERE domain_id=?",
        )
        .bind(f.domainId)
        .first()
    )?.["token"],
  ).toBeNull();
});
