import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlidFactory, parseUlid, SystemEntropy } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  DEV_ACCESS_PRINCIPAL,
  seedDevAccessProject,
} from "../../control-store/test/support/dev-access-fixture.js";
import { STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import { createEnvironmentSecretCipherKeyring } from "../src/environment-secret-cipher.js";
import { IdempotencyKeyReusedError } from "../src/contracts.js";
import type { D1ProductSurfaceRuntime } from "../src/d1-product-surface.js";
import {
  createD1ProjectDataChanges,
  type D1ProjectDataChangeRuntime,
} from "../src/d1-project-data-changes.js";

const NOW = "2026-10-28T11:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const ids = () => createUlidFactory({ clock, entropy: new SystemEntropy() });
const cipher = createEnvironmentSecretCipherKeyring({
  primaryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
  currentKeyVersion: 1,
  crypto: globalThis.crypto,
});

let control: TestControl;
let runtime: D1ProductSurfaceRuntime & D1ProjectDataChangeRuntime;
beforeAll(async () => {
  control = await createTestControl();
  runtime = createControlStore(control.bindings).productApi as never;
});
afterAll(async () => control.dispose());

/** A dev-access project (owner, dev domain) whose Dev and Prod either share one data area or hold their own. */
async function dataProject(mode: "shared" | "isolated") {
  const { project } = await seedDevAccessProject(control),
    db = control.core,
    prodData = mode === "shared" ? project.devEnvironmentId : project.prodEnvironmentId;
  await db.batch([
    db
      .prepare("UPDATE organizations SET beta_admitted_at=? WHERE organization_id=?")
      .bind(STORED_NOW, project.organizationId),
    ...[...new Set([project.devEnvironmentId, prodData])].map((data) =>
      db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
        )
        .bind(project.organizationId, project.projectId, data, STORED_NOW),
    ),
    ...(
      [
        [project.devEnvironmentId, project.devEnvironmentId],
        [project.prodEnvironmentId, prodData],
      ] as const
    ).map(([environmentId, data]) =>
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,1,?4,?5)",
        )
        .bind(project.organizationId, project.projectId, environmentId, data, STORED_NOW),
    ),
    db
      .prepare("UPDATE projects SET data_mode=?3 WHERE organization_id=?1 AND project_id=?2")
      .bind(project.organizationId, project.projectId, mode),
  ]);
  return {
    context: {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
      principalId: DEV_ACCESS_PRINCIPAL,
      requestId: "req-data-change",
    },
    project,
  };
}
const mutation = (
  context: Awaited<ReturnType<typeof dataProject>>["context"],
  key: string,
  fill: number,
) => ({
  ...context,
  idempotencyKey: key,
  canonicalRequestDigest: new Uint8Array(32).fill(fill),
});

describe("D1 project data changes over the real Core", () => {
  it("plans with a one-use confirmation, accepts the change once, replays it exactly and refuses stale, conflicting and racing requests", async () => {
    const { context, project } = await dataProject("shared"),
      changes = createD1ProjectDataChanges({ runtime, clock, ids: ids() });

    // A concurrent head change invalidates the first confirmation attempt; the plan is re-read, and a persistent
    // race ends with the closed refusal instead of a stale confirmation.
    const racing = (rounds: number) => {
      let remaining = rounds;
      return createD1ProjectDataChanges({
        runtime: {
          ...runtime,
          issueApiProjectDataChangePlan: async (request: unknown) => {
            if (remaining-- > 0)
              await control.core
                .prepare("UPDATE environments SET head_version=head_version+1 WHERE project_id=?")
                .bind(project.projectId)
                .run();
            return runtime.issueApiProjectDataChangePlan(request);
          },
        },
        clock,
        ids: ids(),
      });
    };
    await expect(
      racing(3).plan({ ...context, change: "isolate_prod_keeps_data" }),
    ).rejects.toMatchObject({ reason: "data_change_blocked" });
    expect(await racing(1).plan({ ...context, change: "isolate_prod_keeps_data" })).toMatchObject({
      status: 200,
    });

    const plan = await changes.plan({ ...context, change: "isolate_prod_keeps_data" });
    expect(plan).toMatchObject({
      status: 200,
      body: {
        action: "data_change",
        project_id: project.projectId,
        change: "isolate_prod_keeps_data",
        data_mode_before: "shared",
        data_mode_after: "isolated",
        redeploy_environments: ["dev"],
      },
    });
    const body = plan?.body as { resource_etag: string; confirmation_token: string };
    expect(
      await control.core
        .prepare(
          "SELECT action,issued_to_principal_id,consumed_at FROM action_confirmations WHERE project_id=?",
        )
        .bind(project.projectId)
        .first(),
    ).toEqual({
      action: "data_change",
      issued_to_principal_id: DEV_ACCESS_PRINCIPAL,
      consumed_at: null,
    });
    await expect(
      changes.plan({ ...context, change: "share_prod_keeps_data" }),
    ).rejects.toMatchObject({ reason: "data_change_not_applicable" });
    expect(
      await changes.plan({ ...context, change: "isolate_prod_keeps_data", projectId: ulid() }),
    ).toBeNull();

    const connection = {
      organizationId: context.organizationId,
      userId: DEV_ACCESS_PRINCIPAL.slice(5),
      clientId: "data-client",
      consentHash: "cd".repeat(32),
    };
    const proof = await createControlStore(control.bindings).identity.ensureMcpConnectionProof({
      ...connection,
      projectId: context.projectId,
      now: NOW,
    });
    if (!proof) throw new Error("Data-change connection proof missing");
    const delegation = {
      grantId: proof.grantId,
      clientId: connection.clientId,
      consentHash: connection.consentHash,
      action: "projects:delete" as const,
      authorizationRestriction: {
        actions: ["projects:delete" as const],
        projectIds: [context.projectId],
      },
    };
    const request = {
      ...mutation(context, "data-change-1", 21),
      delegation,
      change: "isolate_prod_keeps_data" as const,
      ifMatch: body.resource_etag,
      confirmationToken: body.confirmation_token,
    };
    await expect(changes.change({ ...request, ifMatch: '"sha256-stale"' })).rejects.toMatchObject({
      reason: "etag_mismatch",
    });
    await expect(
      changes.change({ ...request, confirmationToken: "not-the-issued-token" }),
    ).rejects.toMatchObject({ reason: "confirmation_invalid" });
    const accepted = await changes.change(request);
    expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
    const retained = await control.core
      .prepare(
        "SELECT authorization_action,authorization_restriction FROM operation_mcp_delegations WHERE project_id=?",
      )
      .bind(project.projectId)
      .first<{ authorization_action: string; authorization_restriction: string }>();
    expect(retained?.authorization_action).toBe("projects:delete");
    expect(JSON.parse(retained?.authorization_restriction ?? "null")).toEqual(
      delegation.authorizationRestriction,
    );
    expect(await changes.change(request)).toEqual(accepted);
    await expect(
      changes.change({ ...request, canonicalRequestDigest: new Uint8Array(32).fill(22) }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(
      await control.core
        .prepare(
          "SELECT data_change,expected_etag FROM product_command_intents WHERE project_id=? AND event_type='ProjectDataChangeRequestedV1'",
        )
        .bind(project.projectId)
        .first(),
    ).toEqual({ data_change: "isolate_prod_keeps_data", expected_etag: body.resource_etag });

    // The accepted change keeps the project busy: a second plan names the closed refusal instead of racing it.
    await expect(changes.plan({ ...context, change: "reset_dev" })).rejects.toMatchObject({
      reason: "data_change_blocked",
    });
  });

  it("seals a fresh protected Dev share link with the accepted change and refuses a protected change without the cipher", async () => {
    const { context, project } = await dataProject("isolated"),
      withoutCipher = createD1ProjectDataChanges({ runtime, clock, ids: ids() }),
      changes = createD1ProjectDataChanges({ runtime, clock, ids: ids(), devAccessCipher: cipher });

    const plan = await changes.plan({ ...context, change: "reset_dev" }),
      body = plan?.body as { resource_etag: string; confirmation_token: string };
    expect(plan).toMatchObject({
      body: { change: "reset_dev", data_mode_before: "isolated", data_mode_after: "isolated" },
    });
    const request = {
      ...mutation(context, "data-change-reset", 31),
      change: "reset_dev" as const,
      ifMatch: body.resource_etag,
      confirmationToken: body.confirmation_token,
    };
    await expect(withoutCipher.change(request)).rejects.toThrow(
      "Protected data changes require the configured share-link cipher",
    );
    expect(await dev(project.projectId)).toEqual({ dev_access_epoch: 1, links: 0 });

    expect(await changes.change(request)).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await dev(project.projectId)).toEqual({ dev_access_epoch: 2, links: 1 });
    const link = await control.core
      .prepare(
        "SELECT generation,revoked_at,length(ciphertext) size FROM dev_share_links WHERE project_id=?",
      )
      .bind(project.projectId)
      .first<{ generation: number; revoked_at: string | null; size: number }>();
    expect(link).toMatchObject({ generation: 1, revoked_at: null });
    expect(link?.size).toBeGreaterThan(16);
  });

  it("resets a virgin Dev environment at access epoch zero, advancing a protected one with its new link, and fails closed on a negative or concurrently moved epoch", async () => {
    // A project is created with Dev access epoch 0 and no share link; the seeding fixture starts at 1.
    const { context, project } = await dataProject("isolated"),
      changes = createD1ProjectDataChanges({ runtime, clock, ids: ids(), devAccessCipher: cipher });
    await control.core
      .prepare("UPDATE environments SET dev_access_epoch=0 WHERE project_id=?1 AND name='dev'")
      .bind(project.projectId)
      .run();
    expect(await dev(project.projectId)).toEqual({ dev_access_epoch: 0, links: 0 });

    const plan = await changes.plan({ ...context, change: "reset_dev" }),
      body = plan?.body as { resource_etag: string; confirmation_token: string },
      request = {
        ...mutation(context, "data-change-virgin", 41),
        change: "reset_dev" as const,
        ifMatch: body.resource_etag,
        confirmationToken: body.confirmation_token,
      };

    // Epoch 0 is the only new value: a negative epoch is refused by the Control reader and by the Core input.
    const tampered = (
      patch: (renewal: Record<string, unknown>) => void,
      where: "read" | "accept",
    ) =>
      createD1ProjectDataChanges({
        runtime: {
          ...runtime,
          readApiProjectDataChangeState: async (input: unknown) => {
            const state = (await runtime.readApiProjectDataChangeState(input)) as {
              renewal?: { scope: Record<string, unknown> };
            } | null;
            if (where === "read" && state?.renewal?.scope) patch(state.renewal.scope);
            return state;
          },
          acceptApiProductOperation: async (input: unknown) => {
            const accept = input as {
              devShareRenewal?: { expected: { scope: Record<string, unknown> } };
            };
            if (where === "accept" && accept.devShareRenewal)
              patch(accept.devShareRenewal.expected.scope);
            return runtime.acceptApiProductOperation(input);
          },
        },
        clock,
        ids: ids(),
        devAccessCipher: cipher,
      });
    for (const where of ["read", "accept"] as const)
      await expect(
        tampered((scope) => (scope["devAccessEpoch"] = -1), where).change(request),
      ).rejects.toMatchObject({ name: "ZodError" });
    expect(await dev(project.projectId)).toEqual({ dev_access_epoch: 0, links: 0 });

    expect(await changes.change(request)).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await dev(project.projectId)).toEqual({ dev_access_epoch: 1, links: 1 });
    expect(
      await control.core
        .prepare(
          "SELECT (SELECT generation FROM dev_share_links WHERE project_id=?1) generation,(SELECT count(*) FROM product_command_intents WHERE project_id=?1 AND event_type='ProjectDataChangeRequestedV1') intents",
        )
        .bind(project.projectId)
        .first(),
    ).toEqual({ generation: 1, intents: 1 });

    // A concurrent ticket moves the epoch to 1 after the read at 0: the renewal is refused, nothing is written.
    const racing = await dataProject("isolated"),
      racingPlan = await changes.plan({ ...racing.context, change: "reset_dev" }),
      racingBody = racingPlan?.body as { resource_etag: string; confirmation_token: string };
    await control.core
      .prepare("UPDATE environments SET dev_access_epoch=0 WHERE project_id=?1 AND name='dev'")
      .bind(racing.project.projectId)
      .run();
    await expect(
      createD1ProjectDataChanges({
        runtime: {
          ...runtime,
          acceptApiProductOperation: async (input: unknown) => {
            await control.core
              .prepare(
                "UPDATE environments SET dev_access_epoch=1 WHERE project_id=?1 AND name='dev'",
              )
              .bind(racing.project.projectId)
              .run();
            return runtime.acceptApiProductOperation(input);
          },
        },
        clock,
        ids: ids(),
        devAccessCipher: cipher,
      }).change({
        ...mutation(racing.context, "data-change-racing", 42),
        change: "reset_dev" as const,
        ifMatch: racingBody.resource_etag,
        confirmationToken: racingBody.confirmation_token,
      }),
    ).rejects.toMatchObject({ reason: "data_change_not_applicable" });
    expect(await dev(racing.project.projectId)).toEqual({ dev_access_epoch: 1, links: 0 });
    expect(
      await control.core
        .prepare(
          "SELECT count(*) intents FROM product_command_intents WHERE project_id=? AND event_type='ProjectDataChangeRequestedV1'",
        )
        .bind(racing.project.projectId)
        .first(),
    ).toEqual({ intents: 0 });

    // A public Dev environment has no link to renew: its reset is admitted and the epoch stays 0.
    const open = await dataProject("isolated");
    await control.core
      .prepare("UPDATE environments SET dev_access_epoch=0 WHERE project_id=?1 AND name='dev'")
      .bind(open.project.projectId)
      .run();
    await control.core
      .prepare("UPDATE projects SET dev_access_mode='public' WHERE project_id=?1")
      .bind(open.project.projectId)
      .run();
    const openPlan = await changes.plan({ ...open.context, change: "reset_dev" }),
      openBody = openPlan?.body as { resource_etag: string; confirmation_token: string };
    expect(
      await changes.change({
        ...mutation(open.context, "data-change-public", 43),
        change: "reset_dev" as const,
        ifMatch: openBody.resource_etag,
        confirmationToken: openBody.confirmation_token,
      }),
    ).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await dev(open.project.projectId)).toEqual({ dev_access_epoch: 0, links: 0 });
  });
});

const ulid = () => parseUlid(newUlid());
async function dev(projectId: string) {
  return control.core
    .prepare(
      "SELECT (SELECT dev_access_epoch FROM environments WHERE project_id=?1 AND name='dev') dev_access_epoch,(SELECT count(*) FROM dev_share_links WHERE project_id=?1) links",
    )
    .bind(projectId)
    .first();
}
