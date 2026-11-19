import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CloudflareWfpConflictError,
  CloudflareWfpContractError,
  CloudflareWfpInputError,
  CloudflareWfpRequestError,
  CloudflareWfpScriptRejectedError,
  CloudflareWfpSecretSyncUncertainError,
  CloudflareWfpUncertainError,
  CloudflareWfpProvider,
  WFP_CANDIDATE_LAYOUT_TAG,
  createRuntimeSecretManifest,
  computeNativeAuthBindingDigest,
  computeNextCacheBindingDigest,
  computeBindingSetDigest,
  projectCandidateScriptName,
  projectGatewayPublicOrigin,
  parseWfpRuntimePolicy,
  type RuntimeSecretBinding,
  type WfpDeploymentReceipt,
  type WfpPublishInput,
} from "./index.js";
import { normalizeBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DEPLOYMENT_A = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const DEPLOYMENT_B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
const TAG_A = "ff911805a92245df98cb4695335e8403";
const TAG_B = "ba8207f56a9c4d23b63ec23bee22a968";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const CURRENT_LAYOUT = "layout:gateway-scopes-v1";

it("binds Native session identity to the candidate deployment and rejects foreign scopes", async () => {
  const scope = {
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    environmentName: "dev" as const,
    handle: "calm-otter-studio",
  };
  const binding = {
    service: "ohmyho-native-auth-development-eu",
    props: {
      organizationId: PROJECT,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      deploymentId: DEPLOYMENT_A,
    },
  };
  const a = await computeNativeAuthBindingDigest(binding, scope, DEPLOYMENT_A, "ohmyho-sandbox");
  const b = await computeNativeAuthBindingDigest(
    { ...binding, props: { ...binding.props, deploymentId: DEPLOYMENT_B } },
    scope,
    DEPLOYMENT_B,
    "ohmyho-sandbox",
  );
  expect(a).toMatch(/^sha256:/u);
  expect(a).not.toBe(b);
  await expect(
    computeNativeAuthBindingDigest(binding, scope, DEPLOYMENT_B, "ohmyho-sandbox"),
  ).rejects.toThrow();
  await expect(
    computeNativeAuthBindingDigest(
      { ...binding, service: "ohmyho-native-auth-production-eu" },
      scope,
      DEPLOYMENT_A,
      "ohmyho-sandbox",
    ),
  ).rejects.toThrow();
  const existing = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, null, CURRENT_LAYOUT, a),
    )
    .mockResolvedValueOnce(
      envelope([
        {
          type: "service",
          name: "OHMYHOST_AUTH",
          service: binding.service,
          entrypoint: "NativeSessionService",
        },
      ]),
    );
  await expect(
    provider(existing).stageCandidate(
      input(DEPLOYMENT_A, DIGEST_A, [], undefined, undefined, binding),
    ),
  ).resolves.toEqual(receipt());
  const stale = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, null, CURRENT_LAYOUT, b),
    );
  await expect(
    provider(stale).stageCandidate(
      input(DEPLOYMENT_A, DIGEST_A, [], undefined, undefined, binding),
    ),
  ).rejects.toBeInstanceOf(CloudflareWfpConflictError);
});

it("pins a Next cache service to its deployment and region through one bounded binding attestation", async () => {
  const scope = {
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    environmentName: "dev" as const,
    handle: "calm-otter-studio",
  };
  const cache = {
    service: "ohmyho-next-cache-sandbox",
    props: {
      organizationId: PROJECT,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      deploymentId: DEPLOYMENT_A,
      region: "eu" as const,
    },
  };
  const cacheDigest = await computeNextCacheBindingDigest(
    cache,
    scope,
    DEPLOYMENT_A,
    "ohmyho-sandbox",
  );
  const combined = await computeBindingSetDigest(null, null, null, null, cacheDigest);
  if (combined === null) throw new Error("Expected combined Next binding digest");
  const transport = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      details(
        DEPLOYMENT_A,
        DIGEST_A,
        TAG_A,
        null,
        TAG_A,
        null,
        null,
        CURRENT_LAYOUT,
        null,
        combined,
      ),
    )
    .mockResolvedValueOnce(
      envelope([
        {
          type: "service",
          name: "OHMYHOST_NEXT_CACHE",
          service: cache.service,
          entrypoint: "NextCacheRuntime",
        },
      ]),
    );
  await expect(
    provider(transport).stageCandidate(
      input(DEPLOYMENT_A, DIGEST_A, [], undefined, undefined, undefined, cache),
    ),
  ).resolves.toEqual({ ...receipt(), bindingSetDigest: combined });
  const recovery = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(envelope(null, 404))
    .mockRejectedValueOnce(new TypeError("lost test response"))
    .mockResolvedValueOnce(
      details(
        DEPLOYMENT_A,
        DIGEST_A,
        TAG_A,
        null,
        TAG_A,
        null,
        null,
        CURRENT_LAYOUT,
        null,
        combined,
      ),
    )
    .mockResolvedValueOnce(
      envelope([
        {
          type: "service",
          name: "OHMYHOST_NEXT_CACHE",
          service: cache.service,
          entrypoint: "NextCacheRuntime",
        },
      ]),
    );
  await expect(
    provider(recovery).stageCandidate(
      input(DEPLOYMENT_A, DIGEST_A, [], undefined, undefined, undefined, cache),
    ),
  ).resolves.toEqual({ ...receipt(), bindingSetDigest: combined });
  const foreignRecovery = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(envelope(null, 404))
    .mockRejectedValueOnce(new TypeError("lost test response"))
    .mockResolvedValueOnce(
      details(
        DEPLOYMENT_A,
        DIGEST_A,
        TAG_A,
        null,
        TAG_A,
        null,
        null,
        CURRENT_LAYOUT,
        null,
        DIGEST_B,
      ),
    );
  await expect(
    provider(foreignRecovery).stageCandidate(
      input(DEPLOYMENT_A, DIGEST_A, [], undefined, undefined, undefined, cache),
    ),
  ).rejects.toBeInstanceOf(CloudflareWfpUncertainError);
  await expect(
    computeNextCacheBindingDigest(cache, scope, DEPLOYMENT_B, "ohmyho-sandbox"),
  ).rejects.toThrow();
  await expect(
    computeNextCacheBindingDigest(
      { ...cache, service: "ohmyho-next-cache-production" },
      scope,
      DEPLOYMENT_A,
      "ohmyho-sandbox",
    ),
  ).rejects.toThrow();
  expect(
    await computeNextCacheBindingDigest(
      { ...cache, props: { ...cache.props, region: "us" } },
      scope,
      DEPLOYMENT_A,
      "ohmyho-sandbox",
    ),
  ).not.toBe(cacheDigest);
});

function envelope(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      success: status < 400,
      errors: status === 404 ? [{ code: 10007 }] : [],
      messages: [],
      result,
    }),
    { status },
  );
}

function input(
  deploymentId = DEPLOYMENT_A,
  digest = DIGEST_A,
  crons: readonly string[] = [],
  database?: import("./wfp-provider.js").WfpDatabaseBinding,
  storage?: import("./wfp-provider.js").WfpStorageBinding,
  nativeAuth?: import("./wfp-provider.js").WfpNativeAuthBinding,
  nextCache?: import("./wfp-provider.js").WfpNextCacheBinding,
): WfpPublishInput {
  const boundary = "verified-artifact";
  const immutableScriptName = scriptName(deploymentId);
  const cronsJson = JSON.stringify(crons);
  const cronTag =
    crons.length === 0
      ? null
      : `crons:sha256:${createHash("sha256").update(cronsJson).digest("hex")}`;
  const metadata = {
    main_module: "worker.mjs",
    bindings:
      cronTag === null
        ? []
        : [
            {
              type: "plain_text",
              name: "OHMYHOST_CRONS",
              text: cronsJson,
            },
            {
              type: "plain_text",
              name: "OHMYHOST_IMMUTABLE_SCRIPT_NAME",
              text: immutableScriptName,
            },
          ],
    tags: [
      `project:${PROJECT}`,
      `environment:${ENVIRONMENT}`,
      `deployment:${deploymentId}`,
      `artifact:${digest}`,
      CURRENT_LAYOUT,
      ...(cronTag === null ? [] : [cronTag]),
    ],
  };
  if (database !== undefined) {
    metadata.bindings.push({
      type: "service",
      name: "OHMYHOST_DATABASE",
      service: database.service,
      entrypoint: "ProjectDatabaseService",
      props: database.props,
    } as never);
    metadata.tags.push(
      `database:sha256:${createHash("sha256").update(JSON.stringify(database)).digest("hex")}`,
    );
  }
  if (storage !== undefined) {
    metadata.bindings.push({
      type: "service",
      name: "OHMYHOST_STORAGE_GATEWAY",
      service: storage.service,
      props: storage.props,
    } as never);
    metadata.tags.push(
      `storage:sha256:${createHash("sha256").update(JSON.stringify(storage)).digest("hex")}`,
    );
  }
  if (nativeAuth !== undefined) {
    metadata.bindings.push({
      type: "service",
      name: "OHMYHOST_AUTH",
      service: nativeAuth.service,
      entrypoint: "NativeSessionService",
      props: nativeAuth.props,
    } as never);
    metadata.tags.push(
      `native-auth:sha256:${createHash("sha256").update(JSON.stringify(nativeAuth)).digest("hex")}`,
    );
  }
  if (nextCache !== undefined) {
    metadata.bindings.push({
      type: "service",
      name: "OHMYHOST_NEXT_CACHE",
      service: nextCache.service,
      entrypoint: "NextCacheRuntime",
      props: nextCache.props,
    } as never);
    const one = (prefix: string) =>
      metadata.tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;
    const cacheDigest = `sha256:${createHash("sha256").update(JSON.stringify(nextCache)).digest("hex")}`;
    const combined = `sha256:${createHash("sha256")
      .update(
        JSON.stringify([
          one("crons:"),
          one("database:"),
          one("storage:"),
          one("native-auth:"),
          cacheDigest,
        ]),
      )
      .digest("hex")}`;
    metadata.tags = metadata.tags.filter(
      (tag) =>
        !["crons:", "database:", "storage:", "native-auth:"].some((prefix) =>
          tag.startsWith(prefix),
        ),
    );
    metadata.tags.push(`bindings:${combined}`);
  }
  const body = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}--\r\n`,
  );
  return {
    scope: {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev",
      handle: "calm-river-studio",
    },
    artifact: {
      deploymentId,
      digest,
      bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
      platformBindings: {
        immutableScriptName,
        crons,
        ...(nativeAuth === undefined ? {} : { nativeAuth }),
        ...(nextCache === undefined ? {} : { nextCache }),
        ...(database === undefined ? {} : { database }),
        ...(storage === undefined ? {} : { storage }),
      },
    },
  };
}

function scriptName(deploymentId = DEPLOYMENT_A): string {
  return projectCandidateScriptName(PROJECT, "dev", deploymentId);
}

function details(
  deploymentId = DEPLOYMENT_A,
  digest: `sha256:${string}` = DIGEST_A,
  providerTag = TAG_A,
  cronBindingsDigest: `sha256:${string}` | null = null,
  providerDeploymentId = providerTag,
  databaseBindingDigest: `sha256:${string}` | null = null,
  storageBindingDigest: `sha256:${string}` | null = null,
  layout: string | null = CURRENT_LAYOUT,
  nativeAuthBindingDigest: `sha256:${string}` | null = null,
  bindingSetDigest: `sha256:${string}` | null = null,
): Response {
  return envelope({
    modified_on: NOW.toISOString(),
    script: {
      id: scriptName(deploymentId),
      tag: providerTag,
      deployment_id: providerDeploymentId,
      tags: [
        `project:${PROJECT}`,
        `environment:${ENVIRONMENT}`,
        `deployment:${deploymentId}`,
        `artifact:${digest}`,
        ...(layout === null ? [] : [layout]),
        ...(cronBindingsDigest === null ? [] : [`crons:${cronBindingsDigest}`]),
        ...(databaseBindingDigest === null ? [] : [`database:${databaseBindingDigest}`]),
        ...(storageBindingDigest === null ? [] : [`storage:${storageBindingDigest}`]),
        ...(nativeAuthBindingDigest === null ? [] : [`native-auth:${nativeAuthBindingDigest}`]),
        ...(bindingSetDigest === null ? [] : [`bindings:${bindingSetDigest}`]),
      ],
    },
  });
}

function missingDetails(): Response {
  return envelope({
    dispatch_namespace: "ohmyho-sandbox",
    created_on: NOW.toISOString(),
    modified_on: NOW.toISOString(),
    script: null,
  });
}

function receipt(
  deploymentId = DEPLOYMENT_A,
  digest: `sha256:${string}` = DIGEST_A,
  providerTag = TAG_A,
): WfpDeploymentReceipt {
  return {
    provider: "cloudflare-wfp",
    namespace: "ohmyho-sandbox",
    scriptName: scriptName(deploymentId),
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    productDeploymentId: deploymentId,
    providerTag,
    artifactDigest: digest,
    buildReused: false,
    deployedAt: NOW,
  };
}

function provider(fetch: typeof globalThis.fetch): CloudflareWfpProvider {
  return new CloudflareWfpProvider({
    accountId: "00000000000000000000000000000001",
    namespace: "ohmyho-sandbox",
    apiToken: "secret-token",
    fetch,
    now: () => NOW,
  });
}

async function runtimeSecret(
  name = "API_TOKEN",
  value = "value",
  revision = 1,
): Promise<RuntimeSecretBinding> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return {
    name,
    value,
    revision,
    valueSha256: `sha256:${Buffer.from(digest).toString("hex")}`,
  };
}

describe("CloudflareWfpProvider immutable candidates", () => {
  it("rejects invalid provider configuration and candidate identifiers before fetch", () => {
    expect(
      () =>
        new CloudflareWfpProvider({
          accountId: "bad",
          namespace: "bad namespace",
          apiToken: "",
          fetch: vi.fn(),
        }),
    ).toThrow(CloudflareWfpInputError);
    expect(() => projectCandidateScriptName("bad", "dev", DEPLOYMENT_A)).toThrow(
      CloudflareWfpInputError,
    );
  });

  it("exposes stable sanitized provider error classes", () => {
    expect(new CloudflareWfpContractError()).toMatchObject({ code: "cloudflare_contract_invalid" });
    expect(new CloudflareWfpRequestError(400, 1000, "/result")).toMatchObject({
      status: 400,
      providerPointer: "/result",
    });
    expect(new CloudflareWfpUncertainError(TAG_A, DEPLOYMENT_A, DIGEST_A)).toMatchObject({
      currentProviderTag: TAG_A,
    });
    expect(new CloudflareWfpSecretSyncUncertainError([])).toMatchObject({ currentSecrets: [] });
  });

  it("derives collision-free names within Cloudflare's 60-character limit", () => {
    expect(scriptName()).toBe(`p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT_A.toLowerCase()}`);
    expect(projectCandidateScriptName(PROJECT, "prod", DEPLOYMENT_A)).toHaveLength(60);
    expect(scriptName(DEPLOYMENT_B)).not.toBe(scriptName());
  });

  it("derives platform project origins without an isolated gateway Worker", () => {
    const scope = {
      projectId: PROJECT,
      handle: "calm-river-studio",
      environmentName: "dev" as const,
    };
    expect(projectGatewayPublicOrigin(scope, "ohmyho-sandbox")).toBe(
      "https://dev-calm-river-studio.dev.check.omh.st",
    );
    expect(projectGatewayPublicOrigin(scope, "ohmyho-production")).toBe(
      "https://dev-calm-river-studio.check.omh.st",
    );
    expect(() => projectGatewayPublicOrigin(scope, "foreign-namespace")).toThrow(
      CloudflareWfpInputError,
    );
  });

  it("uses a current timestamp and aborts a stalled provider read at its bound", async () => {
    const observedAt = Date.now();
    const current = new CloudflareWfpProvider({
      accountId: "00000000000000000000000000000001",
      namespace: "ohmyho-sandbox",
      apiToken: "secret-token",
      fetch: async () => envelope(null, 404),
    });
    const observation = await current.observeCandidate({
      scope: input().scope,
      deploymentId: DEPLOYMENT_A,
    });
    expect(observation.observedAt.getTime()).toBeGreaterThanOrEqual(observedAt);
    expect(observation.observedAt.getTime()).toBeLessThanOrEqual(Date.now());

    let aborted = false;
    const stalled = new CloudflareWfpProvider({
      accountId: "00000000000000000000000000000001",
      namespace: "ohmyho-sandbox",
      apiToken: "secret-token",
      timeoutMilliseconds: 1,
      now: () => NOW,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("Provider read timed out"));
          });
        }),
    });
    await expect(
      stalled.observeCandidate({ scope: input().scope, deploymentId: DEPLOYMENT_A }),
    ).rejects.toThrow("Provider read timed out");
    expect(aborted).toBe(true);
  });

  it("accepts every customer-chosen handle the shared project-handle rule accepts", async () => {
    for (const handle of [
      "my-garden",
      "acc045-r1793533911",
      "quiet-otter-waves",
      "my-quiet-otter-waves-lake",
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(null, 404));
      const outcome = await provider(fetch)
        .observeCandidate({ scope: { ...input().scope, handle }, deploymentId: DEPLOYMENT_A })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(outcome, handle).not.toBeInstanceOf(CloudflareWfpInputError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses scope handles the shared project-handle rule rejects before fetch", async () => {
    for (const handle of [
      "Quiet-otter",
      "a-b-c-d-e-f",
      "-lead",
      "trail-",
      "dou--ble",
      "ab",
      "a".repeat(60),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        provider(fetch).observeCandidate({
          scope: { ...input().scope, handle },
          deploymentId: DEPLOYMENT_A,
        }),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("creates a frozen, sorted, digest-bound runtime-secret manifest", async () => {
    const database = await runtimeSecret("DATABASE_URL", "postgres://runtime", 3);
    const token = await runtimeSecret("API_TOKEN", "token", 2);
    const manifest = await createRuntimeSecretManifest([database, token]);
    expect(manifest.secrets.map((secret) => secret.name)).toEqual(["API_TOKEN", "DATABASE_URL"]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.secrets)).toBe(true);
    expect(manifest.secrets.every(Object.isFrozen)).toBe(true);
  });

  it("rejects malformed secret manifests and keeps malformed post-mutation responses uncertain", async () => {
    const valid = await runtimeSecret();
    const manifest = await createRuntimeSecretManifest([valid]);
    const invalid = [
      { secrets: [{ ...valid, valueSha256: DIGEST_A }], digest: manifest.digest },
      { secrets: [{ ...valid, revision: 0 }], digest: manifest.digest },
      { secrets: [valid, valid], digest: manifest.digest },
      { secrets: [valid], digest: DIGEST_A },
      {
        secrets: await Promise.all(
          Array.from({ length: 101 }, (_, index) =>
            runtimeSecret(`SECRET_${String(index).padStart(3, "0")}`),
          ),
        ),
        digest: manifest.digest,
      },
    ] as const;
    const noFetch = vi.fn<typeof globalThis.fetch>();
    for (const value of invalid) {
      await expect(
        provider(noFetch).syncRuntimeSecrets({
          scope: input().scope,
          deployment: receipt(),
          manifest: value,
        }),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    }
    expect(noFetch).not.toHaveBeenCalled();

    const leaked = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(
        envelope([{ name: "API_TOKEN", type: "secret_text", text: "leaked" }]),
      );
    const result = expect(
      provider(leaked).syncRuntimeSecrets({
        scope: input().scope,
        deployment: receipt(),
        manifest,
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpSecretSyncUncertainError);
    await result;
  });

  it("stages parallel candidates without overwriting an environment-stable script", async () => {
    const fetchA = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope({ id: scriptName(), tag: TAG_A }))
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(details());
    const fetchB = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope({ id: scriptName(DEPLOYMENT_B), tag: TAG_B }))
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(details(DEPLOYMENT_B, DIGEST_B, TAG_B));
    const [a, b] = await Promise.all([
      provider(fetchA).stageCandidate(input()),
      provider(fetchB).stageCandidate(input(DEPLOYMENT_B, DIGEST_B)),
    ]);
    expect([a.scriptName, b.scriptName]).toEqual([scriptName(), scriptName(DEPLOYMENT_B)]);
    expect([a.providerTag, b.providerTag]).toEqual([TAG_A, TAG_B]);
    expect(fetchA.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT", "GET", "GET"]);
  });

  it("rejects a partial script-null result instead of treating it as canonical absence", async () => {
    for (const response of [
      envelope({ script: null }),
      new Response(
        JSON.stringify({
          success: true,
          errors: [{ code: 1000 }],
          messages: [],
          result: {
            dispatch_namespace: "ohmyho-sandbox",
            created_on: NOW.toISOString(),
            modified_on: NOW.toISOString(),
            script: null,
          },
        }),
        { status: 200 },
      ),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
      await expect(provider(fetch).stageCandidate(input())).rejects.toBeInstanceOf(
        CloudflareWfpContractError,
      );
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it("snapshots integrity-checked candidate bytes before caller mutation", async () => {
    for (const shared of [false, true]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(missingDetails())
        .mockResolvedValueOnce(envelope({ id: scriptName(), tag: TAG_A }))
        .mockResolvedValueOnce(envelope([]))
        .mockResolvedValueOnce(details());
      const initial = input();
      const original = Uint8Array.from(initial.artifact.body);
      const storage = shared
        ? new SharedArrayBuffer(original.byteLength + 8)
        : new ArrayBuffer(original.byteLength + 8);
      const view = new Uint8Array(storage, 4, original.byteLength);
      view.set(original);
      const value = { ...initial, artifact: { ...initial.artifact, body: view } };
      const pending = provider(fetch).stageCandidate(value);
      value.artifact.body[0] = 9;
      await expect(pending).resolves.toMatchObject({ providerTag: TAG_A });
      const body = fetch.mock.calls[1]?.[1]?.body;
      expect(body).toBeInstanceOf(ReadableStream);
      await expect(new Response(body).arrayBuffer()).resolves.toEqual(original.buffer);
    }
  });

  it("reconciles an exact lost upload response without a second PUT", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"))
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]));
    await expect(provider(fetch).stageCandidate(input())).resolves.toEqual(receipt());
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    for (const outcome of ["timeout", "server_error", "success"] as const) {
      const legacy = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(missingDetails());
      if (outcome === "timeout")
        legacy.mockRejectedValueOnce(new DOMException("timeout", "AbortError"));
      else
        legacy.mockResolvedValueOnce(
          outcome === "server_error"
            ? envelope(null, 503)
            : envelope({ id: scriptName(), tag: TAG_A }),
        );
      if (outcome === "success") legacy.mockResolvedValueOnce(envelope([]));
      legacy.mockResolvedValueOnce(
        details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, null, null),
      );
      await expect(provider(legacy).stageCandidate(input())).rejects.toMatchObject({
        code: "cloudflare_result_uncertain",
        reason: "candidate_bindings_outdated",
        currentProviderTag: TAG_A,
        currentProductDeploymentId: DEPLOYMENT_A,
        currentArtifactDigest: DIGEST_A,
      });
      expect(legacy.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    }
  });

  it("classifies a 4xx script rejection as terminal instead of uncertain", async () => {
    const rejected = new Response(
      JSON.stringify({
        success: false,
        errors: [
          {
            code: 10021,
            message:
              "Uncaught SyntaxError: The requested module './ohmyhost-worker.js' does not provide an export named 'default'",
          },
        ],
        messages: [],
        result: null,
      }),
      { status: 400 },
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(rejected);
    const error = await provider(fetch)
      .stageCandidate(input())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareWfpScriptRejectedError);
    expect(error).toMatchObject({
      code: "cloudflare_script_rejected",
      status: 400,
      providerCode: 10021,
    });
    expect(String(error)).not.toContain("ohmyhost-worker.js");
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT"]);

    const denied = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 10000 }], messages: [], result: null }),
          { status: 403 },
        ),
      );
    const deniedError = await provider(denied)
      .stageCandidate(input())
      .catch((caught: unknown) => caught);
    expect(deniedError).toBeInstanceOf(CloudflareWfpRequestError);
    expect(deniedError).not.toBeInstanceOf(CloudflareWfpScriptRejectedError);
  });

  it("reconciles cron bindings only when the exact canonical digest tag survives", async () => {
    const crons = ["*/5 * * * *"];
    const cronsDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(crons))
      .digest("hex")}` as const;
    const exact = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"))
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_A, cronsDigest))
      .mockResolvedValueOnce(
        envelope([
          { type: "plain_text", name: "OHMYHOST_CRONS" },
          { type: "plain_text", name: "OHMYHOST_IMMUTABLE_SCRIPT_NAME" },
        ]),
      );
    await expect(
      provider(exact).stageCandidate(input(DEPLOYMENT_A, DIGEST_A, crons)),
    ).resolves.toMatchObject({ providerTag: TAG_A });

    const missing = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(details());
    await expect(
      provider(missing).stageCandidate(input(DEPLOYMENT_A, DIGEST_A, crons)),
    ).rejects.toBeInstanceOf(CloudflareWfpConflictError);
    for (const invalid of [
      ["*/4 * * * *"],
      ["0 3 * * *", "*/5 * * * *"],
      ["0 3 * * *", "0 3 * * *"],
    ]) {
      await expect(
        provider(vi.fn<typeof globalThis.fetch>()).stageCandidate(
          input(DEPLOYMENT_A, DIGEST_A, invalid),
        ),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    }
  });

  it("binds immutable database service generations through upload, retry and readback", async () => {
    const database = {
      service: "ohmyho-project-database-sandbox-us",
      props: {
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        physicalEnvironmentId: ENVIRONMENT,
        registrationVersion: 1,
        region: "us" as const,
      },
    };
    const digest =
      `sha256:${createHash("sha256").update(JSON.stringify(database)).digest("hex")}` as const;
    const artifact = input(DEPLOYMENT_A, DIGEST_A, [], database);
    const exact = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"))
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, digest))
      .mockResolvedValueOnce(
        envelope([
          {
            type: "service",
            name: "OHMYHOST_DATABASE",
            service: database.service,
            entrypoint: "ProjectDatabaseService",
          },
        ]),
      );
    await expect(provider(exact).stageCandidate(artifact)).resolves.toMatchObject({
      providerTag: TAG_A,
    });
    const stale = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(details());
    await expect(provider(stale).stageCandidate(artifact)).rejects.toBeInstanceOf(
      CloudflareWfpConflictError,
    );
    const staleRead = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(details());
    await expect(
      provider(staleRead).observeCandidate({
        scope: artifact.scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
        expectedDatabaseBindingDigest: digest,
      }),
    ).resolves.toMatchObject({ state: "unknown" });
    const foreign = input(DEPLOYMENT_A, DIGEST_A, [], {
      ...database,
      props: { ...database.props, projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
    });
    const noAccess = vi.fn<typeof globalThis.fetch>();
    await expect(provider(noAccess).stageCandidate(foreign)).rejects.toBeInstanceOf(
      CloudflareWfpInputError,
    );
    expect(noAccess).not.toHaveBeenCalled();
  });

  it("binds storage scope into service metadata, retries and candidate readback", async () => {
    const storage = {
      service: "ohmyho-storage-gateway-sandbox",
      props: {
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        dataEnvironmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      },
    };
    const digest =
      `sha256:${createHash("sha256").update(JSON.stringify(storage)).digest("hex")}` as const;
    const artifact = input(DEPLOYMENT_A, DIGEST_A, [], undefined, storage);
    const exact = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"))
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, digest))
      .mockResolvedValueOnce(
        envelope([{ type: "service", name: "OHMYHOST_STORAGE_GATEWAY", service: storage.service }]),
      );
    await expect(provider(exact).stageCandidate(artifact)).resolves.toMatchObject({
      providerTag: TAG_A,
    });
    const ready = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, digest));
    await expect(
      provider(ready).observeCandidate({
        scope: artifact.scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
        expectedStorageBindingDigest: digest,
      }),
    ).resolves.toMatchObject({ state: "ready" });
    const missing = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(details());
    await expect(
      provider(missing).observeCandidate({
        scope: artifact.scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
        expectedStorageBindingDigest: digest,
      }),
    ).resolves.toMatchObject({ state: "unknown" });
    for (const props of [
      { ...storage.props, projectId: ENVIRONMENT },
      { ...storage.props, environmentId: PROJECT },
      { ...storage.props, dataEnvironmentId: "missing" },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        provider(fetch).stageCandidate(
          input(DEPLOYMENT_A, DIGEST_A, [], undefined, { ...storage, props }),
        ),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
      expect(fetch).not.toHaveBeenCalled();
    }
    const metadataText = new TextDecoder().decode(artifact.artifact.body);
    for (const text of [
      metadataText.replace(
        `"dataEnvironmentId":"${storage.props.dataEnvironmentId}"`,
        `"dataEnvironmentId":"${ENVIRONMENT}"`,
      ),
      metadataText.replace(`,"props":${JSON.stringify(storage.props)}`, ""),
      metadataText.replace(
        `"dataEnvironmentId":"${storage.props.dataEnvironmentId}"`,
        `"dataEnvironmentId":"${storage.props.dataEnvironmentId}","bucketId":"customer-value"`,
      ),
      metadataText.replace(`storage:${digest}`, `storage:${DIGEST_B}`),
    ]) {
      const body = new TextEncoder().encode(text);
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        provider(fetch).stageCandidate({
          ...artifact,
          artifact: {
            ...artifact.artifact,
            body,
            bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
          },
        }),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
      expect(fetch).not.toHaveBeenCalled();
    }
    const database = {
      service: "ohmyho-project-database-sandbox-us",
      props: {
        organizationId: storage.props.organizationId,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        physicalEnvironmentId: storage.props.dataEnvironmentId,
        registrationVersion: 1,
        region: "us" as const,
      },
    };
    const databaseDigest =
      `sha256:${createHash("sha256").update(JSON.stringify(database)).digest("hex")}` as const;
    const combined = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, databaseDigest, digest),
      )
      .mockResolvedValueOnce(
        envelope([
          {
            type: "service",
            name: "OHMYHOST_DATABASE",
            service: database.service,
            entrypoint: "ProjectDatabaseService",
          },
          { type: "service", name: "OHMYHOST_STORAGE_GATEWAY", service: storage.service },
        ]),
      );
    await expect(
      provider(combined).stageCandidate(input(DEPLOYMENT_A, DIGEST_A, [], database, storage)),
    ).resolves.toMatchObject({ providerTag: TAG_A });
    for (const props of [
      { ...database.props, physicalEnvironmentId: ENVIRONMENT },
      { ...database.props, organizationId: DEPLOYMENT_B },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        provider(fetch).stageCandidate(
          input(DEPLOYMENT_A, DIGEST_A, [], { ...database, props }, storage),
        ),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("validates a canonical browser policy independently of private server egress", () => {
    const value = {
      healthCheckPath: "/api/health",
      egressAllowedOrigins: ["https://server.example.test"],
      browser: normalizeBrowserPolicy({
        connect: ["wss://browser.example.test"],
        workers: { self: true },
      }),
    };
    expect(parseWfpRuntimePolicy(value)).toEqual(value);
    for (const invalid of [
      { ...value, browser: { connect: ["*"] } },
      { ...value, egressAllowedOrigins: ["http://server.example.test"] },
      { ...value, egressAllowedOrigins: ["https://server.example.test:8443"] },
      { ...value, egressAllowedOrigins: ["https://203.0.113.4"] },
      { ...value, egressAllowedOrigins: ["https://printer.lan"] },
      { ...value, egressAllowedOrigins: ["https://my_api.example.test"] },
      { ...value, healthCheckPath: "//bad" },
      { ...value, unknown: true },
    ])
      expect(() => parseWfpRuntimePolicy(invalid)).toThrow(CloudflareWfpInputError);
  });

  it("replays exact state and rejects foreign drift", async () => {
    expect(WFP_CANDIDATE_LAYOUT_TAG).toBe(CURRENT_LAYOUT);
    const exact = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]));
    await expect(provider(exact).stageCandidate(input())).resolves.toEqual(receipt());
    const drift = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_B, TAG_B));
    await expect(provider(drift).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpConflictError,
    );
    for (const layout of [null, "layout:gateway-scopes-v0"]) {
      const legacy = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, null, layout),
        );
      await expect(provider(legacy).stageCandidate(input())).rejects.toMatchObject({
        code: "cloudflare_result_uncertain",
        reason: "candidate_bindings_outdated",
        currentProviderTag: TAG_A,
        currentProductDeploymentId: DEPLOYMENT_A,
      });
      expect(legacy).toHaveBeenCalledTimes(1);
      const cleanup = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, null, layout),
        )
        .mockResolvedValueOnce(envelope(null))
        .mockResolvedValueOnce(envelope(null, 404));
      await expect(
        provider(cleanup).removeCandidate({ scope: input().scope, expectedDeployment: receipt() }),
      ).resolves.toMatchObject({ state: "metadata_absent", expectedProviderTag: TAG_A });
      expect(cleanup.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    }
    for (const replacement of [
      "",
      "layout:gateway-scopes-v0",
      `${CURRENT_LAYOUT}","${CURRENT_LAYOUT}`,
    ]) {
      const value = input();
      const original = new TextDecoder().decode(value.artifact.body);
      const text =
        replacement === ""
          ? original.replace(`,"${CURRENT_LAYOUT}"`, "")
          : original.replace(CURRENT_LAYOUT, replacement);
      const body = new TextEncoder().encode(text);
      const noAccess = vi.fn<typeof globalThis.fetch>();
      await expect(
        provider(noAccess).stageCandidate({
          ...value,
          artifact: {
            ...value.artifact,
            body,
            bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
          },
        }),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
      expect(noAccess).not.toHaveBeenCalled();
    }
  });

  it("rejects artifact integrity drift and cross-scope receipts before mutation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      provider(fetch).stageCandidate({
        ...input(),
        artifact: { ...input().artifact, bodyDigest: DIGEST_B },
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    const scheduled = input(DEPLOYMENT_A, DIGEST_A, ["*/5 * * * *"]);
    await expect(
      provider(fetch).stageCandidate({
        ...scheduled,
        artifact: {
          ...scheduled.artifact,
          platformBindings: {
            ...scheduled.artifact.platformBindings,
            crons: ["0 3 * * *"],
          },
        },
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    await expect(
      provider(fetch).removeCandidate({
        scope: { ...input().scope, environmentId: DEPLOYMENT_B },
        expectedDeployment: receipt(),
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on malformed upload envelopes and mismatched post-upload identity", async () => {
    const malformed = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(provider(malformed).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpContractError,
    );
    const mismatched = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope({ id: scriptName(), tag: TAG_A }))
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_B, TAG_B));
    await expect(provider(mismatched).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpContractError,
    );
  });

  it("binds secrets to the exact candidate receipt", async () => {
    const manifest = await createRuntimeSecretManifest([await runtimeSecret()]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope([{ name: "API_TOKEN", type: "secret_text" }]))
      .mockResolvedValueOnce(envelope([{ name: "API_TOKEN", type: "secret_text" }]))
      .mockResolvedValueOnce(details());
    await expect(
      provider(fetch).syncRuntimeSecrets({ scope: input().scope, deployment: receipt(), manifest }),
    ).resolves.toMatchObject({ scriptName: scriptName(), providerTag: TAG_A });
    expect(String(fetch.mock.calls[1]?.[0])).toContain(`${scriptName()}/secrets`);
  });

  it("adopts an already exact empty secret set without mutation", async () => {
    const manifest = await createRuntimeSecretManifest([]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(details());

    await expect(
      provider(fetch).syncRuntimeSecrets({ scope: input().scope, deployment: receipt(), manifest }),
    ).resolves.toMatchObject({ secretNames: [], providerTag: TAG_A });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("atomically writes rotated values even when the redacted names are unchanged", async () => {
    const desired = [
      await runtimeSecret("API_TOKEN", "rotated", 2),
      await runtimeSecret("DATABASE_URL", "postgres://runtime", 1),
    ];
    const manifest = await createRuntimeSecretManifest(desired);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(
        envelope([
          { name: "API_TOKEN", type: "secret_text" },
          { name: "DATABASE_URL", type: "secret_text" },
        ]),
      )
      .mockResolvedValueOnce(
        envelope({
          API_TOKEN: { name: "API_TOKEN", type: "secret_text" },
          DATABASE_URL: { name: "DATABASE_URL", type: "secret_text" },
        }),
      )
      .mockResolvedValueOnce(
        envelope([
          { name: "API_TOKEN", type: "secret_text" },
          { name: "DATABASE_URL", type: "secret_text" },
        ]),
      )
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_B));
    const result = await provider(fetch).syncRuntimeSecrets({
      scope: input().scope,
      deployment: receipt(),
      manifest,
    });
    const mutation = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(mutation).toEqual({
      secrets: {
        API_TOKEN: { name: "API_TOKEN", type: "secret_text", text: "rotated" },
        DATABASE_URL: {
          name: "DATABASE_URL",
          type: "secret_text",
          text: "postgres://runtime",
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/rotated|postgres:\/\//u);
    expect(result.providerTag).toBe(TAG_A);
  });

  it("keeps successful secret mutation uncertain when redacted readback differs", async () => {
    const manifest = await createRuntimeSecretManifest([await runtimeSecret()]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null))
      .mockResolvedValueOnce(envelope([{ name: "OTHER_SECRET", type: "secret_text" }]));
    await expect(
      provider(fetch).syncRuntimeSecrets({ scope: input().scope, deployment: receipt(), manifest }),
    ).rejects.toMatchObject({
      name: "CloudflareWfpSecretSyncUncertainError",
      currentSecrets: [{ name: "OTHER_SECRET", type: "secret_text" }],
    });
  });

  it("uses targeted readback and remains uncertain after a malformed successful secrets-bulk response", async () => {
    const manifest = await createRuntimeSecretManifest([await runtimeSecret()]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(envelope([{ name: "API_TOKEN", type: "secret_text" }]));

    await expect(
      provider(fetch).syncRuntimeSecrets({ scope: input().scope, deployment: receipt(), manifest }),
    ).rejects.toMatchObject({
      name: "CloudflareWfpSecretSyncUncertainError",
      currentSecrets: [{ name: "API_TOKEN", type: "secret_text" }],
    });
    expect(String(fetch.mock.calls[3]?.[0])).toContain(`${scriptName()}/secrets`);
  });

  it("returns exact candidate observations for ready, unknown, and absent states", async () => {
    const readyFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(details());
    await expect(
      provider(readyFetch).observeCandidate({
        scope: input().scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
      }),
    ).resolves.toMatchObject({ state: "ready", providerTag: TAG_A });
    const driftedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_B));
    await expect(
      provider(driftedFetch).observeCandidate({
        scope: input().scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
      }),
    ).resolves.toMatchObject({ state: "unknown", providerTag: TAG_B });
    const unknownFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(details());
    await expect(
      provider(unknownFetch).observeCandidate({ scope: input().scope, deploymentId: DEPLOYMENT_A }),
    ).resolves.toMatchObject({ state: "unknown", providerTag: TAG_A });
    const absentFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(null, 404));
    await expect(
      provider(absentFetch).observeCandidate({ scope: input().scope, deploymentId: DEPLOYMENT_A }),
    ).resolves.toMatchObject({ state: "metadata_absent", providerTag: null });
    for (const layout of [null, "layout:gateway-scopes-v0"]) {
      const legacy = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, null, layout),
        );
      await expect(
        provider(legacy).observeCandidate({
          scope: input().scope,
          deploymentId: DEPLOYMENT_A,
          knownDeployment: receipt(),
        }),
      ).resolves.toMatchObject({
        state: "unknown",
        reason: "candidate_bindings_outdated",
        providerTag: TAG_A,
        productDeploymentId: DEPLOYMENT_A,
        artifactDigest: DIGEST_A,
      });
      const drifted = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          details(DEPLOYMENT_A, DIGEST_B, TAG_B, null, TAG_B, null, null, layout),
        );
      const observation = await provider(drifted).observeCandidate({
        scope: input().scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
      });
      expect(observation).toMatchObject({ state: "unknown", providerTag: TAG_B });
      expect(observation).not.toHaveProperty("reason");
    }
    // The old storage digest authenticates the bound data area, not the injected gateway URL.
    const legacyStorage = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_A, null, DIGEST_B, null),
      );
    await expect(
      provider(legacyStorage).observeCandidate({
        scope: input().scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
        expectedStorageBindingDigest: DIGEST_B,
      }),
    ).resolves.toMatchObject({ state: "unknown", reason: "candidate_bindings_outdated" });
    const maximum = (await details(
      DEPLOYMENT_A,
      DIGEST_A,
      TAG_A,
      DIGEST_B,
      TAG_A,
      DIGEST_A,
      DIGEST_B,
    ).json()) as {
      result: { script: { tags: string[] } };
    };
    maximum.result.script.tags.push("runtime:edge");
    const maximumFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(maximum.result));
    await expect(
      provider(maximumFetch).observeCandidate({
        scope: input().scope,
        deploymentId: DEPLOYMENT_A,
        knownDeployment: receipt(),
      }),
    ).resolves.toMatchObject({ state: "ready" });
    for (const extraTag of [CURRENT_LAYOUT, "layout:gateway-scopes-v0"]) {
      const ambiguous = (await details().json()) as { result: { script: { tags: string[] } } };
      ambiguous.result.script.tags.push(extraTag);
      const malformed = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(envelope(ambiguous.result));
      await expect(
        provider(malformed).observeCandidate({
          scope: input().scope,
          deploymentId: DEPLOYMENT_A,
          knownDeployment: receipt(),
        }),
      ).rejects.toBeInstanceOf(CloudflareWfpContractError);
    }
  });

  it("reports current redacted bindings when secret mutation delivery is uncertain", async () => {
    const manifest = await createRuntimeSecretManifest([await runtimeSecret()]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([]))
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"))
      .mockResolvedValueOnce(envelope([{ name: "API_TOKEN", type: "secret_text" }]));
    await expect(
      provider(fetch).syncRuntimeSecrets({ scope: input().scope, deployment: receipt(), manifest }),
    ).rejects.toMatchObject({
      name: "CloudflareWfpSecretSyncUncertainError",
      currentSecrets: [{ name: "API_TOKEN", type: "secret_text" }],
    });
  });

  it("keeps the immutable script tag when Cloudflare rotates deployment identity", async () => {
    const manifest = await createRuntimeSecretManifest([]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_B))
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_A, null, TAG_B));
    await expect(
      provider(fetch).syncRuntimeSecrets({
        scope: input().scope,
        deployment: receipt(),
        manifest,
      }),
    ).resolves.toMatchObject({ providerTag: TAG_A, secretNames: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects plaintext leaked from candidate secret-list readback", async () => {
    const manifest = await createRuntimeSecretManifest([await runtimeSecret()]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(
        envelope([{ name: "API_TOKEN", type: "secret_text", text: "leaked" }]),
      );
    await expect(
      provider(fetch).syncRuntimeSecrets({
        scope: input().scope,
        deployment: receipt(),
        manifest,
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpContractError);
  });

  it("preserves a safe provider error pointer without exposing response bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: "denied", source: { pointer: "/result" } }],
          messages: [],
          result: null,
        }),
        { status: 400 },
      ),
    );
    await expect(provider(fetch).stageCandidate(input())).rejects.toMatchObject({
      name: "CloudflareWfpRequestError",
      providerCode: 1000,
      providerPointer: "/result",
    });
  });

  it("rejects malformed envelopes and non-canonical 404 responses", async () => {
    const malformed = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(provider(malformed).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpContractError,
    );
    const wrongMissing = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10090, message: "not canonical" }],
          messages: [],
          result: null,
        }),
        { status: 404 },
      ),
    );
    await expect(
      provider(wrongMissing).observeCandidate({
        scope: input().scope,
        deploymentId: DEPLOYMENT_A,
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpRequestError);
  });

  it("deletes only the exact inactive candidate", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope(null, 404));
    await expect(
      provider(fetch).removeCandidate({ scope: input().scope, expectedDeployment: receipt() }),
    ).resolves.toMatchObject({ state: "metadata_absent", scriptName: scriptName() });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("accepts only an exact repeated script-null envelope as final candidate absence", async () => {
    const confirmed = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(missingDetails());
    await expect(
      provider(confirmed).removeCandidate({
        scope: input().scope,
        expectedDeployment: receipt(),
      }),
    ).resolves.toMatchObject({ state: "metadata_absent" });

    const unconfirmed = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope({ script: null }));
    await expect(
      provider(unconfirmed).removeCandidate({
        scope: input().scope,
        expectedDeployment: receipt(),
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpContractError);
  });

  it("does not accept a successful script-null envelope as final deletion proof", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope({ script: null }))
      .mockResolvedValueOnce(envelope({ script: null }));
    await expect(
      provider(fetch).removeCandidate({
        scope: input().scope,
        expectedDeployment: receipt(),
      }),
    ).rejects.toBeInstanceOf(CloudflareWfpContractError);
  });

  it("refuses candidate removal when its exact provider identity drifted", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details(DEPLOYMENT_A, DIGEST_A, TAG_B));
    await expect(
      provider(fetch).removeCandidate({ scope: input().scope, expectedDeployment: receipt() }),
    ).rejects.toBeInstanceOf(CloudflareWfpConflictError);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("reconciles a lost delete only after canonical final 404", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockRejectedValueOnce(new DOMException("timeout", "AbortError"))
      .mockResolvedValueOnce(envelope(null, 404));
    await expect(
      provider(fetch).removeCandidate({
        scope: input().scope,
        expectedDeployment: receipt(),
      }),
    ).resolves.toMatchObject({ state: "metadata_absent" });
  });
});

describe("CloudflareWfpProvider worker binding boundary", () => {
  const BOUNDARY = "verified-artifact";
  const PLATFORM_BINDINGS = [
    { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
    { type: "secret_text", name: "API_TOKEN", text: "customer-secret-value" },
    { type: "service", name: "OHMYHOST_MAIL_GATEWAY", service: "ohmyho-mail-gateway-sandbox" },
  ];

  function workerMetadata(bindings: readonly unknown[]): Record<string, unknown> {
    return {
      main_module: "worker.mjs",
      bindings,
      tags: [
        `project:${PROJECT}`,
        `environment:${ENVIRONMENT}`,
        `deployment:${DEPLOYMENT_A}`,
        `artifact:${DIGEST_A}`,
        CURRENT_LAYOUT,
      ],
    };
  }

  function metadataPart(metadata: Record<string, unknown>): string {
    return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  }

  function modulePart(name: string, content: string): string {
    return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: application/javascript+module\r\n\r\n${content}\r\n`;
  }

  const CLOSING_PART = `--${BOUNDARY}--\r\n`;

  function multipartArtifact(parts: string): WfpPublishInput {
    const base = input();
    const body = new TextEncoder().encode(parts);
    return {
      ...base,
      artifact: {
        ...base.artifact,
        bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        contentType: `multipart/form-data; boundary=${BOUNDARY}`,
        body,
      },
    };
  }

  function uploadUntilReadback(readback: Response | TypeError) {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope({ id: scriptName(), tag: TAG_A }));
    if (readback instanceof TypeError) fetch.mockRejectedValueOnce(readback);
    else fetch.mockResolvedValueOnce(readback);
    return fetch;
  }

  it("admits only the closed platform binding set before any upload request", async () => {
    for (const binding of [
      { type: "secrets_store_secret", name: "STORE_SECRET", secret_name: "token", store_id: "s" },
      { type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" },
      { type: "r2_bucket", name: "FILES", bucket_name: "files" },
      { type: "kv_namespace", name: "CACHE", namespace_id: "cache" },
      { type: "dispatch_namespace", name: "DISPATCH", namespace: "ohmyho-sandbox" },
      { type: "service", name: "OHMYHOST_OTHER", service: "ohmyho-other", entrypoint: "default" },
      { type: "plain_text", name: "CUSTOMER_FLAG", text: "1" },
      {
        type: "durable_object_namespace",
        name: "CUSTOMER_DO",
        class_name: "Counter",
        script_name: "other",
      },
      { type: "queue", name: "CUSTOMER_QUEUE", queue_name: "jobs" },
      { type: "hyperdrive", name: "CUSTOMER_HYPERDRIVE", id: "0".repeat(32) },
      { type: "analytics_engine", name: "CUSTOMER_ANALYTICS", dataset: "events" },
      { type: "ai", name: "CUSTOMER_AI" },
      { type: "vectorize", name: "CUSTOMER_VECTORS", index_name: "vectors" },
      { type: "browser", name: "CUSTOMER_BROWSER" },
      { type: "service", name: "OHMYHOST_DATABASE", service: "ohmyho-database", entrypoint: "X" },
      { type: "service", name: "OHMYHOST_MAIL_GATEWAY", service: "ohmyho-mail-gateway-other" },
      {
        type: "service",
        name: "OHMYHOST_MAIL_GATEWAY",
        service: "ohmyho-storage-gateway-sandbox",
      },
      {
        type: "service",
        name: "OHMYHOST_MAIL_GATEWAY",
        service: "ohmyho-mail-gateway-sandbox",
        entrypoint: "AdminEntrypoint",
      },
      { type: "secret_text", name: "api_token", text: "customer-secret-value" },
      { type: "assets", name: "ASSETS2" },
      "customer-binding",
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        provider(fetch).stageCandidate(
          multipartArtifact(metadataPart(workerMetadata([binding])) + CLOSING_PART),
        ),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("refuses a second metadata part even after the first 512 KiB of the body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const smuggled = workerMetadata([
      { type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" },
    ]);
    await expect(
      provider(fetch).stageCandidate(
        multipartArtifact(
          metadataPart(workerMetadata([])) +
            modulePart("worker.mjs", "x".repeat(600 * 1024)) +
            metadataPart(smuggled) +
            CLOSING_PART,
        ),
      ),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a boundary smuggled into module bytes that opens a second metadata part", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const smuggled = metadataPart(
      workerMetadata([
        { type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" },
      ]),
    );
    await expect(
      provider(fetch).stageCandidate(
        multipartArtifact(
          metadataPart(workerMetadata([])) +
            modulePart("worker.mjs", `export const flag = 1;\r\n${smuggled}`) +
            CLOSING_PART,
        ),
      ),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a module that carries the metadata part name", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      provider(fetch).stageCandidate(
        multipartArtifact(
          metadataPart(workerMetadata([])) + modulePart("metadata", "data") + CLOSING_PART,
        ),
      ),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a candidate whose stored bindings match the metadata it sent", async () => {
    const fetch = uploadUntilReadback(
      envelope([
        { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
        { type: "secret_text", name: "API_TOKEN" },
        { type: "service", name: "OHMYHOST_MAIL_GATEWAY", service: "ohmyho-mail-gateway-sandbox" },
      ]),
    ).mockResolvedValueOnce(details());
    await expect(
      provider(fetch).stageCandidate(
        multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
      ),
    ).resolves.toMatchObject({ providerTag: TAG_A });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT", "GET", "GET"]);
    expect(String(fetch.mock.calls[2]?.[0])).toMatch(/\/scripts\/[^/]+\/bindings$/u);
  });

  it("deletes the just-uploaded script when its stored bindings carry an extra binding", async () => {
    const fetch = uploadUntilReadback(
      envelope([
        { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
        { type: "secret_text", name: "API_TOKEN" },
        { type: "service", name: "OHMYHOST_MAIL_GATEWAY", service: "ohmyho-mail-gateway-sandbox" },
        { type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" },
      ]),
    ).mockResolvedValueOnce(envelope(null));
    const error = await provider(fetch)
      .stageCandidate(
        multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareWfpContractError);
    expect(String(error)).not.toContain("customer-secret-value");
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "DELETE",
    ]);
    expect(String(fetch.mock.calls[3]?.[0])).toBe(String(fetch.mock.calls[1]?.[0]));
  });

  it("fails closed and deletes the script when the stored bindings cannot be read", async () => {
    for (const failure of [envelope(null, 500), new TypeError("fetch failed")]) {
      const fetch = uploadUntilReadback(failure).mockResolvedValueOnce(envelope(null));
      await expect(
        provider(fetch).stageCandidate(
          multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        ),
      ).rejects.toBeInstanceOf(CloudflareWfpContractError);
      expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
        "GET",
        "PUT",
        "GET",
        "DELETE",
      ]);
    }
  });

  it("reports uncertainty when the rejected candidate cannot be deleted", async () => {
    const fetch = uploadUntilReadback(
      envelope([{ type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" }]),
    ).mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(
      provider(fetch).stageCandidate(
        multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
      ),
    ).rejects.toBeInstanceOf(CloudflareWfpUncertainError);
  });

  it("reads back the stored bindings before keeping an existing identical script", async () => {
    const extra = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(
        envelope([{ type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" }]),
      )
      .mockResolvedValueOnce(envelope(null));
    await expect(provider(extra).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpContractError,
    );
    expect(extra.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "DELETE"]);
    expect(String(extra.mock.calls[1]?.[0])).toMatch(/\/scripts\/[^/]+\/bindings$/u);
  });

  it("keeps an existing identical script that carries synced runtime secrets", async () => {
    const synced = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope([{ type: "secret_text", name: "API_TOKEN" }]));
    await expect(provider(synced).stageCandidate(input())).resolves.toEqual(receipt());
    expect(synced.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  });

  it("deletes an existing identical script that lost a platform binding", async () => {
    const exact = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(
        envelope([
          { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
          { type: "secret_text", name: "API_TOKEN" },
        ]),
      )
      .mockResolvedValueOnce(envelope(null));
    await expect(
      provider(exact).stageCandidate(
        multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
      ),
    ).rejects.toBeInstanceOf(CloudflareWfpContractError);
    expect(exact.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "DELETE"]);
  });

  it("does not delete an existing identical script whose bindings cannot be read", async () => {
    const unreadable = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(envelope(null, 500));
    await expect(provider(unreadable).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpUncertainError,
    );
    expect(unreadable.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  });

  it("deletes a lost-response reconcile whose stored bindings carry an extra binding", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(
        envelope([{ type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" }]),
      )
      .mockResolvedValueOnce(envelope(null));
    await expect(provider(fetch).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpContractError,
    );
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "GET",
      "DELETE",
    ]);
  });

  it("deletes a 5xx-response reconcile whose stored bindings carry an extra binding", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope(null, 503))
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(
        envelope([{ type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" }]),
      )
      .mockResolvedValueOnce(envelope(null));
    await expect(provider(fetch).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpContractError,
    );
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "GET",
      "DELETE",
    ]);
  });

  it("does not hand out a receipt after a failed delete of an extra-binding script", async () => {
    const first = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(missingDetails())
      .mockResolvedValueOnce(envelope({ id: scriptName(), tag: TAG_A }))
      .mockResolvedValueOnce(
        envelope([{ type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" }]),
      )
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(provider(first).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpUncertainError,
    );
    const retry = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(
        envelope([{ type: "d1", name: "DATABASE", id: "00000000-0000-4000-8000-000000000000" }]),
      )
      .mockResolvedValueOnce(envelope(null));
    await expect(provider(retry).stageCandidate(input())).rejects.toBeInstanceOf(
      CloudflareWfpContractError,
    );
  });

  it("refuses a boundary-in-body variant with bare line feeds", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const smuggled = `\n--${BOUNDARY}\nContent-Disposition: form-data; name="metadata"\n\n${JSON.stringify(workerMetadata([]))}\n`;
    await expect(
      provider(fetch).stageCandidate(
        multipartArtifact(
          metadataPart(workerMetadata([])) +
            modulePart("worker.mjs", `export const flag = 1;${smuggled}`) +
            CLOSING_PART,
        ),
      ),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a part header that names the part twice", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const header = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"; name="metadata"\r\nContent-Type: text/plain\r\n\r\nx\r\n`;
    await expect(
      provider(fetch).stageCandidate(
        multipartArtifact(metadataPart(workerMetadata([])) + header + CLOSING_PART),
      ),
    ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses bytes before the first delimiter, after the closing delimiter and without CRLF", async () => {
    const variants = [
      `preamble\r\n${metadataPart(workerMetadata([]))}${CLOSING_PART}`,
      metadataPart(workerMetadata([])) + CLOSING_PART + "trailing",
      metadataPart(workerMetadata([])) +
        `--${BOUNDARY}\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: text/plain\r\n\r\nx\r\n` +
        CLOSING_PART,
    ];
    for (const parts of variants) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(provider(fetch).stageCandidate(multipartArtifact(parts))).rejects.toBeInstanceOf(
        CloudflareWfpInputError,
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("refuses stored bindings that differ from the metadata in any compared field", async () => {
    const database = {
      service: "ohmyho-project-database-sandbox-us",
      props: {
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        physicalEnvironmentId: ENVIRONMENT,
        registrationVersion: 1,
        region: "us" as const,
      },
    };
    const mail = {
      type: "service",
      name: "OHMYHOST_MAIL_GATEWAY",
      service: "ohmyho-mail-gateway-sandbox",
    };
    const extra = { type: "d1", name: "ZZZ_EXTRA", id: "00000000-0000-4000-8000-000000000000" };
    const cases: { artifact: WfpPublishInput; stored: readonly unknown[] }[] = [
      {
        artifact: multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        stored: [PLATFORM_BINDINGS[0], PLATFORM_BINDINGS[1], mail, extra],
      },
      {
        artifact: multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        stored: [PLATFORM_BINDINGS[0], PLATFORM_BINDINGS[1]],
      },
      {
        artifact: multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        stored: [PLATFORM_BINDINGS[0], { type: "plain_text", name: "API_TOKEN" }, mail],
      },
      {
        artifact: multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        stored: [PLATFORM_BINDINGS[0], { type: "secret_text", name: "API_TOKEN_2" }, mail],
      },
      {
        artifact: multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        stored: [
          PLATFORM_BINDINGS[0],
          PLATFORM_BINDINGS[1],
          { ...mail, service: "ohmyho-mail-gateway-other" },
        ],
      },
      {
        artifact: multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        stored: [
          PLATFORM_BINDINGS[0],
          PLATFORM_BINDINGS[1],
          { ...mail, entrypoint: "AdminEntrypoint" },
        ],
      },
      {
        artifact: multipartArtifact(metadataPart(workerMetadata(PLATFORM_BINDINGS)) + CLOSING_PART),
        stored: [PLATFORM_BINDINGS[0], PLATFORM_BINDINGS[1], { ...mail, type: "d1" }],
      },
      {
        artifact: input(DEPLOYMENT_A, DIGEST_A, [], database),
        stored: [
          {
            type: "service",
            name: "OHMYHOST_DATABASE",
            service: database.service,
            entrypoint: "default",
          },
          {
            type: "service",
            name: "OHMYHOST_DATABASE",
            service: "ohmyho-project-database-sandbox-eu",
          },
        ],
      },
    ];
    for (const { artifact, stored } of cases) {
      const fetch = uploadUntilReadback(envelope(stored)).mockResolvedValueOnce(envelope(null));
      await expect(provider(fetch).stageCandidate(artifact)).rejects.toBeInstanceOf(
        CloudflareWfpContractError,
      );
      expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
        "GET",
        "PUT",
        "GET",
        "DELETE",
      ]);
    }
  });

  it("admits each platform binding that the closed set names with a matching read-back", async () => {
    const platformPlainText = [
      "BETTER_AUTH_URL",
      "OHMYHOST_AI_BASE_URL",
      "OHMYHOST_ENVIRONMENT_ID",
      "OHMYHOST_MAIL_GATEWAY_URL",
      "OHMYHOST_PROJECT_ID",
      "OHMYHOST_STORAGE_GATEWAY_URL",
    ];
    for (const name of platformPlainText) {
      const fetch = uploadUntilReadback(
        envelope([{ type: "plain_text", name, text: "x" }]),
      ).mockResolvedValueOnce(details());
      await expect(
        provider(fetch).stageCandidate(
          multipartArtifact(
            metadataPart(workerMetadata([{ type: "plain_text", name, text: "x" }])) + CLOSING_PART,
          ),
        ),
      ).resolves.toMatchObject({ providerTag: TAG_A });
    }
    for (const name of ["OHMYHOST_AI_KEY", "OHMYHOST_AI_OTHER"]) {
      // The AI key is a customer-style secret_text; only the base URL is a platform plain text.
      await expect(
        provider(vi.fn()).stageCandidate(
          multipartArtifact(
            metadataPart(workerMetadata([{ type: "plain_text", name, text: "x" }])) + CLOSING_PART,
          ),
        ),
      ).rejects.toBeInstanceOf(CloudflareWfpInputError);
    }
    for (const binding of [
      { type: "assets", name: "ASSETS" },
      { type: "images", name: "IMAGES" },
    ]) {
      const fetch = uploadUntilReadback(envelope([binding])).mockResolvedValueOnce(details());
      await expect(
        provider(fetch).stageCandidate(
          multipartArtifact(metadataPart(workerMetadata([binding])) + CLOSING_PART),
        ),
      ).resolves.toMatchObject({ providerTag: TAG_A });
    }
  });
});
