import { vi } from "vitest";

import type { BuildObjectBody } from "../src/bindings.js";

export const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const PROD_ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
export const DEPLOYMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
export const OPERATION = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
export const DATABASE_REGISTRATION = Object.freeze({
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  physicalEnvironmentId: ENVIRONMENT,
  registrationVersion: 1,
  region: "us" as const,
  provider: "pgcf" as const,
  providerProjectId: "pgcf-project",
  databaseId: "a".repeat(20),
  originHost: "sql.pgcf.example",
  originDatabase: "a".repeat(20),
  originUser: `ohmyho_rw_${ENVIRONMENT.toLowerCase()}`,
  authorizedEnvironmentIds: [ENVIRONMENT, PROD_ENVIRONMENT],
  status: "active" as const,
});
export const STORAGE_BUCKET = `ohmyho-${PROJECT.toLowerCase()}-${ENVIRONMENT.toLowerCase()}`;
export const BUILD_OBJECTS_BUCKET = "ohmyho-builds-development";
export const BUILD_OBJECTS_BUCKET_EU = "ohmyho-builds-development-eu";
export const BUILD_ID = `ohmyho-sandbox-build:${OPERATION}`;
export const DIAGNOSTIC_SIGNING_KEY = Buffer.alloc(32, 7).toString("base64");
export const WFP_API_TOKEN = "narrow-cloudflare-token";
export const DEV_ACCESS_PUBLIC_JWK = Object.freeze({
  kty: "EC",
  crv: "P-256",
  x: "pDiOVRnGi6l37fQ1GL5XCkzaJ_zq06noDbrW00wPf-Q",
  y: "2HwxFGcDWPstz3JnXurywmAqieiGAOdLMxTq1VAsxfs",
});

export const scope = Object.freeze({
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  environmentName: "dev" as const,
  handle: "calm-river-studio",
});

export const lifecycleEvidence = Object.freeze({
  configurationDigest: "0".repeat(64),
  frozenInstall: {
    packageManager: "pnpm",
    packageManagerVersion: "10.28.2",
    lockfile: "pnpm-lock.yaml",
    lockfileSha256: "5".repeat(64),
    installCommandSha256: "6".repeat(64),
    dependencyInventorySha256: "7".repeat(64),
  },
  frameworkBuild: {
    framework: "vite",
    runtime: "static",
    buildCommandSha256: "8".repeat(64),
    frameworkPlanSha256: "2".repeat(64),
    buildOutputSha256: "9".repeat(64),
  },
  buildSandbox: {
    buildId: BUILD_ID,
    projectName: "ohmyho-sandbox-build",
    buildInputFingerprint: "a".repeat(64),
    sourceArchiveSha256: "1".repeat(64),
    terminalStatus: "SUCCEEDED",
  },
  credentialScan: {
    scannerSha256: "b".repeat(64),
    rulesSha256: "c".repeat(64),
    findingsCount: 0,
  },
});

const planEvidence = Object.freeze({
  applicationRoot: ".",
  frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v5",
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] as string[] },
  database: { enabled: false },
  auth: { provider: "none" },
  storage: { enabled: false },
});

/** Provenance whose stored object is never read; enough for input validation scenarios. */
export const artifactProvenance = Object.freeze({
  scope: { projectId: PROJECT, environmentId: ENVIRONMENT, operationId: OPERATION },
  deploymentId: DEPLOYMENT,
  buildId: BUILD_ID,
  sourceCommit: "c".repeat(40),
  sourceDigest: `sha256:${"1".repeat(64)}`,
  buildPlanDigest: `sha256:${"2".repeat(64)}`,
  artifactDigest: `sha256:${"3".repeat(64)}`,
  lifecycleEvidence,
  ...planEvidence,
  output: {
    bucket: BUILD_OBJECTS_BUCKET,
    key: `runs/${PROJECT}/${ENVIRONMENT}/${OPERATION}/output/bundle.tar.gz`,
    versionId: "0123456789abcdef0123456789abcdef",
    eTag: '"etag"',
    byteLength: 100,
    sha256: "4".repeat(64),
  },
});

const encoder = new TextEncoder();

export async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Incompressible bytes, so a bundle is as large on the wire as it is unpacked. */
export function deterministicNoise(byteLength: number, seed: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let state = seed;
  for (let index = 0; index < result.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}

function tar(entries: readonly { path: string; body: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(entry.path), 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(encoder.encode(`${entry.body.byteLength.toString(8).padStart(11, "0")}\0`), 124);
    header.set(encoder.encode("00000000000\0"), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header, entry.body, new Uint8Array((512 - (entry.body.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const result = new Uint8Array(blocks.reduce((sum, block) => sum + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.byteLength;
  }
  return result;
}

async function gzip(body: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Builds a real build bundle and the provenance the build runner records for it: a static site,
 * or with `mainModule` a Next.js Worker beside its assets.
 */
export async function buildBundle(
  extraAssets: readonly { path: string; body: Uint8Array }[] = [],
  mainModule?: Uint8Array,
) {
  const files = [
    ...extraAssets,
    { path: "/index.html", body: encoder.encode("<!doctype html><title>ok</title>") },
  ].sort((left, right) => (left.path < right.path ? -1 : 1));
  const sbom = encoder.encode(
    JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: [] }),
  );
  const assets = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      digest: `sha256:${await sha256Hex(file.body)}`,
      size: file.body.byteLength,
    })),
  );
  const edge =
    mainModule === undefined
      ? null
      : {
          runtime: {
            kind: "cloudflare-worker",
            mainModule: "index.js",
            compatibilityDate: "2026-08-21",
            compatibilityFlags: ["nodejs_compat"],
            entryWrapperVersion: "nextjs-opennext-wrapper-v1",
          },
          modules: [
            {
              path: "index.js",
              contentType: "application/javascript+module",
              digest: `sha256:${await sha256Hex(mainModule)}`,
              size: mainModule.byteLength,
            },
          ],
        };
  const evidence =
    edge === null
      ? lifecycleEvidence
      : {
          ...lifecycleEvidence,
          frameworkBuild: {
            ...lifecycleEvidence.frameworkBuild,
            framework: "nextjs",
            runtime: "edge",
          },
        };
  const artifactDigest = `sha256:${await sha256Hex(
    encoder.encode(
      JSON.stringify(
        edge === null
          ? { ...planEvidence, assets }
          : { ...planEvidence, runtime: edge.runtime, assets, modules: edge.modules },
      ),
    ),
  )}`;
  const manifest = encoder.encode(
    JSON.stringify({
      schemaVersion: "ohmyhost.artifact/v3",
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      deploymentId: DEPLOYMENT,
      operationId: OPERATION,
      buildId: BUILD_ID,
      sourceCommit: artifactProvenance.sourceCommit,
      sourceDigest: artifactProvenance.sourceDigest,
      buildPlanDigest: artifactProvenance.buildPlanDigest,
      ...planEvidence,
      lifecycleEvidence: evidence,
      artifactDigest,
      sbom: { path: "sbom.cdx.json", digest: `sha256:${await sha256Hex(sbom)}` },
      ...(edge === null ? {} : { runtime: edge.runtime }),
      assets,
      ...(edge === null ? {} : { modules: edge.modules }),
    }),
  );
  const body = await gzip(
    tar([
      { path: "manifest.json", body: manifest },
      { path: "sbom.cdx.json", body: sbom },
      ...files.map((file) => ({ path: `assets${file.path}`, body: file.body })),
      ...(mainModule === undefined ? [] : [{ path: "worker/index.js", body: mainModule }]),
    ]),
  );
  return {
    body,
    artifactDigest,
    provenance: {
      ...artifactProvenance,
      lifecycleEvidence: evidence,
      artifactDigest,
      output: {
        ...artifactProvenance.output,
        byteLength: body.byteLength,
        sha256: await sha256Hex(body),
      },
    },
  };
}

/** A stored R2 object as the read-only bucket binding returns it. */
export function storedObject(
  body: Uint8Array,
  output: { readonly versionId: string; readonly eTag: string },
  overrides: Partial<BuildObjectBody> = {},
): BuildObjectBody {
  return {
    version: output.versionId,
    httpEtag: output.eTag,
    size: body.byteLength,
    // A fresh buffer per read, as the bucket binding hands out.
    arrayBuffer: async () => body.slice().buffer as ArrayBuffer,
    ...overrides,
  };
}

export function workerBindings(overrides: Record<string, unknown> = {}) {
  return {
    WFP_ACCOUNT_ID: "00000000000000000000000000000001",
    WFP_DISPATCH_NAMESPACE: "ohmyho-sandbox",
    DATABASE_SERVICE_US: "ohmyho-project-database-sandbox-us",
    DATABASE_SERVICE_EU: "ohmyho-project-database-sandbox-eu",
    WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
    BUILD_OBJECTS_BUCKET_US: BUILD_OBJECTS_BUCKET,
    BUILD_OBJECTS_BUCKET_EU,
    WFP_API_TOKEN,
    DIAGNOSTIC_SIGNING_KEY,
    DEV_ACCESS_PUBLIC_JWK: JSON.stringify(DEV_ACCESS_PUBLIC_JWK),
    BUILD_OBJECTS_US: { get: vi.fn(async (): Promise<BuildObjectBody | null> => null) },
    BUILD_OBJECTS_EU: { get: vi.fn(async (): Promise<BuildObjectBody | null> => null) },
    WFP_DISPATCH: {
      get: vi.fn(() => ({ fetch: async () => new Response(null, { status: 204 }) })),
    },
    GATEWAY_REGISTRY: {
      activate: vi.fn(async (): Promise<unknown> => null),
      observe: vi.fn(async (): Promise<unknown> => null),
      remove: vi.fn(async (): Promise<unknown> => null),
      compensate: vi.fn(async (): Promise<unknown> => null),
      authorizeCandidateRemoval: vi.fn(async () => ({ authorized: true })),
    },
    RUNTIME_PROBES: {
      beginProbe: vi.fn(async () => ({
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      })),
    },
    RUNTIME_SECRET_AUTHORITY: {
      authorizeManifest: vi.fn(async (input: unknown) => {
        void input;
        return { authorized: true };
      }),
    },
    ...overrides,
  };
}

export function cloudflareEnvelope(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
