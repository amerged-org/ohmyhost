import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it, vi } from "vitest";
import {
  createClient,
  createManagedSourceUpload,
  putManagedSourceBlob,
  commitManagedSourceUpload,
  listManagedSourceFiles,
  openProjectPreview,
  getProjectSource,
  getProjectPreview,
} from "@ohmyhost/sdk-ts";
import { createUlidFactory, parseUlid, SystemClock, SystemEntropy } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedManagedSourceProject } from "../../control-store/test/support/managed-source-fixture.js";
import {
  fixture as gitFixture,
  accountId,
  namespace,
  type GitHttpRequest,
} from "../../source-fetcher/test/support/git-artifacts.js";
import { createManagedGitRpc } from "../../source-fetcher/src/managed-git-rpc.js";
import { createD1ExtendedPorts } from "../src/d1-extended-ports.js";
import { createD1ManagedSourceProcessor } from "../src/d1-managed-source-processor.js";
import { createD1ProjectApplication } from "../src/d1-project-application.js";
import {
  createPreviewSurface,
  notifyPreviewSources,
  type PreviewExecutionBinding,
} from "../src/preview-surface.js";
import { createEnvironmentSecretCipherKeyring } from "../src/environment-secret-cipher.js";
import {
  parseRateCard,
  planPublish,
  planActivate,
  readState,
  applyPlan,
} from "../../../scripts/credit-prices-model.mjs";

interface LocalPreviewSocket {
  on(event: "framereceived", listener: (frame: { payload: string | Buffer }) => void): void;
}
interface LocalPreviewPage {
  on(event: "websocket", listener: (socket: LocalPreviewSocket) => void): void;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<{ status(): number } | null>;
  getByRole(
    role: "heading",
    options: { name: string },
  ): { waitFor(options: { timeout: number }): Promise<void> };
  evaluate<Result>(operation: () => Result): Promise<Result>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
}
interface LocalPreviewBrowser {
  close(): Promise<void>;
  newContext(options: {
    ignoreHTTPSErrors: boolean;
  }): Promise<{ newPage(): Promise<LocalPreviewPage> }>;
}
interface LocalPreviewChromium {
  launch(options: {
    headless: boolean;
    executablePath: string;
    args: string[];
  }): Promise<LocalPreviewBrowser>;
}
type PreviewDocumentGlobal = typeof globalThis & { __previewSameDocument?: boolean };

vi.mock("cloudflare:workers", () => ({
  // Test-only Workers base class; no members are needed by the imported RPC targets.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  DurableObject: class {},
  WorkerEntrypoint: class {
    constructor(
      _context: unknown,
      public readonly env: unknown,
    ) {}
  },
}));

it("carries an SDK source upload through the actual API, Core, local Git and Source Fetcher", async () => {
  const control = await createTestControl();
  const objects = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response()}}",
      r2Buckets: { STAGING: "preview-local-stage" },
    }),
  );
  const git = gitFixture();
  let localRuntime: {
    execution: PreviewExecutionBinding;
    waitReady(timeout?: number): Promise<void>;
    actorIdentity(): Promise<{ runtimeGeneration: number; actorId: string; containerId: string }>;
    readonly browserUrl: string;
    readonly chromiumFlags: string[];
    stop(): Promise<void>;
  } | null = null;
  let browser: LocalPreviewBrowser | null = null;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (target: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof target === "string" ? target : target instanceof URL ? target.toString() : target.url;
    if (!url.startsWith(`https://${accountId}.artifacts.cloudflare.net/`))
      return originalFetch(target, init);
    const body =
      init?.body === undefined
        ? undefined
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    const request: GitHttpRequest = {
      url,
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(body === undefined
        ? {}
        : {
            body: (async function* () {
              yield body;
            })(),
          }),
    };
    const response = await git.http.request(request);
    const chunks: Uint8Array[] = [];
    if (response.body) for await (const chunk of response.body) chunks.push(chunk);
    return new Response(Buffer.concat(chunks), {
      status: response.statusCode,
      headers: response.headers ?? {},
    });
  });
  try {
    const project = await seedManagedSourceProject(control);
    const db = control.core;
    const stamp = "2026-10-29T10:00:00.000000Z";
    await db.batch([
      db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
        )
        .bind(project.organizationId, project.projectId, project.prodEnvironmentId, stamp),
      ...[project.devEnvironmentId, project.prodEnvironmentId].map((environmentId) =>
        db
          .prepare(
            "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,1,?4,?5)",
          )
          .bind(
            project.organizationId,
            project.projectId,
            environmentId,
            project.prodEnvironmentId,
            stamp,
          ),
      ),
      db
        .prepare(
          "INSERT INTO credit_account(organization_id,monthly_micros,monthly_ends_at,onetime_micros,reserved_micros,overrun_micros,paid_until,paid_source,updated_at) VALUES(?1,100000000,'2099-01-01T00:00:00.000000Z',0,0,0,'2099-01-01T00:00:00.000000Z','manual',?2)",
        )
        .bind(project.organizationId, stamp),
    ]);
    const priceTime = Date.parse("2026-10-28T08:00:00.000Z");
    const card = parseRateCard(
      JSON.stringify({
        id: "cloudflare-preview-standard-3-2026-11-09-v1",
        effective_from: "2026-10-28T09:00:00.000Z",
        rates: [
          {
            meter: "preview.container.standard-3",
            unit: "usd_pico",
            units_per_charge: "7000000",
            provider_cost_micros: "7",
            credit_micros: "2300",
          },
        ],
      }),
    );
    await applyPlan(db, planPublish(await readState(db), card, priceTime));
    await applyPlan(
      db,
      planActivate(
        await readState(db),
        {
          meter: "preview.container.standard-3",
          cardId: card.id,
          startsAtMs: Date.parse("2026-10-28T09:00:00.000Z"),
        },
        priceTime,
      ),
    );
    const store = createControlStore(control.bindings);
    const clock = new SystemClock();
    const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
    const bucket = await objects.getR2Bucket("STAGING");
    const sourceReads: {
      runtimeGeneration: number;
      tokenGeneration: number;
      sequence: number;
      available: boolean;
    }[] = [];
    const bindings = {
      ARTIFACTS_US: git.binding,
      ARTIFACTS_EU: git.binding,
      MANAGED_ARTIFACTS_ACCOUNT_ID: accountId,
      MANAGED_ARTIFACTS_NAMESPACE_US: "other-us",
      MANAGED_ARTIFACTS_NAMESPACE_EU: namespace,
      MANAGED_SOURCE_STAGING_US: bucket,
      MANAGED_SOURCE_STAGING_EU: bucket,
      BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-development",
      BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development-eu",
      SOURCE_FETCH_TIMEOUT_MS: "30000",
      BINDING_REQUEST_TIMEOUT_MS: "10000",
      PREVIEW_CONTROL: {
        readSource: async (value: unknown) => {
          const request = value as {
            runtimeGeneration: number;
            tokenGeneration: number;
            sequence: number;
          };
          const result = await store.previews.readSource(value);
          sourceReads.push({
            runtimeGeneration: request.runtimeGeneration,
            tokenGeneration: request.tokenGeneration,
            sequence: request.sequence,
            available: result !== null,
          });
          return result;
        },
      },
    };
    const source = await import("../../source-fetcher/src/worker-main.js");
    const sourceService = new source.SourceFetcherService({} as never, bindings as never);
    const rpc = createManagedGitRpc(bindings as never);
    if (process.env["PREVIEW_LOCAL_HMR"] === "1") {
      const harnessPath = process.env["PREVIEW_LOCAL_HMR_HARNESS"];
      if (!harnessPath?.startsWith("/")) throw new Error("local preview harness is required");
      const harness = await import(/* @vite-ignore */ pathToFileURL(harnessPath).href);
      localRuntime = await harness.startLocalPreview({
        core: store.previews,
        source: sourceService,
      });
    }
    const notifyPreviewSource = (scope: { organizationId: string; projectId: string }) =>
      notifyPreviewSources(store.previews as never, localRuntime?.execution, scope);
    const managed = createD1ExtendedPorts({
      bindings: {
        MANAGED_SOURCE_RUNTIME: store.managedSource,
        SOURCE_INSPECTOR: rpc,
        MANAGED_ARTIFACTS_NAMESPACE_US: "other-us",
        MANAGED_ARTIFACTS_NAMESPACE_EU: namespace,
        OPERATION_PUBLISHER: { wake: async () => {} },
        PREVIEW_API_RUNTIME: store.previews,
        ...(localRuntime ? { PREVIEW_EXECUTION: localRuntime.execution } : {}),
      } as never,
      publicOrigin: "https://dev.app.ohmyho.st",
      clock,
      ids,
    }).managedSources;
    const processor = createD1ManagedSourceProcessor({
      runtime: store.managedSource,
      clock,
      ids,
      binding: rpc,
      namespaces: { us: "other-us", eu: namespace },
      wake: async () => {},
      notifyPreviewSource,
      delegations: {
        ensureConnectionProof: async () => {
          throw new Error("no delegation in this fixture");
        },
      },
    });
    const parent = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
      operationId: parseUlid(project.parentOperationId),
    };
    const initialization = await processor.initialize(parent);
    if (!("childOperationId" in initialization) || !initialization.childOperationId)
      throw new Error("source initialization did not start");
    expect(
      await processor.process({ ...parent, operationId: initialization.childOperationId }),
    ).toEqual({ state: "committed" });
    const preview = createPreviewSurface({
      core: store.previews as never,
      runtime: localRuntime?.execution ?? {
        fence: async () => {
          throw new Error("unused");
        },
      },
      cipher: createEnvironmentSecretCipherKeyring({
        primaryKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        currentKeyVersion: 1,
        crypto,
      }),
      ids,
      hostSuffix: "preview.dev.omh.st",
    });
    const app = createD1ProjectApplication({
      runtime: store.projects as never,
      authentication: {
        authenticate: async (token) =>
          token === "local-fixture"
            ? {
                actorId: project.scope.principalId,
                credentialId: "local:test",
                authorizationPrincipal: {
                  kind: "user",
                  subjectId: project.scope.principalId as `user:${string}`,
                },
                organizationIds: [parseUlid(project.organizationId)],
              }
            : null,
      },
      platform: "development",
      clock,
      ids,
      applicationId: "preview-local-integration",
      rateLimits: { consume: async () => ({ allowed: true }) },
      reporter: { report: () => {} },
      extended: { managedSources: managed, previews: preview },
    });
    const client = createClient({
      baseUrl: "https://local.test",
      auth: "local-fixture",
      fetch: async (request) =>
        app.fetch(request instanceof Request ? request : new Request(request)),
      throwOnError: true,
    });
    const save = async (
      expectedCommit: string,
      files: ReadonlyMap<string, Uint8Array>,
      key: string,
    ) => {
      const upload = await createManagedSourceUpload(
        {
          project_id: project.projectId,
          "Idempotency-Key": `${key}-prepare`,
          managedSourceUploadRequest: {
            mode: "commit",
            expected_source_generation: 1,
            expected_source_connection_id: project.sourceConnectionId,
            expected_commit_sha: expectedCommit,
            message: "Save React source",
          },
        },
        { client },
      );
      const manifest = [];
      for (const [path, bytes] of files) {
        const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        manifest.push(
          await putManagedSourceBlob(
            {
              project_id: project.projectId,
              operation_id: upload.id,
              "Idempotency-Key": `${key}-blob-${manifest.length}`,
              managedSourceBlobRequest: {
                path,
                content_base64: Buffer.from(bytes).toString("base64"),
                executable: false,
                sha256,
              },
            },
            { client },
          ),
        );
      }
      await commitManagedSourceUpload(
        {
          project_id: project.projectId,
          operation_id: upload.id,
          "Idempotency-Key": `${key}-commit`,
          managedSourceFinalizeRequest: { expected_source_generation: 1, files: manifest },
        },
        { client },
      );
      expect(await processor.process({ ...parent, operationId: parseUlid(upload.id) })).toEqual({
        state: "committed",
      });
    };
    const binding = await getProjectSource(
      { project_id: project.projectId, include_binding: true },
      { client },
    );
    if (binding.provider !== "managed" || !binding.current_commit_sha)
      throw new Error("managed initialization missing");
    const fixtureRoot = new URL(
      "../../../fixtures/cloudflare-preview/tanstack-start/",
      import.meta.url,
    );
    const files = new Map<string, Uint8Array>();
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "worker-configuration.d.ts",
      "vite.config.ts",
      "wrangler.jsonc",
      "ohmyhost.yaml",
      "src/routeTree.gen.ts",
      "src/router.tsx",
      "src/routes/__root.tsx",
      "src/routes/index.tsx",
      "postgres/migrations/20261109000000_preview_notes.sql",
    ])
      files.set(path, await readFile(new URL(path, fixtureRoot)));
    await save(binding.current_commit_sha, files, "fixture-initial");
    const initial = await openProjectPreview(
      { project_id: project.projectId, environment: "prod" },
      { client },
    );
    if (!initial.source) throw new Error("initial source was not selected");
    let page: LocalPreviewPage | null = null;
    let connected = false;
    let hotUpdate = false;
    let identityBefore: unknown;
    if (localRuntime) {
      try {
        await localRuntime.waitReady(120_000);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : "local_preview_failed"};sourceChecks=${JSON.stringify(sourceReads)}`,
        );
      }
      const playwrightPath = process.env["PREVIEW_LOCAL_PLAYWRIGHT"];
      const chromePath = process.env["PREVIEW_LOCAL_CHROME"];
      if (!playwrightPath?.startsWith("/") || !chromePath?.startsWith("/"))
        throw new Error("local browser is required");
      const { chromium }: { chromium: LocalPreviewChromium } = await import(
        /* @vite-ignore */ pathToFileURL(playwrightPath).href
      );
      browser = await chromium.launch({
        headless: true,
        executablePath: chromePath,
        args: localRuntime.chromiumFlags,
      });
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      page.on("websocket", (socket) =>
        socket.on("framereceived", ({ payload }: { payload: string | Buffer }) => {
          if (typeof payload !== "string") return;
          try {
            const message = JSON.parse(payload);
            if (message.type === "connected") connected = true;
            if (message.type === "update") hotUpdate = true;
          } catch {
            /* Other framework frames are irrelevant. */
          }
        }),
      );
      expect(localRuntime.browserUrl === initial.url).toBe(true);
      let response;
      try {
        response = await page.goto(initial.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch {
        throw new Error("Local preview browser navigation failed");
      }
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "Preview notes" }).waitFor({ timeout: 30_000 });
      await expect.poll(() => connected, { timeout: 30_000 }).toBe(true);
      await page.evaluate(() => {
        (globalThis as PreviewDocumentGlobal).__previewSameDocument = true;
      });
      identityBefore = await localRuntime.actorIdentity();
    }
    const from = {
      sourceConnectionId: project.sourceConnectionId,
      sourceGeneration: 1,
      sequence: initial.source.sequence,
      commitSha: initial.source.commit_sha,
    };
    const initialFence = await store.previews.getCleanupState({ previewId: initial.id });
    if (!initialFence) throw new Error("initial preview fence missing");
    const initialSnapshot = await sourceService.previewDiff({
      previewId: initial.id,
      runtimeGeneration: initialFence.runtimeGeneration,
      tokenGeneration: initialFence.tokenGeneration,
      from: null,
      to: from,
    });
    expect(initialSnapshot.inspection.frameworkPlan.adapter).toBe("tanstack-start");
    const listing = await listManagedSourceFiles(
      { project_id: project.projectId, commit_sha: from.commitSha },
      { client },
    );
    if (!("files" in listing)) throw new Error("source manifest missing");
    const changedFiles = new Map<string, Uint8Array>();
    for (const file of listing.files) {
      const sourceFile = await listManagedSourceFiles(
        { project_id: project.projectId, commit_sha: from.commitSha, path: file.path },
        { client },
      );
      if (!("file" in sourceFile)) throw new Error("source file missing");
      let bytes = Buffer.from(sourceFile.file.content_base64, "base64");
      if (file.path === "src/routes/index.tsx")
        bytes = Buffer.from(
          bytes.toString("utf8").replace("Preview notes</h1>", "Updated preview heading</h1>"),
        );
      changedFiles.set(file.path, bytes);
    }
    const saveStartedAt = Date.now();
    await save(from.commitSha, changedFiles, "save-component");
    let sourceUploadToObservedHeadingMs: number | undefined;
    if (page) {
      await page
        .getByRole("heading", { name: "Updated preview heading" })
        .waitFor({ timeout: 45_000 });
      await expect.poll(() => hotUpdate, { timeout: 15_000 }).toBe(true);
      expect(
        await page.evaluate(
          () => (globalThis as PreviewDocumentGlobal).__previewSameDocument === true,
        ),
      ).toBe(true);
      sourceUploadToObservedHeadingMs = Date.now() - saveStartedAt;
    }
    const updated = await getProjectPreview(
      { project_id: project.projectId, environment: "prod" },
      { client },
    );
    if (!updated.source) throw new Error("updated source was not selected");
    expect(updated.url === initial.url).toBe(true);
    const to = { ...from, sequence: updated.source.sequence, commitSha: updated.source.commit_sha };
    expect(to.sequence).toBeGreaterThan(from.sequence);
    const updatedFence = await store.previews.getCleanupState({ previewId: initial.id });
    if (!updatedFence) throw new Error("updated preview fence missing");
    const delta = await sourceService.previewDiff({
      previewId: initial.id,
      runtimeGeneration: updatedFence.runtimeGeneration,
      tokenGeneration: updatedFence.tokenGeneration,
      from,
      to,
    });
    expect(delta.operations.map((operation) => operation.path)).toEqual(["src/routes/index.tsx"]);
    const changed = delta.operations[0];
    expect(changed?.kind === "write" && new TextDecoder().decode(changed.bytes)).toContain(
      "Updated preview heading",
    );
    expect(delta.dependenciesChanged).toBe(false);
    if (localRuntime) {
      if (!page) throw new Error("local browser page is required");
      const identityAfter = await localRuntime.actorIdentity();
      expect(identityAfter).toEqual(identityBefore);
      const directory = process.env["PREVIEW_LOCAL_ARTIFACT_DIRECTORY"];
      if (directory !== undefined) {
        if (!isAbsolute(directory))
          throw new Error("local artifacts require an absolute directory");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await page.screenshot({ path: join(directory, "tanstack-save-hmr.png"), fullPage: true });
        await writeFile(
          join(directory, "tanstack-save-hmr.json"),
          JSON.stringify(
            {
              fixture: "tanstack-start",
              result: "passed",
              sourcePath: "src/routes/index.tsx",
              unchangedUrl: true,
              sameDocument: true,
              connected,
              hotUpdate,
              sameActorAndContainer: true,
              sourceUploadToObservedHeadingMs,
              timingDefinition:
                "single local SDK save start to observed heading after save completion; no percentile or hosted claim",
              identityBefore,
              identityAfter,
              scope:
                "local workerd/D1/Git/R2/SDK/native Docker/Chromium; synthetic provider metadata; no hosted CPU or latency claim",
            },
            null,
            2,
          ) + "\n",
          { mode: 0o600 },
        );
      }
    }
  } finally {
    await browser?.close();
    await localRuntime?.stop();
    vi.unstubAllGlobals();
    git.close();
    await objects.dispose();
    await control.dispose();
  }
}, 240_000);
