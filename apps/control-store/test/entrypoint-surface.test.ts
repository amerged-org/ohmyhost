import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createTestControl, type TestControl } from "./support/control-d1.js";

type Call = { readonly leaf: string; readonly input: unknown };
const state = vi.hoisted(() => ({
  env: undefined as unknown,
  calls: [] as Call[],
  failure: undefined as unknown,
}));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = state.env;
  },
}));
/**
 * The real store is built over the real D1 binding; only its commands are replaced by recorders of the same shape, so a
 * generated method can reach nothing but a command that exists on the production store.
 */
vi.mock("../src/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store.js")>();
  const record = (leaf: string) => (input: unknown) => {
    state.calls.push({ leaf, input });
    return state.failure === undefined ? Promise.resolve({ leaf }) : Promise.reject(state.failure);
  };
  const mirror = (node: object, path: readonly string[]): object =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(node).map(([key, value]) => [
          key,
          typeof value === "function"
            ? record([...path, key].join("."))
            : mirror(value as object, [...path, key]),
        ]),
      ),
    );
  return {
    ...actual,
    createControlStore: (bindings: Parameters<typeof actual.createControlStore>[0]) =>
      mirror(actual.createControlStore(bindings), []),
  };
});

type Method = (input?: unknown) => Promise<unknown>;
type Instance = Record<string, Method>;
type Entrypoint = new () => Instance;
const invoke = (target: Instance, name: string, input: unknown) =>
  (target[name] as Method).call(target, input);

const JOB = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
};

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(0);
  state.env = { ...control.bindings, CONTROL_PLATFORM_ENVIRONMENT: "development" };
}, 60_000);
afterAll(async () => control.dispose());

const entrypoints = async () => {
  const entry = (await import("../src/worker-main.js")) as unknown as Record<string, Entrypoint>;
  expect(entry["default"]).toEqual({});
  expect(entry["default"]).not.toHaveProperty("fetch");
  return Object.entries(entry)
    .filter(([name]) => name !== "default")
    .sort(([a], [b]) => (a < b ? -1 : 1));
};
const methodsOf = (entrypoint: Entrypoint) =>
  Object.getOwnPropertyNames(entrypoint.prototype)
    .filter((name) => name !== "constructor")
    .sort();

/** What reached the store, as the golden file spells it: the command, and how the input was changed on the way. */
const forwarded = (sent: unknown, call: Call) =>
  call.input === sent
    ? call.leaf
    : call.input === undefined
      ? `${call.leaf} <- nothing`
      : isDeepStrictEqual(call.input, sent)
        ? `${call.leaf} <- parsed`
        : `${call.leaf} <- ${JSON.stringify(call.input)}`;

it("exposes exactly the pinned methods on each entrypoint and forwards each one to its store command", async () => {
  const observed: Record<string, Record<string, string>> = {};
  for (const [name, Entrypoint] of await entrypoints()) {
    const instance = new Entrypoint();
    observed[name] = {};
    for (const method of methodsOf(Entrypoint)) {
      const sent = /RecoveryState$|^readClaimState$/u.test(method) ? JOB : { probe: 1 };
      state.calls.length = 0;
      // The store's answer comes back untouched.
      await expect(invoke(instance, method, sent)).resolves.toEqual({
        leaf: expect.any(String) as string,
      });
      expect(state.calls).toHaveLength(1);
      observed[name][method] = forwarded(sent, state.calls[0] as Call);
    }
  }
  const pinned = JSON.parse(
    readFileSync(new URL("./entrypoint-surface.json", import.meta.url), "utf8"),
  ) as unknown;
  expect(observed).toEqual(pinned);
});

it("refuses the private QA database and mail custody surfaces outside Development", async () => {
  const entry = (await import("../src/worker-main.js")) as unknown as Record<string, Entrypoint>;
  const qa = new (entry["PreviewQaDatabaseAuthority"] as Entrypoint)();
  for (const environment of [undefined, "production"]) {
    state.env = { ...control.bindings, CONTROL_PLATFORM_ENVIRONMENT: environment };
    const unavailable = new (entry["PreviewQaDatabaseAuthority"] as Entrypoint)();
    expect(() => invoke(unavailable, "readRuntimeBinding", JOB)).toThrow("qa_unavailable");
    expect(() => invoke(unavailable, "readApiProjectDataChangeState", JOB)).toThrow(
      "qa_unavailable",
    );
    const mail = new (entry["QaPreviewMailKeyAuthority"] as Entrypoint)();
    expect(() => invoke(mail, "read", JOB)).toThrow("qa_unavailable");
  }
  state.env = { ...control.bindings, CONTROL_PLATFORM_ENVIRONMENT: "development" };
  expect(methodsOf(qa.constructor as Entrypoint)).toEqual([
    "readApiProjectDataChangeState",
    "readRuntimeBinding",
  ]);
});

it("rethrows a lost store response as the same error and refuses invalid recovery input before the store", async () => {
  const entry = (await import("../src/worker-main.js")) as unknown as Record<string, Entrypoint>;
  const api = new (entry["ControlRuntime"] as Entrypoint)(),
    recovery = new (entry["RecoveryRuntime"] as Entrypoint)();
  state.calls.length = 0;
  const lost = new Error("Network connection lost after the batch committed");
  state.failure = lost;
  try {
    await expect(invoke(api, "queueOperation", { probe: 1 })).rejects.toBe(lost);
  } finally {
    state.failure = undefined;
  }
  state.calls.length = 0;
  for (const invalid of [undefined, null, [], "recover"])
    expect(() => invoke(api, "recordProjectRecoveryDispatchFailure", invalid)).toThrow(
      new TypeError("Recovery command is invalid"),
    );
  expect(() => invoke(recovery, "claim", undefined)).toThrow(
    new TypeError("Recovery command is invalid"),
  );
  expect(() => invoke(recovery, "readClaimState", { ...JOB, extra: true })).toThrow();
  const operator = new (entry["FeedbackOperatorRuntime"] as Entrypoint)();
  for (const invalid of [undefined, null, [], "feedback", { runtimeEnvironment: "production" }])
    expect(() => invoke(operator, "preview", invalid)).toThrow(
      new TypeError("Feedback operator input is invalid"),
    );
  state.env = control.bindings;
  const unconfiguredOperator = new (entry["FeedbackOperatorRuntime"] as Entrypoint)();
  expect(() => invoke(unconfiguredOperator, "apply", { probe: 1 })).toThrow(
    new TypeError("Feedback operator input is invalid"),
  );
  state.env = { ...control.bindings, CONTROL_PLATFORM_ENVIRONMENT: "development" };
  expect(state.calls).toEqual([]);
});

it("bundles the RPC-only module with the locked release Wrangler", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "control-core-bundle-"));
  try {
    const config = join(dir, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify({
        name: "control-core-module-test",
        main: join(repositoryRoot, "apps/control-store/src/worker-main.ts"),
        compatibility_date: "2026-08-24",
        compatibility_flags: ["nodejs_compat"],
      }),
    );
    const cli = join(repositoryRoot, "apps/control-api/node_modules/wrangler/bin/wrangler.js");
    expect(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim()).toBe(
      "4.125.0",
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [cli, "deploy", "--dry-run", "--config", config, "--outdir", join(dir, "out")],
        {
          encoding: "utf8",
          timeout: 60_000,
          stdio: "pipe",
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) =>
                  !/(?:TOKEN|SECRET|PASSWORD|DATABASE_URL|DATABASE_DIRECT_URL|PRIVATE_KEY|ACCESS_KEY)/u.test(
                    name,
                  ),
              ),
            ),
            WRANGLER_SEND_METRICS: "false",
          },
        },
      ),
    ).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);

it("names the Control API as the only Worker that binds the maintenance entrypoint", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const configs = execFileSync("git", ["ls-files", "apps/*/wrangler*.jsonc"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const binders = configs
    .filter((path) =>
      readFileSync(join(repositoryRoot, path), "utf8").includes(
        '"entrypoint": "MaintenanceRuntime"',
      ),
    )
    .map((path) => path.split("/")[1])
    .filter((app, index, all) => all.indexOf(app) === index);
  expect(binders).toEqual(["control-api"]);
  const workerMain = readFileSync(new URL("../src/worker-main.ts", import.meta.url), "utf8");
  expect(workerMain).not.toContain("no binding does yet");
  expect(workerMain).toContain("CONTROL_MAINTENANCE_RUNTIME");
});
