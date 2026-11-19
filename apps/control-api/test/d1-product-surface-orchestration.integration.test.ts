import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeploymentPersistenceConflictError, OrganizationCreditError } from "@ohmyhost/database";
import { createUlidFactory, parseUlid, SystemEntropy } from "@ohmyhost/platform";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { beforeFirstWrite } from "../../control-store/test/support/platform-fixtures.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import {
  releaseProviderClaim,
  seedAcceptedOperation,
  rollbackIntent,
  seedPublishedClaim,
} from "../../control-store/test/support/accepted-operation.js";
import {
  seedWfpPublication,
  sourceFrameworkPlan,
} from "../../control-store/test/support/provider-fixtures.js";
import {
  acceptance,
  configureMail,
  linkSource,
  planDataChange,
  productRig,
  publishedRevision,
  requestDigest,
  type ProductRig,
} from "../../control-store/test/support/product-api-fixture.js";
import {
  IdempotencyKeyReusedError,
  SourceAdmissionPolicyInconsistentError,
} from "../src/contracts.js";
import {
  createD1ProductSurfacePort,
  type D1ProductSurfaceRuntime,
} from "../src/d1-product-surface.js";
import {
  ProductSurfaceUnavailableError,
  type SourceInspectorBinding,
} from "../src/product-surface.js";

import { SharedCoreRouter } from "../../control-store/src/router.js";
import { seedContextPublication } from "../../control-store/test/provisioning/context-source-fixture.js";
import * as replay from "../../control-store/src/catalog/provisioning/workflow-replay-recovery.js";
import { activateProductWorkflowReplayAttempt } from "../../control-store/src/catalog/provisioning/attempt-activation.js";
import { failProductDeployment } from "../../control-store/src/catalog/provisioning/deployment-failure.js";

const NOW = "2026-10-28T11:00:00.000Z";
const COMMIT = "a".repeat(40);
const ulidOf = () => parseUlid(newUlid());

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

/** What the source inspector answers for an exact commit: the shape product-surface parses. */
const inspected = {
  resolvedCommitSha: COMMIT,
  sourceSha256: "b".repeat(64),
  byteLength: 1234,
  frameworkPlan: sourceFrameworkPlan(false),
  buildPlanSha256: "c".repeat(64),
};

/** A Worker-only application: no build output, its own Worker module as the companion source. */
const functionsPlan = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: ".",
  adapter: "functions",
  runtime: "functions",
  installCommand: "npm ci --ignore-scripts",
  compatibilityDate: "2025-01-01",
  compatibilityFlags: ["nodejs_compat"],
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
};
const workerModule = {
  schemaVersion: "ohmyhost.worker-module/v1",
  path: "src/ohmyhost/worker.ts",
  byteLength: 120,
  sha256: "d".repeat(64),
};

/** A plain source inspector (external service binding): each call takes the next scripted answer or the default. */
function inspector(answer: () => unknown = () => inspected) {
  const calls: unknown[] = [];
  const queue: (() => unknown)[] = [];
  const binding: SourceInspectorBinding = {
    validateRepositoryLink: async () => {
      throw new Error("unused");
    },
    inspectExact: async (input) => {
      calls.push(input);
      return (queue.shift() ?? answer)();
    },
  };
  return {
    binding,
    calls,
    answer: (value: unknown) => queue.push(() => value),
    refuse: (error: unknown) =>
      queue.push(() => {
        throw error;
      }),
  };
}

/** The customer-facing product port over the real Core of one project; the clock is a plain fixture. */
function surfaceOf(
  rig: ProductRig,
  options: {
    readonly sourceInspector?: SourceInspectorBinding;
    readonly now?: () => Date;
    readonly runtime?: D1ProductSurfaceRuntime;
  } = {},
) {
  const clock = { now: options.now ?? (() => new Date(NOW)) };
  return createD1ProductSurfacePort({
    runtime: options.runtime ?? (rig.store.productApi as unknown as D1ProductSurfaceRuntime),
    clock,
    ids: createUlidFactory({ clock: { now: () => new Date(NOW) }, entropy: new SystemEntropy() }),
    sourceInspector: options.sourceInspector ?? inspector().binding,
    dataChanges: { plan: async () => null, change: async () => null },
  });
}
const contextOf = (rig: ProductRig) => ({
  organizationId: parseUlid(rig.organizationId),
  projectId: parseUlid(rig.projectId),
  principalId: rig.principalId,
  requestId: "req-orchestration",
});
/** One published Dev deployment whose plan uses the project's database, so a rollback or promotion touches data. */
async function publishedWithDatabase(rig: ProductRig) {
  const { published } = await seedPublishedClaim(rig, rig.devEnvironmentId, (operationId) =>
    seedWfpPublication(rig, {
      operationId,
      environmentId: rig.devEnvironmentId,
      frameworkPlan: sourceFrameworkPlan(true),
    }),
  );
  await releaseProviderClaim(rig);
  return published;
}
/** The Core of a project with `before` running just ahead of the acceptance: a change that lands between check and write. */
function racing(rig: ProductRig, before: () => Promise<unknown>) {
  const api = rig.store.productApi;
  return {
    ...api,
    acceptApiProductOperation: async (input: unknown) => {
      await before();
      return api.acceptApiProductOperation(input);
    },
  } as unknown as D1ProductSurfaceRuntime;
}
/** The ready managed source of the project: what linkSource makes for GitHub, with the repository the platform hosts. */
async function linkManagedSource(rig: ProductRig) {
  const db = rig.control.core,
    sourceConnectionId = newUlid(),
    grantId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'managed','acme/shop',?5)",
      )
      .bind(rig.organizationId, sourceConnectionId, rig.projectId, rig.billingEpochId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'managed',NULL,'acme/shop','acme','shop','contents:read',?6)",
      )
      .bind(
        rig.organizationId,
        grantId,
        rig.projectId,
        rig.billingEpochId,
        sourceConnectionId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at) VALUES(?1,?2,?3,'managed',1,?4,?5)",
      )
      .bind(rig.organizationId, rig.projectId, sourceConnectionId, COMMIT, STORED_NOW),
    db
      .prepare(
        "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'managed',NULL,'acme/shop','acme','shop','ready',1,?6,?6)",
      )
      .bind(rig.organizationId, rig.projectId, newUlid(), rig.billingEpochId, grantId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO cloudflare_project_domains(organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,mail_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at) VALUES(?1,?2,?3,?4,'omh.st',?5,?6,NULL,'user:fixture',?7,?7,?8)",
      )
      .bind(
        rig.organizationId,
        rig.projectId,
        rig.input.operation.operationId,
        rig.handle,
        `${rig.handle}.check.omh.st`,
        `dev-${rig.handle}.check.omh.st`,
        new Uint8Array(32).fill(3),
        STORED_NOW,
      ),
  ]);
  return { sourceConnectionId };
}
const run = async (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .run();
let keys = 0;
const mutationOf = (rig: ProductRig) => ({
  ...contextOf(rig),
  idempotencyKey: `orchestration-${++keys}`,
  canonicalRequestDigest: requestDigest(),
});

describe("product surface source and push-to-deploy", () => {
  it("serves the GitHub source of an active project and the auto-deploy configuration with its replays", async () => {
    const rig = await productRig(control),
      surface = surfaceOf(rig),
      context = contextOf(rig);
    // A project without a linked source has none to show.
    expect(await surface.getSource(context)).toBeNull();
    expect(await surface.getAutoDeploy(context)).toEqual({
      status: 200,
      body: {
        branch: null,
        ref: null,
        environment: "dev",
        enabled: false,
        generation: 0,
        grant_status: null,
        updated_at: null,
      },
    });
    const { sourceConnectionId, grantId } = await linkSource(rig);
    expect(await surface.getSource(context)).toEqual({
      status: 200,
      body: {
        provider: "github",
        source_connection_id: sourceConnectionId,
        source_generation: 1,
        installation_id: "7",
        repository_full_name: "o/r",
        status: "ready",
        linked_at: "2026-10-28T10:00:00.000Z",
        updated_at: "2026-10-28T10:00:00.000Z",
      },
    });
    // Another organization's project is never answered.
    expect(await surface.getSource({ ...context, projectId: ulidOf() })).toBeNull();

    const configure = { ...mutationOf(rig), branchRef: "refs/heads/release", enabled: true };
    const configured = await surface.configureAutoDeploy(configure);
    expect(configured).toEqual({
      status: 200,
      body: {
        branch: "release",
        ref: "refs/heads/release",
        environment: "dev",
        enabled: true,
        generation: 1,
        grant_status: "active",
        updated_at: NOW,
      },
    });
    expect(await surface.configureAutoDeploy(configure)).toEqual(configured);
    expect(await surface.getAutoDeploy(context)).toEqual(configured);
    await expect(
      surface.configureAutoDeploy({ ...configure, canonicalRequestDigest: requestDigest() }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

    // A revoked grant is reported as such and no longer takes a new enablement.
    await control.core
      .prepare(
        "INSERT INTO repository_grant_revocations(organization_id,revocation_id,grant_id,project_id,reason,revoked_at) VALUES(?1,?2,?3,?4,'permission_revoked',?5)",
      )
      .bind(rig.organizationId, newUlid(), grantId, rig.projectId, STORED_NOW)
      .run();
    expect(await surface.getAutoDeploy(context)).toMatchObject({
      body: { grant_status: "revoked", enabled: true },
    });
    await expect(surface.configureAutoDeploy(mutationOfEnable(rig))).rejects.toMatchObject({
      reason: "auto_deploy_source_unavailable",
    });
  }, 60_000);

  it("refuses enabling auto-deploy on a platform-hosted source, which no GitHub push reaches", async () => {
    const rig = await productRig(control);
    await linkManagedSource(rig);
    await expect(surfaceOf(rig).configureAutoDeploy(mutationOfEnable(rig))).rejects.toMatchObject({
      reason: "auto_deploy_source_unavailable",
    });
  });
});

describe("product surface managed source", () => {
  it("shows the platform-hosted source and plans its commit with the managed grant", async () => {
    const rig = await productRig(control),
      { sourceConnectionId } = await linkManagedSource(rig),
      source = inspector(),
      surface = surfaceOf(rig, { sourceInspector: source.binding }),
      context = contextOf(rig);
    expect(await surface.getSource(context)).toMatchObject({
      status: 200,
      body: {
        provider: "managed",
        source_connection_id: sourceConnectionId,
        namespace: "acme",
        repository_name: "shop",
        branch: "main",
        status: "ready",
      },
    });
    await surface.planDeployment({ ...context, commitSha: COMMIT });
    expect(source.calls[0]).toMatchObject({
      provider: "managed",
      region: "eu",
      repository: { owner: "acme", name: "shop", externalRepositoryId: "acme/shop" },
      grant: { status: "approved", installationId: null, repositoryId: "acme/shop" },
    });
  }, 60_000);
});

describe("product surface deployments", () => {
  it("plans an inspected commit, accepts the deployment against its plan once and lists and reads it", async () => {
    const rig = await productRig(control),
      { sourceConnectionId } = await linkSource(rig),
      source = inspector(),
      surface = surfaceOf(rig, { sourceInspector: source.binding }),
      context = contextOf(rig);

    const planned = await surface.planDeployment({ ...context, commitSha: COMMIT });
    expect(planned).toMatchObject({
      status: 200,
      body: {
        project_id: rig.projectId,
        environment: "dev",
        commit_sha: COMMIT,
        source_digest: `sha256:${"b".repeat(64)}`,
        build_plan_digest: `sha256:${"c".repeat(64)}`,
        application_root: ".",
        runtime: "cloudflare_workers_edge_ssr",
        created_at: NOW,
        expires_at: "2026-10-29T11:00:00.000Z",
        limits: expect.arrayContaining([expect.stringContaining("32 MiB")]),
      },
    });
    // The GitHub grant is handed to the inspector with its numeric provider identifiers.
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]).toMatchObject({
      sourceConnectionId,
      commitSha: COMMIT,
      repository: { owner: "o", name: "r", externalRepositoryId: "42" },
      grant: { status: "approved", installationId: 7, repositoryId: 42, revokedAt: null },
    });
    const planId = parseUlid(String(planned.body["id"]));

    const request = { ...mutationOf(rig), planId };
    const accepted = await surface.createDeployment(request);
    expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await surface.createDeployment(request)).toEqual(accepted);
    await expect(
      surface.createDeployment({ ...request, canonicalRequestDigest: requestDigest() }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    // A plan this project never made, or one past its day, cannot be deployed.
    await expect(
      surface.createDeployment({ ...mutationOf(rig), planId: ulidOf() }),
    ).rejects.toMatchObject({ reason: "deployment_plan_expired" });
    const late = surfaceOf(rig, { now: () => new Date("2026-10-29T11:00:00.001Z") });
    await expect(late.createDeployment({ ...mutationOf(rig), planId })).rejects.toMatchObject({
      reason: "deployment_plan_expired",
    });

    // A plan that lapses while the deployment is accepted is expired, whatever the first read saw.
    let reads = 0;
    const lapsing = surfaceOf(rig, {
      now: () => new Date(reads++ === 0 ? NOW : "2026-10-29T11:00:00.001Z"),
    });
    await expect(lapsing.createDeployment({ ...mutationOf(rig), planId })).rejects.toMatchObject({
      reason: "deployment_plan_expired",
    });
    // A stored plan this release cannot read is incompatible; any other Core failure passes through.
    const unreadable = (error: Error) =>
      surfaceOf(rig, {
        runtime: {
          ...(rig.store.productApi as unknown as D1ProductSurfaceRuntime),
          readApiDeploymentPlan: async () => {
            throw error;
          },
        },
      }).createDeployment({ ...mutationOf(rig), planId });
    await expect(unreadable(new TypeError("Invalid framework plan"))).rejects.toMatchObject({
      reason: "deployment_plan_incompatible",
    });
    await expect(unreadable(new Error("core down"))).rejects.toThrow("core down");

    const page = await surface.listDeployments({ ...context, limit: 20 });
    expect(page).toMatchObject({
      status: 200,
      body: { items: [{ project_id: rig.projectId, status: "queued" }] },
    });
    const deploymentId = parseUlid(String((page.body["items"] as { id: string }[])[0]?.id));

    // A second queued deployment makes a page of one continue with a cursor.
    const second = await surface.planDeployment({ ...context, commitSha: COMMIT });
    await surface.createDeployment({
      ...mutationOf(rig),
      planId: parseUlid(String(second.body["id"])),
    });
    const first = await surface.listDeployments({ ...context, limit: 1 });
    expect(first.body["items"]).toHaveLength(1);
    const cursor = String(first.body["next_cursor"]);
    const rest = await surface.listDeployments({ ...context, limit: 1, cursor });
    expect(rest.body["items"]).toHaveLength(1);
    expect(rest.body).not.toHaveProperty("next_cursor");
    expect((rest.body["items"] as { id: string }[])[0]?.id).not.toBe(
      (first.body["items"] as { id: string }[])[0]?.id,
    );
    expect(await surface.getDeployment({ ...context, deploymentId })).toMatchObject({
      status: 200,
      body: { id: deploymentId, status: "queued" },
      etag: expect.stringMatching(/^"sha256-[0-9a-f]{64}"$/u),
    });
    expect(await surface.getDeployment({ ...context, deploymentId: ulidOf() })).toBeNull();
    const foreign = { ...context, projectId: ulidOf() };
    expect(await surface.getDeployment({ ...foreign, deploymentId })).toBeNull();
    await expect(surface.listDeployments({ ...foreign, limit: 20 })).rejects.toBeInstanceOf(
      ProductSurfaceUnavailableError,
    );
  }, 60_000);
});

describe("product surface deployment planning refusals", () => {
  it("turns each coded refusal of the source inspector into its closed conflict and rethrows anything else", async () => {
    const rig = await productRig(control);
    await linkSource(rig);
    const source = inspector(),
      surface = surfaceOf(rig, { sourceInspector: source.binding }),
      plan = (error: unknown) => {
        source.refuse(error);
        return surface.planDeployment({ ...contextOf(rig), commitSha: COMMIT });
      };
    for (const code of ["requested_commit_not_found", "source_commit_not_found"])
      await expect(plan({ code })).rejects.toMatchObject({ reason: "source_commit_not_found" });
    await expect(
      plan({
        code: "source_runtime_workers_incompatible",
        findings: [{ code: "workers_node_stub_module", path: "src/a.ts", module: "node:fs" }],
      }),
    ).rejects.toMatchObject({ reason: "workers_runtime_incompatible" });
    // Without its findings the refusal is not the Workers refusal and passes through unchanged.
    const unfound = { code: "source_runtime_workers_incompatible" };
    await expect(plan(unfound)).rejects.toBe(unfound);
    await expect(plan({ code: "source_repository_configuration_missing" })).rejects.toMatchObject({
      reason: "repository_configuration_missing",
    });
    await expect(plan({ code: "source_migration_filename_noncanonical" })).rejects.toMatchObject({
      reason: "migration_filename_noncanonical",
    });
    const unrelated = new Error("provider down");
    await expect(plan(unrelated)).rejects.toBe(unrelated);

    // A framework conversion names the adapter's requirement and, when the inspector found one, the file to fix.
    await expect(
      plan({
        code: "source_framework_conversion_required",
        adapter: "tanstack-start",
        requirement: "tanstack-adapter",
      }),
    ).rejects.toMatchObject({ reason: "framework_conversion_required", diagnostic: null });
    const syntax = { code: "source_syntax_invalid", path: "app/page.tsx" };
    await expect(
      plan({
        code: "source_framework_conversion_required",
        adapter: "nextjs",
        requirement: "nextjs-adapter",
        diagnostic: syntax,
      }),
    ).rejects.toMatchObject({ reason: "framework_conversion_required", diagnostic: syntax });
    const manifest = { code: "package_manifest_invalid", path: "site/package.json" };
    await expect(
      plan({
        code: "source_framework_conversion_required",
        adapter: null,
        requirement: null,
        diagnostic: manifest,
      }),
    ).rejects.toMatchObject({ reason: "framework_conversion_required", diagnostic: manifest });
    // An adapter paired with another adapter's requirement, or no adapter without a diagnostic, is a platform fault.
    for (const mismatched of [
      { adapter: "tanstack-start", requirement: "vite-adapter" },
      { adapter: "nextjs", requirement: null },
      { adapter: null, requirement: null, diagnostic: null },
    ]) {
      const error = { code: "source_framework_conversion_required", ...mismatched };
      await expect(plan(error)).rejects.toBe(error);
    }

    // The refused framework version is decided again with Control's own policy; they must agree.
    const declared = {
      code: "framework_version_unsupported",
      path: "site/package.json",
      package: "next",
      version: "16.4.4",
      minimum: "16.4.5",
    };
    const locked = { ...declared, path: "site/pnpm-lock.yaml", version: "15.5.27" };
    for (const agreed of [declared, locked])
      await expect(
        plan({
          code: "source_framework_conversion_required",
          adapter: "nextjs",
          requirement: "nextjs-adapter",
          diagnostic: agreed,
        }),
      ).rejects.toMatchObject({ reason: "framework_conversion_required", diagnostic: agreed });
    for (const disputed of [
      { ...declared, version: "16.4.5", minimum: "16.3.6" },
      { ...declared, minimum: "16.3.8" },
      { ...locked, version: "^16.4.0" },
    ])
      await expect(
        plan({
          code: "source_framework_conversion_required",
          adapter: "nextjs",
          requirement: "nextjs-adapter",
          diagnostic: disputed,
        }),
      ).rejects.toBeInstanceOf(SourceAdmissionPolicyInconsistentError);
  }, 60_000);

  it("refuses an inspection that is not exactly the inspected commit and a project without a source", async () => {
    const rig = await productRig(control),
      context = contextOf(rig),
      source = inspector();
    await expect(
      surfaceOf(rig, { sourceInspector: source.binding }).planDeployment({
        ...context,
        commitSha: COMMIT,
      }),
    ).rejects.toBeInstanceOf(ProductSurfaceUnavailableError);
    expect(source.calls).toHaveLength(0);

    await linkSource(rig);
    const surface = surfaceOf(rig, { sourceInspector: source.binding }),
      worker = { ...inspected, frameworkPlan: functionsPlan, companionSource: workerModule };
    for (const bad of [
      null,
      { ...inspected, frameworkPlan: { schemaVersion: "ohmyhost.framework-plan/v1" } },
      { ...inspected, extra: true },
      { ...inspected, resolvedCommitSha: "d".repeat(40) },
      { ...inspected, sourceSha256: "B".repeat(64) },
      { ...inspected, buildPlanSha256: "c".repeat(63) },
      { ...inspected, byteLength: 0 },
      { ...inspected, byteLength: 1.5 },
      // A Worker module needs its companion source, exactly named.
      Object.fromEntries(Object.entries(worker).filter(([key]) => key !== "companionSource")),
      {
        ...worker,
        companionSource: { ...workerModule, schemaVersion: "ohmyhost.vite-api-companion/v1" },
      },
      { ...worker, companionSource: { ...workerModule, path: "src/ohmyhost/companion.ts" } },
      { ...worker, companionSource: { ...workerModule, byteLength: 256 * 1024 + 1 } },
      { ...worker, companionSource: { ...workerModule, sha256: "invalid" } },
      { ...worker, companionSource: { ...workerModule, extra: 1 } },
    ]) {
      source.answer(bad);
      await expect(
        surface.planDeployment({ ...context, commitSha: COMMIT }),
      ).rejects.toBeInstanceOf(ProductSurfaceUnavailableError);
    }
    // A GitHub installation that is not a positive integer never reaches the inspector.
    for (const installationId of ["0", null]) {
      const unsafe = surfaceOf(rig, {
        sourceInspector: source.binding,
        runtime: {
          ...(rig.store.productApi as unknown as D1ProductSurfaceRuntime),
          readApiPlanningSource: async (input: unknown) => ({
            ...((await rig.store.productApi.readApiPlanningSource(input)) as object),
            installationId,
          }),
        },
      });
      const before = source.calls.length;
      await expect(unsafe.planDeployment({ ...context, commitSha: COMMIT })).rejects.toBeInstanceOf(
        ProductSurfaceUnavailableError,
      );
      expect(source.calls).toHaveLength(before);
    }
  }, 60_000);
});

describe("product surface deployment planning targets", () => {
  it("plans Worker-only and Vite companion applications and stores them for deployment", async () => {
    const rig = await productRig(control);
    await linkSource(rig);
    const source = inspector(),
      surface = surfaceOf(rig, { sourceInspector: source.binding }),
      context = contextOf(rig);
    source.answer({ ...inspected, frameworkPlan: functionsPlan, companionSource: workerModule });
    const worker = await surface.planDeployment({ ...context, commitSha: COMMIT });
    expect(worker).toMatchObject({
      status: 200,
      body: {
        runtime: "cloudflare_workers_edge_ssr",
        limits: ["The build is limited to 8 minutes."],
      },
    });
    const vite = {
      ...functionsPlan,
      adapter: "vite-static",
      runtime: "edge",
      buildCommand: "npm run build",
      outputDirectory: "dist",
      serverOutputDirectory: ".ohmyhost/vite-companion",
      serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
      serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
      runtimePolicy: { healthCheckPath: "/api/health", egressAllowedOrigins: [] },
    };
    source.answer({
      ...inspected,
      frameworkPlan: vite,
      companionSource: {
        schemaVersion: "ohmyhost.vite-api-companion/v1",
        path: "src/ohmyhost/companion.ts",
        byteLength: 15_871,
        sha256: "6".repeat(64),
      },
    });
    const companion = await surface.planDeployment({ ...context, commitSha: COMMIT });
    expect(companion).toMatchObject({
      status: 200,
      body: { runtime: "cloudflare_workers_edge_ssr" },
    });
    source.answer({
      ...inspected,
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: ".",
        adapter: "vite-static",
        runtime: "static",
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm run build",
        outputDirectory: "dist",
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      },
    });
    const staticSite = await surface.planDeployment({ ...context, commitSha: COMMIT });
    expect(staticSite).toMatchObject({
      status: 200,
      body: { runtime: "cloudflare_workers_static_assets" },
    });
    // Each plan is stored as inspected, so the deployment that follows builds exactly it.
    for (const planned of [worker, companion, staticSite]) {
      const planId = parseUlid(String(planned.body["id"]));
      expect(await surface.createDeployment({ ...mutationOf(rig), planId })).toMatchObject({
        status: 202,
        body: { state: "queued" },
      });
    }
  }, 60_000);

  it("plans a direct Prod build with shared data and refuses a storage region or Mail domain the project lacks", async () => {
    const rig = await productRig(control);
    await linkSource(rig);
    const source = inspector(),
      surface = surfaceOf(rig, { sourceInspector: source.binding }),
      context = contextOf(rig);
    source.answer({ ...inspected, frameworkPlan: sourceFrameworkPlan(false) });
    const prod = await surface.planDeployment({
      ...context,
      commitSha: COMMIT,
      environment: "prod",
    });
    expect(prod).toMatchObject({
      status: 200,
      body: {
        environment: "prod",
        route: expect.not.stringContaining("dev-"),
        risks: expect.arrayContaining([expect.stringContaining("straight into Prod")]),
      },
    });
    const dev = await surface.planDeployment({ ...context, commitSha: COMMIT });
    expect(dev.body["route"]).toContain("dev-");
    expect(dev.body["risks"]).not.toContainEqual(expect.stringContaining("straight into Prod"));

    const prodOnlyRig = await productRig(control, { prodOnly: true });
    await linkSource(prodOnlyRig);
    const prodOnlySurface = surfaceOf(prodOnlyRig);
    const prodOnlyContext = contextOf(prodOnlyRig);
    expect(
      await prodOnlySurface.planDeployment({ ...prodOnlyContext, commitSha: COMMIT }),
    ).toMatchObject({
      status: 200,
      body: { environment: "prod", route: expect.not.stringContaining("dev-") },
    });
    await expect(
      prodOnlySurface.planDeployment({ ...prodOnlyContext, commitSha: COMMIT, environment: "dev" }),
    ).rejects.toMatchObject({ reason: "development_environment_missing" });
    await expect(
      prodOnlySurface.configureAutoDeploy({
        ...mutationOf(prodOnlyRig),
        branchRef: "refs/heads/main",
        enabled: true,
      }),
    ).rejects.toMatchObject({ reason: "development_environment_missing" });
    expect(
      await prodOnlySurface.configureAutoDeploy({
        ...mutationOf(prodOnlyRig),
        branchRef: "refs/heads/main",
        enabled: false,
      }),
    ).toMatchObject({ status: 200, body: { enabled: false } });

    // The direct plan makes the effect on the shared database explicit and can be accepted.
    source.answer({ ...inspected, frameworkPlan: sourceFrameworkPlan(true) });
    const sharedProd = await surface.planDeployment({
      ...context,
      commitSha: COMMIT,
      environment: "prod",
    });
    expect(sharedProd).toMatchObject({
      status: 200,
      body: { risks: expect.arrayContaining([expect.stringContaining("share data")]) },
    });
    const mutation = { ...mutationOf(rig), planId: parseUlid(String(sharedProd.body["id"])) };
    const accepted = await surface.createDeployment(mutation);
    expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await surface.createDeployment(mutation)).toEqual(accepted);
    expect(await surface.planDeployment({ ...context, commitSha: COMMIT })).toMatchObject({
      status: 200,
    });

    // The project stores its files in the EU, so ohmyhost.yaml cannot ask for the US.
    source.answer({
      ...inspected,
      frameworkPlan: {
        ...sourceFrameworkPlan(false),
        storage: { enabled: true, provider: "r2", jurisdiction: "us", public: false },
      },
    });
    await expect(surface.planDeployment({ ...context, commitSha: COMMIT })).rejects.toMatchObject({
      reason: "storage_jurisdiction_conflict",
    });
    // Mail needs the project's sender domain; the Core refuses the plan without it.
    source.answer({
      ...inspected,
      frameworkPlan: { ...sourceFrameworkPlan(false), mail: { enabled: true } },
    });
    await expect(surface.planDeployment({ ...context, commitSha: COMMIT })).rejects.toMatchObject({
      reason: "mail_domain_required",
    });
    // With the domain configured the Core still asks for Paid access, and that refusal is not rewritten.
    await configureMail(rig);
    source.answer({
      ...inspected,
      frameworkPlan: { ...sourceFrameworkPlan(false), mail: { enabled: true } },
    });
    await expect(surface.planDeployment({ ...context, commitSha: COMMIT })).rejects.toBeInstanceOf(
      OrganizationCreditError,
    );
  }, 60_000);
});

/** Legacy NULL intent remains immutable: supported recovery may only fail it, without touching the active app. */
async function legacyRollbackRecovery() {
  const rig = await productRig(control);
  await linkSource(rig);
  const { published } = await seedPublishedClaim(rig, rig.devEnvironmentId, (operationId) =>
    seedContextPublication(rig, { operationId, environmentId: rig.devEnvironmentId }),
  );
  await releaseProviderClaim(rig);
  const accepted = await seedAcceptedOperation(rig, rig.devEnvironmentId, {
    eventType: "DeploymentRollbackRequestedV1",
    claim: false,
    intent: (operationId) => rollbackIntent(rig, operationId, rig.devEnvironmentId, published),
  });
  const scope = {
    organizationId: parseUlid(rig.organizationId),
    operationId: parseUlid(accepted.operationId),
  };
  const db = control.core,
    context = { directory: db, router: new SharedCoreRouter(db) };
  const head = () =>
    db
      .prepare(
        "SELECT active_deployment_id,active_revision_id,head_version FROM environments WHERE organization_id=?1 AND environment_id=?2",
      )
      .bind(rig.organizationId, rig.devEnvironmentId)
      .first();
  const originalHead = await head();
  const immutable = () =>
    db
      .prepare("SELECT * FROM product_command_intents WHERE organization_id=?1 AND operation_id=?2")
      .bind(rig.organizationId, accepted.operationId)
      .first();
  const originalIntent = await immutable();
  expect(originalIntent?.["source_generation"]).toBeNull();
  await expect(
    rig.store.provisioning.assertExecution({ ...scope, projectId: rig.projectId }),
  ).rejects.toHaveProperty("name", "OperationAuthorizationConflictError");
  await db
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(accepted.eventId, "2026-10-28T12:01:00.000000Z")
    .run();
  const prepare = async (fill: number) => {
    const candidate = await replay.findProductWorkflowReplayCandidate(context, scope);
    if (!candidate) throw new Error("Missing legacy rollback recovery candidate");
    const attemptId = parseUlid(newUlid());
    const input = {
      ...candidate,
      attemptId,
      physicalWorkflowId: `product-command-replay-v1-${attemptId}`,
      actorId: "user:legacy-recovery",
      idempotencyDigest: new Uint8Array(32).fill(fill),
      preparedAt: "2026-10-28T12:02:00.000Z",
    };
    expect(await replay.prepareProductWorkflowReplay(context, input)).toBe("prepared");
    await activateProductWorkflowReplayAttempt(context, {
      attemptId,
      physicalWorkflowId: input.physicalWorkflowId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      operationId: input.operationId,
      eventId: input.eventId,
    });
    return input;
  };
  const first = await prepare(1);
  const input = {
    workflowId: accepted.workflowId,
    organizationId: rig.organizationId,
    projectId: rig.projectId,
    environmentId: rig.devEnvironmentId,
    operationId: accepted.operationId,
    outboxEventId: accepted.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    actorId: "deployment-workflow",
    errorCode: "AUTHORIZATION_CHANGED",
    failedAt: "2026-10-28T12:03:00.000Z",
  };
  let second: Awaited<ReturnType<typeof prepare>> | undefined,
    rejectedBatch = 0;
  const boundary = beforeFirstWrite(db, async () => {
    await replay.recoverTerminalProductWorkflowReplay(context, {
      ...scope,
      attemptId: first.attemptId,
      failureId: parseUlid(newUlid()),
      actorId: first.actorId,
      terminalStatus: "errored",
      evidenceDigest: new Uint8Array(32).fill(4),
      recoveredAt: "2026-10-28T12:02:01.000Z",
    });
    second = await prepare(2);
  });
  const raced = {
    ...boundary,
    batch: async (statements: Parameters<typeof db.batch>[0]) => {
      try {
        return await boundary.batch(statements);
      } catch (error) {
        rejectedBatch++;
        // The A snapshot cannot clear B or leave any terminal history before a lawful reread.
        expect(
          await db
            .prepare(
              "SELECT state,active_replay_attempt_id FROM product_workflow_runs WHERE workflow_id=?1",
            )
            .bind(accepted.workflowId)
            .first(),
        ).toEqual({ state: "queued", active_replay_attempt_id: second?.attemptId });
        expect(
          await db
            .prepare(
              "SELECT count(*) n FROM operation_events WHERE organization_id=?1 AND operation_id=?2",
            )
            .bind(rig.organizationId, accepted.operationId)
            .first(),
        ).toEqual({ n: 0 });
        expect(
          await db
            .prepare(
              "SELECT count(*) n FROM audit_events WHERE organization_id=?1 AND operation_id=?2 AND event_type='DeploymentRollbackRequestedV1Failed'",
            )
            .bind(rig.organizationId, accepted.operationId)
            .first(),
        ).toEqual({ n: 0 });
        throw error;
      }
    },
  };
  expect(
    await failProductDeployment({ directory: raced, router: new SharedCoreRouter(raced) }, input),
  ).toBe("failed");
  expect(rejectedBatch).toBe(1);
  expect(await failProductDeployment(context, input)).toBe("replayed");
  for (const attempt of [first, second]) {
    if (!attempt) throw new Error("Missing second replay attempt");
    expect(
      await replay.readProductWorkflowReplayAttempt(context, {
        ...scope,
        attemptId: attempt.attemptId,
        actorId: attempt.actorId,
        idempotencyDigest: attempt.idempotencyDigest,
      }),
    ).toEqual({ outcome: "completed", attemptId: attempt.attemptId });
  }
  expect(
    await db
      .prepare("SELECT state,failure FROM operations WHERE organization_id=?1 AND operation_id=?2")
      .bind(rig.organizationId, accepted.operationId)
      .first(),
  ).toMatchObject({ state: "failed", failure: expect.stringContaining('"AUTHORIZATION_CHANGED"') });
  expect(
    await db
      .prepare("SELECT status FROM deployments WHERE organization_id=?1 AND deployment_id=?2")
      .bind(rig.organizationId, accepted.intent.deployment_id)
      .first(),
  ).toEqual({ status: "failed" });
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM product_provider_mutation_claims WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(rig.organizationId, accepted.operationId)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM product_workflow_replay_attempts WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(rig.organizationId, accepted.operationId)
      .first(),
  ).toEqual({ n: 2 });
  expect(await immutable()).toEqual(originalIntent);
  expect(await head()).toEqual(originalHead);
}

describe("product surface rollback", () => {
  it("lists, reads and rolls back a Prod-only project's published deployment", async () => {
    const rig = await productRig(control, { prodOnly: true });
    await linkSource(rig);
    const published = await publishedRevision(rig, rig.prodEnvironmentId);
    const surface = surfaceOf(rig),
      context = contextOf(rig);
    const targetDeploymentId = parseUlid(published.deploymentId);
    const listed = await surface.listDeployments({ ...context, limit: 10 });
    expect(listed).toMatchObject({
      status: 200,
      body: {
        items: expect.arrayContaining([expect.objectContaining({ id: targetDeploymentId })]),
      },
    });
    expect(
      await surface.getDeployment({ ...context, deploymentId: targetDeploymentId }),
    ).toMatchObject({ status: 200, body: { id: targetDeploymentId } });
    const plan = await surface.planRollback({ ...context, targetDeploymentId });
    expect(plan).toMatchObject({
      status: 200,
      body: { action: "rollback", target_deployment_id: targetDeploymentId },
    });
    const rollback = {
      ...mutationOf(rig),
      targetDeploymentId,
      ifMatch: String(plan?.body["resource_etag"]),
      confirmationToken: String(plan?.body["confirmation_token"]),
    };
    const accepted = await surface.rollback(rollback);
    expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await surface.rollback(rollback)).toEqual(accepted);
  }, 60_000);

  it("plans and accepts a rollback to a published deployment over its one-time confirmation", async () => {
    for (const bound of [true, false]) {
      const rig = await productRig(control);
      const { sourceConnectionId } = await linkManagedSource(rig);
      const published = await publishedRevision(rig, rig.devEnvironmentId),
        surface = surfaceOf(rig),
        context = contextOf(rig),
        targetDeploymentId = parseUlid(published.deploymentId);

      // An ordinary managed commit changes the head, not the source-selection generation. The target remains immutable.
      if (bound)
        await run(
          "UPDATE project_source_bindings SET commit_sha=?3 WHERE organization_id=?1 AND project_id=?2",
          rig.organizationId,
          rig.projectId,
          "b".repeat(40),
        );
      else
        await run(
          "DELETE FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2",
          rig.organizationId,
          rig.projectId,
        );
      const generation = bound ? 1 : 0;
      expect(await surface.planRollback({ ...context, targetDeploymentId: ulidOf() })).toBeNull();
      const plan = await surface.planRollback({ ...context, targetDeploymentId });
      expect(plan).toMatchObject({
        status: 200,
        body: {
          action: "rollback",
          project_id: rig.projectId,
          target_deployment_id: published.deploymentId,
          target_artifact_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          resource_etag: expect.stringMatching(/^"sha256-[0-9a-f]{64}"$/u),
          confirmation_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          created_at: NOW,
          expires_at: "2026-10-28T11:10:00.000Z",
        },
      });
      const rollback = {
        ...mutationOf(rig),
        targetDeploymentId,
        ifMatch: String(plan?.body["resource_etag"]),
        confirmationToken: String(plan?.body["confirmation_token"]),
      };
      expect(await surface.rollback({ ...rollback, projectId: ulidOf() })).toBeNull();
      expect(await surface.rollback({ ...rollback, targetDeploymentId: ulidOf() })).toBeNull();
      await expect(surface.rollback({ ...rollback, ifMatch: '"sha256-0"' })).rejects.toMatchObject({
        reason: "etag_mismatch",
      });
      await expect(
        surface.rollback({ ...rollback, confirmationToken: "A".repeat(43) }),
      ).rejects.toMatchObject({ reason: "confirmation_invalid" });

      const accepted = await surface.rollback(rollback);
      expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
      expect(await surface.rollback(rollback)).toEqual(accepted);
      const operationId = parseUlid(String(accepted?.body["id"]));
      const execution = {
        organizationId: rig.organizationId,
        projectId: rig.projectId,
        operationId,
      };
      expect(
        await control.core
          .prepare(
            "SELECT source_generation FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(rig.organizationId, rig.projectId, operationId)
          .first(),
      ).toEqual({ source_generation: generation });
      await expect(rig.store.provisioning.assertExecution(execution)).resolves.toBeUndefined();
      // The confirmation was consumed by the first acceptance and cannot authorize another request.
      await expect(
        surface.rollback({ ...rollback, idempotencyKey: "second-rollback" }),
      ).rejects.toMatchObject({ reason: "confirmation_invalid" });
      if (bound) {
        const fresh = await surface.planRollback({ ...context, targetDeploymentId });
        const rejectedOperationCount = await control.core
          .prepare("SELECT count(*) n FROM operations WHERE organization_id=?1 AND project_id=?2")
          .bind(rig.organizationId, rig.projectId)
          .first();
        const raced = createControlStore({
          CONTROL_CORE: beforeFirstWrite(control.core, () =>
            run(
              "UPDATE project_source_bindings SET generation=generation+1 WHERE organization_id=?1 AND project_id=?2",
              rig.organizationId,
              rig.projectId,
            ).then(() => undefined),
          ),
        });
        await expect(
          surfaceOf(rig, {
            runtime: raced.productApi as unknown as D1ProductSurfaceRuntime,
          }).rollback({
            ...mutationOf(rig),
            targetDeploymentId,
            ifMatch: String(fresh?.body["resource_etag"]),
            confirmationToken: String(fresh?.body["confirmation_token"]),
          }),
        ).rejects.toThrow();
        expect(
          await control.core
            .prepare("SELECT count(*) n FROM operations WHERE organization_id=?1 AND project_id=?2")
            .bind(rig.organizationId, rig.projectId)
            .first(),
        ).toEqual(rejectedOperationCount);
        expect(
          await control.core
            .prepare(
              "SELECT consumed_at FROM action_confirmations WHERE organization_id=?1 AND project_id=?2 AND consumed_at IS NULL",
            )
            .bind(rig.organizationId, rig.projectId)
            .all(),
        ).toMatchObject({ results: expect.arrayContaining([{ consumed_at: null }]) });
      } else
        await run(
          "INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at) VALUES(?1,?2,?3,'managed',1,?4,?5)",
          rig.organizationId,
          rig.projectId,
          sourceConnectionId,
          COMMIT,
          STORED_NOW,
        );
      await expect(rig.store.provisioning.assertExecution(execution)).rejects.toHaveProperty(
        "name",
        "OperationAuthorizationConflictError",
      );
      expect(
        await control.core
          .prepare(
            "SELECT source_generation FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(rig.organizationId, rig.projectId, operationId)
          .first(),
      ).toEqual({ source_generation: generation });
    }
    await legacyRollbackRecovery();
  }, 60_000);

  it("refuses a rollback whose data moved on or is being changed", async () => {
    const moved = await productRig(control, { shared: false });
    await linkSource(moved);
    const published = await publishedWithDatabase(moved),
      targetDeploymentId = parseUlid(published.deploymentId),
      dataEnvironmentId = newUlid();
    await run(
      "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      moved.organizationId,
      moved.projectId,
      dataEnvironmentId,
      STORED_NOW,
    );
    await run(
      "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,2,?4,'2026-10-28T12:00:00.000000Z')",
      moved.organizationId,
      moved.projectId,
      moved.devEnvironmentId,
      dataEnvironmentId,
    );
    const stale = surfaceOf(moved);
    await expect(
      stale.planRollback({ ...contextOf(moved), targetDeploymentId }),
    ).rejects.toMatchObject({ reason: "rollback_target_data_changed" });
    await expect(
      stale.rollback({
        ...mutationOf(moved),
        targetDeploymentId,
        ifMatch: '"sha256-0"',
        confirmationToken: "A".repeat(43),
      }),
    ).rejects.toMatchObject({ reason: "rollback_target_data_changed" });

    // A queued data change owns the data until it finishes.
    const changing = await productRig(control, { shared: false });
    await linkSource(changing);
    const publishedChanging = await publishedRevision(changing, changing.devEnvironmentId),
      change = await planDataChange(changing, "reset_dev");
    await changing.store.productApi.acceptApiProductOperation(change.request());
    const busy = surfaceOf(changing),
      busyTarget = parseUlid(publishedChanging.deploymentId);
    await expect(
      busy.planRollback({ ...contextOf(changing), targetDeploymentId: busyTarget }),
    ).rejects.toMatchObject({ reason: "data_change_in_progress" });
    await expect(
      busy.rollback({
        ...mutationOf(changing),
        targetDeploymentId: busyTarget,
        ifMatch: '"sha256-0"',
        confirmationToken: "A".repeat(43),
      }),
    ).rejects.toMatchObject({ reason: "data_change_in_progress" });
  }, 60_000);
});

describe("product surface promotion", () => {
  it("plans a Dev to Prod promotion for the exact heads it saw and accepts it once over its confirmation", async () => {
    for (const bound of [true, false]) {
      const rig = await productRig(control);
      const { sourceConnectionId } = await linkSource(rig);
      const published = await publishedWithDatabase(rig),
        surface = surfaceOf(rig),
        context = contextOf(rig),
        sourceDeploymentId = parseUlid(published.deploymentId);

      if (!bound)
        await run(
          "DELETE FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2",
          rig.organizationId,
          rig.projectId,
        );
      const generation = bound ? 1 : 0;
      expect(
        await surface.planPromotion({ ...context, projectId: ulidOf(), sourceDeploymentId }),
      ).toBeNull();
      await expect(
        surface.planPromotion({ ...context, sourceDeploymentId: ulidOf() }),
      ).rejects.toMatchObject({ reason: "promotion_source_stale" });
      const plan = await surface.planPromotion({ ...context, sourceDeploymentId });
      expect(plan).toMatchObject({
        status: 200,
        body: {
          action: "promote",
          project_id: rig.projectId,
          source_deployment_id: published.deploymentId,
          source_artifact_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          source_environment: "dev",
          target_environment: "prod",
          resource_etag: expect.stringMatching(/^"sha256-[0-9a-f]{64}"$/u),
          // The token carries the source and target head versions the plan read.
          confirmation_token: expect.stringMatching(/^p1\.1\.0\.[A-Za-z0-9_-]{43}$/u),
          effects: [
            "Activate the verified dev artifact in prod without rebuilding.",
            "Keep the explicitly shared database and file namespace; dev schema/data changes already affect prod.",
          ],
          risks: ["Production requests use the promoted artifact after activation."],
          expires_at: "2026-10-28T11:10:00.000Z",
        },
      });
      const token = String(plan?.body["confirmation_token"]),
        tail = token.slice(-43),
        promotion = {
          ...mutationOf(rig),
          sourceDeploymentId,
          ifMatch: String(plan?.body["resource_etag"]),
          confirmationToken: token,
        };
      expect(await surface.promote({ ...promotion, projectId: ulidOf() })).toBeNull();
      await expect(
        surface.promote({ ...promotion, sourceDeploymentId: ulidOf() }),
      ).rejects.toMatchObject({ reason: "promotion_source_stale" });
      await expect(
        surface.promote({ ...promotion, confirmationToken: "A".repeat(43) }),
      ).rejects.toMatchObject({ reason: "confirmation_invalid" });
      await expect(
        surface.promote({ ...promotion, confirmationToken: `p1.2.0.${tail}` }),
      ).rejects.toMatchObject({ reason: "promotion_source_stale" });
      await expect(
        surface.promote({ ...promotion, confirmationToken: `p1.1.5.${tail}` }),
      ).rejects.toMatchObject({ reason: "promotion_target_stale" });
      await expect(
        surface.promote({ ...promotion, confirmationToken: `p1.${"9".repeat(20)}.0.${tail}` }),
      ).rejects.toMatchObject({ reason: "confirmation_invalid" });
      await expect(surface.promote({ ...promotion, ifMatch: '"sha256-0"' })).rejects.toMatchObject({
        reason: "etag_mismatch",
      });
      // A well-formed token nobody issued is no confirmation.
      await expect(
        surface.promote({ ...promotion, confirmationToken: `p1.1.0.${"A".repeat(43)}` }),
      ).rejects.toMatchObject({ reason: "confirmation_invalid" });

      const accepted = await surface.promote(promotion);
      expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
      expect(await surface.promote(promotion)).toEqual(accepted);
      const operationId = parseUlid(String(accepted?.body["id"]));
      const execution = {
        organizationId: rig.organizationId,
        projectId: rig.projectId,
        operationId,
      };
      expect(
        await control.core
          .prepare(
            "SELECT source_generation FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(rig.organizationId, rig.projectId, operationId)
          .first(),
      ).toEqual({ source_generation: generation });
      await expect(rig.store.provisioning.assertExecution(execution)).resolves.toBeUndefined();
      await expect(
        surface.promote({ ...promotion, idempotencyKey: "second-promotion" }),
      ).rejects.toMatchObject({ reason: "confirmation_invalid" });
      if (bound)
        await run(
          "UPDATE project_source_bindings SET generation=generation+1 WHERE organization_id=?1 AND project_id=?2",
          rig.organizationId,
          rig.projectId,
        );
      else
        await run(
          "INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at) VALUES(?1,?2,?3,'github',1,NULL,?4)",
          rig.organizationId,
          rig.projectId,
          sourceConnectionId,
          STORED_NOW,
        );
      await expect(rig.store.provisioning.assertExecution(execution)).rejects.toHaveProperty(
        "name",
        "OperationAuthorizationConflictError",
      );
      expect(
        await control.core
          .prepare(
            "SELECT source_generation FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(rig.organizationId, rig.projectId, operationId)
          .first(),
      ).toEqual({ source_generation: generation });
    }
  }, 60_000);

  it("describes the separate Prod database of an isolated project and refuses a project with nothing in Dev", async () => {
    const isolated = await productRig(control, { shared: false });
    await linkSource(isolated);
    const published = await publishedWithDatabase(isolated),
      plan = await surfaceOf(isolated).planPromotion({
        ...contextOf(isolated),
        sourceDeploymentId: parseUlid(published.deploymentId),
      });
    expect(plan?.body["effects"]).toEqual([
      "Activate the verified dev artifact in prod without rebuilding.",
      "Apply missing verified SQL migrations to the separate prod database; do not copy dev data or credentials.",
    ]);
    expect(plan?.body["risks"]).toEqual([
      "Production requests use the promoted artifact after activation.",
      "The separate prod database adds measured compute/storage consumption. Unsupported or conflicting migrations stop activation.",
    ]);

    const empty = await productRig(control),
      request = { ...contextOf(empty), sourceDeploymentId: ulidOf() };
    await expect(surfaceOf(empty).planPromotion(request)).rejects.toMatchObject({
      reason: "promotion_invalid_target",
    });
    await expect(
      surfaceOf(empty).promote({
        ...mutationOf(empty),
        sourceDeploymentId: request.sourceDeploymentId,
        ifMatch: '"sha256-0"',
        confirmationToken: `p1.0.0.${"A".repeat(43)}`,
      }),
    ).rejects.toMatchObject({ reason: "promotion_invalid_target" });
  }, 60_000);

  it("names what moved when the promoted heads change between the check and the acceptance", async () => {
    const rig = await productRig(control);
    await linkSource(rig);
    const published = await publishedRevision(rig, rig.devEnvironmentId),
      sourceDeploymentId = parseUlid(published.deploymentId),
      bump = (environmentId: string) => () =>
        run(
          "UPDATE environments SET head_version=head_version+1 WHERE environment_id=?1",
          environmentId,
        );
    const promotionOf = async (surface: ReturnType<typeof surfaceOf>) => {
      const plan = await surfaceOf(rig).planPromotion({ ...contextOf(rig), sourceDeploymentId });
      return {
        surface,
        request: {
          ...mutationOf(rig),
          sourceDeploymentId,
          ifMatch: String(plan?.body["resource_etag"]),
          confirmationToken: String(plan?.body["confirmation_token"]),
        },
      };
    };
    let raced = await promotionOf(
      surfaceOf(rig, { runtime: racing(rig, bump(rig.devEnvironmentId)) }),
    );
    await expect(raced.surface.promote(raced.request)).rejects.toMatchObject({
      reason: "promotion_source_stale",
    });
    raced = await promotionOf(
      surfaceOf(rig, { runtime: racing(rig, bump(rig.prodEnvironmentId)) }),
    );
    await expect(raced.surface.promote(raced.request)).rejects.toMatchObject({
      reason: "promotion_target_stale",
    });
    // Any other failure of the write passes through untouched.
    raced = await promotionOf(
      surfaceOf(rig, {
        runtime: racing(rig, async () => {
          throw new Error("core down");
        }),
      }),
    );
    await expect(raced.surface.promote(raced.request)).rejects.toThrow("core down");
    // A confirmation that lapses while the request is accepted leaves the heads as they were: it is only invalid.
    let reads = 0;
    const lapsing = await promotionOf(
      surfaceOf(rig, {
        now: () => new Date(reads++ === 0 ? NOW : "2026-10-28T11:10:00.001Z"),
      }),
    );
    await expect(lapsing.surface.promote(lapsing.request)).rejects.toMatchObject({
      reason: "confirmation_invalid",
    });
  }, 60_000);
});

describe("product surface deletion and address change", () => {
  it("plans a project deletion with what it removes and accepts it once over its confirmation", async () => {
    const rig = await productRig(control),
      surface = surfaceOf(rig),
      context = contextOf(rig);
    expect(await surface.planDelete({ ...context, projectId: ulidOf() })).toBeNull();
    const plain = await surface.planDelete(context);
    // A workspace mail domain is retained by project deletion, so the plan promises no mail or DNS removal.
    expect(plain?.body["effects"]).toEqual([
      "Delete Dev and Prod with their deployments, databases, files, function schedules and stored SQL exports.",
      "Remove the domain routes ohmyho.st created for this project. A workspace mail domain stays until it is retired.",
    ]);
    // A managed Git repository is deleted with the project and the customer is told so.
    await run(
      "INSERT INTO managed_source_repositories(source_connection_id,organization_id,project_id,billing_epoch_id,namespace,repository_name,created_at) VALUES(?1,?2,?3,?4,'acme','shop',?5)",
      newUlid(),
      rig.organizationId,
      rig.projectId,
      rig.billingEpochId,
      "2026-10-28T10:00:00.000000Z",
    );
    const plan = await surface.planDelete(context);
    expect(plan).toMatchObject({
      status: 200,
      body: {
        action: "delete",
        project_id: rig.projectId,
        resource_etag: expect.stringMatching(/^"sha256-[0-9a-f]{64}"$/u),
        confirmation_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        effects: expect.arrayContaining([
          "Delete 1 managed Git repository with saved code history and 0 staged source objects.",
        ]),
        expires_at: "2026-10-28T11:10:00.000Z",
      },
    });
    await run(
      "INSERT INTO managed_source_repositories(source_connection_id,organization_id,project_id,billing_epoch_id,namespace,repository_name,created_at) VALUES(?1,?2,?3,?4,'acme','shop-two',?5)",
      newUlid(),
      rig.organizationId,
      rig.projectId,
      rig.billingEpochId,
      "2026-10-28T10:00:00.000000Z",
    );
    expect((await surface.planDelete(context))?.body["effects"]).toContainEqual(
      "Delete 2 managed Git repositories with saved code history and 0 staged source objects.",
    );
    const deletion = {
      ...mutationOf(rig),
      ifMatch: String(plan?.body["resource_etag"]),
      confirmationToken: String(plan?.body["confirmation_token"]),
    };
    expect(await surface.deleteProject({ ...deletion, projectId: ulidOf() })).toBeNull();
    await expect(
      surface.deleteProject({ ...deletion, ifMatch: '"sha256-0"' }),
    ).rejects.toMatchObject({
      reason: "etag_mismatch",
    });
    await expect(
      surface.deleteProject({ ...deletion, confirmationToken: "A".repeat(43) }),
    ).rejects.toMatchObject({ reason: "confirmation_invalid" });

    const accepted = await surface.deleteProject(deletion);
    expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await surface.deleteProject(deletion)).toEqual(accepted);
    // The deleting project takes no second plan and no second request.
    expect(await surface.planDelete(context)).toBeNull();
    expect(
      await surface.deleteProject({ ...deletion, idempotencyKey: "second-deletion" }),
    ).toBeNull();
  }, 60_000);

  it("reports a deletion that waits for an unfinished database write as in progress, not as a stale confirmation", async () => {
    const rig = await productRig(control),
      surface = surfaceOf(rig),
      context = contextOf(rig),
      plan = await surface.planDelete(context);
    await run(
      "INSERT INTO project_database_writes(operation_id,organization_id,project_id,environment_id,environment,data_environment_id,billing_epoch_id,provider_project_id,default_branch_id,principal_id,idempotency_key,request_sha256,started_at,deadline_at,completed_at,command,affected_rows,failure_code,provider) VALUES(?1,?2,?3,?4,'dev',?4,?5,'prj-busy','br-busy','user:fixture','busy-write',zeroblob(32),?6,?7,NULL,NULL,NULL,NULL,'neon')",
      rig.input.operation.operationId,
      rig.organizationId,
      rig.projectId,
      rig.devEnvironmentId,
      rig.billingEpochId,
      "2026-10-28T10:00:00.000000Z",
      "2026-10-28T10:01:00.000000Z",
    );
    await expect(
      surface.deleteProject({
        ...mutationOf(rig),
        ifMatch: String(plan?.body["resource_etag"]),
        confirmationToken: String(plan?.body["confirmation_token"]),
      }),
    ).rejects.toMatchObject({ reason: "project_operation_in_progress" });
  }, 60_000);

  it("moves a project to a free address under its current ETag and refuses every address it cannot take", async () => {
    const rig = await productRig(control),
      other = await productRig(control),
      surface = surfaceOf(rig),
      context = contextOf(rig),
      status = await surface.getProjectStatus(context),
      ifMatch = String(status?.body["etag"]);
    const rename = (handle: string, overrides: Record<string, unknown> = {}) =>
      surface.changeProjectHandle({ ...mutationOf(rig), handle, ifMatch, ...overrides });
    await expect(rename("Acme Shop")).rejects.toMatchObject({ reason: "project_handle_invalid" });
    await expect(rename("my-api-gateway")).rejects.toMatchObject({
      reason: "project_handle_invalid",
    });
    expect(await rename("acme-shop", { projectId: ulidOf() })).toBeNull();
    await expect(rename(rig.handle)).rejects.toMatchObject({ reason: "project_handle_unchanged" });
    await expect(rename(other.handle)).rejects.toMatchObject({ reason: "project_handle_taken" });
    await expect(rename("acme-shop", { ifMatch: '"sha256-0"' })).rejects.toMatchObject({
      reason: "etag_mismatch",
    });

    const request = { ...mutationOf(rig), handle: "acme-shop", ifMatch };
    const accepted = await surface.changeProjectHandle(request);
    expect(accepted).toMatchObject({ status: 202, body: { state: "queued" } });
    expect(await surface.changeProjectHandle(request)).toEqual(accepted);
    // A rename in flight moves the gateways, so the next change waits for it.
    await expect(rename("acme-store")).rejects.toMatchObject({ reason: "project_rename_blocked" });
    const recoverySurface = surfaceOf(rig, {
      runtime: {
        ...rig.store.productApi,
        readApiRenameAdmission: async (input: unknown) => {
          const original = await rig.store.productApi.readApiRenameAdmission(input);
          return original === null
            ? null
            : { ...original, busy: false, nativeRecoveryPending: true };
        },
      } as unknown as D1ProductSurfaceRuntime,
    });
    expect(
      await recoverySurface.changeProjectHandle({
        ...mutationOf(rig),
        idempotencyKey: "fresh-native-recovery",
        handle: rig.handle,
        ifMatch,
      }),
    ).toMatchObject({ status: 202, body: { state: "queued" } });

    // Another request that lands between the check and the write decides how the loser is told.
    const contend = async (rival: (raced: ProductRig, key: string) => () => Promise<unknown>) => {
      const raced = await productRig(control),
        key = `contended-${++keys}`,
        etag = String((await surfaceOf(raced).getProjectStatus(contextOf(raced)))?.body["etag"]);
      return surfaceOf(raced, { runtime: racing(raced, rival(raced, key)) }).changeProjectHandle({
        ...mutationOf(raced),
        idempotencyKey: key,
        handle: "acme-shop",
        ifMatch: etag,
      });
    };
    await expect(
      contend(
        (raced, key) => () =>
          raced.store.productApi.acceptApiProductOperation(
            acceptance(raced, raced.devEnvironmentId, {
              eventType: "ProjectHandleChangeRequestedV1",
              routeTemplate: "/v1/projects/{project_id}/handle",
              httpMethod: "PUT",
              expectedEtag: '"rival"',
              requestedHandle: "rival-name",
              idempotencyKey: key,
            }),
          ),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    await expect(
      contend(() => async () => {
        throw new Error("core down");
      }),
    ).rejects.toThrow("core down");
    // The address is taken by another project in that window.
    await expect(
      contend(
        () => async () =>
          run("UPDATE projects SET handle='acme-shop' WHERE project_id=?1", other.projectId),
      ),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);
  }, 60_000);
});

function mutationOfEnable(rig: ProductRig) {
  return { ...mutationOf(rig), branchRef: "refs/heads/main", enabled: true };
}
