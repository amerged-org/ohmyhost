import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS } from "@ohmyhost/contracts/framework-admission-corpus";
import { build } from "esbuild";
import type * as MiniflareModule from "miniflare";
import * as typescript from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { inspectFrameworkArchive } from "../src/source-fetcher.js";
import { gzipTar, sourceEntries, viteEntries } from "./tar-fixture.js";

const workerState = vi.hoisted(() => ({ env: undefined as unknown }));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = workerState.env;
  },
}));

/** Control reads a SourceFetcher refusal only through the own properties of the thrown error. */
const CONTROL_CALLER = `export default {
  async fetch(request, env) {
    try {
      const inspection = await env.SOURCE_INSPECTOR.inspectArchive(
        new Uint8Array(await request.arrayBuffer()),
      );
      return Response.json({
        adapter: inspection.frameworkPlan.adapter,
        buildPlanSha256: inspection.buildPlanSha256,
      });
    } catch (error) {
      const own = (key) => Reflect.get(error, key);
      return Response.json({
        name: own("name"),
        message: own("message"),
        stack: String(own("stack")),
        code: own("code"),
        adapter: own("adapter"),
        requirement: own("requirement"),
        diagnostic: own("diagnostic"),
      });
    }
  },
};`;

/** The production inspection, throwing its refusals exactly as both inspectExact paths do. */
const SOURCE_INSPECTION_PROBE = `import { WorkerEntrypoint } from "cloudflare:workers";
import { inspectFrameworkArchive, normalizeSourceFetcherFailure } from "./src/source-fetcher.ts";

export class SourceInspectionProbe extends WorkerEntrypoint {
  async inspectArchive(archive) {
    try {
      return await inspectFrameworkArchive(archive);
    } catch (error) {
      throw normalizeSourceFetcherFailure(error);
    }
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };`;

/** The production SourceFetcher Worker, whose managed Git uses its regional Artifacts bindings. */
const SOURCE_FETCHER_PROBE = `export { default, SourceFetcherService } from "./src/worker-main.ts";`;

/** Artifacts is a Workers RPC binding: a repository is deleted only by calling delete(name). */
const ARTIFACTS_PROVIDER = `import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
const remote = (name) =>
  "https://${"a".repeat(32)}.artifacts.cloudflare.net/git/test-us/" + name + ".git";
const repositories = new Set();
const calls = [];
class Repository extends RpcTarget {
  constructor(name) {
    super();
    this.repositoryName = name;
  }
  async info() {
    calls.push("info");
    const name = this.repositoryName;
    return { name, remote: remote(name), defaultBranch: "main" };
  }
}
export class ArtifactsProvider extends WorkerEntrypoint {
  async get(name) {
    calls.push("get");
    if (!repositories.has(name)) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    return new Repository(name);
  }
  async create(name, options) {
    calls.push("create");
    repositories.add(name);
    return { name, remote: remote(name), defaultBranch: options.setDefaultBranch };
  }
  async delete(name) {
    calls.push("delete");
    return repositories.delete(name);
  }
  async calls() {
    return calls.splice(0);
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`;

/** The deletion Workflow calls SourceFetcher over RPC and reads only a refusal's code. */
const DELETION_CALLER = `export default {
  async fetch(request, env) {
    const { method, input } = await request.json();
    const outcome = await env.SOURCE_FETCHER.managedGit(method, input).then(
      (result) => ({ result }),
      (error) => ({ code: Reflect.get(error, "code") }),
    );
    return Response.json({ ...outcome, calls: await env.ARTIFACTS.calls() });
  },
};`;

describe("source fetcher Worker entrypoints", () => {
  beforeEach(() => {
    workerState.env = {};
  });

  it("keeps HTTP private and fails unconfigured source and authorization RPCs closed", async () => {
    const { default: worker, SourceFetcherService } = await import("../src/worker-main.js");
    await expect(worker.fetch()).resolves.toMatchObject({ status: 404 });
    const service = new SourceFetcherService({} as never, {} as never);
    await expect(service.acquireExact({})).rejects.toMatchObject({
      code: "source_fetch_configuration_unavailable",
    });
    await expect(service.inspectExact({})).rejects.toMatchObject({
      code: "source_fetch_configuration_unavailable",
    });
    await expect(service.validateRepositoryLink({})).rejects.toMatchObject({
      code: "source_fetch_configuration_unavailable",
    });
    await expect(service.beginRepositoryAuthorization({})).rejects.toMatchObject({
      code: "source_fetch_configuration_unavailable",
    });
    await expect(service.completeRepositoryAuthorization({})).rejects.toMatchObject({
      code: "source_fetch_configuration_unavailable",
    });
    for (const method of [
      "beginOrganizationAuthorization",
      "completeOrganizationAuthorization",
      "observeOrganizationInstallation",
      "validateOrganizationRepository",
    ] as const)
      await expect(service[method]({})).rejects.toMatchObject({
        code: "source_fetch_configuration_unavailable",
      });
  });

  it("observes the GitHub head and exports its current preview archive through the private Worker", async () => {
    const id = "01J00000000000000000000001";
    const commitSha = "a".repeat(40);
    const version = { sourceConnectionId: id, sourceGeneration: 1, sequence: 1, commitSha };
    const archive = await gzipTar(
      viteEntries([{ path: "fixture/heading.txt", content: "Current preview" }]),
    );
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const privateKey = Buffer.from(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
    ).toString("base64");
    let revoked = false;
    const descriptor = {
      provider: "github",
      targetSource: version,
      organizationId: id,
      billingEpochId: id,
      projectId: id,
      environmentId: id,
      sourceConnectionId: id,
      region: "eu",
      repository: { owner: "owner", name: "repo", externalRepositoryId: "42" },
      grant: {
        status: "approved",
        grantId: id,
        organizationId: id,
        billingEpochId: id,
        projectId: id,
        sourceConnectionId: id,
        installationId: 7,
        repositoryId: 42,
        owner: "owner",
        repository: "repo",
        permission: "contents:read",
        grantedAt: "2026-01-01T00:00:00.000Z",
        revokedAt: null,
      },
    };
    const beginArchive = vi.fn(async () => {
      throw new Error("preview must not create a build upload");
    });
    workerState.env = {
      PREVIEW_CONTROL: { readSource: async () => (revoked ? null : descriptor) },
      BUILD_RUNNER: { beginArchive },
      BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-development",
      BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development-eu",
      GITHUB_APP_PRIVATE_KEY_BASE64: privateKey,
      GITHUB_APP_CLIENT_ID: "Iv23Example000000001",
      GITHUB_APP_CLIENT_SECRET: "private-test-client-secret",
      GITHUB_APP_SLUG: "ohmyhost-test",
      GITHUB_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
      GITHUB_USER_AGENT: "local-preview-test",
      SOURCE_ARCHIVE_MAX_BYTES: "25000000",
      SOURCE_FETCH_TIMEOUT_MS: "30000",
      PROVIDER_REQUEST_TIMEOUT_MS: "10000",
      BINDING_REQUEST_TIMEOUT_MS: "10000",
    };
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url.href);
      if (url.origin === "https://api.github.com") {
        if (url.pathname.endsWith("/access_tokens")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            repository_ids: [42],
            permissions: { contents: "read" },
          });
          return Response.json(
            {
              token: "private-local-installation-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              repository_selection: "selected",
              permissions: { contents: "read" },
              repositories: [{ id: 42 }],
            },
            { status: 201 },
          );
        }
        if (url.pathname === "/repos/owner/repo")
          return Response.json({ id: 42, full_name: "owner/repo", default_branch: "main" });
        if (url.pathname === "/repos/owner/repo/git/ref/heads/main")
          return Response.json({
            ref: "refs/heads/main",
            object: { type: "commit", sha: commitSha },
          });
        if (url.pathname.includes("/commits/")) return new Response(commitSha);
        if (url.pathname.includes("/tarball/"))
          return new Response(null, {
            status: 302,
            headers: {
              location: `https://codeload.github.com/owner/repo/legacy.tar.gz/${commitSha}`,
            },
          });
      }
      if (url.href === `https://codeload.github.com/owner/repo/legacy.tar.gz/${commitSha}`)
        return new Response(new Uint8Array(archive), {
          headers: { "content-length": String(archive.byteLength) },
        });
      throw new Error("unexpected local provider request");
    });
    try {
      const { SourceFetcherService } = await import("../src/worker-main.js");
      const service = new SourceFetcherService({} as never, {} as never);
      expect(
        await service.resolvePreviewGithubHead({
          installationId: "7",
          repositoryId: "42",
          repositoryFullName: "owner/repo",
          ref: "refs/heads/main",
        }),
      ).toEqual({ defaultBranch: "refs/heads/main", head: commitSha });
      const request = {
        previewId: id,
        runtimeGeneration: 1,
        tokenGeneration: 1,
        from: null,
        to: version,
      };
      const delta = await service.previewDiff(request);
      expect(delta.inspection.frameworkPlan.adapter).toBe("vite-static");
      expect(delta.operations.find((operation) => operation.path === "heading.txt")).toMatchObject({
        kind: "write",
        bytes: new TextEncoder().encode("Current preview"),
      });
      expect(beginArchive).not.toHaveBeenCalled();
      expect(JSON.stringify(delta)).not.toContain("private-local-installation-token");
      const count = requests.length;
      revoked = true;
      await expect(service.previewDiff(request)).rejects.toThrow("Preview source is unavailable");
      expect(requests).toHaveLength(count);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Typed refusals reach Control only as own properties of a thrown error, which enhanced error
  // serialization (the default since compatibility date 2026-04-21) keeps across Workers RPC.
  it("carries typed inspection refusals through real Workers RPC at the production compatibility dates", async () => {
    const { admitted, refused } = FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS;
    const [customer] = admitted;
    const incident = refused.find(
      ({ diagnostic }) =>
        diagnostic.code === "framework_version_unsupported" &&
        diagnostic.path === "package-lock.json",
    );
    const configuration = refused.find(
      ({ diagnostic }) => diagnostic.code === "repository_configuration_invalid",
    );
    const nextConfig = incident?.files["next.config.ts"];
    const repositoryConfig = configuration?.files["ohmyhost.yaml"];
    if (
      customer === undefined ||
      incident === undefined ||
      configuration === undefined ||
      nextConfig === undefined ||
      repositoryConfig === undefined
    )
      throw new Error("conformance corpus is incomplete");
    const marker = "customer-private-bytes";
    // The YAML parser quotes the line it rejects; the refusal must not carry it.
    const brokenConfig = repositoryConfig.replace("[npm ci", `[npm ci ${marker}`);
    expect(brokenConfig).toContain(marker);
    const { Miniflare, convertV4MiniflareOptions } = sourceFetcherMiniflare();
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "control-api",
            ...productionCompatibility("../../control-api/wrangler.production.jsonc"),
            modules: true,
            script: CONTROL_CALLER,
            serviceBindings: {
              SOURCE_INSPECTOR: { name: "source-fetcher", entrypoint: "SourceInspectionProbe" },
            },
          },
          {
            name: "source-fetcher",
            ...productionCompatibility("../wrangler.production.jsonc"),
            modules: true,
            script: await sourceFetcherProbe(SOURCE_INSPECTION_PROBE),
          },
        ],
      }),
    );
    const inspect = async (files: Readonly<Record<string, string>>): Promise<unknown> => {
      const response = await runtime.dispatchFetch("https://control.invalid/inspect", {
        method: "POST",
        body: await gzipTar(sourceEntries(files)),
      });
      return response.json();
    };
    try {
      const planned = await inspectFrameworkArchive(await gzipTar(sourceEntries(customer.files)));
      expect(await inspect(customer.files)).toEqual({
        adapter: "nextjs",
        buildPlanSha256: planned.buildPlanSha256,
      });
      const version = await inspect({
        ...incident.files,
        "next.config.ts": `${nextConfig}// ${marker}\n`,
      });
      expect(version).toEqual({
        name: "SourceFetcherFrameworkConversionRequiredError",
        message: "Source framework conversion is incomplete",
        stack: expect.any(String),
        code: "source_framework_conversion_required",
        adapter: "nextjs",
        requirement: "nextjs-adapter",
        diagnostic: incident.diagnostic,
      });
      const invalidConfiguration = await inspect({
        ...configuration.files,
        "ohmyhost.yaml": brokenConfig,
      });
      expect(invalidConfiguration).toEqual({
        name: "SourceFetcherFrameworkConversionRequiredError",
        message: "Source framework conversion is incomplete",
        stack: expect.any(String),
        code: "source_framework_conversion_required",
        adapter: null,
        requirement: null,
        diagnostic: configuration.diagnostic,
      });
      expect(JSON.stringify([version, invalidConfiguration])).not.toContain(marker);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  // Dev deletion 01M4HGJR5V71C9MMD1DY0ZHFFC (2026-10-09) never deleted its managed repository:
  // on an RPC binding, `delete.bind` names a remote method instead of Function.prototype.bind.
  it("deletes a managed repository through an Artifacts binding over real Workers RPC", async () => {
    const { Miniflare, convertV4MiniflareOptions } = sourceFetcherMiniflare();
    const sourceFetcher = productionCompatibility("../wrangler.production.jsonc");
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "deployment-workflow",
            ...productionCompatibility(
              "../../project-provisioning-worker/wrangler.production.deployment-workflow.jsonc",
            ),
            modules: true,
            script: DELETION_CALLER,
            serviceBindings: {
              SOURCE_FETCHER: { name: "source-fetcher", entrypoint: "SourceFetcherService" },
              ARTIFACTS: { name: "artifacts", entrypoint: "ArtifactsProvider" },
            },
          },
          {
            name: "source-fetcher",
            ...sourceFetcher,
            modules: true,
            script: await sourceFetcherProbe(SOURCE_FETCHER_PROBE),
            bindings: {
              MANAGED_ARTIFACTS_ACCOUNT_ID: "a".repeat(32),
              MANAGED_ARTIFACTS_NAMESPACE_US: "test-us",
              MANAGED_ARTIFACTS_NAMESPACE_EU: "test-eu",
              BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-development",
              BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development-eu",
              SOURCE_FETCH_TIMEOUT_MS: "30000",
            },
            serviceBindings: {
              ARTIFACTS_US: { name: "artifacts", entrypoint: "ArtifactsProvider" },
              ARTIFACTS_EU: { name: "artifacts", entrypoint: "ArtifactsProvider" },
            },
          },
          { name: "artifacts", ...sourceFetcher, modules: true, script: ARTIFACTS_PROVIDER },
        ],
      }),
    );
    const repository = {
      namespace: "test-us",
      repositoryName: "01j00000000000000000000002-01j00000000000000000000005",
    };
    const deletion = {
      organizationId: "01J00000000000000000000000",
      projectId: "01J00000000000000000000002",
      operationId: "01J00000000000000000000004",
      repository,
    };
    const managedGit = async (method: string, input: unknown): Promise<unknown> =>
      (
        await runtime.dispatchFetch("https://workflow.invalid/", {
          method: "POST",
          body: JSON.stringify({ method, input }),
        })
      ).json();
    try {
      expect(await managedGit("ensureRepository", { repository })).toEqual({
        result: null,
        calls: ["get", "create"],
      });
      expect(await managedGit("deleteRepository", deletion)).toEqual({
        result: null,
        calls: ["get", "info", "delete", "get"],
      });
      expect(await managedGit("deleteRepository", deletion)).toEqual({
        result: null,
        calls: ["get"],
      });
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});

/**
 * The Miniflare of SourceFetcher's own Wrangler: its workerd runs the production compatibility
 * date, which the older workspace Miniflare refuses.
 */
function sourceFetcherMiniflare(): typeof MiniflareModule {
  const wrangler = createRequire(import.meta.url).resolve("wrangler/package.json");
  return createRequire(wrangler)("miniflare") as typeof MiniflareModule;
}

/** The compatibility date and flags a production Wrangler config deploys with. */
function productionCompatibility(
  relativePath: string,
): Readonly<{ compatibilityDate: string; compatibilityFlags: string[] }> {
  const config: unknown = typescript.parseConfigFileTextToJson(
    relativePath,
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ).config;
  const compatibilityDate: unknown = Reflect.get(Object(config), "compatibility_date");
  const compatibilityFlags: unknown = Reflect.get(Object(config), "compatibility_flags");
  if (
    typeof compatibilityDate !== "string" ||
    !Array.isArray(compatibilityFlags) ||
    compatibilityFlags.some((flag) => typeof flag !== "string")
  )
    throw new Error(`${relativePath} declares no compatibility date and flags`);
  return { compatibilityDate, compatibilityFlags: compatibilityFlags as string[] };
}

/** SourceFetcher code bundled from source for workerd, behind its RPC entrypoint. */
async function sourceFetcherProbe(contents: string): Promise<string> {
  const bundle = await build({
    stdin: {
      contents,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "source-fetcher-probe.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "error",
  });
  const [output] = bundle.outputFiles;
  if (output === undefined) throw new Error("SourceFetcher probe bundle is empty");
  return output.text;
}
