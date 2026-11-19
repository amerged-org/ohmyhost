import { expect, it, vi } from "vitest";
import { createEnvironmentSecretCipherKeyring, parseUlid } from "@ohmyhost/platform";
import type { PreviewRuntimeRecord } from "@ohmyhost/contracts/previews";
import { RuntimeSecretDeliveryPreview } from "../src/worker-main.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public constructor(
      _context: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

it("keeps real encrypted gateway keys outside the guest and fences changed scope without retry", async () => {
  const scope = {
    organizationId: "00000000000000000000000001",
    projectId: "00000000000000000000000002",
    environmentId: "00000000000000000000000003",
  };
  const fence = {
    previewId: "00000000000000000000000004",
    runtimeGeneration: 1,
    tokenGeneration: 1,
  };
  let current = {
    ...scope,
    ...fence,
    state: "ready",
    authGeneration: 1,
    assignmentVersion: 1,
    ownershipVersion: 1,
    lifecycleVersion: 1,
    billingEpochId: "epoch-1",
    targetSource: null,
  } as unknown as PreviewRuntimeRecord;
  const cipherKey = btoa("k".repeat(32));
  const key = "x".repeat(43);
  const cipher = createEnvironmentSecretCipherKeyring({
    primaryKeyBase64: cipherKey,
    currentKeyVersion: 1,
    crypto: globalThis.crypto,
  });
  const sealed = await cipher.encrypt({
    organizationId: parseUlid(scope.organizationId),
    projectId: parseUlid(scope.projectId),
    environmentId: parseUlid(scope.environmentId),
    name: "OHMYHOST_MAIL_KEY",
    value: key,
  });
  const customer = await cipher.encrypt({
    organizationId: parseUlid(scope.organizationId),
    projectId: parseUlid(scope.projectId),
    environmentId: parseUlid(scope.environmentId),
    name: "APP_MESSAGE",
    value: "synthetic customer setting",
  });
  const ai = await cipher.encrypt({
    organizationId: parseUlid(scope.organizationId),
    projectId: parseUlid(scope.projectId),
    environmentId: parseUlid(scope.environmentId),
    name: "OHMYHOST_AI_KEY",
    value: key,
  });
  const envelopes = [
    { ...scope, name: "OHMYHOST_MAIL_KEY", ...sealed, revision: 1 },
    {
      ...scope,
      name: "APP_MESSAGE",
      ...customer,
      valueSha256: await cipher.keyedDigest(
        "value",
        new TextEncoder().encode("synthetic customer setting"),
      ),
      revision: 1,
    },
    { ...scope, name: "OHMYHOST_AI_KEY", ...ai, revision: 1 },
  ];
  const gateway = vi.fn(async (request: Request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("x-ohmyhost-egress-project-id")).toBe(scope.projectId);
    expect(new URL(request.url).pathname).toBe("/v1/send");
    return Response.json({ status: "accepted" });
  });
  const forbidden = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("unexpected administrative call");
      },
    },
  );
  const bindings = {
    RUNTIME_CONFIGURATION_STATE: "configured",
    RUNTIME_SECRET_RUNTIME: forbidden,
    WFP_MANAGEMENT: forbidden,
    ENVIRONMENT_SECRET_KEY_BASE64: cipherKey,
    ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: "{}",
    ENVIRONMENT_SECRET_KEY_VERSION: "1",
    PROJECT_PREVIEW_AUTHORITY: { authorizeRuntime: vi.fn(async () => current) },
    PREVIEW_SECRET_AUTHORITY: {
      listCustomerSecretNames: vi.fn(async () => ["APP_MESSAGE"]),
      readEnvelopes: async ({ names }: { names: readonly string[] }) => ({
        preview: current,
        envelopes: envelopes.filter((envelope) => names.includes(envelope.name)),
      }),
    },
    PREVIEW_MAIL_GATEWAY: { fetch: gateway },
    PREVIEW_STORAGE_GATEWAY: { fetch: gateway },
    PREVIEW_AI_GATEWAY: { fetch: gateway },
  };
  const access = new RuntimeSecretDeliveryPreview({} as never, bindings as never);
  const request = () =>
    new Request("http://preview.capabilities/mail/v1/send", {
      method: "POST",
      body: "{}",
      headers: {
        authorization: "Bearer guest",
        cookie: "secret",
        "x-ohmyhost-egress-project-id": "foreign",
        "content-type": "application/json",
        "idempotency-key": "one-send",
      },
    });
  expect(await (await access.fetchPreview(request(), fence)).json()).toEqual({
    status: "accepted",
  });
  expect(await access.readCustomerVariables({ fence })).toEqual({
    APP_MESSAGE: "synthetic customer setting",
  });
  const customerEnvelope = envelopes[1];
  const platformEnvelope = envelopes[0];
  if (!customerEnvelope || !platformEnvelope) throw new Error("missing synthetic envelope");
  envelopes[1] = { ...customerEnvelope, valueSha256: new Uint8Array(32) };
  expect(await access.readCustomerVariables({ fence })).toEqual({
    APP_MESSAGE: "synthetic customer setting",
  });
  const damaged = new Uint8Array(customerEnvelope.ciphertext);
  damaged[0] = (damaged[0] ?? 0) ^ 1;
  envelopes[1] = { ...customerEnvelope, ciphertext: damaged };
  await expect(access.readCustomerVariables({ fence })).rejects.toMatchObject({
    code: "environment_secret_decryption_failed",
  });
  envelopes[1] = customerEnvelope;
  envelopes[0] = { ...platformEnvelope, valueSha256: new Uint8Array(32) };
  await expect(access.fetchPreview(request(), fence)).rejects.toMatchObject({
    code: "environment_secret_decryption_failed",
  });
  expect(gateway).toHaveBeenCalledTimes(1);
  envelopes[0] = platformEnvelope;
  const customerNames = Array.from(
    { length: 100 },
    (_, index) => `CUSTOMER_${String(index).padStart(3, "0")}`,
  );
  envelopes.push(
    ...(await Promise.all(
      customerNames.map(async (name) => {
        const value = `synthetic-${name}`;
        const sealed = await cipher.encrypt({
          organizationId: parseUlid(scope.organizationId),
          projectId: parseUlid(scope.projectId),
          environmentId: parseUlid(scope.environmentId),
          name,
          value,
        });
        return {
          ...scope,
          name,
          ...sealed,
          valueSha256: await cipher.keyedDigest("value", new TextEncoder().encode(value)),
          revision: 1,
        };
      }),
    )),
  );
  for (const size of [65, 100]) {
    const names = customerNames.slice(0, size);
    bindings.PREVIEW_SECRET_AUTHORITY.listCustomerSecretNames.mockResolvedValueOnce(names);
    const values = await access.readCustomerVariables({ fence });
    expect(values).toEqual(Object.fromEntries(names.map((name) => [name, `synthetic-${name}`])));
  }
  await expect(
    access.readCustomerVariables({ fence, names: ["APP_MESSAGE", ...customerNames] }),
  ).rejects.toThrow("preview_capability_unavailable");
  const disabled = new RuntimeSecretDeliveryPreview(
    {} as never,
    { ...bindings, RUNTIME_CONFIGURATION_STATE: "disabled" } as never,
  );
  expect(() => disabled.fetchPreview(request(), fence)).toThrow("delivery is disabled");
  await expect(
    access.readCustomerVariables({ fence, names: ["OHMYHOST_MAIL_KEY"] }),
  ).rejects.toThrow();
  await expect(access.readCustomerVariables({ fence, names: ["DATABASE_URL"] })).rejects.toThrow();
  gateway.mockImplementationOnce(async () => {
    current = { ...current, assignmentVersion: 2 };
    return Response.json({ status: "accepted" });
  });
  expect((await access.fetchPreview(request(), fence)).status).toBe(409);
  expect(gateway).toHaveBeenCalledTimes(2);

  // Use the existing Workers 101 adapter pattern: Node's native Response rejects status 101.
  const NativeResponse = globalThis.Response;
  class UpgradeResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      Object.defineProperty(this, "status", { value: init?.status ?? 200 });
      Object.defineProperty(this, "webSocket", { value: init?.webSocket ?? null });
    }
  }
  vi.stubGlobal("Response", UpgradeResponse);
  try {
    for (const outcome of ["allowed", "changed", "unavailable"]) {
      let accepted = false;
      const socket = {
        accept: vi.fn(() => {
          accepted = true;
        }),
        close: vi.fn(() => {
          expect(accepted).toBe(true);
        }),
      };
      bindings.PREVIEW_AI_GATEWAY.fetch = vi.fn(async (forwarded: Request) => {
        expect(forwarded.url).toBe("https://preview-gateway.internal/v1/realtime?model=voice");
        expect(forwarded.headers.get("authorization")).toBe(`Bearer ${key}`);
        expect(forwarded.headers.get("upgrade")).toBe("websocket");
        expect(forwarded.headers.has("cookie")).toBe(false);
        if (outcome === "changed")
          current = { ...current, assignmentVersion: current.assignmentVersion + 1 };
        if (outcome === "unavailable")
          bindings.PROJECT_PREVIEW_AUTHORITY.authorizeRuntime.mockRejectedValueOnce(
            new Error("Core unavailable"),
          );
        const init = {
          status: 101,
          webSocket: socket,
          headers: {
            upgrade: "websocket",
            "set-cookie": "not-forwarded=1",
            location: "https://not-forwarded.example",
          },
        };
        return new Response(null, init);
      });
      const response = await access.fetchPreview(
        new Request("http://preview.capabilities/ai/v1/realtime?model=voice", {
          headers: { upgrade: "websocket", authorization: "Bearer guest", cookie: "guest=1" },
        }),
        fence,
      );
      if (outcome === "allowed") {
        expect(response.status).toBe(101);
        expect((response as Response & { webSocket: unknown }).webSocket).toBe(socket);
        expect(response.headers.has("set-cookie") || response.headers.has("location")).toBe(false);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(socket.accept).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(409);
        expect(socket.accept).toHaveBeenCalledOnce();
        expect(socket.close).toHaveBeenCalledWith(1001, "Preview ended");
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
