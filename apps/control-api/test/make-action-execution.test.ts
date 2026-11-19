import { expect, test, vi } from "vitest";
import { handleMakeActionExecution, parseMakeAction } from "../src/make-action-execution.js";

const organization = "01M145HEM4JWAP8KJBG92BSCGE";
const binding = "01M700GSJ36CCXDS2ZBATQ9ZFT";
const authorization = `Bearer omh_make_v1.${organization}.${binding}.${"A".repeat(43)}`;

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://dev.app.ohmyho.st/v1/make/actions/run", {
    method: "POST",
    headers: {
      authorization,
      "idempotency-key": "intent-1",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("routes only an action key and bounded server input and preserves the unknown outcome", async () => {
  const executeMakeAction = vi.fn().mockResolvedValue({ state: "uncertain" });
  const broker = { executeMakeAction };
  const invalidKey = await handleMakeActionExecution(
    request({ input: {} }, { authorization: "Bearer an-ordinary-key" }),
    broker,
  );
  const overreach = await handleMakeActionExecution(request({ input: {}, teamId: 7 }), broker);
  expect(invalidKey.status).toBe(403);
  expect(overreach.status).toBe(400);
  expect(
    parseMakeAction({
      kind: "scenario",
      scenario_id: 7,
      method: "GET",
      path_prefix: "/v1.0/me/drive/items",
    }),
  ).toEqual({ kind: "scenario", scenarioId: 7, method: "GET", pathPrefix: "/v1.0/me/drive/items" });

  expect(executeMakeAction).not.toHaveBeenCalled();

  const outcome = await handleMakeActionExecution(request({ input: { top: 1 } }), broker);
  expect(outcome.status).toBe(502);
  expect(await outcome.json()).toEqual({ state: "uncertain" });
  expect(executeMakeAction).toHaveBeenCalledWith({
    key: authorization.slice("Bearer ".length),
    idempotencyKey: "intent-1",
    input: { top: 1 },
  });
  expect(
    parseMakeAction({
      kind: "endpoint",
      app_name: "microsoft-email",
      app_version: 2,
      endpoint_name: "arbitrary-call",
    }),
  ).toBeNull();
});
