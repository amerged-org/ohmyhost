import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

import {
  RecoveryControlError,
  decodeControlResult,
  encodeControlBody,
} from "@ohmyhost/project-recovery-worker/control-wire";

import { classifyStoreFailure, sha256Hex } from "../src/control-mediator.js";

/**
 * Real workerd: the production control handler (bundled from source) calls a real service binding whose entrypoint
 * throws the store's error classes. What reaches the handler after the RPC hop is what the mapping may rely on.
 */
const STORE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { StoreBusyError, StoreOutcomeUnknownError } from "../../control-store/src/run-command.js";
import {
  RecoverySourceBusyError, RecoveryFenceLostError,
  ProjectRecoveryConflictError, RecoveryScopeUnavailableError,
} from "../../control-store/src/catalog/recovery/errors.js";
export class Store extends WorkerEntrypoint {
  readClaimState(input) { return { status: "running", seen: input }; }
  claim(input) {
    if (input.holderId === "00000000-0000-4000-8000-00000000dead") throw new RecoverySourceBusyError();
    return {
      status: "claimed", preparedArchive: null, expired: false, denialCode: null, replayed: false,
      archiveBucket: "ohmyho-development-backups",
      archiveKey: "snapshots/" + input.organizationId + "/" + input.projectId + "/" + input.operationId + ".zip",
      sealedInput: { ciphertext: new Uint8Array(8208).map((_, i) => i % 251), nonce: new Uint8Array(12).fill(9), keyVersion: 1 },
      seen: input,
    };
  }
  acquireFence() { throw new RecoverySourceBusyError(); }
  renewFence() { throw new RecoveryFenceLostError(); }
  releaseFence() { throw new ProjectRecoveryConflictError(); }
  readScope(input) {
    if (input.projectId === "01ARZ3NDEKTSV4RRFFQ69G5FAB") throw new Error("recovery_database_not_ready");
    if (input.projectId === "01ARZ3NDEKTSV4RRFFQ69G5FAC") throw new Error("recovery_inventory_invalid");
    return null;
  }
  prepareArchive(input) { return { outcome: "prepared", type: input.archive.sha256.constructor.name, length: input.archive.sha256.byteLength }; }
  discardArchive(input) { return { outcome: "discarded", type: input.archive.sha256.constructor.name, length: input.archive.sha256.byteLength }; }
  finish(input) {
    if (input.failureCode === "UNKNOWN") throw new StoreOutcomeUnknownError("unknown");
    if (input.failureCode === "BUSY") throw new StoreBusyError("busy");
    if (input.failureCode === "LEAK") throw new TypeError("customer SQL secret detail");
    if (input.failureCode === "SCOPE") throw new RecoveryScopeUnavailableError();
    return { outcome: "finished", status: "failed" };
  }
  readArchive() { return null; }
}
export default { fetch() { return new Response("store"); } };
`;

const scope = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
};
const CLAIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "t".repeat(43);

let miniflare: Miniflare;
let grant: Record<string, unknown>;

beforeAll(async () => {
  const storeBundle = await build({
    stdin: {
      contents: STORE,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "store.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external: ["cloudflare:*"],
    logLevel: "silent",
  });
  const bundle = await build({
    entryPoints: [new URL("./support/rpc-harness.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    target: "es2023",
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
  });
  miniflare = new Miniflare({
    workers: [
      {
        name: "harness",
        modules: [
          {
            type: "ESModule",
            path: "harness.mjs",
            contents: bundle.outputFiles[0]?.text ?? "",
          },
        ],
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: { STORE: { name: "store", entrypoint: "Store" } },
      },
      {
        name: "store",
        modules: true,
        script: storeBundle.outputFiles[0]?.text ?? "",
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    ],
  });
  await miniflare.ready;
  grant = {
    containerId: "do-1",
    action: "run",
    ...scope,
    claimId: CLAIM,
    tokenSha256: await sha256Hex(TOKEN),
    expiresAtMs: Date.now() + 3_600_000,
  };
});
afterAll(async () => miniflare.dispose());

const call = async (
  method: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => {
  const response = await miniflare.dispatchFetch(`http://harness/v1/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-grant": JSON.stringify(grant),
      "x-container-id": "do-1",
      ...headers,
    },
    body: encodeControlBody(body),
  });
  return { status: response.status, text: await response.text() };
};
const code = (result: { text: string }) => (JSON.parse(result.text) as { code: string }).code;

it("carries binary values, the exact scope and the execution-clock request over a real RPC binding", async () => {
  const seen = await call("readClaimState");
  expect(seen.status).toBe(200);
  expect(JSON.parse(seen.text)).toEqual({ status: "running", seen: scope });

  // The largest admitted sealed input crosses RPC and the wire byte for byte, inside the response cap.
  const claim = await call("claim", { holderId: "11111111-1111-4111-8111-111111111111" });
  expect(claim.status).toBe(200);
  expect(new TextEncoder().encode(claim.text).byteLength).toBeLessThan(64 * 1024);
  const decoded = decodeControlResult("claim", claim.text) as {
    sealedInput: { ciphertext: Uint8Array; nonce: Uint8Array };
  };
  expect([...decoded.sealedInput.ciphertext]).toEqual(
    Array.from({ length: 8208 }, (_, i) => i % 251),
  );
  expect([...decoded.sealedInput.nonce]).toEqual(new Array(12).fill(9));
  const echoed = (JSON.parse(claim.text) as { seen: Record<string, unknown> }).seen;
  expect(echoed).toMatchObject({
    ...scope,
    claimId: CLAIM,
    holderId: "11111111-1111-4111-8111-111111111111",
    clock: "execution",
  });
  expect(Object.keys(echoed)).not.toContain("sql");

  // A Uint8Array request field arrives as a Uint8Array.
  const digest = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");
  const prepared = await call("prepareArchive", {
    archive: {
      sqlFiles: ["dev.sql"],
      bytes: 5,
      sha256: digest,
      capturedAt: "2026-10-28T10:00:00.000Z",
    },
    fence: { epoch: 1, holderId: CLAIM },
  });
  expect(JSON.parse(prepared.text)).toMatchObject({
    outcome: "prepared",
    type: "Uint8Array",
    length: 32,
  });
  const discarded = await call("discardArchive", {
    archive: {
      sqlFiles: ["dev.sql"],
      bytes: 5,
      sha256: digest,
      capturedAt: "2026-10-28T10:00:00.000Z",
    },
    fence: { epoch: 1, holderId: CLAIM },
  });
  expect(JSON.parse(discarded.text)).toMatchObject({
    outcome: "discarded",
    type: "Uint8Array",
    length: 32,
  });
});

it("maps the store's exceptions, as delivered by workerd RPC, to the closed wire codes", async () => {
  const lease = { holderId: CLAIM, leaseMilliseconds: 5000 };
  const expectations: [string, Record<string, unknown>, number, string][] = [
    ["acquireFence", lease, 409, "recovery_source_busy"],
    [
      "renewFence",
      { epoch: 1, holderId: CLAIM, leaseMilliseconds: 5000 },
      409,
      "recovery_fence_lost",
    ],
    ["releaseFence", { epoch: 1, holderId: CLAIM }, 409, "project_recovery_conflict"],
    ["finish", { failureCode: "UNKNOWN" }, 503, "control_outcome_unknown"],
    ["finish", { failureCode: "BUSY" }, 503, "control_outcome_unknown"],
    ["finish", { failureCode: "SCOPE" }, 409, "recovery_scope_unavailable"],
    // An unclassified failure never leaks its message to the container.
    ["finish", { failureCode: "LEAK" }, 503, "control_unavailable"],
  ];
  for (const [method, body, status, expected] of expectations) {
    const result = await call(method, body);
    expect({ method, status: result.status, code: code(result) }).toEqual({
      method,
      status,
      code: expected,
    });
    expect(result.text).not.toContain("secret");
  }
  // The two plain Errors of the canonical inventory keep their code in the message across RPC.
  for (const [projectId, expected] of [
    ["01ARZ3NDEKTSV4RRFFQ69G5FAB", "recovery_database_not_ready"],
    ["01ARZ3NDEKTSV4RRFFQ69G5FAC", "recovery_inventory_invalid"],
  ] as const) {
    grant = { ...grant, projectId };
    const result = await call("readInventory");
    expect({ status: result.status, code: code(result) }).toEqual({ status: 409, code: expected });
  }
  grant = { ...grant, projectId: scope.projectId };
  // The classification the Node side acts on: retryable codes are exactly the unknown/unavailable ones.
  expect(new RecoveryControlError("control_outcome_unknown").retryable).toBe(true);
  expect(classifyStoreFailure(new RecoveryControlError("recovery_fence_lost")).status).toBe(400);
  expect(classifyStoreFailure("string")).toEqual({ status: 503, code: "control_unavailable" });
});

it("refuses a forged scope, a foreign container and an expired token before any store call", async () => {
  const forged = await call("readClaimState", { organizationId: scope.organizationId });
  expect({ status: forged.status, code: code(forged) }).toEqual({
    status: 400,
    code: "invalid_request",
  });
  const foreign = await call("readClaimState", {}, { "x-container-id": "do-2" });
  expect({ status: foreign.status, code: code(foreign) }).toEqual({
    status: 403,
    code: "forbidden",
  });
  const rawSql = await call("query", { sql: "select 1" });
  expect({ status: rawSql.status, code: code(rawSql) }).toEqual({ status: 404, code: "not_found" });
  grant = { ...grant, expiresAtMs: Date.now() - 1 };
  const expired = await call("readClaimState");
  expect({ status: expired.status, code: code(expired) }).toEqual({
    status: 401,
    code: "token_expired",
  });
});
