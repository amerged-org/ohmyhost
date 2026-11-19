import { beforeEach, expect, it, vi } from "vitest";
import { createEnvironmentSecretCipherKeyring, parseUlid } from "@ohmyhost/platform";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const state = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = state.env;
  },
}));
const org = "01M145HEM4JWAP8KJBG92BSCGE",
  project = "01M700N2PQY18W4NGX2TSM9FKT",
  envId = "01M700N2PQY18W4NGX2TSM9FKZ";
const key = "qa-test-key-not-a-secret-value-123456789012";
const base64 = Buffer.alloc(32, 0x41).toString("base64");
const management = () => ({
  stageVerifiedArtifact: vi.fn(),
  prepareExistingCandidate: vi.fn(),
  activateCandidate: vi.fn(),
  compensateGatewayActivation: vi.fn(),
  compensateActivation: vi.fn(),
  removeCandidate: vi.fn(),
  observeActivation: vi.fn(),
  syncRuntimeSecrets: vi.fn(),
});
const persistence = new Proxy({}, { get: () => async () => null });
const cipher = createEnvironmentSecretCipherKeyring({
  primaryKeyBase64: base64,
  currentKeyVersion: 1,
  crypto: globalThis.crypto,
});
let envelope: Record<string, unknown>;
let reads = 0;
let after: Record<string, unknown> | null;
const binding = {
  read: vi.fn(async () => {
    reads += 1;
    return reads === 1 ? envelope : after;
  }),
};
function bindings() {
  return {
    RUNTIME_CONFIGURATION_STATE: "configured",
    RUNTIME_SECRET_RUNTIME: persistence,
    ENVIRONMENT_SECRET_KEY_BASE64: base64,
    ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: "{}",
    ENVIRONMENT_SECRET_KEY_VERSION: "1",
    WFP_MANAGEMENT: management(),
    RUNTIME_QA_PREVIEW_MAIL_ENABLED: "development-only-v1",
    QA_MAIL_KEY_AUTHORITY: binding,
  };
}

beforeEach(async () => {
  reads = 0;
  const sealed = await cipher.encrypt({
    organizationId: parseUlid(org),
    projectId: parseUlid(project),
    environmentId: parseUlid(envId),
    name: "OHMYHOST_MAIL_KEY",
    value: key,
  });
  envelope = {
    organizationId: org,
    projectId: project,
    environmentId: envId,
    name: "OHMYHOST_MAIL_KEY",
    ...sealed,
    revision: 1,
    devAccessEpoch: 3,
    senderDomain: "qa.example.com",
    senderRevision: "1",
  };
  after = envelope;
  binding.read.mockClear();
  state.env = bindings();
});

it("returns only the fixed Dev mail key after exact fresh authority and authenticated custody checks", async () => {
  const { QaPreviewMailKey } = await import("../src/worker-main.js");
  const service = new QaPreviewMailKey({} as never, state.env as never);
  expect(await service.read()).toBe(key);
  expect(binding.read).toHaveBeenCalledTimes(2);
  for (const call of binding.read.mock.calls) expect(call).toEqual([]);
  await expect(service.read({ projectId: "other" } as never)).rejects.toThrow(
    "qa_mail_key_unavailable",
  );
  expect(binding.read).toHaveBeenCalledTimes(2);
});

it("refuses stale, foreign, corrupted and disabled authority without leaking custody material", async () => {
  const { QaPreviewMailKey } = await import("../src/worker-main.js");
  for (const change of [
    () => {
      after = { ...envelope, revision: 2 };
    },
    () => {
      after = { ...envelope, devAccessEpoch: 4 };
    },
    () => {
      envelope = { ...envelope, projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" };
      after = envelope;
    },
    () => {
      envelope = { ...envelope, valueSha256: new Uint8Array(32) };
      after = envelope;
    },
    () => {
      after = null;
    },
  ]) {
    reads = 0;
    change();
    const service = new QaPreviewMailKey({} as never, state.env as never);
    await expect(service.read()).rejects.toThrow("qa_mail_key_unavailable");
    const sealed = await cipher.encrypt({
      organizationId: parseUlid(org),
      projectId: parseUlid(project),
      environmentId: parseUlid(envId),
      name: "OHMYHOST_MAIL_KEY",
      value: key,
    });
    envelope = {
      organizationId: org,
      projectId: project,
      environmentId: envId,
      name: "OHMYHOST_MAIL_KEY",
      ...sealed,
      revision: 1,
      devAccessEpoch: 3,
      senderDomain: "qa.example.com",
      senderRevision: "1",
    };
    after = envelope;
  }
  const disabled = { ...bindings(), RUNTIME_QA_PREVIEW_MAIL_ENABLED: "production" };
  state.env = disabled;
  const service = new QaPreviewMailKey({} as never, disabled as never);
  reads = 0;
  await expect(service.read()).rejects.toThrow("qa_mail_key_unavailable");
  expect(reads).toBe(0);
});

it("decrypts the synthetic fixed envelope across actual private workerd RPC bindings", async () => {
  const sealed = envelope;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "client",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "client.mjs",
              contents: `export default { async fetch(_, env) { try { const value=await env.KEY.read(); return Response.json({matches:value===${JSON.stringify(key)}}); } catch { return new Response(null,{status:503}); } } };`,
            },
          ],
          serviceBindings: { KEY: { name: "custody", entrypoint: "QaPreviewMailKey" } },
        },
        {
          name: "custody",
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./qa-custody-worker.mjs", import.meta.url)),
              contents: readFileSync(
                new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
                "utf8",
              ),
            },
          ],
          bindings: {
            RUNTIME_CONFIGURATION_STATE: "configured",
            ENVIRONMENT_SECRET_KEY_BASE64: base64,
            ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: "{}",
            ENVIRONMENT_SECRET_KEY_VERSION: "1",
            RUNTIME_QA_PREVIEW_MAIL_ENABLED: "development-only-v1",
          },
          serviceBindings: {
            RUNTIME_SECRET_RUNTIME: { name: "authority", entrypoint: "Core" },
            WFP_MANAGEMENT: { name: "authority", entrypoint: "Core" },
            QA_MAIL_KEY_AUTHORITY: { name: "authority", entrypoint: "Core" },
          },
        },
        {
          name: "authority",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "authority.mjs",
              contents: `import {WorkerEntrypoint} from 'cloudflare:workers'; export class Core extends WorkerEntrypoint { read() { return {organizationId:${JSON.stringify(org)},projectId:${JSON.stringify(project)},environmentId:${JSON.stringify(envId)},name:'OHMYHOST_MAIL_KEY',ciphertext:Uint8Array.from(${JSON.stringify(Array.from(sealed["ciphertext"] as Uint8Array))}),nonce:Uint8Array.from(${JSON.stringify(Array.from(sealed["nonce"] as Uint8Array))}),valueSha256:Uint8Array.from(${JSON.stringify(Array.from(sealed["valueSha256"] as Uint8Array))}),keyVersion:1,revision:1,devAccessEpoch:3,senderDomain:'qa.example.com',senderRevision:'1'}; } } export default {fetch(){return new Response(null,{status:404});}};`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const response = await mf.dispatchFetch("https://client.example/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matches: true });
  } finally {
    await mf.dispose();
  }
}, 30_000);
