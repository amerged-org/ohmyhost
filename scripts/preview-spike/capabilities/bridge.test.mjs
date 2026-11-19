/* global AbortController, ReadableStream, Request, Response, TextEncoder, URL */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildQaBindings, QA_FIXTURES } from "./config.mjs";
import { decodeValue, encodeValue } from "./wire.mjs";
import { handleDatabaseRequest } from "./bridge.mjs";

const id = (number) => String(number).padStart(26, "0");
const makeManifest = () => ({
  platform: "development",
  projects: QA_FIXTURES.map((fixture, index) => ({
    fixture,
    organizationId: id(1),
    projectId: id(10 + index),
    environmentId: id(20 + index),
    physicalEnvironmentId: id(30 + index),
    registrationVersion: 1,
    region: "eu",
    handle: `qa-${index}`,
    origin: `https://dev-qa-${index}.dev.check.omh.st`,
    principalId: "qa-operator",
    devAccessEpoch: 1,
  })),
});

// Exercise actual local workerd RPC and fixed service props with synthetic-only services.
// This does not contact a hosted provider or prove the live QA scopes.
async function checkWorkerdRpc(configuration, scope) {
  const bridgePath = fileURLToPath(new URL("./bridge.mjs", import.meta.url));
  const compiled = await build({
    stdin: {
      contents: `import { handleDatabaseRequest } from ${JSON.stringify(bridgePath)};
        export default { fetch(request, env) {
          return handleDatabaseRequest(request, env, { fixture: 'react-vite' }, () => Date.parse('2026-11-14T12:00:01.000Z'));
        } };`,
      loader: "js",
      resolveDir: fileURLToPath(new URL("./", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "qa-client",
          compatibilityDate: "2026-08-24",
          modules: [
            { type: "ESModule", path: "qa-client.mjs", contents: compiled.outputFiles[0].text },
          ],
          bindings: configuration.vars,
          serviceBindings: {
            QA_DEV_ACCESS: { name: "synthetic-services", entrypoint: "DevAccess" },
            QA_CREDIT: { name: "synthetic-services", entrypoint: "Credit" },
            QA_SCOPED_DATABASE: { name: "synthetic-services", entrypoint: "ScopedDatabase" },
          },
        },
        {
          name: "synthetic-services",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "synthetic-services.mjs",
              contents: `
          import { WorkerEntrypoint } from 'cloudflare:workers';
          export class DevAccess extends WorkerEntrypoint {
            authorizeDevAccessSession(input) { return input.projectId === ${JSON.stringify(scope.projectId)} && input.devAccessEpoch === 1; }
          }
          export class Credit extends WorkerEntrypoint {
            read(input) { return { organizationId: input.organizationId, projectId: input.projectId,
              environmentId: input.environmentId, allowed: true, paidAllowed: true, reason: null,
              checkedAt: input.now, expiresAt: '2026-11-14T12:01:00.000Z' }; }
          }
          export class ScopedDatabase extends WorkerEntrypoint {
            execute(call) {
              if (call.platform !== 'development' || JSON.stringify(call.scope) !== ${JSON.stringify(JSON.stringify(scope))}
                || call.operation !== 'query') throw new Error('scope_not_authorized');
              return { command: 'SELECT', rowCount: 1,
                rows: [{ fixedProject: call.scope.projectId, value: call.input.values[0] }] };
            }
          }
          export default { fetch() { return new Response(null, {status:404}); } };`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const response = await runtime.dispatchFetch("http://preview.capabilities/database/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-project-id": id(99) },
      body: encodeValue({ text: "SELECT $1", values: ["bound"] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(decodeValue(await response.text()), {
      command: "SELECT",
      rowCount: 1,
      rows: [{ fixedProject: scope.projectId, value: "bound" }],
    });
  } finally {
    await runtime.dispose();
  }
}

test("Development bindings target the trusted executor while live QA scopes remain unverified", () => {
  const manifest = makeManifest();
  const configuration = buildQaBindings(manifest);
  assert.equal(configuration.services.length, 3);
  assert.deepEqual(configuration.activation, {
    allowed: false,
    blocker: "qa_live_scopes_unverified",
  });
  assert.deepEqual(configuration.services[2], {
    binding: "QA_SCOPED_DATABASE",
    service: "ohmyho-project-database-development-eu",
    entrypoint: "ProjectDatabaseQa",
  });
  assert.equal(configuration.vars.SPIKE_QA_MANIFEST, JSON.stringify(manifest));
  assert.equal(configuration.databaseRuntime.vars.QA_DATABASE_MANIFEST, JSON.stringify(manifest));
  assert.deepEqual(
    configuration.databaseRuntime.services.map((binding) => binding.entrypoint),
    ["PreviewQaDatabaseAuthority", "DevAccessRuntime", "GatewayCreditRuntime"],
  );
  const changes = [
    (value) => {
      value.platform = "production";
    },
    (value) => {
      value.projects.pop();
    },
    (value) => {
      value.projects[1].fixture = value.projects[0].fixture;
    },
    (value) => {
      value.projects[1].projectId = value.projects[0].projectId;
    },
    (value) => {
      value.projects[0].region = "us";
    },
    (value) => {
      value.projects[0].origin = "https://dev-qa-0.check.omh.st";
    },
    (value) => {
      value.projects[0].extra = "unexpected";
    },
  ];
  for (const change of changes) {
    const invalid = makeManifest();
    change(invalid);
    assert.throws(() => buildQaBindings(invalid), /qa_configuration_invalid/u);
  }
});

test("scoped database requests recheck Dev authority and funding and ignore guest scope", async () => {
  const configuration = buildQaBindings(makeManifest());
  const scope = makeManifest().projects[0];
  const calls = [];
  let authorized = true;
  let funded = true;
  let foreignCreditScope = false;
  let expiredCredit = false;
  let revokeDuringQuery = false;
  const env = {
    ...configuration.vars,
    QA_DEV_ACCESS: {
      async authorizeDevAccessSession(value) {
        calls.push(["authority", value]);
        return (
          authorized &&
          value.devAccessEpoch === scope.devAccessEpoch &&
          value.principalId === scope.principalId
        );
      },
    },
    QA_CREDIT: {
      async read(value) {
        calls.push(["credit", value]);
        return {
          organizationId: scope.organizationId,
          projectId: foreignCreditScope ? id(99) : scope.projectId,
          environmentId: scope.environmentId,
          allowed: funded,
          paidAllowed: funded,
          reason: funded ? null : "insufficient_organization_credits",
          checkedAt: "2026-11-14T12:00:00.000Z",
          expiresAt: expiredCredit ? "2026-11-14T12:00:00.000Z" : "2026-11-14T12:01:00.000Z",
        };
      },
    },
    QA_SCOPED_DATABASE: {
      async execute(value) {
        if (value.scope.fixture !== scope.fixture) throw new Error("scope_not_authorized");
        assert.deepEqual(value.scope, scope);
        assert.equal(value.platform, "development");
        calls.push([value.operation, value.input]);
        if (revokeDuringQuery) authorized = false;
        return value.operation === "query"
          ? { command: "SELECT", rows: [{ answer: 42 }], rowCount: 1 }
          : [];
      },
    },
  };
  const now = () => Date.parse("2026-11-14T12:00:01.000Z");
  const request = (path = "/database/query") =>
    new Request(`http://preview.capabilities${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-project-id": id(99) },
      body: encodeValue({ text: "SELECT 42", values: [] }),
    });
  const response = await handleDatabaseRequest(request(), env, { fixture: "react-vite" }, now);
  assert.equal(response.status, 200);
  assert.deepEqual(decodeValue(await response.text()), {
    command: "SELECT",
    rows: [{ answer: 42 }],
    rowCount: 1,
  });
  assert.equal(calls[0][1].projectId, scope.projectId);
  assert.equal(calls[1][1].projectId, scope.projectId);
  assert.equal(calls[2][0], "query");

  calls.length = 0;
  assert.equal(
    (await handleDatabaseRequest(request(), env, { fixture: "not-a-fixture" }, now)).status,
    404,
  );
  assert.equal(
    (await handleDatabaseRequest(request(), env, { fixture: "react-vite", projectId: id(99) }, now))
      .status,
    404,
  );
  assert.equal(
    (await handleDatabaseRequest(request("/database/open"), env, { fixture: "react-vite" }, now))
      .status,
    404,
  );
  assert.equal(
    (await handleDatabaseRequest(request(), env, { fixture: "vanilla-vite" }, now)).status,
    503,
  );
  assert.equal(
    calls.some(([kind]) => kind === "query" || kind === "transaction"),
    false,
  );
  calls.length = 0;
  authorized = false;
  assert.equal(
    (await handleDatabaseRequest(request(), env, { fixture: "react-vite" }, now)).status,
    403,
  );
  assert.equal(
    calls.some(([kind]) => kind === "query" || kind === "transaction"),
    false,
  );
  calls.length = 0;
  authorized = true;
  funded = false;
  assert.equal(
    (await handleDatabaseRequest(request(), env, { fixture: "react-vite" }, now)).status,
    403,
  );
  assert.equal(
    calls.some(([kind]) => kind === "query" || kind === "transaction"),
    false,
  );
  funded = true;
  foreignCreditScope = true;
  calls.length = 0;
  assert.equal(
    (await handleDatabaseRequest(request(), env, { fixture: "react-vite" }, now)).status,
    503,
  );
  assert.equal(
    calls.some(([kind]) => kind === "query" || kind === "transaction"),
    false,
  );
  foreignCreditScope = false;
  expiredCredit = true;
  calls.length = 0;
  assert.equal(
    (await handleDatabaseRequest(request(), env, { fixture: "react-vite" }, now)).status,
    503,
  );
  assert.equal(
    calls.some(([kind]) => kind === "query" || kind === "transaction"),
    false,
  );
  expiredCredit = false;

  const stale = makeManifest();
  stale.projects[0].devAccessEpoch += 1;
  const staleEnv = { ...env, ...buildQaBindings(stale).vars };
  calls.length = 0;
  assert.equal(
    (await handleDatabaseRequest(request(), staleEnv, { fixture: "react-vite" }, now)).status,
    403,
  );
  assert.equal(
    calls.some(([kind]) => kind === "query" || kind === "transaction"),
    false,
  );

  const injected = new Request("http://preview.capabilities/database/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeValue({ text: "SELECT 42", values: [], projectId: id(99) }),
  });
  calls.length = 0;
  assert.equal(
    (await handleDatabaseRequest(injected, env, { fixture: "react-vite" }, now)).status,
    400,
  );
  assert.equal(calls.length, 0);
  const invalidTransaction = new Request("http://preview.capabilities/database/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeValue([{ text: "SELECT 42", values: [], organizationId: id(99) }]),
  });
  assert.equal(
    (await handleDatabaseRequest(invalidTransaction, env, { fixture: "react-vite" }, now)).status,
    400,
  );
  assert.equal(calls.length, 0);
  const parameter = "'); DROP TABLE preview_notes; --";
  const boundParameter = new Request("http://preview.capabilities/database/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeValue({ text: "SELECT $1 AS value", values: [parameter] }),
  });
  assert.equal(
    (await handleDatabaseRequest(boundParameter, env, { fixture: "react-vite" }, now)).status,
    200,
  );
  assert.deepEqual(calls.find(([kind]) => kind === "query")[1], {
    text: "SELECT $1 AS value",
    values: [parameter],
  });

  calls.length = 0;
  revokeDuringQuery = true;
  const revoked = await handleDatabaseRequest(request(), env, { fixture: "react-vite" }, now);
  assert.equal(revoked.status, 409);
  assert.deepEqual(await revoked.json(), {
    error: "qa_database_outcome_unknown",
    outcome: "unknown",
    retryable: false,
  });
  assert.equal(calls.filter(([kind]) => kind === "query").length, 1);
  await checkWorkerdRpc(configuration, scope);
});

test("tagged wire preserves typed values and rejects ambiguous or oversized input", () => {
  const value = {
    date: new Date("2026-01-01T00:00:00.000Z"),
    bytes: new Uint8Array([0, 255]),
    nested: [null, true, 2],
  };
  assert.deepEqual(decodeValue(encodeValue(value)), value);
  for (const input of [
    "not-json",
    '["unknown",null]',
    '["object",[["x",["number",1]],["x",["number",2]]]]',
    "x".repeat(2 * 1024 * 1024 + 1),
  ]) {
    assert.throws(() => decodeValue(input), /qa_transport_invalid/u);
  }
});

test("static database bindings and manifest flags cannot replace the scoped executor", async () => {
  let executions = 0;
  const configuration = buildQaBindings(makeManifest());
  const env = {
    ...configuration.vars,
    QA_DATABASE_BINDINGS_VERIFIED: true,
    QA_DEV_ACCESS: { authorizeDevAccessSession: async () => true },
    QA_CREDIT: {
      read: async (value) => ({
        ...value,
        allowed: true,
        paidAllowed: true,
        reason: null,
        checkedAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    },
    ...Object.fromEntries(
      QA_FIXTURES.map((_, index) => [
        `QA_DATABASE_${index}`,
        {
          identity: async () => makeManifest().projects[index],
          query: async () => {
            executions += 1;
          },
          transaction: async () => {
            executions += 1;
          },
        },
      ]),
    ),
  };
  for (const fixture of QA_FIXTURES) {
    const response = await handleDatabaseRequest(
      new Request("http://preview.capabilities/database/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeValue({ text: "INSERT INTO notes VALUES (1)", values: [] }),
      }),
      env,
      { fixture },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "qa_capability_unavailable" });
  }
  assert.equal(executions, 0);
});

test("post-dispatch database failures and a stalled executor remain unknown without replay", async () => {
  const scope = makeManifest().projects[0];
  const now = () => Date.parse("2026-11-14T12:00:01.000Z");
  for (const operation of ["query", "transaction"]) {
    for (const fault of ["revoked", "credit-failed", "lost-reply", "invalid-result"]) {
      let committed = 0;
      const env = {
        ...buildQaBindings(makeManifest()).vars,
        QA_DEV_ACCESS: {
          authorizeDevAccessSession: async () => fault !== "revoked" || committed === 0,
        },
        QA_CREDIT: {
          read: async () => {
            if (fault === "credit-failed" && committed) throw new Error("private credit error");
            return {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              allowed: true,
              paidAllowed: true,
              reason: null,
              checkedAt: "2026-11-14T12:00:00.000Z",
              expiresAt: "2026-11-14T12:01:00.000Z",
            };
          },
        },
        QA_SCOPED_DATABASE: {
          execute: async (call) => {
            assert.equal(call.operation, operation);
            assert.deepEqual(call.scope, scope);
            committed += 1;
            if (fault === "lost-reply") throw new Error("private committed SQL");
            if (fault === "invalid-result") return { unsupported: undefined };
            return { privateRows: "must never return" };
          },
        },
      };
      const statement = { text: "INSERT INTO notes VALUES (1)", values: [] };
      const response = await handleDatabaseRequest(
        new Request(`http://preview.capabilities/database/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeValue(operation === "query" ? statement : [statement]),
        }),
        env,
        { fixture: scope.fixture },
        now,
      );
      assert.equal(response.status, 409, `${operation}/${fault}`);
      assert.deepEqual(await response.json(), {
        error: "qa_database_outcome_unknown",
        outcome: "unknown",
        retryable: false,
      });
      assert.equal(committed, 1, `${operation}/${fault}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), null);
    }
  }
  const stalled = {
    ...buildQaBindings(makeManifest()).vars,
    QA_DEV_ACCESS: { authorizeDevAccessSession: async () => true },
    QA_CREDIT: {
      read: async () => ({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        allowed: true,
        paidAllowed: true,
        reason: null,
        checkedAt: "2026-11-14T12:00:00.000Z",
        expiresAt: "2026-11-14T12:01:00.000Z",
      }),
    },
    QA_SCOPED_DATABASE: { execute: () => new Promise(() => undefined) },
  };
  const response = await handleDatabaseRequest(
    new Request("http://preview.capabilities/database/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeValue({ text: "INSERT INTO notes VALUES (1)", values: [] }),
    }),
    stalled,
    { fixture: scope.fixture },
    now,
    25,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "qa_database_outcome_unknown",
    outcome: "unknown",
    retryable: false,
  });
});

test("the guest transport preserves unknown outcomes as non-retryable SQLSTATE for the actual customer SDK", async () => {
  const { callDatabase } = await import("./transport.mjs");
  const sdk = await build({
    entryPoints: [
      fileURLToPath(new URL("../../../packages/customer-runtime/src/database.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { createPrivateDatabaseClient } = await import(
    `data:text/javascript;base64,${Buffer.from(sdk.outputFiles[0].text).toString("base64")}`
  );
  const statement = { text: "SELECT 42", values: [] };
  const expected = { command: "SELECT", rows: [{ answer: 42 }], rowCount: 1 };
  assert.deepEqual(
    await callDatabase("query", statement, async () => new Response(encodeValue(expected))),
    expected,
  );
  assert.deepEqual(
    await callDatabase(
      "transaction",
      [statement],
      async () => new Response(encodeValue([expected])),
    ),
    [expected],
  );
  await assert.rejects(
    () =>
      callDatabase("open", statement, async () => {
        throw new Error("must not dispatch");
      }),
    /project_database_unavailable/u,
  );
  await assert.rejects(
    () =>
      callDatabase("query", statement, async () =>
        Response.json({ error: "qa_capability_unavailable" }, { status: 403 }),
      ),
    /project_database_unavailable/u,
  );
  const unknown = { error: "qa_database_outcome_unknown", outcome: "unknown", retryable: false };
  for (const fault of ["unknown-response", "lost-reply", "invalid-result", "proxy-error"]) {
    let dispatches = 0;
    const fetcher = async () => {
      dispatches += 1;
      if (fault === "lost-reply") throw new Error("private lost reply after commit");
      if (fault === "invalid-result") return new Response("invalid transport");
      if (fault === "proxy-error") return new Response("upstream unavailable", { status: 502 });
      return Response.json(unknown, { status: 409 });
    };
    const database = createPrivateDatabaseClient({
      query: (input) => callDatabase("query", input, fetcher),
      transaction: (input) => callDatabase("transaction", input, fetcher),
    });
    const query = { text: "INSERT INTO notes VALUES (1)", values: [] };
    for (const action of [() => database.query(query), () => database.transaction([query])]) {
      await assert.rejects(action, (error) => {
        assert.equal(error.code, "08007", fault);
        assert.equal(error.retryable, false, fault);
        assert.doesNotMatch(String(error), /private/);
        return true;
      });
    }
    assert.equal(dispatches, 2, fault);
  }
});

test("database body reads bound chunks, total time and abort without waiting for cancel", async (t) => {
  const queryBytes = new TextEncoder().encode(encodeValue({ text: "SELECT 42", values: [] }));
  function environment() {
    const calls = [];
    const scope = makeManifest().projects[0];
    return {
      calls,
      env: {
        ...buildQaBindings(makeManifest()).vars,
        QA_DEV_ACCESS: {
          authorizeDevAccessSession: async () => {
            calls.push("admission");
            return true;
          },
        },
        QA_CREDIT: {
          read: async () => ({
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            allowed: true,
            paidAllowed: true,
            reason: null,
            checkedAt: "2026-11-14T12:00:00.000Z",
            expiresAt: "2026-11-14T12:01:00.000Z",
          }),
        },
        QA_SCOPED_DATABASE: {
          execute: async () => {
            calls.push("execute");
            return null;
          },
        },
      },
    };
  }
  function invoke(body, env, signal) {
    return handleDatabaseRequest(
      new Request("http://preview.capabilities/database/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
        signal,
      }),
      env,
      { fixture: "react-vite" },
      () => Date.parse("2026-11-14T12:00:01.000Z"),
    );
  }
  await t.test("too many empty chunks cannot smuggle a valid query to the executor", async () => {
    const { calls, env } = environment();
    let chunk = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunk++ < 2000) controller.enqueue(new Uint8Array());
        else {
          controller.enqueue(queryBytes);
          controller.close();
        }
      },
    });
    const response = await invoke(stream, env);
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
    assert.equal(stream.locked, false);
  });
  await t.test(
    "oversized chunks return despite an underlying cancel that never settles",
    async () => {
      const { calls, env } = environment();
      let canceled = 0,
        response;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        },
        cancel() {
          canceled += 1;
          return new Promise(() => {});
        },
      });
      void invoke(stream, env).then((value) => {
        response = value;
      });
      await setImmediate();
      assert.equal(response?.status, 400);
      assert.equal(canceled, 1);
      assert.deepEqual(calls, []);
      assert.equal(stream.locked, false);
    },
  );
  await t.test("a stalled body has one total deadline and never awaits cancel", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls, env } = environment();
    let canceled = 0,
      controller,
      response;
    const stream = new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        canceled += 1;
        return new Promise(() => {});
      },
    });
    void invoke(stream, env).then((value) => {
      response = value;
    });
    await setImmediate();
    context.mock.timers.tick(14_999);
    controller.enqueue(new Uint8Array());
    await setImmediate();
    assert.equal(response, undefined);
    context.mock.timers.tick(1);
    await setImmediate();
    assert.equal(response?.status, 400);
    assert.equal(canceled, 1);
    assert.deepEqual(calls, []);
    assert.equal(stream.locked, false);
  });
  await t.test("abort during admission still cannot dispatch a completed body", async () => {
    const { calls, env } = environment();
    const controller = new AbortController();
    const readCredit = env.QA_CREDIT.read;
    env.QA_CREDIT.read = async () => {
      controller.abort();
      return readCredit();
    };
    const response = await invoke(queryBytes, env, controller.signal);
    assert.equal(response.status, 400);
    assert.deepEqual(calls, ["admission"]);
  });
  for (const when of ["before-read", "during-read"]) {
    await t.test(`abort ${when} stops the reader and cannot dispatch`, async () => {
      const { calls, env } = environment();
      const controller = new AbortController();
      let canceled = 0,
        response;
      const stream = new ReadableStream({
        cancel() {
          canceled += 1;
          return new Promise(() => {});
        },
      });
      if (when === "before-read") controller.abort();
      void invoke(stream, env, controller.signal).then((value) => {
        response = value;
      });
      await setImmediate();
      if (when === "during-read") controller.abort();
      await setImmediate();
      assert.equal(response?.status, 400);
      assert.equal(canceled, 1);
      assert.deepEqual(calls, []);
      assert.equal(stream.locked, false);
    });
  }
});
