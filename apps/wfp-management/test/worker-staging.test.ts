import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
  CloudflareWfpProvider,
  createRuntimeSecretManifest,
  type WfpPublishInput,
} from "@ohmyhost/provider-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = Object.freeze({});
  },
}));

import { createWfpManagementRuntime } from "../src/worker-main.js";
import {
  buildBundle,
  cloudflareEnvelope,
  DEPLOYMENT,
  deterministicNoise,
  ENVIRONMENT,
  PROJECT,
  ORGANIZATION,
  scope,
  storedObject,
  workerBindings,
} from "./worker-fixtures.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const MIB = 1024 * 1024;
const SCRIPT_NAME = `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`;
const PROVIDER_TAG = "44e2244f9dec426aa7330ba66b44ebf0";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

/** Bytes that gzip to roughly a third of their size, like minified JavaScript. */
function compressibleBytes(byteLength: number, seed: number): Uint8Array {
  const result = deterministicNoise(byteLength, seed);
  for (let index = 0; index < result.length; index += 1) {
    if (index % 80 >= 24) result[index] = 97 + (index % 7);
  }
  return result;
}

/** Live JavaScript memory: what stays after a full collection, as an isolate limit counts it. */
async function liveBytes(): Promise<number> {
  // Array buffers are swept concurrently; a second collection after a turn settles the counters.
  collectGarbage();
  await new Promise((resolve) => setTimeout(resolve, 5));
  collectGarbage();
  const usage = process.memoryUsage();
  // `external` covers array buffers and strings that live outside the heap.
  return usage.heapUsed + usage.external;
}

/**
 * The Cloudflare asset API as the staging path meets it: one upload session that asks for every
 * asset in a single bucket (the largest request the provider can ask for) and one upload whose
 * multipart body the transport serializes in full before it is sent.
 */
function assetApi(
  sample: () => Promise<void>,
  onUpload: () => void = () => undefined,
  inspectUpload?: (body: ArrayBuffer, headers: HeadersInit | undefined) => Promise<void>,
) {
  return vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith("/assets-upload-session")) {
      const request = JSON.parse(String(init?.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      return cloudflareEnvelope({
        jwt: "upload.jwt",
        buckets: [Object.values(request.manifest).map((asset) => asset.hash)],
      });
    }
    onUpload();
    const serialized = await new Response(init?.body).arrayBuffer();
    await inspectUpload?.(serialized, init?.headers);
    await sample();
    expect(serialized.byteLength).toBeGreaterThan(0);
    return cloudflareEnvelope({ jwt: "complete.jwt" }, 201);
  });
}

function stageProvider(
  artifactDigest: string,
  sample: () => Promise<void>,
  onStage: () => void = () => undefined,
) {
  const receipt = {
    provider: "cloudflare-wfp" as const,
    namespace: "ohmyho-sandbox",
    scriptName: SCRIPT_NAME,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    productDeploymentId: DEPLOYMENT,
    providerTag: PROVIDER_TAG,
    artifactDigest: artifactDigest as `sha256:${string}`,
    buildReused: false,
    deployedAt: NOW,
  };
  const stageCandidate = vi
    .spyOn(CloudflareWfpProvider.prototype, "stageCandidate")
    .mockImplementation(async (input: WfpPublishInput) => {
      onStage();
      await sample();
      expect(input.artifact.digest).toBe(artifactDigest);
      return receipt;
    });
  vi.spyOn(CloudflareWfpProvider.prototype, "observeCandidate").mockImplementation(async () => {
    await sample();
    return {
      state: "ready" as const,
      scriptName: SCRIPT_NAME,
      providerTag: PROVIDER_TAG,
      productDeploymentId: DEPLOYMENT,
      artifactDigest: receipt.artifactDigest,
      observedAt: NOW,
    };
  });
  vi.spyOn(CloudflareWfpProvider.prototype, "syncRuntimeSecrets").mockImplementation(
    async (input) => ({
      provider: "cloudflare-wfp" as const,
      namespace: "ohmyho-sandbox",
      scriptName: SCRIPT_NAME,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      manifestDigest: input.manifest.digest,
      secretNames: [],
      providerTag: PROVIDER_TAG,
      observedAt: NOW,
    }),
  );
  return { receipt, stageCandidate };
}

describe("staging a build bundle inside the private Worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the exact stored bundle, uploads its assets and stages the candidate", async () => {
    const bundle = await buildBundle();
    const bindings = workerBindings({
      BUILD_OBJECTS_US: {
        get: vi.fn(async () => storedObject(bundle.body, bundle.provenance.output)),
      },
    });
    let uploadedForm: FormData | undefined;
    const fetch = assetApi(
      async () => undefined,
      () => undefined,
      async (body, headers) => {
        uploadedForm = await new Response(body, {
          ...(headers === undefined ? {} : { headers }),
        }).formData();
      },
    );
    const { receipt, stageCandidate } = stageProvider(bundle.artifactDigest, async () => undefined);
    const runtime = createWfpManagementRuntime(bindings as never, {
      fetch,
      now: () => NOW,
      sleep: async () => undefined,
    });
    const runtimeSecretManifest = await createRuntimeSecretManifest([]);

    await expect(
      runtime.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact: { provenance: bundle.provenance },
        knownDeployments: [],
        runtimeSecretManifest,
      } as never),
    ).resolves.toEqual({
      status: "staged",
      candidate: receipt,
      priorGateway: null,
      activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      deploymentUrl: "https://dev-calm-river-studio.dev.check.omh.st",
      runtimeSecretManifestDigest: runtimeSecretManifest.digest,
    });
    expect(bindings.BUILD_OBJECTS_US.get).toHaveBeenCalledExactlyOnceWith(
      bundle.provenance.output.key,
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer narrow-cloudflare-token",
    );
    expect(stageCandidate).toHaveBeenCalledOnce();
    const upload = fetch.mock.calls[1]?.[1];
    expect(upload?.body).toBeInstanceOf(ReadableStream);
    expect(uploadedForm).toBeInstanceOf(FormData);
    if (uploadedForm === undefined) throw new Error("The upload was not observed");
    const uploaded = [...uploadedForm.entries()];
    expect(uploaded.map(([hash]) => hash)).toEqual([expect.stringMatching(/^[a-f0-9]{32}$/u)]);
    const part = uploaded[0]?.[1] as File;
    expect(part.type).toBe("text/html; charset=utf-8");
    expect(Buffer.from(await part.text(), "base64").toString("utf8")).toBe(
      "<!doctype html><title>ok</title>",
    );

    await expect(
      runtime.prepareExistingCandidate({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope,
        candidate: receipt,
        artifact: { provenance: bundle.provenance },
        runtimeSecretManifest,
      } as never),
    ).resolves.toMatchObject({
      status: "prepared",
      candidate: { productDeploymentId: DEPLOYMENT },
    });
    expect(bindings.BUILD_OBJECTS_US.get).toHaveBeenCalledTimes(2);
  });

  it("stages nothing when the stored object no longer is the provenance's version", async () => {
    const bundle = await buildBundle();
    const bindings = workerBindings({
      BUILD_OBJECTS_US: {
        get: vi.fn(async () =>
          storedObject(bundle.body, bundle.provenance.output, {
            version: "fedcba9876543210fedcba9876543210",
          }),
        ),
      },
    });
    const fetch = assetApi(async () => undefined);
    const { stageCandidate } = stageProvider(bundle.artifactDigest, async () => undefined);
    const runtime = createWfpManagementRuntime(bindings as never, { fetch, now: () => NOW });

    await expect(
      runtime.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact: { provenance: bundle.provenance },
        knownDeployments: [],
        runtimeSecretManifest: await createRuntimeSecretManifest([]),
      } as never),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    expect(fetch).not.toHaveBeenCalled();
    expect(stageCandidate).not.toHaveBeenCalled();
  });

  /**
   * Stages one bundle and reports the live memory the staging path added while it unpacked the
   * bundle, while the asset upload was serialized and while the candidate was staged.
   */
  async function measureStaging(bundle: Awaited<ReturnType<typeof buildBundle>>) {
    const bindings = workerBindings({
      BUILD_OBJECTS_US: {
        get: vi.fn(async () => storedObject(bundle.body, bundle.provenance.output)),
      },
    });
    const baseline = await liveBytes();
    const peaks = { unpack: 0, upload: 0, stage: 0 };
    let phase: keyof typeof peaks = "unpack";
    const sample = async () => {
      // Recorded double calls would keep finished request bodies alive.
      vi.clearAllMocks();
      const live = (await liveBytes()) - baseline;
      peaks[phase] = Math.max(peaks[phase], live);
    };
    // Between the doubles only a timer can observe the unpacking of the bundle.
    let sampling = false;
    let pendingSample = Promise.resolve();
    const sampler = setInterval(() => {
      if (sampling) return;
      sampling = true;
      pendingSample = sample().finally(() => {
        sampling = false;
      });
    }, 5);
    const fetch = assetApi(sample, () => {
      phase = "upload";
    });
    stageProvider(bundle.artifactDigest, sample, () => {
      phase = "stage";
    });
    const runtime = createWfpManagementRuntime(bindings as never, {
      fetch,
      now: () => NOW,
      sleep: async () => undefined,
    });

    const result = await runtime
      .stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact: { provenance: bundle.provenance },
        knownDeployments: [],
        runtimeSecretManifest: await createRuntimeSecretManifest([]),
      } as never)
      .finally(async () => {
        clearInterval(sampler);
        await pendingSample;
      });

    expect(result).toMatchObject({ status: "staged" });
    const mib = (bytes: number) => (bytes / MIB).toFixed(1);
    process.stderr.write(
      `\nwfp-management staging memory: stored ${mib(bundle.body.byteLength)} MiB, live peaks ` +
        `unpack ${mib(peaks.unpack)} MiB, upload ${mib(peaks.upload)} MiB, ` +
        `stage ${mib(peaks.stage)} MiB\n`,
    );
    return Math.max(peaks.unpack, peaks.upload, peaks.stage);
  }

  it("stages the Next.js reference shape inside the memory of one Worker isolate", async () => {
    // About 8 MiB stored and 26 MiB unpacked, like the measured Next.js reference build: one
    // 12 MiB Worker module and 14 MiB of assets that compress to roughly a third.
    const bundle = await buildBundle(
      Array.from({ length: 28 }, (_, index) => ({
        path: `/_next/static/chunk-${String(index).padStart(2, "0")}.js`,
        body: compressibleBytes(MIB / 2, index + 1),
      })),
      compressibleBytes(12 * MIB, 99),
    );
    expect(bundle.body.byteLength).toBeGreaterThan(6 * MIB);
    expect(bundle.body.byteLength).toBeLessThan(10 * MIB);

    expect(await measureStaging(bundle)).toBeLessThan(80 * MIB);
  }, 60_000);

  it("keeps the live memory of staging a 30 MiB-class bundle from growing", async () => {
    // A valid 28.5 MiB object: 24 MiB ordinary assets fit their separate 25 MiB budget,
    // plus a 4.5 MiB Worker. Every asset is requested in one upload.
    const bundle = await buildBundle(
      [1, 2, 3].map((seed) => ({
        path: `/assets/noise-${seed}.bin`,
        body: deterministicNoise(8 * MIB, seed),
      })),
      deterministicNoise(4.5 * MIB, 99),
    );
    expect(bundle.body.byteLength).toBeGreaterThan(28 * MIB);

    // Measured 105 MiB: the unpacked assets, their base64 form and the serialized upload at once.
    // That leaves too little of a 128 MB isolate, so this bound only keeps the path from growing
    // until the largest bundle is unpacked and uploaded with fewer copies.
    expect(await measureStaging(bundle)).toBeLessThan(110 * MIB);
  }, 60_000);
});
