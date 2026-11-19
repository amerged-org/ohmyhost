import { expect, it } from "vitest";

import { createWorkosCurrentIdentity } from "../src/current-identity.js";
import { createPrivateServiceBindingHandler } from "../src/service-binding.js";
import { createWorkosManagementWorkerRuntime } from "../src/worker-runtime.js";
import { FixtureDatabase, FixedIds, FixedOrganizationIds, SequenceClock } from "./fixtures.js";

it("reads only verified current identity metadata through the private binding and fails closed", async () => {
  const credential = "private-management-test-credential";
  const calls: Request[] = [];
  let failure: ((request: Request) => Response | Promise<Response>) | undefined;
  const runtime = createWorkosManagementWorkerRuntime({
    sessionAnswers: new Map(),
    bindings: {
      WORKOS_DEPLOYMENT: "production",
      WORKOS_MANAGEMENT_CREDENTIAL: credential,
      MANAGEMENT_ARTIFACT_SHA256: "a".repeat(64),
      CF_VERSION_METADATA: {
        id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
        tag: "a".repeat(64),
        timestamp: "2026-08-19T10:00:00.000Z",
      },
      CONTROL_RUNTIME: {},
    },
    database: new FixtureDatabase(),
    clock: new SequenceClock([new Date("2026-08-19T10:00:00.000Z")]),
    ids: new FixedIds(),
    organizationIds: new FixedOrganizationIds(),
    fetcher: async (request) => {
      calls.push(request);
      expect(request.headers.get("authorization")).toBe(`Bearer ${credential}`);
      expect(request.redirect).toBe("manual");
      expect(request.signal.aborted).toBe(false);
      if (failure) return failure(request);
      const id = new URL(request.url).pathname.split("/").at(-1);
      return Response.json(
        id?.startsWith("user_")
          ? { id, email: "signed-in@example.test", private_detail: "excluded" }
          : { id, name: `Current ${id}`, private_detail: "excluded" },
      );
    },
  });
  const request = (value: unknown, serialized = JSON.stringify(value)) =>
    new Request("https://workos-management.internal/current-identity", {
      method: "POST",
      body: serialized,
    });
  const current = { user_id: "user_current", workos_organization_ids: ["org_second", "org_first"] };
  const response = await runtime.handler.fetch(request(current));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    user_id: "user_current",
    email: "signed-in@example.test",
    organizations: [
      { workos_id: "org_second", name: "Current org_second" },
      { workos_id: "org_first", name: "Current org_first" },
    ],
  });
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/user_management/users/user_current",
    "/organizations/org_second",
    "/organizations/org_first",
  ]);
  calls.length = 0;
  const machine = await runtime.handler.fetch(
    request({ user_id: null, workos_organization_ids: ["org_machine"] }),
  );
  expect(await machine.json()).toEqual({
    user_id: null,
    email: null,
    organizations: [{ workos_id: "org_machine", name: "Current org_machine" }],
  });
  expect(calls).toHaveLength(1);
  calls.length = 0;
  const noWorkspace = await runtime.handler.fetch(
    request({ user_id: "user_current", workos_organization_ids: [] }),
  );
  expect(await noWorkspace.json()).toEqual({
    user_id: "user_current",
    email: "signed-in@example.test",
    organizations: [],
  });
  expect(calls).toHaveLength(1);
  calls.length = 0;
  const empty = await runtime.handler.fetch(
    request({ user_id: null, workos_organization_ids: [] }),
  );
  expect(await empty.json()).toEqual({ user_id: null, email: null, organizations: [] });
  expect(calls).toHaveLength(0);

  for (const invalid of [
    null,
    [],
    {},
    { ...current, extra: true },
    { ...current, user_id: "user_../../other" },
    { ...current, user_id: 1 },
    { ...current, workos_organization_ids: "org_first" },
    { ...current, workos_organization_ids: ["org_first", "org_first"] },
    { ...current, workos_organization_ids: ["org_../../other"] },
    { ...current, workos_organization_ids: [1] },
    { ...current, workos_organization_ids: Array.from({ length: 101 }, (_, i) => `org_${i}`) },
  ]) {
    const invalidResponse = await runtime.handler.fetch(request(invalid));
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({ error: { code: "invalid_request" } });
  }
  for (const body of ["not-json", "x".repeat(16_385)]) {
    expect((await runtime.handler.fetch(request(null, body))).status).toBe(400);
  }
  expect(calls).toHaveLength(0);

  for (const upstream of [
    () => Response.json({ private_detail: credential }, { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
    () => Response.json({ id: "user_wrong", email: "other@example.test" }),
    () => Response.json({ id: "user_current", email: null }),
    () => Response.json({ id: "user_current", email: "bad\n@example.test" }),
    () => Response.json({ id: "user_current", email: "bad\u200b@example.test" }),
    () => Response.json({ id: "user_current", email: "bad@example..test" }),
    () => Response.json({ id: "user_current", email: "bad@.example.test" }),
    () => Response.json({ id: "user_current", email: "bad@example" }),
    () => Response.json({ id: "user_current", email: `${"a".repeat(255)}@example.test` }),
    () => new Response("not-json"),
    () => new Response("x".repeat(32_769)),
    () =>
      Response.json(
        { id: "user_current", email: "signed-in@example.test" },
        { headers: { "content-length": "32769" } },
      ),
    () => {
      throw new Error(credential);
    },
  ]) {
    failure = upstream;
    const failed = await runtime.handler.fetch(request(current));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: { code: "service_unavailable" } });
  }
  for (const organization of [
    { id: "org_wrong", name: "Other" },
    { id: "org_machine", name: "" },
    { id: "org_machine", name: " Current workspace " },
    { id: "org_machine", name: "A\u001fB" },
    { id: "org_machine", name: "A\u007fB" },
    { id: "org_machine", name: "a".repeat(129) },
    { id: "org_machine", name: 1 },
  ]) {
    failure = () => Response.json(organization);
    const failed = await runtime.handler.fetch(
      request({ user_id: null, workos_organization_ids: ["org_machine"] }),
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: { code: "service_unavailable" } });
  }
  for (const name of ["Team 👩‍💻", "A\u200bB", "A\u2028B", "A\u2029B", "A\u0085B"]) {
    failure = () => Response.json({ id: "org_machine", name });
    const allowedName = await runtime.handler.fetch(
      request({ user_id: null, workos_organization_ids: ["org_machine"] }),
    );
    expect(allowedName.status).toBe(200);
    expect(await allowedName.json()).toEqual({
      user_id: null,
      email: null,
      organizations: [{ workos_id: "org_machine", name }],
    });
  }
  const unavailable = createPrivateServiceBindingHandler({
    rpc: {
      dispatch: async () => ({ status: 503, body: { ok: false, error: { code: "unavailable" } } }),
    },
  });
  expect((await unavailable.fetch(request(current))).status).toBe(503);
  expect(() =>
    createWorkosCurrentIdentity({ credential: "", fetcher: async () => Response.json({}) }),
  ).toThrow("unavailable");
});
