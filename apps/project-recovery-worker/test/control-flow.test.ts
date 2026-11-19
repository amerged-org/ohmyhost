import { createHash, webcrypto } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createRecoveryArchiveStore } from "../src/r2-archives.js";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createRecoveryInputCipher } from "@ohmyhost/platform";
import { RecoveryArchiveError } from "@ohmyhost/project-recovery";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "../../../packages/contracts/src/native-auth.js";

import { createRecoveryCommands } from "../../control-store/src/catalog/recovery/commands.js";
import { DB_NOW } from "../../control-store/src/catalog/recovery/shared.js";
import { storedTimestamp } from "../../control-store/src/timestamps.js";
import { withRouteRefresh } from "../../control-store/src/fence.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import type { PlatformContext } from "../../control-store/src/catalog/platform-support.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  bytes,
  freezeOwnership,
  seedProject,
  STORED_NOW,
  ulidOf,
  type SeededProject,
} from "../../control-store/test/support/platform-fixtures.js";
import { DELETION_INVENTORY_TARGETS } from "../../control-store/src/catalog/provisioning/lifecycle-inventory.js";
import type { RecoveryScope } from "../../control-store/src/catalog/recovery/scope.js";
import { runtimeRoleOf } from "../../control-store/src/catalog/database/contracts.js";
import { seedWfpPublication } from "../../control-store/test/support/provider-fixtures.js";
import {
  seedProviderClaim,
  seedDeletionIntent,
} from "../../control-store/test/support/accepted-operation.js";
import {
  createRecoveryControlHandler,
  readRecoveryInventory,
  sha256Hex,
  type RecoveryControlDependencies,
  type RecoveryControlGrant,
  type RecoveryScopeSnapshot,
  type RecoveryStorePort,
} from "../../recovery-container/src/control-mediator.js";
import { createRecoveryControlClient } from "../src/control-client.js";
import {
  RECOVERY_CONTROL_HOST,
  RecoveryControlError,
  type RecoveryControl,
} from "../src/control-wire.js";
import { createRecoveryJobRunner } from "../src/job.js";

const capture = vi.hoisted(() => ({
  run: undefined as
    | undefined
    | ((input: { signal: AbortSignal; databases: unknown[] }) => Promise<unknown>),
}));
vi.mock("@ohmyhost/project-recovery/capture", () => ({
  captureProjectRecoveryArchive: (input: { signal: AbortSignal; databases: unknown[] }) =>
    (capture.run as NonNullable<typeof capture.run>)(input),
  captureProjectRecoveryArchiveV2: (input: { signal: AbortSignal; databases: unknown[] }) =>
    (capture.run as NonNullable<typeof capture.run>)(input),
}));

let control: TestControl;
let recovery: ReturnType<typeof createRecoveryCommands>;
let store: RecoveryStorePort;
const BASE = Date.parse("2026-10-28T10:00:00.000Z") + Math.floor(Math.random() * 1000) * 1000;
let now = BASE;
const clock = { now: () => new Date(now) };
const iso = (offset = 0) => new Date(BASE + offset).toISOString();
// The store runs every guarded command at the SQL clock of its shared core (`clock: "execution"`). In these
// tests that clock is the same controllable instant as the handler's: the core handed to the store rewrites the SQL
// clock expression (`DB_NOW`) into the current simulated instant, so a delayed request is simulated by moving `now`.
// Only this harness does that; the real SQLite clock is proven in apps/control-store/test/recovery.
let restoreClock: (() => void) | undefined;

function withSimulatedSqlClock(db: D1Database): D1Database {
  const literal = () => `'${storedTimestamp(new Date(now).toISOString())}'`;
  return {
    prepare: (sql) => db.prepare(sql.replaceAll(DB_NOW, literal())),
    batch: (statements) => db.batch(statements),
  };
}

beforeAll(async () => {
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => spy.mockRestore();
  control = await createTestControl(2);
  const core = withSimulatedSqlClock(control.core);
  const context: PlatformContext = {
    directory: core,
    router: new SharedCoreRouter(core),
  };
  recovery = createRecoveryCommands(
    (command) => (input) => withRouteRefresh(context.router, () => command(context, input)),
  );
  store = {
    readClaimState: recovery.executor.readClaimState,
    claim: recovery.executor.claim,
    acquireFence: recovery.executor.acquireFence,
    renewFence: recovery.executor.renewFence,
    releaseFence: recovery.executor.releaseFence,
    readScope: recovery.executor.readScope,
    authorizeNativeCapture: recovery.executor.authorizeNativeCapture,
    prepareArchive: recovery.executor.prepareArchive,
    dispatchArchive: recovery.executor.dispatchArchive,
    readCleanupTarget: recovery.cleanup.readCleanupTarget,
    recordNativeExportRetired: recovery.cleanup.recordNativeExportRetired,
    discardArchive: recovery.executor.discardArchive,
    finish: recovery.executor.finish,
    readArchive: recovery.owner.readArchive,
  };
});
afterAll(async () => {
  restoreClock?.();
  await control.dispose();
});

const cipher = createRecoveryInputCipher({
  key: new Uint8Array(32).fill(5),
  keyVersion: 1,
  crypto: webcrypto as unknown as Crypto,
});
let sequence = 0;
const next = () => (sequence += 1);
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const CLAIM = "11111111-1111-4111-8111-111111111111";
const TOKEN = "t".repeat(43);

interface Job {
  readonly project: SeededProject;
  readonly scope: { organizationId: string; projectId: string; operationId: string };
  readonly devData: string;
  readonly prodData: string;
  readonly plaintext: { ciphertext: Uint8Array; nonce: Uint8Array };
  readonly database: { providerProjectId: string; databaseId: string };
}

/** The active PGCF target of one physical environment (real rows of the 0070 revision and head tables). */
async function seedPgcf(
  project: SeededProject,
  physical: string,
  n: number,
  state: "active" | "retired" = "active",
): Promise<{ providerProjectId: string; databaseId: string }> {
  const suffix = n.toString(36).padStart(4, "0");
  const identity = {
    providerProjectId: `prj_${"b".repeat(16)}${suffix}`,
    databaseId: `a${"a".repeat(15)}${suffix}`,
  };
  await project.shard.batch([
    project.shard
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, region_id, size_class_id, runtime_role, credential_reference, operation_id, created_at) VALUES (?1, ?2, ?3, 1, 'pgcf', ?4, ?5, 'eu-dev', 'standard', ?6, 'sealed:1', NULL, ?7)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        physical,
        identity.providerProjectId,
        identity.databaseId,
        runtimeRoleOf(physical),
        STORED_NOW,
      ),
    project.shard
      .prepare(
        "INSERT INTO database_provider_target_heads(organization_id, project_id, physical_environment_id, target_version, state, activated_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, NULL, ?5)",
      )
      .bind(project.organizationId, project.projectId, physical, state, STORED_NOW),
  ]);
  return identity;
}

/** The prod environment's active deployment with `plan` (the real publication graph under the final schema). */
async function activatePlan(job: Job, plan: unknown): Promise<void> {
  const { project } = job;
  const claim = await seedProviderClaim(project, project.prodEnvironmentId);
  await seedWfpPublication(project, {
    operationId: claim.operationId,
    frameworkPlan: plan,
    headVersion: 2,
  });
}

/** A valid current static framework plan (the platform parser accepts it); `enabled` is its database requirement. */
const staticPlan = (databaseEnabled = false) => ({
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: "site",
  adapter: "vite-static",
  runtime: "static",
  installCommand: "npm ci --ignore-scripts",
  buildCommand: "npm run build",
  outputDirectory: "dist",
  runtimePolicy: { healthCheckPath: "/health", egressAllowedOrigins: ["https://api.example.com"] },
  database: databaseEnabled ? { enabled: true, migrations: "db/migrations" } : { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
});

async function accepted(
  shard = 0,
  options: { pgcf?: boolean; plaintext?: Uint8Array; prodOnly?: boolean } = {},
): Promise<Job> {
  const project = await seedProject(control, {
    shard,
    ...(options.prodOnly ? { prodOnly: true } : {}),
  });
  if (!options.prodOnly) await makePaid(project.shard, project.organizationId);
  const n = next();
  const operationId = ulidOf("fop", n);
  const scope = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    operationId,
  };
  const devData = ulidOf("fdd", n);
  const prodData = ulidOf("fpd", n);
  await project.shard.batch(
    [
      ...(options.prodOnly ? [] : [[devData, project.devEnvironmentId]]),
      [prodData, project.prodEnvironmentId],
    ].flatMap(([data, environment]) => [
      project.shard
        .prepare(
          "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(project.organizationId, project.projectId, data, STORED_NOW),
      project.shard
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at, operation_id) VALUES (?1, ?2, 1, ?3, ?4, ?5, NULL)",
        )
        .bind(project.organizationId, environment, project.projectId, data, STORED_NOW),
    ]),
  );
  const database =
    options.pgcf === false
      ? { providerProjectId: "", databaseId: "" }
      : await seedPgcf(project, options.prodOnly ? prodData : devData, n);
  const sealed = await cipher.seal(
    scope,
    options.plaintext ??
      new TextEncoder().encode(JSON.stringify({ version: 1, passphrase: "correct horse battery" })),
  );
  await recovery.owner.acceptRecoveryJob({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: options.prodOnly ? project.prodEnvironmentId : project.devEnvironmentId,
    billingEpochId: project.billingEpochId,
    operationId,
    operationEventId: ulidOf("fev", n),
    auditEventId: ulidOf("fau", n),
    outboxEventId: ulidOf("fob", n),
    principalId: "user:user_owner",
    requestId: `request-${n}`,
    httpMethod: "POST",
    routeTemplate: "/v1/projects/{project_id}/exports",
    idempotencyKey: `key-${n}`,
    canonicalRequestDigest: String(n).padStart(64, "0"),
    occurredAt: iso(),
    archiveBucket: "ohmyho-development-backups",
    sealedInput: sealed,
  });
  return { project, scope, devData, prodData, plaintext: sealed, database };
}

type GrantOverrides = { [K in keyof RecoveryControlGrant]?: RecoveryControlGrant[K] | undefined };
const grantOf = async (job: Job, overrides: GrantOverrides = {}) =>
  ({
    containerId: "container-1",
    action: "run",
    ...job.scope,
    claimId: CLAIM,
    tokenSha256: await sha256Hex(TOKEN),
    expiresAtMs: BASE + 60 * 60_000,
    ...overrides,
  }) as RecoveryControlGrant;

/** The Worker side exactly as the Container proxy calls it; `fault` loses a response after the command ran. */
function virtualFetch(
  grant: unknown,
  dependencies: RecoveryControlDependencies | undefined,
  fault?: (method: string, call: number) => "after" | "before" | undefined,
  containerId = "container-1",
) {
  const handler = createRecoveryControlHandler<object>({
    dependencies: () => dependencies,
    clock,
  });
  const calls = new Map<string, number>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const method = new URL(request.url).pathname.slice(4);
    const count = (calls.get(method) ?? 0) + 1;
    calls.set(method, count);
    const mode = fault?.(method, count);
    if (mode === "before") throw new TypeError("connection reset");
    const response = await handler(
      request,
      {},
      { containerId, className: "RecoverySandbox", params: grant },
    );
    if (mode === "after") throw new TypeError("response lost");
    return response;
  }) as typeof fetch;
}

async function clientFor(
  job: Job,
  options: {
    fault?: (method: string, call: number) => "after" | "before" | undefined;
    grant?: GrantOverrides;
    store?: Partial<RecoveryStorePort>;
    attempts?: number;
  } = {},
): Promise<RecoveryControl> {
  return createRecoveryControlClient({
    token: TOKEN,
    attempts: options.attempts ?? 3,
    sleep: async () => undefined,
    fetch: virtualFetch(
      await grantOf(job, options.grant),
      { store: { ...store, ...options.store } },
      options.fault,
    ),
  });
}

const rows = async <Row>(db: D1Database, sql: string, ...binds: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .all<Row>()
  ).results;

describe("mediated port over real D1", () => {
  it("serves binary ciphertext and nonce byte for byte and the scope from the token", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const client = await clientFor(job);
    expect(await client.readClaimState()).toEqual({ status: "queued" });
    const claim = await client.claim();
    if (claim.status !== "claimed" || claim.sealedInput === null) throw new Error("not claimed");
    expect([...claim.sealedInput.ciphertext]).toEqual([...job.plaintext.ciphertext]);
    expect([...claim.sealedInput.nonce]).toEqual([...job.plaintext.nonce]);
    expect(claim.sealedInput.keyVersion).toBe(1);
    expect(claim.archiveKey).toBe(
      `snapshots/${job.scope.organizationId}/${job.scope.projectId}/${job.scope.operationId}.zip`,
    );
    // The recovered bytes still open under the original AAD.
    const opened = await cipher.open(job.scope, claim.sealedInput);
    expect(new TextDecoder().decode(opened)).toContain("correct horse battery");
    expect(await client.claim()).toMatchObject({ status: "claimed", replayed: true });
  });

  it("refuses the request shapes the token does not allow", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const grant = await grantOf(job);
    const dependencies = { store };
    const send = (
      overrides: {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: BodyInit | null;
        grant?: unknown;
        containerId?: string;
        dependencies?: RecoveryControlDependencies | undefined;
        clockMs?: number;
      } = {},
    ) => {
      const handler = createRecoveryControlHandler<object>({
        dependencies: () => ("dependencies" in overrides ? overrides.dependencies : dependencies),
        clock: { now: () => new Date(overrides.clockMs ?? now) },
      });
      return handler(
        new Request(overrides.url ?? `http://${RECOVERY_CONTROL_HOST}/v1/readClaimState`, {
          method: overrides.method ?? "POST",
          headers: { authorization: `Bearer ${TOKEN}`, ...overrides.headers },
          body: "body" in overrides ? (overrides.body ?? null) : "{}",
        }),
        {},
        {
          containerId: overrides.containerId ?? "container-1",
          className: "RecoverySandbox",
          params: "grant" in overrides ? overrides.grant : grant,
        },
      );
    };
    const code = async (response: Response) => ({
      status: response.status,
      code: ((await response.json()) as { code: string }).code,
    });
    expect(await code(await send({ method: "GET", body: null }))).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await code(await send({ url: `http://evil.example/v1/readClaimState` }))).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(
      await code(await send({ url: `http://${RECOVERY_CONTROL_HOST}/v1/dropTables` })),
    ).toEqual({ status: 404, code: "not_found" });
    expect(
      await code(await send({ url: `http://${RECOVERY_CONTROL_HOST}/v1/readClaimState?x=1` })),
    ).toEqual({ status: 404, code: "not_found" });
    expect(await code(await send({ grant: undefined }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(await code(await send({ grant: { ...grant, extra: 1 } }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(
      await code(
        await send({
          url: `http://${RECOVERY_CONTROL_HOST}/v1/discardArchive`,
          grant: { ...grant, action: "download", claimId: undefined },
        }),
      ),
    ).toEqual({ status: 403, code: "forbidden" });
    expect(await code(await send({ grant: { ...grant, action: "purge" } }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(await code(await send({ grant: { ...grant, claimId: "nope" } }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(await code(await send({ grant: { ...grant, tokenSha256: "zz" } }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(await code(await send({ grant: { ...grant, expiresAtMs: 1.5 } }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(await code(await send({ grant: { ...grant, organizationId: "x" } }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(await code(await send({ grant: [] }))).toEqual({ status: 403, code: "forbidden" });
    expect(await code(await send({ containerId: "container-2" }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(await code(await send({ headers: { authorization: "Bearer short" } }))).toEqual({
      status: 401,
      code: "unauthorized",
    });
    expect(
      await code(await send({ headers: { authorization: `Bearer ${"u".repeat(43)}` } })),
    ).toEqual({ status: 401, code: "unauthorized" });
    expect(await code(await send({ headers: { authorization: `Basic ${TOKEN}` } }))).toEqual({
      status: 401,
      code: "unauthorized",
    });
    expect(await code(await send({ clockMs: grant.expiresAtMs }))).toEqual({
      status: 401,
      code: "token_expired",
    });
    // A download token may only read the archive locator.
    const download = await grantOf(job, { action: "download" });
    const downloadGrant = Object.fromEntries(
      Object.entries(download).filter(([key]) => key !== "claimId"),
    );
    expect(await code(await send({ grant: downloadGrant }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(
      await code(
        await send({
          grant: downloadGrant,
          url: `http://${RECOVERY_CONTROL_HOST}/v1/finish`,
          body: JSON.stringify({ failureCode: "X" }),
        }),
      ),
    ).toEqual({ status: 403, code: "forbidden" });
    expect(
      (await send({ grant: downloadGrant, url: `http://${RECOVERY_CONTROL_HOST}/v1/readArchive` }))
        .status,
    ).toBe(200);
    // The body cannot choose another scope or smuggle fields.
    expect(
      await code(
        await send({ body: JSON.stringify({ organizationId: job.scope.organizationId }) }),
      ),
    ).toEqual({ status: 400, code: "invalid_request" });
    expect(await code(await send({ body: "not json" }))).toEqual({
      status: 400,
      code: "invalid_request",
    });
    expect(await code(await send({ body: null }))).toEqual({
      status: 400,
      code: "invalid_request",
    });
    expect(await code(await send({ body: new Uint8Array([0xff, 0xfe]) }))).toEqual({
      status: 400,
      code: "invalid_request",
    });
    expect(await code(await send({ headers: { "content-length": "999999" } }))).toEqual({
      status: 413,
      code: "payload_too_large",
    });
    const chunked = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20_000));
        controller.close();
      },
    });
    const streamed = createRecoveryControlHandler<object>({
      dependencies: () => dependencies,
      clock,
    });
    const bigRequest = new Request(`http://${RECOVERY_CONTROL_HOST}/v1/readClaimState`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: chunked,
      duplex: "half",
    } as RequestInit);
    expect(
      await code(
        await streamed(
          bigRequest,
          {},
          { containerId: "container-1", className: "x", params: grant },
        ),
      ),
    ).toEqual({ status: 413, code: "payload_too_large" });
    // Missing private bindings fail closed and answer nothing.
    expect(await code(await send({ dependencies: undefined }))).toEqual({
      status: 503,
      code: "control_unavailable",
    });
    // Nothing above touched the job.
    expect((await recovery.executor.readClaimState(job.scope))?.status).toBe("queued");
  });

  it("takes the trusted instant after the body and lets the store lift it: neither a slow body nor a stale instant revives a lease or a token", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const owner = await clientFor(job);
    await owner.claim();
    const lease = await owner.acquireFence({ holderId: uuid(70), leaseMilliseconds: 5000 });
    const leaseEnd = () =>
      rows<{ lease_expires_at: string }>(
        job.project.shard,
        "SELECT lease_expires_at FROM project_recovery_fences WHERE organization_id = ?1",
        job.scope.organizationId,
      );
    const before = await leaseEnd();
    const grant = await grantOf(job, { expiresAtMs: now + 8_000 });
    const renewal = { epoch: lease.epoch, holderId: lease.holderId, leaseMilliseconds: 5000 };
    const call = async (
      handlerClock: () => Date,
      advanceMs: number,
      params: RecoveryControlGrant = grant,
    ) => {
      const handler = createRecoveryControlHandler<object>({
        dependencies: () => ({ store }),
        clock: { now: handlerClock },
      });
      // The body is produced only when the handler reads it: that is where the time passes.
      const body = new ReadableStream({
        pull(controller) {
          now += advanceMs;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(renewal)));
          controller.close();
        },
      });
      const response = await handler(
        new Request(`http://${RECOVERY_CONTROL_HOST}/v1/renewFence`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body,
          duplex: "half",
        } as RequestInit),
        {},
        { containerId: "container-1", className: "RecoverySandbox", params },
      );
      return { status: response.status, code: ((await response.json()) as { code?: string }).code };
    };
    // 10 s pass while the body is read: the lease (5 s) and the token (8 s) are both over when the store runs.
    expect(await call(clock.now, 10_000)).toEqual({ status: 401, code: "token_expired" });
    expect(await leaseEnd()).toEqual(before);
    // A token that still stands, a lease that does not: the instant taken after the body expires the lease.
    now = BASE + 60_000;
    const longGrant = await grantOf(job, { expiresAtMs: BASE + 3_600_000 });
    expect(await call(clock.now, 10_000, longGrant)).toEqual({
      status: 409,
      code: "recovery_fence_lost",
    });
    expect(await leaseEnd()).toEqual(before);
    // The store is not trusting an instant the Worker supplied: a frozen (stale) handler clock is lifted to the
    // store's own execution clock, so the expired lease is still refused.
    now = BASE + 60_000;
    const frozen = new Date(BASE + 60_000);
    expect(await call(() => frozen, 10_000, longGrant)).toEqual({
      status: 409,
      code: "recovery_fence_lost",
    });
    expect(await leaseEnd()).toEqual(before);
    // Control: without delay the very same renewal is applied.
    now = BASE + 60_000;
    expect(await call(clock.now, 0, longGrant)).toEqual({ status: 200, code: undefined });
  });

  it("keeps one job's scope: another organization's token reaches nothing of it", async () => {
    now = BASE + 60_000;
    const job = await accepted(0);
    const other = await accepted(1);
    const foreign = await clientFor(job, { grant: { organizationId: other.scope.organizationId } });
    expect(await foreign.readClaimState()).toBeNull();
    expect(await foreign.claim()).toEqual({ status: "absent" });
    expect(await foreign.readInventory()).toBeNull();
    await expect(
      foreign.acquireFence({ holderId: uuid(1), leaseMilliseconds: 5000 }),
    ).rejects.toMatchObject({ code: "recovery_scope_unavailable" });
    expect(await recovery.executor.readClaimState(job.scope)).toEqual({ status: "queued" });
    expect(await recovery.executor.readClaimState(other.scope)).toEqual({ status: "queued" });
    // Frozen ownership: the same job's project is no longer an active scope.
    const frozen = await accepted(0);
    await freezeOwnership(frozen.project);
    expect(await (await clientFor(frozen)).readInventory()).toBeNull();
  });

  it("serves the one canonical inventory snapshot and refuses every unusable shape instead of capturing nothing", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const inventory = await (await clientFor(job)).readInventory();
    expect(inventory).toMatchObject({
      dataMode: "shared",
      environments: [
        {
          name: "dev",
          databaseEnvironmentId: job.devData,
          database: {
            provider: "pgcf",
            providerProjectId: job.database.providerProjectId,
            databaseId: job.database.databaseId,
            postgresVersion: "18",
            databaseName: job.database.databaseId,
            roleName: `ohmyho_backup_${job.devData.toLowerCase()}`,
            targetVersion: 1,
          },
        },
        { name: "prod", databaseEnvironmentId: job.prodData, database: null },
      ],
    });
    // The Worker consumes the store's own type: this assignment fails to compile if the two ever diverge.
    const canonical = (await recovery.executor.readScope({
      organizationId: job.scope.organizationId,
      projectId: job.scope.projectId,
    })) as RecoveryScope;
    const consumed: RecoveryScopeSnapshot = canonical;
    expect(consumed.environments).toHaveLength(2);
    // A valid platform plan whose database requirement matches is accepted.
    await activatePlan(job, staticPlan(false));
    expect(await (await clientFor(job)).readInventory()).not.toBeNull();

    // A recorded but retired head is not ready (original `recovery_database_not_ready`).
    const retired = await accepted(0, { pgcf: false });
    await seedPgcf(retired.project, retired.devData, 900, "retired");
    await expect((await clientFor(retired)).readInventory()).rejects.toMatchObject({
      code: "recovery_database_not_ready",
    });
    // An enabled database that was never placed is not ready either, and becomes ready once PGCF exists.
    const unplaced = await accepted(0, { pgcf: false });
    await activatePlan(unplaced, staticPlan(true));
    await expect((await clientFor(unplaced)).readInventory()).rejects.toMatchObject({
      code: "recovery_database_not_ready",
    });
    // The real deployment_plans INSERT guards refuse a malformed or shallow plan, so none can be stored: never
    // weaken them to construct an impossible head. The one legal historical head without a plan is invalid.
    for (const bad of [{ database: { enabled: "yes" } }, { database: { enabled: false } }]) {
      await expect(activatePlan(await accepted(), bad)).rejects.toThrow(
        /D1_ERROR: deployment .+ shape/u,
      );
    }
    const legacy = await accepted();
    await activatePlan(legacy, null);
    await expect((await clientFor(legacy)).readInventory()).rejects.toMatchObject({
      code: "recovery_inventory_invalid",
    });
    // A plan the platform parser refuses is refused by the mediator even when the store derived its flag.
    const shallow = await accepted();
    await activatePlan(shallow, staticPlan(false));
    const realShallow = store.readScope;
    await expect(
      readRecoveryInventory(
        {
          store: {
            ...store,
            readScope: async (input) => {
              const scope = (await realShallow(input)) as RecoveryScope;
              return {
                ...scope,
                environments: scope.environments.map((e) =>
                  e.head === null
                    ? e
                    : {
                        ...e,
                        head: { ...e.head, frameworkPlan: { database: { enabled: false } } },
                      },
                ) as unknown as RecoveryScopeSnapshot["environments"],
              };
            },
          },
        },
        shallow.scope,
      ),
    ).rejects.toMatchObject({ code: "recovery_inventory_invalid" });
    // The platform plan disagrees with the flag the store derived: refused, never trusted.
    const mismatch = await accepted();
    await activatePlan(mismatch, staticPlan(false));
    const real = store.readScope;
    await expect(
      readRecoveryInventory(
        {
          store: {
            ...store,
            readScope: async (input) => {
              const scope = (await real(input)) as RecoveryScope;
              return {
                ...scope,
                environments: scope.environments.map((e) =>
                  e.head === null ? e : { ...e, head: { ...e.head, databaseEnabled: true } },
                ) as unknown as RecoveryScopeSnapshot["environments"],
              };
            },
          },
        },
        mismatch.scope,
      ),
    ).rejects.toMatchObject({ code: "recovery_inventory_invalid" });
    // A historical Neon placement is never an active capture source: not ready, with no Neon fallback anywhere.
    const neon = await accepted(0, { pgcf: false });
    await neon.project.shard.batch([
      neon.project.shard
        .prepare(
          "INSERT INTO neon_project_placement_receipts(organization_id, project_id, environment_id, operation_id, claim_id, project_name, region_id, postgres_version, provider_project_id, default_branch_id, operation_ids, state, observed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?7, 'aws-eu-central-1', 17, 'neon-project-1', 'br-main-1', '[]', 'ready', ?6, ?6)",
        )
        .bind(
          neon.project.organizationId,
          neon.project.projectId,
          neon.devData,
          ulidOf("nop", 1),
          ulidOf("ncl", 1),
          STORED_NOW,
          `ohmyho-${neon.project.projectId.toLowerCase()}`,
        ),
      neon.project.shard
        .prepare(
          "INSERT INTO neon_project_role_receipts(organization_id, project_id, environment_id, operation_id, claim_id, provider_project_id, branch_id, role_name, operation_ids, state, observed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'neon-project-1', 'br-main-1', ?6, '[]', 'ready', ?7, ?7)",
        )
        .bind(
          neon.project.organizationId,
          neon.project.projectId,
          neon.devData,
          ulidOf("nrp", 1),
          ulidOf("ncr", 1),
          `ohmyho_ro_${neon.devData.toLowerCase()}`,
          STORED_NOW,
        ),
    ]);
    expect(
      (
        (await recovery.executor.readScope({
          organizationId: neon.scope.organizationId,
          projectId: neon.scope.projectId,
        })) as RecoveryScope
      ).environments[0]?.database?.provider,
    ).toBe("neon");
    await expect((await clientFor(neon)).readInventory()).rejects.toMatchObject({
      code: "recovery_database_not_ready",
    });
    // A snapshot that does not hold exactly dev and prod is invalid.
    await expect(
      readRecoveryInventory(
        {
          store: {
            ...store,
            readScope: async () => ({
              dataMode: "shared",
              ownershipVersion: 1,
              lifecycleVersion: 1,
              environments: [],
            }),
          },
        },
        job.scope,
      ),
    ).rejects.toMatchObject({ code: "recovery_inventory_invalid" });
  });

  it("fences stale holders: a lapsed lease is taken over at the next epoch and the old holder writes nothing", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const a = await clientFor(job);
    expect(await a.claim()).toMatchObject({ status: "claimed" });
    const leaseA = await a.acquireFence({ holderId: uuid(1), leaseMilliseconds: 5000 });
    expect(leaseA).toMatchObject({ outcome: "acquired", epoch: 1 });
    expect(await a.acquireFence({ holderId: uuid(1), leaseMilliseconds: 5000 })).toMatchObject({
      outcome: "replayed",
      epoch: 1,
    });
    await expect(
      a.acquireFence({ holderId: uuid(2), leaseMilliseconds: 5000 }),
    ).rejects.toMatchObject({ code: "recovery_source_busy" });
    now += 10_000;
    const leaseB = await a.acquireFence({ holderId: uuid(2), leaseMilliseconds: 5000 });
    expect(leaseB).toMatchObject({ outcome: "acquired", epoch: 2 });
    const archive = {
      sqlFiles: ["dev.sql"],
      bytes: 10,
      sha256: bytes(32, 3),
      capturedAt: new Date(now).toISOString(),
    };
    const staleFence = { epoch: 1, holderId: uuid(1) };
    await expect(a.renewFence({ ...staleFence, leaseMilliseconds: 5000 })).rejects.toMatchObject({
      code: "recovery_fence_lost",
    });
    await expect(a.prepareArchive({ archive, fence: staleFence })).rejects.toMatchObject({
      code: "recovery_fence_lost",
    });
    await expect(a.finish({ archive, fence: staleFence })).rejects.toMatchObject({
      code: expect.stringMatching(/recovery_fence_lost|project_recovery_conflict/u),
    });
    expect(await a.releaseFence(staleFence)).toEqual({ outcome: "superseded" });
    expect(await a.readClaimState()).toEqual({ status: "running" });
    expect(
      await rows(
        job.project.shard,
        "SELECT epoch, holder_id FROM project_recovery_fences WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ epoch: 2, holder_id: uuid(2) }]);
    expect(await a.releaseFence({ epoch: 2, holderId: uuid(2) })).toEqual({ outcome: "released" });
  });

  it("replays a lost response through the command's own identity and never starts a second job", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const lose = (method: string, call: number) =>
      call === 1 && ["claim", "acquireFence", "prepareArchive", "finish"].includes(method)
        ? "after"
        : undefined;
    const client = await clientFor(job, { fault: lose });
    expect(await client.claim()).toMatchObject({ status: "claimed" });
    const lease = await client.acquireFence({ holderId: uuid(7), leaseMilliseconds: 5000 });
    expect(lease.epoch).toBe(1);
    const archive = {
      sqlFiles: ["dev.sql"],
      bytes: 10,
      sha256: bytes(32, 3),
      capturedAt: new Date(now).toISOString(),
    };
    const fence = { epoch: lease.epoch, holderId: lease.holderId };
    expect(await client.prepareArchive({ archive, fence })).toEqual({ outcome: "replayed" });
    expect(await client.finish({ archive, fence })).toMatchObject({ status: "succeeded" });
    expect(
      await rows(
        job.project.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ n: 1 }]);
    expect((await recovery.executor.readClaimState(job.scope))?.status).toBe("succeeded");
    // Every attempt lost: the caller sees an unknown outcome, never a fabricated success.
    const dead = await clientFor(job, { fault: () => "before", attempts: 2 });
    await expect(dead.readClaimState()).rejects.toMatchObject({
      code: "control_outcome_unknown",
      retryable: true,
    });
  });

  it("delivers the owner download locator only for a verified archive", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const client = await clientFor(job, { grant: { action: "download", claimId: undefined } });
    expect(await client.readArchive()).toBeNull();
  });
});

/**
 * `objects`: a create-only object store keyed by the archive key. A PUT over an existing key fails, and a readback
 * reports the object absent, verified or different by comparing the digest it holds.
 */
function runner(
  client: RecoveryControl,
  options: {
    fence?: { leaseMilliseconds: number; renewEveryMilliseconds: number };
    verify?: "verified" | "absent" | "different" | "throw";
    cipher?: typeof cipher;
    objects?: Map<string, Uint8Array>;
  } = {},
) {
  const puts: unknown[] = [];
  let holder = 100;
  const objects = options.objects;
  const instance = createRecoveryJobRunner({
    control: client,
    cipher: options.cipher ?? cipher,
    database: {
      read: async (reference) => {
        if (reference.provider !== "pgcf") throw new Error("production reference is not PGCF");
        if ("kind" in reference)
          return {
            connectionUrl: `postgres://${reference.roleName}:password@pgcf.example.test/${reference.databaseId}`,
            transport: {
              provider: "pgcf" as const,
              websocketUrl: "wss://pgcf.example.test/",
              databaseId: reference.databaseId,
              role: reference.roleName,
            },
          };
        return `postgres://reader@example.test/${reference.databaseId}`;
      },
    },
    archives: {
      put: async (input) => {
        if (objects !== undefined) {
          if (objects.has(input.key)) throw new Error("object exists");
          objects.set(input.key, input.archive.sha256);
        }
        puts.push(input.key);
      },
      verify: async (input) => {
        if (options.verify === "throw") throw new Error("network");
        if (objects === undefined) return options.verify ?? "verified";
        const stored = objects.get(input.key);
        if (stored === undefined) return "absent";
        return sameBytes(stored, input.archive.sha256) ? "verified" : "different";
      },
    },
    clock,
    holderIds: { next: () => uuid((holder += 1)) },
    fence: options.fence ?? { leaseMilliseconds: 5000, renewEveryMilliseconds: 20 },
  });
  return { run: (job: Job) => instance.run({ ...job.scope, claimId: CLAIM }), puts };
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
/** The client counts the discards the runner asks for; the retries of one call stay below it. */
function watching(client: RecoveryControl, discards: unknown[]): RecoveryControl {
  return {
    ...client,
    discardArchive: async (input) => {
      discards.push(input);
      return client.discardArchive(input);
    },
  };
}
const keyOf = (job: Job) =>
  `snapshots/${job.scope.organizationId}/${job.scope.projectId}/${job.scope.operationId}.zip`;
interface Recorded {
  sqlFiles: string[];
  bytes: number;
  sha256: Uint8Array;
  capturedAt: string;
}
/** Claims, takes the fence and records `archive`, then crashes: the upload never happens. */
async function crashedWith(job: Job, archive: Recorded): Promise<void> {
  const client = await clientFor(job);
  await client.claim();
  const lease = await client.acquireFence({ holderId: uuid(900), leaseMilliseconds: 5_000 });
  await client.prepareArchive({
    archive,
    fence: { epoch: lease.epoch, holderId: lease.holderId },
  });
}
async function seedNativeOwner(project: SeededProject) {
  await project.shard.batch([
    project.shard
      .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
      .bind(project.organizationId, STORED_NOW),
    project.shard
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_owner','admin','active',1,?2,?3,'evt')",
      )
      .bind(project.organizationId, new Uint8Array(32).fill(1), STORED_NOW),
    project.shard
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_owner','owner',?3)",
      )
      .bind(project.organizationId, ulidOf("grant", next()), STORED_NOW),
  ]);
}
const receipt = () => ({
  sqlFiles: ["dev.sql"],
  bytes: 2048,
  sha256: `sha256:${"ab".repeat(32)}`,
  capturedAt: new Date(now).toISOString(),
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (job: Job) =>
  rows<{ state: string }>(
    job.project.shard,
    "SELECT state FROM operations WHERE organization_id = ?1 AND operation_id = ?2",
    job.scope.organizationId,
    job.scope.operationId,
  );

describe("Node job runner over the mediated port", () => {
  it("captures a canonical Prod-only project through Core, private wire and the job's actual archive scope", async () => {
    now = BASE + 60_000;
    const job = await accepted(0, { prodOnly: true });
    const client = await clientFor(job);
    expect((await client.readInventory())?.environments.map((entry) => entry.name)).toEqual([
      "prod",
    ]);
    let captured = false;
    capture.run = async (input) => {
      captured = true;
      expect(input).toMatchObject({
        scope: {
          dataMode: "shared",
          environments: { prod: job.prodData },
          databaseEnvironments: [job.prodData],
        },
        databases: [{ environmentId: job.prodData }],
      });
      expect(input).toHaveProperty("scope.environments", { prod: job.prodData });
      expect(input.databases).toHaveLength(1);
      return { ...receipt(), sqlFiles: ["shared.sql"] };
    };
    expect(await runner(client).run(job)).toEqual({ status: "succeeded" });
    expect(captured).toBe(true);
    expect(await state(job)).toEqual([{ state: "succeeded" }]);
  });
  it("captures an Auth-only project through the typed private inventory", async () => {
    now = BASE + 60_000;
    const job = await accepted(0, { pgcf: false });
    const project = job.project,
      e = project.devEnvironmentId,
      databaseId = "a1234567890123456789";
    await seedNativeOwner(project);
    await project.shard
      .prepare(
        `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'prj_12345678901234567890',?3,'operation','eu-dev','r256-s500m',1,'2026-10-28T08:20:00.000000Z','2026-10-28T08:00:00.000000Z')`,
      )
      .bind(project.organizationId, project.projectId, databaseId)
      .run();
    await project.shard
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','Test',1,1)",
      )
      .bind(project.organizationId, project.projectId, e)
      .run();
    await project.shard
      .prepare(
        `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890',?6,1,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        project.organizationId,
        project.projectId,
        e,
        ulidOf("prep", 1),
        ulidOf("claim", 1),
        databaseId,
        `omh_auth_${e.toLowerCase()}`,
        `omh_ar_${e.toLowerCase()}`,
        `omh_am_${e.toLowerCase()}`,
        `omh_ab_${project.projectId.toLowerCase()}`,
        NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      )
      .run();
    let captureStarted = false;
    capture.run = async (value) => {
      captureStarted = true;
      expect(value.databases).toMatchObject([
        { resource: { kind: "native_auth_database", databaseId } },
      ]);
      const base = (
        value as unknown as {
          scope: {
            nativeManifest: { realms: Record<string, unknown>[] } & Record<string, unknown>;
          };
        }
      ).scope.nativeManifest;
      const manifest = {
        ...base,
        realms: base.realms.map((realm) => ({
          ...realm,
          dumpOffset: 0,
          dumpBytes: 1,
          dumpSha256: "a".repeat(64),
        })),
      };
      return {
        ...receipt(),
        sqlFiles: ["auth.sql"],
        nativeManifest: manifest,
        nativeManifestSha256: `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
      };
    };
    const setRole = async (role: "admin" | "member") =>
      project.shard
        .prepare(
          "UPDATE organization_memberships SET role=?2 WHERE organization_id=?1 AND workos_user_id='user_owner'",
        )
        .bind(project.organizationId, role)
        .run();
    const authorityClient = await clientFor(job, {
      store: {
        authorizeNativeCapture: async (input) => {
          await setRole("member");
          await expect(recovery.executor.authorizeNativeCapture(input)).rejects.toThrow();
          expect(captureStarted).toBe(false);
          await setRole("admin");
          return recovery.executor.authorizeNativeCapture(input);
        },
        prepareArchive: async (input) => {
          await setRole("member");
          await expect(recovery.executor.prepareArchive(input)).rejects.toThrow();
          expect(
            await rows(
              project.shard,
              "SELECT state FROM native_export_effects WHERE operation_id=?1",
              job.scope.operationId,
            ),
          ).toEqual([]);
          await setRole("admin");
          return recovery.executor.prepareArchive(input);
        },
        dispatchArchive: async (input) => {
          await setRole("member");
          await expect(recovery.executor.dispatchArchive(input)).rejects.toThrow();
          expect(
            await rows(
              project.shard,
              "SELECT state FROM native_export_effects WHERE operation_id=?1",
              job.scope.operationId,
            ),
          ).toEqual([{ state: "reserved" }]);
          await setRole("admin");
          return recovery.executor.dispatchArchive(input);
        },
      },
    });
    expect(await runner(authorityClient).run(job)).toEqual({ status: "succeeded" });
    const stored = await job.project.shard
      .prepare(
        "SELECT native_manifest,lower(hex(native_manifest_sha256)) AS digest,lower(hex(archive_sha256)) AS archive FROM project_recovery_jobs WHERE operation_id=?1",
      )
      .bind(job.scope.operationId)
      .first<{ native_manifest: string; digest: string; archive: string }>();
    if (!stored) throw new Error("Native export manifest was not persisted");
    expect(stored.digest).toBe(createHash("sha256").update(stored.native_manifest).digest("hex"));
    expect(stored.archive).toBe("ab".repeat(32));
    expect(JSON.parse(stored.native_manifest)).toMatchObject({
      projectId: project.projectId,
      databaseId,
      realms: [{ environmentId: e, revocationEpoch: 1, configurationRevision: 1 }],
    });
    await expect(
      job.project.shard
        .prepare("UPDATE project_recovery_jobs SET native_manifest='{}' WHERE operation_id=?1")
        .bind(job.scope.operationId)
        .run(),
    ).rejects.toThrow();
  });
  it("retains one lost Native upload permit and retires it only after expiry", async () => {
    now = BASE + 60_000;
    const job = await accepted(0, { pgcf: false });
    const project = job.project,
      e = project.devEnvironmentId,
      databaseId = `a${job.scope.operationId.toLowerCase().slice(-19)}`;
    await seedNativeOwner(project);
    await project.shard
      .prepare(
        `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'prj_12345678901234567890',?3,'operation','eu-dev','r256-s500m',1,'2026-10-28T08:20:00.000000Z','2026-10-28T08:00:00.000000Z')`,
      )
      .bind(project.organizationId, project.projectId, databaseId)
      .run();
    await project.shard
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','Test',1,1)",
      )
      .bind(project.organizationId, project.projectId, e)
      .run();
    await project.shard
      .prepare(
        `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890',?6,1,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        project.organizationId,
        project.projectId,
        e,
        ulidOf("prep", 1),
        ulidOf("claim", 1),
        databaseId,
        `omh_auth_${e.toLowerCase()}`,
        `omh_ar_${e.toLowerCase()}`,
        `omh_am_${e.toLowerCase()}`,
        `omh_ab_${project.projectId.toLowerCase()}`,
        NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      )
      .run();
    capture.run = async (value) => {
      expect(value.databases).toMatchObject([
        { resource: { kind: "native_auth_database", databaseId } },
      ]);
      const base = (
        value as unknown as {
          scope: {
            nativeManifest: { realms: Record<string, unknown>[] } & Record<string, unknown>;
          };
        }
      ).scope.nativeManifest;
      const manifest = {
        ...base,
        realms: base.realms.map((realm) => ({
          ...realm,
          dumpOffset: 0,
          dumpBytes: 1,
          dumpSha256: "a".repeat(64),
        })),
      };
      return {
        ...receipt(),
        sqlFiles: ["auth.sql"],
        nativeManifest: manifest,
        nativeManifestSha256: `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
      };
    };
    const objects = new Map<string, Uint8Array>();
    const client = await clientFor(job, {
      fault: (method, count) => (method === "dispatchArchive" && count === 1 ? "after" : undefined),
    });
    const attempt = runner(client, { objects });
    expect(await attempt.run(job)).toEqual({ status: "running" });
    expect(attempt.puts).toEqual([]);
    expect(
      await rows(
        job.project.shard,
        "SELECT state,object_key FROM native_export_effects WHERE operation_id=?1",
        job.scope.operationId,
      ),
    ).toEqual([
      {
        state: "dispatched",
        object_key: `native-exports/${job.scope.organizationId}/${job.scope.projectId}/${job.scope.operationId}.zip`,
      },
    ]);
    const inventory = await job.project.shard
      .prepare(DELETION_INVENTORY_TARGETS)
      .bind(job.scope.organizationId, job.scope.projectId)
      .all<{ resource_kind: string; locator: string }>();
    expect(
      inventory.results.some(
        (row) =>
          row.resource_kind === "sql-export" &&
          row.locator.endsWith(`/${job.scope.operationId}.zip`),
      ),
    ).toBe(true);
    const retry = runner(await clientFor(job), { objects });
    expect(await retry.run(job)).toEqual({ status: "running" });
    expect(retry.puts).toEqual([]);
    const direct = await clientFor(job);
    const claimed = await direct.claim();
    if (claimed.status !== "claimed" || !claimed.preparedArchive)
      throw new Error("missing prepared archive");
    const lease = await direct.acquireFence({ holderId: uuid(900), leaseMilliseconds: 5000 });
    const fence = { epoch: lease.epoch, holderId: lease.holderId };
    if (typeof direct.dispatchArchive !== "function")
      throw new Error("missing native archive dispatch capability");
    expect(await direct.dispatchArchive({ archive: claimed.preparedArchive, fence })).toEqual({
      granted: false,
    });
    await expect(
      direct.discardArchive({ archive: claimed.preparedArchive, fence }),
    ).rejects.toBeInstanceOf(RecoveryControlError);
    await direct.releaseFence(fence);
    // Deletion can retire this retained effect only when the current project scope and frozen inventory agree.
    const deletion = ulidOf("deletion", next()),
      cleanup = ulidOf("cleanup", next());
    const deletionScope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      operationId: deletion,
      exportId: job.scope.operationId,
    };
    await project.shard.batch([
      project.shard
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,?5,?5)",
        )
        .bind(
          project.organizationId,
          deletion,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
      project.shard
        .prepare(
          "INSERT INTO native_auth_deletion_operations(organization_id,project_id,operation_id,target_version,provider_project_id,database_id,idempotency_key,state) VALUES(?1,?2,?3,1,'prj_12345678901234567890',?4,?3,'reserved')",
        )
        .bind(project.organizationId, project.projectId, deletion, databaseId),
      project.shard
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=2 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(project.organizationId, project.projectId),
      project.shard
        .prepare(
          "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,'running',1,?5,?5)",
        )
        .bind(project.organizationId, cleanup, project.projectId, deletion, STORED_NOW),
    ]);
    await seedDeletionIntent(project, project.devEnvironmentId, deletion, {
      cleanupRunId: cleanup,
    });
    await expect(recovery.cleanup.readCleanupTarget(deletionScope)).rejects.toThrow();
    const nativeKey = `native-exports/${project.organizationId}/${project.projectId}/${job.scope.operationId}.zip`;
    const locator = `encoded/${Buffer.from(`ohmyho-development-backups/${nativeKey}`).toString("base64url")}`;
    await project.shard
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','sql-export',?5,?6,?7)",
      )
      .bind(
        project.organizationId,
        ulidOf("inventory", next()),
        project.projectId,
        deletion,
        new Uint8Array(32).fill(5),
        STORED_NOW,
        locator,
      )
      .run();
    await expect(
      project.shard
        .prepare(
          "UPDATE projects SET lifecycle_state='deleted' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(project.organizationId, project.projectId)
        .run(),
    ).rejects.toThrow("native export retirement incomplete");
    expect(await recovery.cleanup.readCleanupTarget(deletionScope)).toMatchObject({
      key: nativeKey,
      nativeEffect: { state: "dispatched" },
    });
    await expect(
      recovery.cleanup.readCleanupTarget({
        ...deletionScope,
        organizationId: ulidOf("foreign", next()),
      }),
    ).rejects.toThrow();
    await expect(
      recovery.cleanup.recordNativeExportRetired({
        ...deletionScope,
        exportId: ulidOf("foreign", next()),
        outcome: "tombstoned",
      }),
    ).rejects.toThrow();
    // Service cleanup remains authorized after the initiating owner loses their role.
    await project.shard
      .prepare(
        "UPDATE organization_memberships SET role='member' WHERE organization_id=?1 AND workos_user_id='user_owner'",
      )
      .bind(project.organizationId)
      .run();
    const purge = { ...job.scope, exportId: job.scope.operationId };
    await expect(recovery.cleanup.readCleanupTarget(purge)).rejects.toThrow();
    now += 7 * 24 * 60 * 60 * 1000;
    const claims = await Promise.all([
      recovery.maintenance.prepareMaintenance({ auditEventId: ulidOf("expiry-audit", next()) }),
      recovery.maintenance.prepareMaintenance({ auditEventId: ulidOf("expiry-audit", next()) }),
    ]);
    const claimedDue = claims.flatMap((result) => result.dueNativeArchivePurges);
    expect(new Set(claimedDue.map((row) => row.operationId)).size).toBe(claimedDue.length);
    expect(claimedDue).toContainEqual(purge);
    for (const other of claimedDue) {
      if (other.operationId !== purge.operationId)
        await recovery.cleanup.recordNativeExportRetired({ ...other, outcome: "absent" });
    }
    const immediate = await recovery.maintenance.prepareMaintenance({
      auditEventId: ulidOf("expiry-audit", next()),
    });
    expect(immediate.dueNativeArchivePurges).not.toContainEqual(purge);
    now += 5 * 60 * 1000 + 1;
    const retried = await recovery.maintenance.prepareMaintenance({
      auditEventId: ulidOf("expiry-audit", next()),
    });
    expect(retried.dueNativeArchivePurges).toContainEqual(purge);
    expect(await recovery.cleanup.readCleanupTarget(purge)).toMatchObject({
      exportId: job.scope.operationId,
      nativeEffect: { state: "dispatched", bytes: 2048, sha256: "ab".repeat(32) },
    });
    await expect(
      recovery.cleanup.readCleanupTarget({ ...purge, organizationId: ulidOf("foreign", next()) }),
    ).rejects.toThrow();
    let marker: { body: Buffer; type: string } | undefined;
    const s3 = {
      async send(command: unknown) {
        if (command instanceof GetBucketLifecycleConfigurationCommand)
          throw Object.assign(new Error(), { name: "NoSuchLifecycleConfiguration" });
        if (command instanceof GetObjectCommand) {
          if (!marker) throw { $metadata: { httpStatusCode: 404 } };
          return {
            Body: Readable.from([marker.body]),
            ContentLength: marker.body.length,
            ContentType: marker.type,
          };
        }
        if (command instanceof PutObjectCommand) {
          if (marker) throw { $metadata: { httpStatusCode: 412 } };
          expect(command.input.IfNoneMatch).toBe("*");
          marker = {
            body: Buffer.from(command.input.Body as Uint8Array),
            type: String(command.input.ContentType),
          };
          return {};
        }
        throw new Error("unexpected S3 operation");
      },
      destroy() {},
    };
    const archiveStore = createRecoveryArchiveStore(
      {
        accountId: "a".repeat(32),
        bucket: "ohmyho-development-backups",
        accessKeyId: "b".repeat(32),
        apiToken: "fixture-private-token-long",
        now: () => new Date(now),
      },
      s3 as never,
    );
    const purgeClient = await clientFor(job, {
      grant: {
        action: "purge",
        claimId: undefined,
        exportId: job.scope.operationId,
        expiresAtMs: now + 60000,
      },
    });
    const executePurge = createRecoveryRuntime({
      control: purgeClient,
      archiveDownloads: archiveStore,
      clock,
    } as never);
    expect(await executePurge({ action: "purge", ...purge })).toEqual({
      status: "absent",
      exportId: job.scope.operationId,
    });
    await expect(
      s3.send(
        new PutObjectCommand({
          Bucket: "ohmyho-development-backups",
          Key: `native-exports/${job.scope.organizationId}/${job.scope.projectId}/${job.scope.operationId}.zip`,
          Body: Buffer.from("late"),
          IfNoneMatch: "*",
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    archiveStore.close();
    expect(
      await recovery.cleanup.recordNativeExportRetired({ ...purge, outcome: "tombstoned" }),
    ).toEqual({ outcome: "replayed" });
    await expect(
      recovery.cleanup.recordNativeExportRetired({ ...purge, outcome: "absent" }),
    ).rejects.toThrow();
    await expect(
      job.project.shard
        .prepare("UPDATE native_export_effects SET state='dispatched' WHERE operation_id=?1")
        .bind(job.scope.operationId)
        .run(),
    ).rejects.toThrow();
    expect(
      (
        await recovery.maintenance.prepareMaintenance({
          auditEventId: ulidOf("expiry-audit", next()),
        })
      ).dueNativeArchivePurges,
    ).not.toContainEqual(purge);
  });
  it("retires an uncertain Native export only with the accepted deletion inventory", async () => {
    now = BASE + 60_000;
    const job = await accepted(0, { pgcf: false });
    const project = job.project,
      e = project.devEnvironmentId,
      databaseId = `a${job.scope.operationId.toLowerCase().slice(-19)}`;
    await seedNativeOwner(project);
    await project.shard
      .prepare(
        `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'prj_12345678901234567890',?3,'operation','eu-dev','r256-s500m',1,'2026-10-28T08:20:00.000000Z','2026-10-28T08:00:00.000000Z')`,
      )
      .bind(project.organizationId, project.projectId, databaseId)
      .run();
    await project.shard
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','Test',1,1)",
      )
      .bind(project.organizationId, project.projectId, e)
      .run();
    await project.shard
      .prepare(
        `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890',?6,1,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        project.organizationId,
        project.projectId,
        e,
        ulidOf("prep", 1),
        ulidOf("claim", 1),
        databaseId,
        `omh_auth_${e.toLowerCase()}`,
        `omh_ar_${e.toLowerCase()}`,
        `omh_am_${e.toLowerCase()}`,
        `omh_ab_${project.projectId.toLowerCase()}`,
        NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      )
      .run();
    capture.run = async (value) => {
      expect(value.databases).toMatchObject([
        { resource: { kind: "native_auth_database", databaseId } },
      ]);
      const base = (
        value as unknown as {
          scope: {
            nativeManifest: { realms: Record<string, unknown>[] } & Record<string, unknown>;
          };
        }
      ).scope.nativeManifest;
      const manifest = {
        ...base,
        realms: base.realms.map((realm) => ({
          ...realm,
          dumpOffset: 0,
          dumpBytes: 1,
          dumpSha256: "a".repeat(64),
        })),
      };
      return {
        ...receipt(),
        sqlFiles: ["auth.sql"],
        nativeManifest: manifest,
        nativeManifestSha256: `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
      };
    };
    const objects = new Map<string, Uint8Array>();
    const client = await clientFor(job, {
      fault: (method, count) => (method === "dispatchArchive" && count === 1 ? "after" : undefined),
    });
    expect(await runner(client, { objects }).run(job)).toEqual({ status: "running" });
    // Deletion can retire this retained effect only when the current project scope and frozen inventory agree.
    const deletion = ulidOf("deletion", next()),
      cleanup = ulidOf("cleanup", next());
    const deletionScope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      operationId: deletion,
      exportId: job.scope.operationId,
    };
    await project.shard.batch([
      project.shard
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,?5,?5)",
        )
        .bind(
          project.organizationId,
          deletion,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
      project.shard
        .prepare(
          "INSERT INTO native_auth_deletion_operations(organization_id,project_id,operation_id,target_version,provider_project_id,database_id,idempotency_key,state) VALUES(?1,?2,?3,1,'prj_12345678901234567890',?4,?3,'reserved')",
        )
        .bind(project.organizationId, project.projectId, deletion, databaseId),
      project.shard
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=2 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(project.organizationId, project.projectId),
      project.shard
        .prepare(
          "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,'running',1,?5,?5)",
        )
        .bind(project.organizationId, cleanup, project.projectId, deletion, STORED_NOW),
    ]);
    await seedDeletionIntent(project, project.devEnvironmentId, deletion, {
      cleanupRunId: cleanup,
    });
    await expect(recovery.cleanup.readCleanupTarget(deletionScope)).rejects.toThrow();
    const nativeKey = `native-exports/${project.organizationId}/${project.projectId}/${job.scope.operationId}.zip`;
    const locator = `encoded/${Buffer.from(`ohmyho-development-backups/${nativeKey}`).toString("base64url")}`;
    await project.shard
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','sql-export',?5,?6,?7)",
      )
      .bind(
        project.organizationId,
        ulidOf("inventory", next()),
        project.projectId,
        deletion,
        new Uint8Array(32).fill(5),
        STORED_NOW,
        locator,
      )
      .run();
    await expect(
      project.shard
        .prepare(
          "UPDATE projects SET lifecycle_state='deleted' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(project.organizationId, project.projectId)
        .run(),
    ).rejects.toThrow("native export retirement incomplete");
    expect(await recovery.cleanup.readCleanupTarget(deletionScope)).toMatchObject({
      key: nativeKey,
      nativeEffect: { state: "dispatched" },
    });
    await expect(
      recovery.cleanup.readCleanupTarget({
        ...deletionScope,
        organizationId: ulidOf("foreign", next()),
      }),
    ).rejects.toThrow();
    await expect(
      recovery.cleanup.recordNativeExportRetired({
        ...deletionScope,
        exportId: ulidOf("foreign", next()),
        outcome: "tombstoned",
      }),
    ).rejects.toThrow();
    expect(
      await recovery.cleanup.recordNativeExportRetired({ ...deletionScope, outcome: "tombstoned" }),
    ).toEqual({ outcome: "recorded" });
    expect(
      await recovery.cleanup.recordNativeExportRetired({ ...deletionScope, outcome: "tombstoned" }),
    ).toEqual({ outcome: "replayed" });
    expect(
      await rows(
        project.shard,
        "SELECT state FROM native_export_effects WHERE operation_id=?1",
        job.scope.operationId,
      ),
    ).toEqual([{ state: "tombstoned" }]);
  });
  it("captures application and Native Auth databases in a single scoped V2 export", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const project = job.project,
      e = project.devEnvironmentId,
      databaseId = `a${job.scope.operationId.toLowerCase().slice(-19)}`;
    await seedNativeOwner(project);
    await project.shard
      .prepare(
        `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'prj_12345678901234567890',?3,'operation','eu-dev','r256-s500m',1,'2026-10-28T08:20:00.000000Z','2026-10-28T08:00:00.000000Z')`,
      )
      .bind(project.organizationId, project.projectId, databaseId)
      .run();
    await project.shard
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','Test',1,1)",
      )
      .bind(project.organizationId, project.projectId, e)
      .run();
    await project.shard
      .prepare(
        `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890',?6,1,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        project.organizationId,
        project.projectId,
        e,
        ulidOf("prep", 1),
        ulidOf("claim", 1),
        databaseId,
        `omh_auth_${e.toLowerCase()}`,
        `omh_ar_${e.toLowerCase()}`,
        `omh_am_${e.toLowerCase()}`,
        `omh_ab_${project.projectId.toLowerCase()}`,
        NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      )
      .run();
    let captureStarted = false;
    capture.run = async (value) => {
      captureStarted = true;
      expect(value.databases).toMatchObject([
        { resource: { kind: "application_database", environmentId: job.devData } },
        { resource: { kind: "native_auth_database", databaseId } },
      ]);
      const base = (
        value as unknown as {
          scope: {
            nativeManifest: { realms: Record<string, unknown>[] } & Record<string, unknown>;
          };
        }
      ).scope.nativeManifest;
      const manifest = {
        ...base,
        realms: base.realms.map((realm) => ({
          ...realm,
          dumpOffset: 0,
          dumpBytes: 1,
          dumpSha256: "a".repeat(64),
        })),
      };
      return {
        ...receipt(),
        sqlFiles: ["dev.sql", "auth.sql"],
        nativeManifest: manifest,
        nativeManifestSha256: `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
      };
    };
    const setRole = async (role: "admin" | "member") =>
      project.shard
        .prepare(
          "UPDATE organization_memberships SET role=?2 WHERE organization_id=?1 AND workos_user_id='user_owner'",
        )
        .bind(project.organizationId, role)
        .run();
    const authorityClient = await clientFor(job, {
      store: {
        authorizeNativeCapture: async (input) => {
          await setRole("member");
          await expect(recovery.executor.authorizeNativeCapture(input)).rejects.toThrow();
          expect(captureStarted).toBe(false);
          await setRole("admin");
          return recovery.executor.authorizeNativeCapture(input);
        },
        prepareArchive: async (input) => {
          await setRole("member");
          await expect(recovery.executor.prepareArchive(input)).rejects.toThrow();
          expect(
            await rows(
              project.shard,
              "SELECT state FROM native_export_effects WHERE operation_id=?1",
              job.scope.operationId,
            ),
          ).toEqual([]);
          await setRole("admin");
          return recovery.executor.prepareArchive(input);
        },
        dispatchArchive: async (input) => {
          await setRole("member");
          await expect(recovery.executor.dispatchArchive(input)).rejects.toThrow();
          expect(
            await rows(
              project.shard,
              "SELECT state FROM native_export_effects WHERE operation_id=?1",
              job.scope.operationId,
            ),
          ).toEqual([{ state: "reserved" }]);
          await setRole("admin");
          return recovery.executor.dispatchArchive(input);
        },
      },
    });
    expect(await runner(authorityClient).run(job)).toEqual({ status: "succeeded" });
    const stored = await job.project.shard
      .prepare(
        "SELECT native_manifest,lower(hex(native_manifest_sha256)) AS digest,lower(hex(archive_sha256)) AS archive FROM project_recovery_jobs WHERE operation_id=?1",
      )
      .bind(job.scope.operationId)
      .first<{ native_manifest: string; digest: string; archive: string }>();
    if (!stored) throw new Error("Native export manifest was not persisted");
    expect(stored.digest).toBe(createHash("sha256").update(stored.native_manifest).digest("hex"));
    expect(stored.archive).toBe("ab".repeat(32));
    expect(JSON.parse(stored.native_manifest)).toMatchObject({
      projectId: project.projectId,
      databaseId,
      realms: [{ environmentId: e, revocationEpoch: 1, configurationRevision: 1 }],
    });
    await expect(
      job.project.shard
        .prepare("UPDATE project_recovery_jobs SET native_manifest='{}' WHERE operation_id=?1")
        .bind(job.scope.operationId)
        .run(),
    ).rejects.toThrow();
  });
  it("captures, records, verifies and finishes through the port and releases the lease", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    capture.run = async (input) => {
      expect(input.databases).toHaveLength(1);
      return receipt();
    };
    const { run, puts } = runner(await clientFor(job));
    expect(await run(job)).toEqual({ status: "succeeded" });
    expect(puts).toEqual([
      `snapshots/${job.scope.organizationId}/${job.scope.projectId}/${job.scope.operationId}.zip`,
    ]);
    expect(await state(job)).toEqual([{ state: "succeeded" }]);
    expect(
      await rows(
        job.project.shard,
        "SELECT released_at IS NOT NULL AS released, epoch FROM project_recovery_fences WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ released: 1, epoch: 1 }]);
    expect(
      await rows(
        job.project.shard,
        "SELECT length(archive_sha256) AS n, input_ciphertext FROM project_recovery_jobs WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ n: 32, input_ciphertext: null }]);
    // Terminal job: the same dispatch only reports its state.
    expect(await run(job)).toEqual({ status: "succeeded" });
    expect(
      await (
        await clientFor(job, { grant: { action: "download", claimId: undefined } })
      ).readArchive(),
    ).toMatchObject({
      operationId: job.scope.operationId,
      bytes: 2048,
      bucket: "ohmyho-development-backups",
    });
  });

  it("aborts the capture when the lease is lost and lets a later dispatch finish the ORIGINAL job", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    let aborted = false;
    capture.run = async ({ signal }) => {
      now += 20 * 60_000; // the lease lapses while the capture is still running
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      aborted = true;
      signal.throwIfAborted();
      return receipt();
    };
    const first = runner(await clientFor(job));
    expect(await first.run(job)).toEqual({ status: "running" });
    expect(aborted).toBe(true);
    expect(first.puts).toEqual([]);
    expect(await state(job)).toEqual([{ state: "running" }]);
    capture.run = async () => receipt();
    const second = runner(await clientFor(job));
    expect(await second.run(job)).toEqual({ status: "succeeded" });
    expect(
      await rows(
        job.project.shard,
        "SELECT epoch FROM project_recovery_fences WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ epoch: 2 }]);
    expect(
      await rows(
        job.project.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ n: 1 }]);
  });

  it("keeps capturing through transient renewal failures while the lease stands, then aborts at its end", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    let calls = 0;
    capture.run = async ({ signal }) => {
      await sleep(80); // renewals fail transiently, the lease still stands
      expect(signal.aborted).toBe(false);
      now += 60_000; // now the last known lease is over
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return receipt();
    };
    const client = await clientFor(job, {
      attempts: 1,
      fault: (method) => (method === "renewFence" && ++calls > 0 ? "before" : undefined),
    });
    expect(await runner(client).run(job)).toEqual({ status: "running" });
    expect(calls).toBeGreaterThan(1);
  });

  it("claims again inside the fence: input that expired while the fence was acquired is denied and failed in ONE batch", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    capture.run = async () => {
      throw new Error("must not capture");
    };
    let opened = 0;
    const counting = {
      ...cipher,
      open: async (...args: Parameters<typeof cipher.open>) => (opened++, cipher.open(...args)),
    } as typeof cipher;
    // The fence acquisition itself takes longer than the input's remaining lifetime.
    const slow = await clientFor(job, {
      grant: { expiresAtMs: BASE + 5 * 60 * 60_000 },
      store: {
        acquireFence: async (input) => {
          const lease = await store.acquireFence(input);
          now = BASE + 2 * 60 * 60_000;
          return lease;
        },
      },
    });
    expect(await runner(slow, { cipher: counting }).run(job)).toEqual({ status: "failed" });
    expect(opened).toBe(0);
    expect(
      await rows(
        job.project.shard,
        "SELECT failure_code, input_ciphertext FROM project_recovery_jobs WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_INPUT_EXPIRED", input_ciphertext: null }]);
    // The denial, the failure events and the release of the fence committed together, exactly once.
    expect(
      await rows(
        job.project.shard,
        "SELECT event_type FROM operation_events WHERE organization_id = ?1 AND operation_id = ?2 ORDER BY revision",
        job.scope.organizationId,
        job.scope.operationId,
      ),
    ).toEqual([
      { event_type: "OperationQueued" },
      { event_type: "OperationStarted" },
      { event_type: "OperationFailed" },
    ]);
    expect(
      await rows(
        job.project.shard,
        "SELECT released_at IS NOT NULL AS released FROM project_recovery_fences WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ released: 1 }]);
  });

  it("ends the capture at the last confirmed lease when a renewal hangs, and the old holder can never finish the new lease", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    let hung = 0;
    const hanging = await clientFor(job, {
      store: { renewFence: () => (hung++, new Promise<never>(() => undefined)) },
    });
    let aborted = false;
    capture.run = async ({ signal }) => {
      now += 6_000; // past the 5 s lease, with the renewal still pending
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      aborted = true;
      signal.throwIfAborted();
      return receipt();
    };
    const first = runner(hanging);
    expect(await first.run(job)).toEqual({ status: "running" });
    expect(aborted).toBe(true);
    expect(hung).toBe(1); // one renewal in flight: the queue never stacks further requests
    expect(first.puts).toEqual([]);
    // A new holder takes the lapsed lease at the next epoch; the old holder (epoch 1) is refused everywhere.
    const direct = await clientFor(job);
    expect(
      await direct.acquireFence({ holderId: uuid(50), leaseMilliseconds: 5000 }),
    ).toMatchObject({ epoch: 2 });
    const stale = { epoch: 1, holderId: uuid(101) };
    const archive = {
      sqlFiles: ["dev.sql"],
      bytes: 10,
      sha256: bytes(32, 3),
      capturedAt: new Date(now).toISOString(),
    };
    await expect(direct.prepareArchive({ archive, fence: stale })).rejects.toMatchObject({
      code: "recovery_fence_lost",
    });
    expect(await direct.finish({ failureCode: "STALE_HOLDER", fence: stale })).toEqual({
      outcome: "waiting",
      status: "running",
    });
    expect(await state(job)).toEqual([{ state: "running" }]);
  });

  it("replays a lost response of EVERY mutation through the recorded identity: no second event, outcome or job", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    capture.run = async () => receipt();
    const lose = (method: string, call: number) =>
      call === 1 &&
      ["claim", "acquireFence", "renewFence", "prepareArchive", "finish", "releaseFence"].includes(
        method,
      )
        ? "after"
        : undefined;
    const client = await clientFor(job, { fault: lose });
    expect(await client.claim()).toMatchObject({ status: "claimed" });
    const lease = await client.acquireFence({ holderId: uuid(60), leaseMilliseconds: 5000 });
    now += 1_000;
    expect(
      await client.renewFence({
        epoch: lease.epoch,
        holderId: lease.holderId,
        leaseMilliseconds: 5000,
      }),
    ).toMatchObject({ epoch: 1 });
    const archive = {
      sqlFiles: ["dev.sql"],
      bytes: 2048,
      sha256: new Uint8Array(32).fill(0xab),
      capturedAt: new Date(now).toISOString(),
    };
    const fence = { epoch: lease.epoch, holderId: lease.holderId };
    expect(await client.prepareArchive({ archive, fence })).toEqual({ outcome: "replayed" });
    expect(await client.finish({ archive, fence })).toEqual({
      outcome: "replayed",
      status: "succeeded",
    });
    expect(await client.releaseFence(fence)).toEqual({ outcome: "replayed" });
    const events = (j: Job) =>
      rows<{ event_type: string }>(
        j.project.shard,
        "SELECT event_type FROM operation_events WHERE organization_id = ?1 AND operation_id = ?2 ORDER BY revision",
        j.scope.organizationId,
        j.scope.operationId,
      );
    expect((await events(job)).map((e) => e.event_type)).toEqual([
      "OperationQueued",
      "OperationStarted",
      "OperationSucceeded",
    ]);
    expect(
      await rows(
        job.project.shard,
        "SELECT count(*) AS n FROM audit_events WHERE organization_id = ?1 AND operation_id = ?2",
        job.scope.organizationId,
        job.scope.operationId,
      ),
    ).toEqual([{ n: 3 }]);
    // A failure finish with a lost response replays to the same terminal failure.
    const failing = await accepted();
    const lost = await clientFor(failing, {
      fault: (method, call) =>
        call === 1 && ["finish", "claim"].includes(method) ? "after" : undefined,
    });
    await lost.claim();
    const held = await lost.acquireFence({ holderId: uuid(61), leaseMilliseconds: 5000 });
    expect(
      await lost.finish({
        failureCode: "RECOVERY_IO_FAILED",
        fence: { epoch: held.epoch, holderId: held.holderId },
      }),
    ).toEqual({ outcome: "replayed", status: "failed" });
    expect((await events(failing)).map((e) => e.event_type)).toEqual([
      "OperationQueued",
      "OperationStarted",
      "OperationFailed",
    ]);
    // The composed denial of an expired input replays too.
    const expired = await accepted();
    now = BASE + 2 * 60 * 60_000;
    const denied = await clientFor(expired, {
      grant: { expiresAtMs: BASE + 5 * 60 * 60_000 },
      fault: (method, call) => (call === 1 && method === "claim" ? "after" : undefined),
    });
    expect(await denied.claim()).toEqual({ status: "failed" });
    expect((await events(expired)).map((e) => e.event_type)).toEqual([
      "OperationQueued",
      "OperationStarted",
      "OperationFailed",
    ]);
  });

  it("carries the largest admitted sealed input (8208 bytes of ciphertext) through the wire byte for byte", async () => {
    now = BASE + 60_000;
    const plaintext = new Uint8Array(8192).fill(0x41);
    const job = await accepted(0, { plaintext });
    expect(job.plaintext.ciphertext.byteLength).toBe(8208);
    const claim = await (await clientFor(job)).claim();
    if (claim.status !== "claimed" || claim.sealedInput === null) throw new Error("not claimed");
    expect([...claim.sealedInput.ciphertext]).toEqual([...job.plaintext.ciphertext]);
    expect([...(await cipher.open(job.scope, claim.sealedInput))]).toEqual([...plaintext]);
    // Another operation's AAD never opens it.
    await expect(
      cipher.open({ ...job.scope, operationId: ulidOf("other", 1) }, claim.sealedInput),
    ).rejects.toThrow();
  });

  it("extends the lease watchdog only through a renewal the store answered", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    // Lease 5 s from minute 1. Two jumps of 3 s each pass the ORIGINAL end; only a confirmed renewal in between
    // can carry the capture through the second one.
    capture.run = async () => {
      now += 3_000;
      await sleep(150);
      now += 3_000;
      await sleep(1_300);
      return receipt();
    };
    const result = await runner(await clientFor(job)).run(job);
    expect(result).toEqual({ status: "succeeded" });
    const [fence] = await rows<{ lease_expires_at: string }>(
      job.project.shard,
      "SELECT lease_expires_at FROM project_recovery_fences WHERE organization_id = ?1",
      job.scope.organizationId,
    );
    expect(Date.parse((fence as { lease_expires_at: string }).lease_expires_at)).toBeGreaterThan(
      BASE + 60_000 + 5_000,
    );
  });

  it("lets a crashed Node's lease lapse and then takes over the same job", async () => {
    now = BASE + 60_000;
    const job = await accepted();
    const crashed = await clientFor(job);
    await crashed.claim();
    await crashed.acquireFence({ holderId: uuid(90), leaseMilliseconds: 5000 });
    capture.run = async () => receipt();
    const { run } = runner(await clientFor(job));
    expect(await run(job)).toEqual({ status: "running" }); // the live lease of another holder: wait
    now += 10_000;
    expect(await run(job)).toEqual({ status: "succeeded" });
    expect(
      await rows(
        job.project.shard,
        "SELECT epoch FROM project_recovery_fences WHERE organization_id = ?1",
        job.scope.organizationId,
      ),
    ).toEqual([{ epoch: 2 }]);
  });

  it("records a closed failure code with the fence and refuses success without a verified archive", async () => {
    now = BASE + 60_000;
    const failing = await accepted();
    capture.run = async () => {
      throw new RecoveryArchiveError("recovery_io_failed");
    };
    expect(await runner(await clientFor(failing)).run(failing)).toEqual({ status: "failed" });
    expect(
      await rows(
        failing.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        failing.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_IO_FAILED" }]);
    const generic = await accepted();
    capture.run = async () => {
      throw new Error("boom");
    };
    expect(await runner(await clientFor(generic)).run(generic)).toEqual({ status: "failed" });
    expect(
      await rows(
        generic.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        generic.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_JOB_FAILED" }]);
    const different = await accepted();
    capture.run = async () => receipt();
    expect(
      await runner(await clientFor(different), { verify: "different" }).run(different),
    ).toEqual({ status: "failed" });
    expect(
      await rows(
        different.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        different.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_CHECKSUM_MISMATCH" }]);
    const uncertain = await accepted();
    expect(await runner(await clientFor(uncertain), { verify: "throw" }).run(uncertain)).toEqual({
      status: "running",
    });
    expect(await state(uncertain)).toEqual([{ state: "running" }]);
    // The prepared archive survives; the next dispatch only verifies and finishes (no second capture).
    let captures = 0;
    capture.run = async () => {
      captures += 1;
      return receipt();
    };
    expect(await runner(await clientFor(uncertain)).run(uncertain)).toEqual({
      status: "succeeded",
    });
    expect(captures).toBe(0);
  });

  it("denies an expired input and a missing input without capturing", async () => {
    const expired = await accepted();
    now = BASE + 2 * 60 * 60_000;
    capture.run = async () => {
      throw new Error("must not capture");
    };
    const lateGrant = { expiresAtMs: BASE + 5 * 60 * 60_000 };
    expect(await runner(await clientFor(expired, { grant: lateGrant })).run(expired)).toEqual({
      status: "failed",
    });
    expect(
      await rows(
        expired.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        expired.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_INPUT_EXPIRED" }]);
    now = BASE + 60_000;
    const absent = await accepted();
    const lost = { ...absent, scope: { ...absent.scope, operationId: ulidOf("nope", 1) } } as Job;
    expect(await runner(await clientFor(lost)).run(lost)).toEqual({ status: "absent" });
    const stale = await accepted();
    await freezeOwnership(stale.project);
    await stale.project.shard
      .prepare("UPDATE projects SET lifecycle_state = 'deleting' WHERE organization_id = ?1")
      .bind(stale.scope.organizationId)
      .run();
    expect(await runner(await clientFor(stale)).run(stale)).toEqual({ status: "failed" });
    expect(
      await rows(
        stale.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        stale.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_SCOPE_UNAVAILABLE" }]);
  });

  it("fails closed on a missing sealed input, a missing inventory and an unusable database", async () => {
    now = BASE + 60_000;
    capture.run = async () => receipt();
    const unready = await accepted(0, { pgcf: false });
    await seedPgcf(unready.project, unready.devData, 902, "retired");
    expect(await runner(await clientFor(unready)).run(unready)).toEqual({ status: "failed" });
    expect(
      await rows(
        unready.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        unready.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_JOB_FAILED" }]);
    const wrong = await accepted();
    const noInput = await clientFor(wrong, {
      attempts: 1,
      store: {
        claim: async (input: unknown) => ({
          ...((await store.claim(input)) as object),
          sealedInput: null,
        }),
      },
    });
    expect(await runner(noInput).run(wrong)).toEqual({ status: "failed" });
    const vanished = await accepted();
    const noInventory = {
      ...(await clientFor(vanished)),
      readInventory: async () => null,
    } as RecoveryControl;
    expect(await runner(noInventory).run(vanished)).toEqual({ status: "failed" });
  });

  it("surfaces typed refusals the port cannot recover from", async () => {
    const bad = (code: string): RecoveryControl => ({
      ...({} as RecoveryControl),
      claim: async () => {
        throw new RecoveryControlError(code as never);
      },
    });
    now = BASE + 60_000;
    const job = await accepted();
    await expect(runner(bad("forbidden")).run(job)).rejects.toMatchObject({ code: "forbidden" });
    const running = (code: string, extra: Partial<RecoveryControl> = {}): RecoveryControl => ({
      ...({} as RecoveryControl),
      claim: async () => ({
        status: "claimed",
        preparedArchive: null,
        expired: false,
        denialCode: null,
        replayed: false,
        archiveBucket: "ohmyho-development-backups",
        archiveKey: "k",
        sealedInput: null,
      }),
      acquireFence: async () => {
        throw new RecoveryControlError(code as never);
      },
      ...extra,
    });
    expect(await runner(running("recovery_source_busy")).run(job)).toEqual({ status: "running" });
    expect(await runner(running("control_unavailable")).run(job)).toEqual({ status: "running" });
    await expect(runner(running("invalid_request")).run(job)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(runner(running("forbidden")).run(job)).rejects.toMatchObject({
      code: "forbidden",
    });
    const finishes: unknown[] = [];
    const scopeGone = running("recovery_scope_unavailable", {
      finish: async (input) => {
        finishes.push(input);
        return { outcome: "finished", status: "failed" };
      },
    });
    expect(await runner(scopeGone).run(job)).toEqual({ status: "failed" });
    expect(finishes).toEqual([{ failureCode: "RECOVERY_SCOPE_UNAVAILABLE" }]);
    const conflicted = running("project_recovery_conflict", {
      readClaimState: async () => ({ status: "cancelled" }),
    });
    expect(await runner(conflicted).run(job)).toEqual({ status: "cancelled" });
    expect(
      await runner(running("project_recovery_conflict", { readClaimState: async () => null })).run(
        job,
      ),
    ).toEqual({ status: "absent" });
    // A denial the store reports (it normally ends the job itself): finished without a fence before the lease, with
    // the holder's fence after it; a finish that must wait keeps the job running.
    const denied = (code: string): RecoveryControl["claim"] =>
      (async () => ({
        status: "claimed",
        preparedArchive: null,
        expired: true,
        denialCode: code,
        replayed: false,
        archiveBucket: "ohmyho-development-backups",
        archiveKey: "k",
        sealedInput: null,
      })) as RecoveryControl["claim"];
    const ending: unknown[] = [];
    const lease = async () => ({
      outcome: "acquired" as const,
      epoch: 4,
      holderId: uuid(1),
      leaseExpiresAt: new Date(now + 5000).toISOString(),
      sourceOwnershipVersion: 1,
      sourceLifecycleVersion: 1,
    });
    const finishing = (outcome: "finished" | "waiting") => async (input: unknown) => {
      ending.push(input);
      return {
        outcome,
        status: outcome === "finished" ? ("failed" as const) : ("running" as const),
      };
    };
    const beforeFence = running("none", {
      claim: denied("RECOVERY_SCOPE_UNAVAILABLE"),
      finish: finishing("finished"),
    });
    expect(await runner(beforeFence).run(job)).toEqual({ status: "failed" });
    let calls = 0;
    const insideFence = {
      ...running("none"),
      claim: async (input?: unknown) =>
        ++calls === 1 ? running("none").claim() : denied("RECOVERY_INPUT_EXPIRED")(input as never),
      acquireFence: lease,
      releaseFence: async () => ({ outcome: "released" as const }),
      finish: finishing("finished"),
    } as RecoveryControl;
    expect(await runner(insideFence).run(job)).toEqual({ status: "failed" });
    calls = 0;
    const waits = { ...insideFence, finish: finishing("waiting") } as RecoveryControl;
    expect(await runner(waits).run(job)).toEqual({ status: "running" });
    expect(ending).toEqual([
      { failureCode: "RECOVERY_SCOPE_UNAVAILABLE" },
      { failureCode: "RECOVERY_INPUT_EXPIRED", fence: { epoch: 4, holderId: uuid(1) } },
      { failureCode: "RECOVERY_INPUT_EXPIRED", fence: { epoch: 4, holderId: uuid(1) } },
    ]);
    // Without an injected source each invocation draws its own random holder id.
    const drawn: string[] = [];
    const defaults = createRecoveryJobRunner({
      control: {
        ...running("none"),
        acquireFence: async (input: { holderId: string }) => {
          drawn.push(input.holderId);
          throw new RecoveryControlError("recovery_source_busy");
        },
      } as unknown as RecoveryControl,
      cipher,
      database: { read: async () => "" },
      archives: { put: async () => undefined, verify: async () => "verified" },
      clock,
    });
    await defaults.run({ ...job.scope, claimId: CLAIM });
    await defaults.run({ ...job.scope, claimId: CLAIM });
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(drawn[0]).not.toBe(drawn[1]);
    // A finish that is told to wait keeps the job running; one that fails closed keeps it running too.
    const waiting = running("recovery_scope_unavailable", {
      finish: async () => ({ outcome: "waiting", status: "running" }),
    });
    expect(await runner(waiting).run(job)).toEqual({ status: "running" });
    const brokenFinish = {
      ...running("none"),
      acquireFence: async () => ({
        outcome: "acquired" as const,
        epoch: 1,
        holderId: uuid(1),
        leaseExpiresAt: new Date(now + 5000).toISOString(),
        sourceOwnershipVersion: 1,
        sourceLifecycleVersion: 1,
      }),
      releaseFence: async () => {
        throw new RecoveryControlError("control_unavailable");
      },
      finish: async () => {
        throw new RecoveryControlError("control_unavailable");
      },
    } as RecoveryControl;
    expect(await runner(brokenFinish).run(job)).toEqual({ status: "running" });
    const exploding = {
      ...brokenFinish,
      finish: async () => {
        throw new Error("unexpected");
      },
    } as RecoveryControl;
    await expect(runner(exploding).run(job)).rejects.toThrow("unexpected");
    // The command is validated before any port call.
    await expect(
      createRecoveryJobRunner({
        control: brokenFinish,
        cipher,
        database: { read: async () => "" },
        archives: { put: async () => undefined, verify: async () => "verified" },
        clock,
      }).run({ ...job.scope, claimId: "bad" }),
    ).rejects.toThrow("recovery_input_invalid");
  });

  it("captures a fresh archive when the recorded one never landed and keeps every landed or finished archive immutable", async () => {
    const recorded: Recorded = {
      sqlFiles: ["dev.sql"],
      bytes: 10,
      sha256: bytes(32, 3),
      capturedAt: iso(60_000),
    };
    const archiveRow = (job: Job) =>
      rows<{ sha: string; bytes: number }>(
        job.project.shard,
        "SELECT lower(hex(archive_sha256)) AS sha, archive_bytes AS bytes FROM project_recovery_jobs WHERE organization_id = ?1",
        job.scope.organizationId,
      );
    const events = (job: Job) =>
      rows<{ event_type: string }>(
        job.project.shard,
        "SELECT event_type FROM operation_events WHERE organization_id = ?1 AND operation_id = ?2 ORDER BY revision",
        job.scope.organizationId,
        job.scope.operationId,
      );

    // 1. the recorded receipt never landed and the sealed input is still held: the receipt is discarded, a fresh
    //    archive is captured and written once
    now = BASE + 60_000;
    const lost = await accepted();
    await crashedWith(lost, recorded);
    now += 10_000;
    const lostObjects = new Map<string, Uint8Array>();
    let captures = 0;
    capture.run = async () => {
      captures += 1;
      return receipt();
    };
    const lostDiscards: unknown[] = [];
    const lostRun = runner(watching(await clientFor(lost), lostDiscards), { objects: lostObjects });
    expect(await lostRun.run(lost)).toEqual({ status: "succeeded" });
    expect(captures).toBe(1);
    expect(lostDiscards).toEqual([
      expect.objectContaining({ archive: expect.objectContaining({ bytes: 10 }) }),
    ]);
    expect(await archiveRow(lost)).toEqual([{ sha: "ab".repeat(32), bytes: 2048 }]);
    expect(lostRun.puts).toEqual([keyOf(lost)]);
    expect(lostObjects.get(keyOf(lost))).toEqual(new Uint8Array(32).fill(0xab));
    expect(await events(lost)).toEqual([
      { event_type: "OperationQueued" },
      { event_type: "OperationStarted" },
      { event_type: "OperationSucceeded" },
    ]);
    expect(
      await rows(
        lost.project.shard,
        "SELECT epoch, released_at IS NOT NULL AS released FROM project_recovery_fences WHERE organization_id = ?1",
        lost.scope.organizationId,
      ),
    ).toEqual([{ epoch: 2, released: 1 }]);

    // 2. the discard response is lost: the retry replays it and the fresh archive is still captured once
    now = BASE + 60_000;
    const retried = await accepted();
    await crashedWith(retried, recorded);
    now += 10_000;
    captures = 0;
    const retriedObjects = new Map<string, Uint8Array>();
    const retriedRun = runner(
      await clientFor(retried, {
        fault: (method, call) => (method === "discardArchive" && call === 1 ? "after" : undefined),
      }),
      { objects: retriedObjects },
    );
    expect(await retriedRun.run(retried)).toEqual({ status: "succeeded" });
    expect(captures).toBe(1);
    expect(await archiveRow(retried)).toEqual([{ sha: "ab".repeat(32), bytes: 2048 }]);
    expect(await events(retried)).toHaveLength(3);

    // 3. nothing can be recaptured (the sealed input expired): the job fails with RECOVERY_ARCHIVE_LOST, the
    //    recorded receipt stays, and nothing is discarded
    now = BASE + 60_000;
    const expired = await accepted();
    await crashedWith(expired, recorded);
    now = BASE + 2 * 60 * 60_000;
    capture.run = async () => {
      throw new Error("must not capture");
    };
    const expiredDiscards: unknown[] = [];
    const expiredClient = await clientFor(expired, {
      grant: { expiresAtMs: BASE + 5 * 60 * 60_000 },
    });
    expect(
      await runner(watching(expiredClient, expiredDiscards), { objects: new Map() }).run(expired),
    ).toEqual({ status: "failed" });
    expect(expiredDiscards).toEqual([]);
    expect(
      await rows(
        expired.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        expired.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_ARCHIVE_LOST" }]);
    expect(await archiveRow(expired)).toEqual([{ sha: "03".repeat(32), bytes: 10 }]);

    // 4. the recorded archive landed: it is verified and finished, never captured or replaced
    now = BASE + 60_000;
    const landed = await accepted();
    await crashedWith(landed, recorded);
    now += 10_000;
    capture.run = async () => {
      throw new Error("must not capture");
    };
    const landedDiscards: unknown[] = [];
    expect(
      await runner(watching(await clientFor(landed), landedDiscards), {
        objects: new Map([[keyOf(landed), bytes(32, 3)]]),
      }).run(landed),
    ).toEqual({ status: "succeeded" });
    expect(landedDiscards).toEqual([]);
    expect(await archiveRow(landed)).toEqual([{ sha: "03".repeat(32), bytes: 10 }]);

    // 5. another object is at the key: the readback differs, the job fails and the receipt stays
    now = BASE + 60_000;
    const different = await accepted();
    await crashedWith(different, recorded);
    now += 10_000;
    const differentDiscards: unknown[] = [];
    expect(
      await runner(watching(await clientFor(different), differentDiscards), {
        objects: new Map([[keyOf(different), bytes(32, 0xcd)]]),
      }).run(different),
    ).toEqual({ status: "failed" });
    expect(differentDiscards).toEqual([]);
    expect(
      await rows(
        different.project.shard,
        "SELECT failure_code FROM project_recovery_jobs WHERE organization_id = ?1",
        different.scope.organizationId,
      ),
    ).toEqual([{ failure_code: "RECOVERY_CHECKSUM_MISMATCH" }]);
    expect(await archiveRow(different)).toEqual([{ sha: "03".repeat(32), bytes: 10 }]);
  });
});
