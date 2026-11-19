import { OrganizationCreditError } from "@ohmyhost/database";
import { describe, expect, it, vi } from "vitest";

import {
  createControlApi,
  createUnavailableProductSurfacePort,
  IdempotencyKeyReusedError,
  ProductSurfaceConflictError,
  type ControlApiDependencies,
} from "../src/index.js";
import type { CreditManagementPort } from "../src/credits.js";
import { createProjectDatabaseWritePort } from "../src/project-database-write.js";
import {
  API,
  BEARER,
  JSON_BEARER,
  NOW,
  OPERATION_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  PRINCIPAL,
  creditBudgetBody,
  recordingReporter,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

const PROJECT = `${API}/v1/projects/${PROJECT_ID}`;
const ETAG = `"sha256-${"a".repeat(64)}"`;
const OPERATION = { id: OPERATION_ID, state: "queued", created_at: NOW, updated_at: NOW };

describe("POST /v1/projects/:project_id/data-changes", () => {
  const apply = (
    app: ReturnType<typeof createControlApi>,
    body: unknown = { change: "reset_dev" },
    headers: Record<string, string> = {},
  ) =>
    app.request(`${PROJECT}/data-changes`, {
      method: "POST",
      headers: {
        ...JSON_BEARER,
        "Idempotency-Key": "change-1",
        "If-Match": ETAG,
        "X-Confirmation-Token": "t".repeat(43),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const surface = (changeData: unknown) =>
    ({
      ...createUnavailableProductSurfacePort(),
      changeData,
    }) as ControlApiDependencies["productSurface"];

  it("applies a confirmed data change as one guarded operation", async () => {
    const changeData = vi.fn(async () => ({
      status: 202 as const,
      location: `/v1/operations/${OPERATION_ID}`,
      body: OPERATION,
    }));
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      routeDependencies({ productSurface: surface(changeData), authorization: { check } }),
    );

    const response = await apply(app, { change: "isolate_prod_keeps_data" });

    expect(response.status, await response.clone().text()).toBe(202);
    expect(response.headers.get("Location")).toBe(`/v1/operations/${OPERATION_ID}`);
    expect(await response.json()).toEqual(OPERATION);
    expect(changeData).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:user_1",
      requestId: "req_fixture",
      idempotencyKey: "change-1",
      canonicalRequestDigest: expect.any(Uint8Array),
      ifMatch: ETAG,
      confirmationToken: "t".repeat(43),
      change: "isolate_prod_keeps_data",
    });
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ action: "projects:delete" }));
  });

  it("refuses unknown change kinds, extra fields and missing guards before the port", async () => {
    const changeData = vi.fn();
    const app = createControlApi(routeDependencies({ productSurface: surface(changeData) }));
    for (const body of [{ change: "reset_prod" }, { change: "reset_dev", force: true }, {}]) {
      const response = await apply(app, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        detail: expect.stringContaining("Supply change:"),
      });
    }
    expect((await apply(app, undefined, { "Idempotency-Key": "" })).status).toBe(400);
    expect((await apply(app, undefined, { "If-Match": "" })).status).toBe(400);
    expect((await apply(app, undefined, { "X-Confirmation-Token": "short" })).status).toBe(400);
    expect(
      (await apply(app, undefined, { "X-Confirmation-Token": `${"t".repeat(40)} !!` })).status,
    ).toBe(400);
    expect(changeData).not.toHaveBeenCalled();
  });

  it("reports a stale or blocked change as a conflict and an unsupported store as unavailable", async () => {
    const conflict = createControlApi(
      routeDependencies({
        productSurface: surface(async () => {
          throw new ProductSurfaceConflictError("data_change_in_progress");
        }),
      }),
    );
    const blocked = await apply(conflict);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "data_change_in_progress" });

    const unsupported = createControlApi(
      routeDependencies({
        productSurface: createUnavailableProductSurfacePort(),
      }),
    );
    expect((await apply(unsupported)).status).toBe(503);
    const hidden = createControlApi(
      routeDependencies({
        productSurface: surface(async () => null),
      }),
    );
    expect((await apply(hidden)).status).toBe(404);
  });
});

describe("project credit budget", () => {
  const budgetPort = (overrides: Partial<CreditManagementPort> = {}): CreditManagementPort =>
    ({
      readBudget: vi.fn(async () => ({ status: 200 as const, body: creditBudgetBody() as never })),
      setBudget: vi.fn(async () => ({ status: 200 as const, body: creditBudgetBody() })),
      readOrganization: vi.fn(),
      readUsage: vi.fn(),
      readAccount: vi.fn(),
      ...overrides,
    }) as CreditManagementPort;
  const read = (app: ReturnType<typeof createControlApi>) =>
    app.request(`${PROJECT}/credit-budget`, { headers: BEARER });
  const write = (
    app: ReturnType<typeof createControlApi>,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${PROJECT}/credit-budget`, {
      method: "PUT",
      headers: { ...JSON_BEARER, "Idempotency-Key": "budget-1", ...headers },
      body: JSON.stringify(body),
    });

  it("reads the project budget through the credit port under the project write permission", async () => {
    const credits = budgetPort();
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(routeDependencies({ credits, authorization: { check } }));

    const response = await read(app);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(creditBudgetBody());
    expect(credits.readBudget).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:user_1",
      requestId: "req_fixture",
    });
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "project", organizationId: ORGANIZATION_ID, projectId: PROJECT_ID },
      action: "projects:write",
    });
  });

  it("returns an unset budget as continue without an amount", async () => {
    const unset = {
      ...creditBudgetBody(),
      amount_micros: null,
      mode: "continue",
    };
    const app = createControlApi(
      routeDependencies({
        credits: budgetPort({ readBudget: async () => ({ status: 200, body: unset as never }) }),
      }),
    );
    const response = await read(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unset);
  });

  it("fails closed on a budget that violates the contract and on a missing credit store", async () => {
    const { reports, reporter } = recordingReporter();
    for (const broken of [
      { ...creditBudgetBody(), mode: "pause" },
      { ...creditBudgetBody(), amount_micros: null, mode: "stop" },
      { ...creditBudgetBody(), amount_micros: "-5" },
      { ...creditBudgetBody(), used_micros: 600 },
      { ...creditBudgetBody(), period_start: "September" },
      { ...creditBudgetBody(), project_id: "invalid" },
      { ...creditBudgetBody(), extra: true },
      "not a budget",
    ]) {
      const app = createControlApi(
        routeDependencies({
          reporter,
          credits: budgetPort({ readBudget: async () => ({ status: 200, body: broken as never }) }),
        }),
      );
      const response = await read(app);
      expect(response.status, JSON.stringify(broken)).toBe(503);
      expect(await response.json()).toMatchObject({ code: "service_unavailable" });
    }
    const missing = await read(createControlApi(routeDependencies({ reporter })));
    expect(missing.status).toBe(503);
    expect(reports.every((entry) => entry.code === "PRODUCT_SURFACE_UNAVAILABLE")).toBe(true);
    expect(reports).toHaveLength(9);
  });

  it("answers a budget write on a project that is leaving as a non-retryable 404, never a 503", async () => {
    const app = createControlApi(
      routeDependencies({ credits: budgetPort({ setBudget: async () => null }) }),
    );
    const response = await write(app, { amount_micros: "5000000", mode: "stop" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "resource_not_found", retryable: false });
  });

  it("sets a stop budget, then an unlimited continue budget, with the caller's idempotency key", async () => {
    const credits = budgetPort();
    const app = createControlApi(routeDependencies({ credits }));

    const stop = await write(app, { amount_micros: "5000000", mode: "stop" });
    expect(stop.status, await stop.clone().text()).toBe(200);
    expect(await stop.json()).toEqual(creditBudgetBody());
    expect(credits.setBudget).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:user_1",
      requestId: "req_fixture",
      idempotencyKey: "budget-1",
      canonicalRequestDigest: expect.any(Uint8Array),
      amountMicros: "5000000",
      mode: "stop",
    });
    await write(app, { amount_micros: null, mode: "continue" });
    expect(credits.setBudget).toHaveBeenLastCalledWith(
      expect.objectContaining({ amountMicros: null, mode: "continue" }),
    );
    await write(app, { amount_micros: "0", mode: "stop" });
    expect(credits.setBudget).toHaveBeenLastCalledWith(
      expect.objectContaining({ amountMicros: "0", mode: "stop" }),
    );
    await write(app, { amount_micros: "9007199254740991", mode: "continue" });
    expect(credits.setBudget).toHaveBeenLastCalledWith(
      expect.objectContaining({ amountMicros: "9007199254740991" }),
    );
  });

  it.each([
    ["a numeric amount", { amount_micros: 5, mode: "stop" }],
    ["a leading zero", { amount_micros: "05", mode: "stop" }],
    ["a negative amount", { amount_micros: "-1", mode: "stop" }],
    ["a decimal amount", { amount_micros: "1.5", mode: "stop" }],
    [
      "an amount above the exact integer limit of the Core",
      { amount_micros: "9007199254740992", mode: "stop" },
    ],
    [
      "an amount above the signed 64-bit limit",
      { amount_micros: "9223372036854775808", mode: "stop" },
    ],
    ["a stop budget without an amount", { amount_micros: null, mode: "stop" }],
    ["an unknown mode", { amount_micros: "1", mode: "pause" }],
    ["a missing mode", { amount_micros: "1" }],
    ["a missing amount", { mode: "continue" }],
    ["an extra field", { amount_micros: "1", mode: "stop", currency: "usd" }],
  ])("rejects %s without calling the credit store", async (_name, body) => {
    const credits = budgetPort();
    const response = await write(createControlApi(routeDependencies({ credits })), body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: "Request fields are invalid." });
    expect(credits.setBudget).not.toHaveBeenCalled();
  });

  it("requires an idempotency key and maps replay conflicts and an unavailable store", async () => {
    const credits = budgetPort();
    const app = createControlApi(routeDependencies({ credits }));
    expect(
      (await write(app, { amount_micros: "1", mode: "stop" }, { "Idempotency-Key": "" })).status,
    ).toBe(400);
    expect(credits.setBudget).not.toHaveBeenCalled();

    const failures: unknown[] = [
      new OrganizationCreditError("credit_request_conflict"),
      new IdempotencyKeyReusedError(),
      new Error("d1-private-canary"),
    ];
    const failing = createControlApi(
      routeDependencies({
        credits: budgetPort({
          setBudget: async () => {
            throw failures.shift();
          },
        }),
      }),
    );
    const request = { amount_micros: "1", mode: "stop" };
    const conflict = await write(failing, request);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "idempotency_key_reused",
      detail: "The idempotency key belongs to a different budget request.",
    });
    const reused = await write(failing, request);
    expect(reused.status).toBe(409);
    const unavailable = await write(failing, request);
    const text = await unavailable.text();
    expect(unavailable.status).toBe(503);
    expect(text).not.toContain("d1-private-canary");
    const missing = await write(createControlApi(routeDependencies()), request);
    expect(missing.status).toBe(503);
  });

  it("returns the indistinguishable 404 to a caller without project write permission", async () => {
    const credits = budgetPort();
    const app = createControlApi(
      routeDependencies({ credits, authorization: { check: async () => "deny" } }),
    );
    expect((await read(app)).status).toBe(404);
    expect((await write(app, { amount_micros: "1", mode: "stop" })).status).toBe(404);
    expect(credits.readBudget).not.toHaveBeenCalled();
    expect(credits.setBudget).not.toHaveBeenCalled();
  });
});

describe("GET /v1/project-handles/:handle", () => {
  const check = (
    app: ReturnType<typeof createControlApi>,
    handle: string,
    headers: Record<string, string> = {},
  ) => app.request(`${API}/v1/project-handles/${handle}`, { headers: { ...BEARER, ...headers } });
  const handlesApp = (
    takenProjectHandles: ControlApiDependencies["persistence"]["takenProjectHandles"],
    overrides: Partial<ControlApiDependencies> = {},
  ) => {
    const base = routeDependencies();
    return createControlApi(
      routeDependencies({
        persistence: { ...base.persistence, takenProjectHandles },
        ...overrides,
      }),
    );
  };

  it("confirms a free well-formed handle without offering alternatives", async () => {
    const taken = vi.fn(async () => new Set<string>());
    const response = await check(handlesApp(taken), "calm-otter-waves");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      handle: "calm-otter-waves",
      available: true,
      alternatives: [],
    });
    expect(taken).toHaveBeenCalledOnce();
    expect(taken).toHaveBeenCalledWith(["calm-otter-waves"]);
  });

  it("offers at most five free alternatives for a taken handle, skipping those already held", async () => {
    const calls: (readonly string[])[] = [];
    const app = handlesApp(async (candidates) => {
      calls.push(candidates);
      return calls.length === 1
        ? new Set(candidates)
        : new Set(candidates.filter((candidate) => candidate === "calm-otter-waves-2"));
    });

    const response = await check(app, "calm-otter-waves");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ handle: "calm-otter-waves", available: false, reason: "taken" });
    expect(body.alternatives).toHaveLength(5);
    expect(body.alternatives).not.toContain("calm-otter-waves");
    expect(body.alternatives).not.toContain("calm-otter-waves-2");
    expect(body.alternatives[0]).toBe("calm-otter-waves-3");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(16);
    expect(calls[1]).not.toContain("calm-otter-waves");
  });

  it("names the reason a handle is unusable even when nobody holds it", async () => {
    const app = handlesApp(async () => new Set<string>());
    for (const [handle, reason] of [
      ["ab", "too_short"],
      ["a".repeat(60), "too_long"],
      ["Not%20A%20Handle", "invalid_shape"],
      ["under_score", "invalid_shape"],
    ] as const) {
      const response = await check(app, handle);
      expect(response.status, handle).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ available: false, reason });
      expect(body.alternatives.length).toBeGreaterThan(0);
      expect(body.alternatives.length).toBeLessThanOrEqual(5);
    }
  });

  it("rejects an absent, oversized or control-character handle", async () => {
    const taken = vi.fn(async () => new Set<string>());
    const app = handlesApp(taken);
    for (const handle of ["x".repeat(121), "bad%00handle"]) {
      const response = await check(app, handle);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ detail: "A handle is required." });
    }
    expect((await check(app, "calm-otter", { "X-Request-Id": "r".repeat(129) })).status).toBe(400);
    expect(taken).not.toHaveBeenCalled();
  });

  it("reports an unreachable handle registry once instead of guessing", async () => {
    const { reports, reporter } = recordingReporter();
    const first = handlesApp(
      async () => {
        throw new Error("d1-private-canary");
      },
      { reporter },
    );
    const response = await check(first, "calm-otter-waves");
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: "service_unavailable", retryable: true });
    expect(text).not.toContain("d1-private-canary");

    let calls = 0;
    const second = handlesApp(
      async (candidates) => {
        if (++calls === 1) return new Set(candidates);
        throw new Error("d1-private-canary");
      },
      { reporter },
    );
    expect((await check(second, "calm-otter-waves")).status).toBe(503);
    expect(reports.map((entry) => entry.code)).toEqual([
      "PROJECT_HANDLE_LOOKUP_FAILED",
      "PROJECT_HANDLE_LOOKUP_FAILED",
    ]);
  });

  it("requires authentication and honours the rate limits", async () => {
    const taken = vi.fn(async () => new Set<string>());
    const { reports, reporter } = recordingReporter();
    const anonymous = await handlesApp(taken).request(`${API}/v1/project-handles/calm-otter`);
    expect(anonymous.status).toBe(401);
    const down = await check(
      handlesApp(taken, {
        reporter,
        authentication: {
          authenticate: async () => {
            throw new Error("identity provider offline");
          },
        },
      }),
      "calm-otter",
    );
    expect(down.status).toBe(503);
    expect(reports.map((entry) => entry.code)).toEqual(["AUTHENTICATION_UNAVAILABLE"]);
    const limited = await check(
      handlesApp(taken, {
        rateLimits: {
          consume: async ({ dimension }) =>
            dimension === "actor" ? { allowed: false, retryAfterSeconds: 8 } : { allowed: true },
        },
      }),
      "calm-otter",
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("8");
    const throttled = await check(
      handlesApp(taken, {
        rateLimits: { consume: async () => ({ allowed: false, retryAfterSeconds: 1 }) },
      }),
      "calm-otter",
    );
    expect(throttled.status).toBe(429);
    expect(taken).not.toHaveBeenCalled();
  });
});

describe("POST /v1/projects/:project_id/database/write", () => {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    operation_id: OPERATION_ID,
    environment: "dev",
    state: "succeeded",
    command: "UPDATE",
    affected_rows: 2,
    error: null,
    ...overrides,
  });
  const request = {
    environment: "dev",
    statement: "UPDATE visits SET count = count + 1 WHERE id = $1",
    parameters: [7],
  };
  const writeApp = (writeProject: (input: never) => Promise<unknown>) =>
    createControlApi(
      routeDependencies({
        projectDatabaseWrite: createProjectDatabaseWritePort({ writeProject }),
      }),
    );
  const write = (
    app: ReturnType<typeof createControlApi>,
    body: unknown = request,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${PROJECT}/database/write`, {
      method: "POST",
      headers: { ...JSON_BEARER, "Idempotency-Key": "write-1", ...headers },
      body: JSON.stringify(body),
    });

  it("runs one DML statement and returns its receipt with the operation location", async () => {
    const writeProject = vi.fn(async () => receipt());
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      routeDependencies({
        authorization: { check },
        projectDatabaseWrite: createProjectDatabaseWritePort({ writeProject }),
      }),
    );

    const response = await write(app);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Location")).toBe(`/v1/operations/${OPERATION_ID}`);
    expect(await response.json()).toEqual(receipt());
    expect(writeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        idempotencyKey: "write-1",
        environment: "dev",
        statement: request.statement,
        parameters: [7],
      }),
    );
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ action: "projects:write" }));
  });

  it("answers 202 while the statement is still running", async () => {
    const response = await write(
      writeApp(async () => receipt({ state: "running", command: null, affected_rows: null })),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toBe(`/v1/operations/${OPERATION_ID}`);
  });

  it.each([
    ["a SELECT statement", { ...request, statement: "SELECT 1" }],
    ["another environment name", { ...request, environment: "staging" }],
    ["a statement with a NUL byte", { ...request, statement: "DELETE FROM visits\0" }],
    ["too many parameters", { ...request, parameters: Array(101).fill(1) }],
    ["parameters that are not a list", { ...request, parameters: { a: 1 } }],
    ["an extra field", { ...request, timeout: 5 }],
    [
      "a statement over 64 KiB",
      { ...request, statement: `UPDATE t SET a = '${"x".repeat(65_536)}'` },
    ],
  ])("rejects %s before the write port", async (_name, body) => {
    const writeProject = vi.fn(async () => receipt());
    const response = await write(writeApp(writeProject), body);
    expect([400, 413]).toContain(response.status);
    expect(writeProject).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key and the write port", async () => {
    const writeProject = vi.fn(async () => receipt());
    const missing = await write(writeApp(writeProject), request, { "Idempotency-Key": "" });
    expect(missing.status).toBe(400);
    expect(writeProject).not.toHaveBeenCalled();
    const notComposed = await write(createControlApi(routeDependencies()));
    expect(notComposed.status).toBe(503);
  });

  it("maps scope, replay, pending and budget outcomes of the write service", async () => {
    const answer = (value: unknown) => write(writeApp(async () => value));
    expect((await answer({ status: "rejected", code: "scope" })).status).toBe(404);
    const reused = await answer({ status: "rejected", code: "idempotency" });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "idempotency_key_reused" });
    const pending = await answer({ status: "rejected", code: "pending" });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: "database_write_pending" });
    const exhausted = await answer({ status: "rejected", code: "project_budget_exceeded" });
    expect(exhausted.status).toBe(402);
    expect(await exhausted.json()).toMatchObject({ code: "project_budget_exceeded" });
    const noCredits = await answer({
      status: "rejected",
      code: "insufficient_organization_credits",
    });
    expect(noCredits.status).toBe(402);
    const invalid = await answer({ operation_id: "bad" });
    expect(invalid.status).toBe(503);
    const wrongEnvironment = await answer(receipt({ environment: "prod" }));
    expect(wrongEnvironment.status).toBe(503);
  });
});
