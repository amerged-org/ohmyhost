import { FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS } from "@ohmyhost/contracts/framework-admission-corpus";
import type { SourceArchiveProvider, SourceArchiveReceipt } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";
import { GithubProviderInputError, GithubProviderTransportError } from "@ohmyhost/provider-github";

import {
  createSourceFetcher,
  SourceFetcherCommitNotFoundError,
  SourceFetcherWorkersIncompatibleError,
  SourceFetcherFrameworkConversionRequiredError,
  SourceFetcherInputError,
  SourceFetcherMigrationFilenameNoncanonicalError,
  SourceFetcherUncertainError,
  type SourceFetchRequest,
} from "../src/source-fetcher.js";
import {
  gzipTar,
  nextEdgeEntries,
  sourceEntries,
  tanStackEdgeEntries,
  viteEntries,
} from "./tar-fixture.js";
import type { ArchiveObjectReceipt, BuildArchiveSink } from "../src/build-archive-sink.js";

const ULIDS = {
  organization: "01J00000000000000000000000",
  billingEpoch: "01J00000000000000000000001",
  project: "01J00000000000000000000002",
  environment: "01J00000000000000000000003",
  operation: "01J00000000000000000000004",
  connection: "01J00000000000000000000005",
  grant: "01J00000000000000000000006",
} as const;
const COMMIT = "e".repeat(40);
const DIGEST = "a".repeat(64);

function request(): SourceFetchRequest {
  return {
    organizationId: ULIDS.organization,
    billingEpochId: ULIDS.billingEpoch,
    projectId: ULIDS.project,
    environmentId: ULIDS.environment,
    operationId: ULIDS.operation,
    idempotencyKey: "deploy:one",
    sourceConnectionId: ULIDS.connection,
    region: "us",
    knownArchiveSha256: null,
    expectedSourceSha256: DIGEST,
    repository: {
      owner: "aixyte",
      name: "ohmyho.st",
      externalRepositoryId: "1339976528",
    },
    commitSha: COMMIT,
    grant: {
      status: "approved",
      grantId: ULIDS.grant,
      organizationId: ULIDS.organization,
      billingEpochId: ULIDS.billingEpoch,
      projectId: ULIDS.project,
      sourceConnectionId: ULIDS.connection,
      installationId: 154436098,
      repositoryId: 1339976528,
      owner: "aixyte",
      repository: "ohmyho.st",
      permission: "contents:read",
      grantedAt: "2026-08-19T18:00:00.000Z",
      revokedAt: null,
    },
  };
}

function receipt(input: SourceFetchRequest): SourceArchiveReceipt {
  return {
    identity: {
      context: {
        projectId: input.projectId as never,
        environmentId: input.environmentId as never,
        operationId: input.operationId as never,
        idempotencyKey: input.idempotencyKey,
      },
      source: {
        provider: "github",
        sourceConnectionId: input.sourceConnectionId as never,
        externalRepositoryId: input.repository.externalRepositoryId,
        repository: { owner: input.repository.owner, name: input.repository.name },
        requestedCommitSha: input.commitSha,
      },
    },
    archiveId: `r2-version:ohmyho-builds-development/runs/${input.projectId}/${input.environmentId}/${input.operationId}/input/source.tar.gz#0123456789abcdef0123456789abcdef`,
    archiveFormat: "tar.gz",
    byteLength: 42,
    sha256: DIGEST,
  };
}

function archive(input: SourceFetchRequest): ArchiveObjectReceipt {
  const scope = {
    projectId: input.projectId,
    environmentId: input.environmentId,
    operationId: input.operationId,
  };
  return {
    bucket: "ohmyho-builds-development",
    key: `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}/input/source.tar.gz`,
    versionId: "0123456789abcdef0123456789abcdef",
    eTag: '"object-etag"',
    byteLength: 42,
    scope,
    sourceSha256: DIGEST,
  };
}

const config = {
  maximumArchiveBytes: 25_000_000,
  operationTimeoutMs: 30_000,
};

describe("source fetcher", () => {
  it("binds the approved one-repository grant and returns only an immutable receipt", async () => {
    const observed = request();
    const provider: SourceArchiveProvider = {
      async acquireExact(input, sink) {
        expect(input.identity.source.requestedCommitSha).toBe(COMMIT);
        expect(input.maxBytes).toBe(config.maximumArchiveBytes);
        expect(input.deadline.toISOString()).toBe("2026-08-19T20:00:30.000Z");
        await sink.observe(input.identity);
        await providerFactory.mock.calls[0]?.[0].resolver.resolve({
          context: input.identity.context,
          source: input.identity.source,
          deadline: input.deadline,
        });
        return receipt(observed);
      },
    };
    const durableArchive = archive(observed);
    const sink: BuildArchiveSink = {
      observe: vi.fn().mockResolvedValue(null),
      begin: vi.fn(),
      archiveReceipt: () => durableArchive,
    };
    const providerFactory = vi.fn(({ grant }) => {
      expect(grant).toMatchObject({ installationId: 154436098, repositoryId: 1339976528 });
      return provider;
    });
    const sinkFactory = vi.fn(() => sink);
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory,
      sinkFactory,
      repositoryLinkValidator: vi.fn(),
    });

    await expect(fetcher.acquireExact(observed)).resolves.toEqual({
      organizationId: ULIDS.organization,
      billingEpochId: ULIDS.billingEpoch,
      projectId: ULIDS.project,
      environmentId: ULIDS.environment,
      operationId: ULIDS.operation,
      sourceConnectionId: ULIDS.connection,
      grantId: ULIDS.grant,
      repositoryId: "1339976528",
      repository: { owner: "aixyte", name: "ohmyho.st" },
      commitSha: COMMIT,
      archiveId: `r2-version:ohmyho-builds-development/runs/${ULIDS.project}/${ULIDS.environment}/${ULIDS.operation}/input/source.tar.gz#0123456789abcdef0123456789abcdef`,
      archiveFormat: "tar.gz",
      byteLength: 42,
      sha256: DIGEST,
      archive: durableArchive,
    });
    expect(providerFactory).toHaveBeenCalledOnce();
    expect(sinkFactory).toHaveBeenCalledOnce();
    expect(sinkFactory).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ region: "us" }) }),
    );
  });

  it("hands the sink an EU request and refuses a request without a hosting region", async () => {
    const observed = { ...request(), region: "eu" as const };
    const durableArchive = archive(observed);
    const sinkFactory = vi.fn(() => ({
      observe: vi.fn().mockResolvedValue(null),
      begin: vi.fn(),
      archiveReceipt: () => durableArchive,
    }));
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({ acquireExact: vi.fn().mockResolvedValue(receipt(observed)) }),
      sinkFactory,
      repositoryLinkValidator: vi.fn(),
    });

    await expect(fetcher.acquireExact(observed)).resolves.toMatchObject({
      archive: durableArchive,
    });
    expect(sinkFactory).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ region: "eu" }) }),
    );
    const { region: _region, ...withoutRegion } = observed;
    void _region;
    for (const value of [
      withoutRegion,
      { ...observed, region: "apac" },
      { ...observed, region: 1 },
    ]) {
      await expect(fetcher.acquireExact(value)).rejects.toBeInstanceOf(SourceFetcherInputError);
    }
    expect(sinkFactory).toHaveBeenCalledOnce();
  });

  it("rejects extra keys, cross-tenant grants, revoked grants and fixture substitution", async () => {
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: vi.fn(),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    const extra = { ...request(), token: "must-not-cross-boundary" };
    const valid = request();
    const crossTenant = {
      ...valid,
      grant: { ...valid.grant, organizationId: ULIDS.project },
    };
    const revoked = {
      ...valid,
      grant: { ...valid.grant, revokedAt: "2026-08-19T19:00:00.000Z" },
    };
    const substituted = {
      ...valid,
      repository: { ...valid.repository, name: "other" },
    };
    const invalidCommit = { ...valid, commitSha: "main" };

    for (const value of [extra, crossTenant, revoked, substituted, invalidCommit]) {
      await expect(fetcher.acquireExact(value)).rejects.toBeInstanceOf(SourceFetcherInputError);
    }
  });

  it("rejects provider receipts that do not exactly match the operation", async () => {
    const invalidReceipt = receipt(request());
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({
        acquireExact: vi.fn().mockResolvedValue({ ...invalidReceipt, byteLength: 30_000_000 }),
      }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(fetcher.acquireExact(request())).rejects.toMatchObject({
      code: "source_fetch_contract_invalid",
    });
  });

  it("accepts deployment B at another exact full commit SHA", async () => {
    const second = { ...request(), commitSha: "d".repeat(40) };
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({ acquireExact: vi.fn().mockResolvedValue(receipt(second)) }),
      sinkFactory: () => ({
        observe: vi.fn(),
        begin: vi.fn(),
        archiveReceipt: () => archive(second),
      }),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(fetcher.acquireExact(second)).resolves.toMatchObject({
      commitSha: "d".repeat(40),
    });
  });

  it("rejects a structured archive receipt that disagrees with the provider receipt", async () => {
    const observed = request();
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({ acquireExact: vi.fn().mockResolvedValue(receipt(observed)) }),
      sinkFactory: () => ({
        observe: vi.fn(),
        begin: vi.fn(),
        archiveReceipt: () => ({ ...archive(observed), versionId: "wrong-version" }),
      }),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(fetcher.acquireExact(observed)).rejects.toMatchObject({
      code: "source_fetch_contract_invalid",
    });
  });

  it("redacts unknown provider failures and preserves reconciliation semantics", async () => {
    const failure = new Error("ghs_secret must not escape");
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({ acquireExact: vi.fn().mockRejectedValue(failure) }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(fetcher.acquireExact(request())).rejects.toMatchObject({
      code: "source_fetch_transport_failed",
      message: "Source archive acquisition failed",
    });

    const uncertain = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({
        acquireExact: vi.fn().mockRejectedValue({ code: "build_broker_result_uncertain" }),
      }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(uncertain.acquireExact(request())).rejects.toBeInstanceOf(
      SourceFetcherUncertainError,
    );

    const aggregate = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({
        acquireExact: vi
          .fn()
          .mockRejectedValue(
            new AggregateError(
              [new Error("download failed"), new SourceFetcherUncertainError()],
              "must be redacted",
            ),
          ),
      }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(aggregate.acquireExact(request())).rejects.toBeInstanceOf(
      SourceFetcherUncertainError,
    );
  });

  it("inspects the exact archive without creating the persistent sink", async () => {
    const observed = request();
    const archive = await gzipTar(viteEntries());
    const sinkFactory = vi.fn();
    let inspectionResolver: Parameters<
      Parameters<typeof createSourceFetcher>[0]["providerFactory"]
    >[0]["resolver"];
    const provider: SourceArchiveProvider = {
      async acquireExact(input, sink) {
        await inspectionResolver.resolve({
          context: input.identity.context,
          source: input.identity.source,
          deadline: input.deadline,
        });
        const writer = await sink.begin(input.identity);
        await writer.write(archive);
        const result = await writer.commit({
          archiveFormat: "tar.gz",
          byteLength: archive.byteLength,
          sha256: DIGEST,
        });
        await writer.abort();
        return result;
      },
    };
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: ({ resolver }) => {
        inspectionResolver = resolver;
        return provider;
      },
      sinkFactory,
      repositoryLinkValidator: vi.fn(),
    });
    const {
      knownArchiveSha256: _known,
      expectedSourceSha256: _expected,
      region: _region,
      ...inspection
    } = observed;
    void _known;
    void _expected;
    void _region;

    await expect(fetcher.inspectExact(inspection)).resolves.toEqual({
      resolvedCommitSha: COMMIT,
      sourceSha256: DIGEST,
      byteLength: archive.byteLength,
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
      buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(sinkFactory).not.toHaveBeenCalled();
  });

  it("returns a redacted Workers-incompatibility blocker before provider mutation", async () => {
    const observed = request();
    const sourceArchive = await gzipTar(
      nextEdgeEntries([
        {
          path: "fixture/src/app/api/report/route.ts",
          content: `import { Worker } from "node:worker_threads"; export { Worker };`,
        },
      ]),
    );
    let resolver: Parameters<
      Parameters<typeof createSourceFetcher>[0]["providerFactory"]
    >[0]["resolver"];
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: (input) => {
        resolver = input.resolver;
        return {
          async acquireExact(request, sink) {
            await resolver.resolve({
              context: request.identity.context,
              source: request.identity.source,
              deadline: request.deadline,
            });
            const writer = await sink.begin(request.identity);
            await writer.write(sourceArchive);
            return writer.commit({
              archiveFormat: "tar.gz",
              byteLength: sourceArchive.byteLength,
              sha256: DIGEST,
            });
          },
        };
      },
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    const {
      knownArchiveSha256: _known,
      expectedSourceSha256: _expected,
      region: _region,
      ...inspection
    } = observed;
    void _known;
    void _expected;
    void _region;

    await expect(fetcher.inspectExact(inspection)).rejects.toMatchObject({
      code: "source_runtime_workers_incompatible",
      classification: "unsupported",
      message: "Source uses a native addon or a Node.js API that does not function on Workers",
      findings: [
        {
          code: "workers_node_stub_module",
          path: "src/app/api/report/route.ts",
          module: "node:worker_threads",
        },
      ],
    });
    await expect(fetcher.inspectExact(inspection)).rejects.toBeInstanceOf(
      SourceFetcherWorkersIncompatibleError,
    );
  });

  it("inspects customer SDK dependencies without requiring an auth or database migration", async () => {
    const observed = request();
    const sourceArchive = await gzipTar(
      nextEdgeEntries().map((entry) =>
        entry.path === "fixture/package.json" && typeof entry.content === "string"
          ? {
              ...entry,
              content: JSON.stringify({
                ...(JSON.parse(entry.content) as Record<string, unknown>),
                dependencies: {
                  ...(JSON.parse(entry.content) as { dependencies: Record<string, string> })
                    .dependencies,
                  "@supabase/ssr": "0.9.0",
                  "@supabase/supabase-js": "2.57.4",
                },
              }),
            }
          : entry,
      ),
    );
    let resolver: Parameters<
      Parameters<typeof createSourceFetcher>[0]["providerFactory"]
    >[0]["resolver"];
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: (input) => {
        resolver = input.resolver;
        return {
          async acquireExact(request, sink) {
            await resolver.resolve({
              context: request.identity.context,
              source: request.identity.source,
              deadline: request.deadline,
            });
            const writer = await sink.begin(request.identity);
            await writer.write(sourceArchive);
            return writer.commit({
              archiveFormat: "tar.gz",
              byteLength: sourceArchive.byteLength,
              sha256: DIGEST,
            });
          },
        };
      },
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    const {
      knownArchiveSha256: _known,
      expectedSourceSha256: _expected,
      region: _region,
      ...inspection
    } = observed;
    void _known;
    void _expected;
    void _region;

    const result = await fetcher.inspectExact(inspection);
    expect(result).toMatchObject({
      resolvedCommitSha: COMMIT,
      sourceSha256: DIGEST,
      byteLength: sourceArchive.byteLength,
      frameworkPlan: { adapter: "nextjs", runtime: "edge", auth: { provider: "none" } },
    });
    await expect(fetcher.inspectExact(inspection)).resolves.toEqual(result);
  });

  it("returns a redacted actionable framework conversion requirement before planning", async () => {
    const observed = request();
    let sourceArchive = await gzipTar(
      tanStackEdgeEntries().map((entry) =>
        entry.path === "fixture/vite.config.ts" && typeof entry.content === "string"
          ? {
              ...entry,
              content: entry.content.replace(
                "cloudflare({ viteEnvironment: { name: 'ssr' } }), ",
                "",
              ),
            }
          : entry,
      ),
    );
    let resolver: Parameters<
      Parameters<typeof createSourceFetcher>[0]["providerFactory"]
    >[0]["resolver"];
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: (input) => {
        resolver = input.resolver;
        return {
          async acquireExact(request, sink) {
            await resolver.resolve({
              context: request.identity.context,
              source: request.identity.source,
              deadline: request.deadline,
            });
            const writer = await sink.begin(request.identity);
            await writer.write(sourceArchive);
            return writer.commit({
              archiveFormat: "tar.gz",
              byteLength: sourceArchive.byteLength,
              sha256: DIGEST,
            });
          },
        };
      },
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    const {
      knownArchiveSha256: _known,
      expectedSourceSha256: _expected,
      region: _region,
      ...inspection
    } = observed;
    void _known;
    void _expected;
    void _region;

    await expect(fetcher.inspectExact(inspection)).rejects.toMatchObject({
      code: "source_framework_conversion_required",
      adapter: "tanstack-start",
      requirement: "tanstack-adapter",
    });
    await expect(fetcher.inspectExact(inspection)).rejects.toBeInstanceOf(
      SourceFetcherFrameworkConversionRequiredError,
    );
    for (const applicationRoot of [".", "packages/site"]) {
      let entries = nextEdgeEntries([
        { path: "fixture/app/", type: 53 },
        {
          path: "fixture/app/page.tsx",
          content:
            'export default function Page() { return <div>invalid; const secret = "do-not-return-this";',
        },
      ]);
      if (applicationRoot !== ".") {
        entries = [
          { path: "fixture/", type: 53 },
          { path: "fixture/packages/", type: 53 },
          { path: "fixture/packages/site/", type: 53 },
          ...entries
            .filter((entry) => entry.path !== "fixture/")
            .map((entry) =>
              entry.path === "fixture/ohmyhost.yaml"
                ? {
                    ...entry,
                    content: String(entry.content).replace(
                      "version: 1\n",
                      "version: 1\napplicationRoot: packages/site\n",
                    ),
                  }
                : { ...entry, path: entry.path.replace("fixture/", "fixture/packages/site/") },
            ),
        ];
      }
      sourceArchive = await gzipTar(entries);
      let failure: unknown;
      try {
        await fetcher.inspectExact(inspection);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "source_framework_conversion_required",
        adapter: "nextjs",
        requirement: "nextjs-adapter",
        diagnostic: {
          code: "source_syntax_invalid",
          path: applicationRoot === "." ? "app/page.tsx" : "packages/site/app/page.tsx",
        },
      });
      expect(JSON.stringify(failure)).not.toContain("do-not-return-this");
      expect(String(failure)).not.toContain("do-not-return-this");
    }
    // A refused framework version keeps its package, judged version and minimum; the lockfile that
    // resolved it is named, and nothing else of the customer's source leaves the inspector.
    const incident = FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.refused.find(
      ({ diagnostic }) =>
        diagnostic.code === "framework_version_unsupported" &&
        diagnostic.path === "package-lock.json",
    );
    const nextConfig = incident?.files["next.config.ts"];
    if (incident === undefined || nextConfig === undefined)
      throw new Error("conformance corpus has no lockfile refusal");
    sourceArchive = await gzipTar(
      sourceEntries({
        ...incident.files,
        "next.config.ts": `${nextConfig}// do-not-return-this\n`,
      }),
    );
    const refusal: unknown = await fetcher.inspectExact(inspection).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(SourceFetcherFrameworkConversionRequiredError);
    expect({ ...(refusal as SourceFetcherFrameworkConversionRequiredError) }).toEqual({
      name: "SourceFetcherFrameworkConversionRequiredError",
      code: "source_framework_conversion_required",
      adapter: "nextjs",
      requirement: "nextjs-adapter",
      diagnostic: incident.diagnostic,
    });
    expect(`${JSON.stringify(refusal)}${String(refusal)}`).not.toContain("do-not-return-this");
  });

  it("returns a stable nonretryable migration naming requirement before provider build", async () => {
    const observed = request();
    let sourceArchive = await gzipTar(
      viteEntries([
        { path: "fixture/postgres/", type: 53 },
        { path: "fixture/postgres/migrations/", type: 53 },
        {
          path: "fixture/postgres/migrations/001_foundation.sql",
          content: "create table public.items(id uuid primary key);\n",
        },
      ]).map((entry) =>
        entry.path === "fixture/ohmyhost.yaml"
          ? {
              ...entry,
              content:
                "version: 1\nproject: vite-app\nbuild:\n  install: pnpm install --frozen-lockfile\n  command: pnpm build\n  output: dist\nruntime:\n  mode: static\ndatabase:\n  enabled: true\n  migrations: postgres/migrations\n",
            }
          : entry,
      ),
    );
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({
        async acquireExact(request, sink) {
          const writer = await sink.begin(request.identity);
          await writer.write(sourceArchive);
          return writer.commit({
            archiveFormat: "tar.gz",
            byteLength: sourceArchive.byteLength,
            sha256: DIGEST,
          });
        },
      }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    const {
      knownArchiveSha256: _known,
      expectedSourceSha256: _expected,
      region: _region,
      ...inspection
    } = observed;
    void _known;
    void _expected;
    void _region;

    await expect(fetcher.inspectExact(inspection)).rejects.toMatchObject({
      code: "source_migration_filename_noncanonical",
    });
    await expect(fetcher.inspectExact(inspection)).rejects.toBeInstanceOf(
      SourceFetcherMigrationFilenameNoncanonicalError,
    );
    sourceArchive = await gzipTar(
      viteEntries().map((entry) =>
        entry.path === "fixture/ohmyhost.yaml"
          ? { ...entry, path: "fixture/site/ohmyhost.yaml" }
          : entry,
      ),
    );
    await expect(fetcher.inspectExact(inspection)).rejects.toMatchObject({
      name: "SourceFetcherRepositoryConfigurationMissingError",
      code: "source_repository_configuration_missing",
    });
    // A schema-invalid ohmyhost.yaml names no application yet; it is still the customer's to fix.
    sourceArchive = await gzipTar(
      viteEntries().map((entry) =>
        entry.path === "fixture/ohmyhost.yaml"
          ? { ...entry, content: String(entry.content).replace("mode: static", "mode: container") }
          : entry,
      ),
    );
    await expect(fetcher.inspectExact(inspection)).rejects.toMatchObject({
      name: "SourceFetcherFrameworkConversionRequiredError",
      code: "source_framework_conversion_required",
      adapter: null,
      requirement: null,
      diagnostic: { code: "repository_configuration_invalid", path: "ohmyhost.yaml" },
    });
  });

  it("fails closed for inspection grant substitution, timeout, and redacts provider details", async () => {
    const observed = request();
    const {
      knownArchiveSha256: _known,
      expectedSourceSha256: _expected,
      region: _region,
      ...inspection
    } = observed;
    void _known;
    void _expected;
    void _region;
    const deniedWithResolver = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: ({ resolver }) => {
        return {
          async acquireExact(input) {
            await resolver.resolve({
              context: input.identity.context,
              source: {
                ...input.identity.source,
                repository: { owner: input.identity.source.repository.owner, name: "other" },
              },
              deadline: input.deadline,
            });
            return receipt(observed);
          },
        };
      },
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(deniedWithResolver.inspectExact(inspection)).rejects.toBeInstanceOf(
      SourceFetcherInputError,
    );

    const timedOut = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({
        acquireExact: vi
          .fn()
          .mockRejectedValue(new GithubProviderTransportError("github_request_timeout")),
      }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(timedOut.inspectExact(inspection)).rejects.toMatchObject({
      code: "source_fetch_transport_failed",
      message: "Source archive acquisition failed",
    });

    // GitHub answers 422 for a SHA the linked repository does not contain: an unpushed commit.
    const unpushed = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({
        acquireExact: vi
          .fn()
          .mockRejectedValue(new GithubProviderInputError("requested_commit_not_found" as never)),
      }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    for (const attempt of [unpushed.inspectExact(inspection), unpushed.acquireExact(observed)]) {
      await expect(attempt).rejects.toMatchObject({
        code: "source_commit_not_found",
        message: "The linked GitHub repository has no such commit",
      });
    }
    await expect(unpushed.inspectExact(inspection)).rejects.toBeInstanceOf(
      SourceFetcherCommitNotFoundError,
    );
    const invalidSha = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({
        acquireExact: vi
          .fn()
          .mockRejectedValue(new GithubProviderInputError("invalid_requested_sha")),
      }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(invalidSha.inspectExact(inspection)).rejects.toBeInstanceOf(
      SourceFetcherInputError,
    );
  });

  it("rejects a durable receipt whose digest differs from the immutable plan", async () => {
    const invalid = { ...receipt(request()), sha256: "b".repeat(64) };
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: () => ({ acquireExact: vi.fn().mockResolvedValue(invalid) }),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: vi.fn(),
    });
    await expect(fetcher.acquireExact(request())).rejects.toMatchObject({
      code: "source_fetch_contract_invalid",
    });
  });

  it("validates any exact grantable repository link and returns no credential", async () => {
    const validator = vi.fn().mockResolvedValue({
      repositoryId: 24681012,
      owner: "aixyte",
      name: "stay-simpli",
    });
    const fetcher = createSourceFetcher({
      config,
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      providerFactory: vi.fn(),
      sinkFactory: vi.fn(),
      repositoryLinkValidator: validator,
    });
    const link = {
      organizationId: ULIDS.organization,
      billingEpochId: ULIDS.billingEpoch,
      projectId: ULIDS.project,
      environmentId: ULIDS.environment,
      operationId: ULIDS.operation,
      installationId: 154436098,
      owner: "aixyte",
      name: "stay-simpli",
    };
    await expect(fetcher.validateRepositoryLink(link)).resolves.toEqual({
      installationId: 154436098,
      externalRepositoryId: "24681012",
      owner: "aixyte",
      name: "stay-simpli",
      permission: "contents:read",
    });
    expect(validator).toHaveBeenCalledWith({
      installationId: 154436098,
      owner: "aixyte",
      repository: "stay-simpli",
      deadline: new Date("2026-08-19T20:00:30.000Z"),
    });
    validator.mockResolvedValueOnce({
      repositoryId: 24681012,
      owner: "aixyte",
      name: "different-repository",
    });
    await expect(fetcher.validateRepositoryLink(link)).rejects.toMatchObject({
      code: "source_fetch_contract_invalid",
    });
  });
});
