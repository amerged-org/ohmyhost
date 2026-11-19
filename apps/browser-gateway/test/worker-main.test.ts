import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { BrowserGatewayRuntime } from "@ohmyhost/platform";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly testStub = true;
  },
}));
import worker, { gatewayFromEnvironment } from "../src/worker-main.js";

describe("Browser gateway Worker bindings", () => {
  it("fails closed without all private bindings and dispatches a configured sweep", async () => {
    expect(gatewayFromEnvironment({})).toBeNull();
    expect(
      (await worker.fetch(new Request("https://browser.ohmyho.st/v1/pdf"), {}, { waitUntil() {} }))
        .status,
    ).toBe(503);
    await expect(worker.scheduled(null, {})).rejects.toThrow("browser_gateway_unconfigured");
    const runtime = {
      authorizeKey: vi.fn(),
      admit: vi.fn(),
      settle: vi.fn(),
      release: vi.fn(),
      sweep: vi.fn(async () => ({ released: 0 })),
    };
    const env = {
      BROWSER_RUNTIME: runtime,
      BROWSER: { quickAction: vi.fn() },
      BROWSER_SETTLEMENT_JOURNAL: { getByName: vi.fn(() => ({ record: vi.fn() })) },
      AUTH_LIMITER: { limit: vi.fn() },
      PROJECT_LIMITER: { limit: vi.fn() },
    };
    expect(gatewayFromEnvironment(env)).not.toBeNull();
    await worker.scheduled(null, env);
    expect(runtime.sweep).toHaveBeenCalledWith({ olderThanMs: 900_000, limit: 200 });
    expect(
      (
        await worker.fetch(new Request("https://browser.ohmyho.st/unknown"), env, {
          waitUntil() {},
        })
      ).status,
    ).toBe(404);
  });

  it("routes each authorized environment through its own reservation and content-free journal", async () => {
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const keys = ["a", "b"].map((secret) => `omh_browser_${projectId}_${secret.repeat(43)}`);
    const hash = (key: string) => createHash("sha256").update(key).digest("hex");
    const scopes = keys.map((key, index) => ({
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      projectId,
      environmentId: index === 0 ? "01ARZ3NDEKTSV4RRFFQ69G5FAW" : "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      keySha256: hash(key),
      keyRevision: 1,
      deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      revisionId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      ownershipVersion: 1,
      billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    }));
    const runtime = {
      authorizeKey: vi.fn(
        async (input: { projectId: string; keySha256: string }) =>
          scopes.find(
            (scope) => scope.projectId === input.projectId && scope.keySha256 === input.keySha256,
          ) ?? null,
      ),
      admit: vi.fn<BrowserGatewayRuntime["admit"]>(async () => ({
        admitted: true as const,
        reservedMicros: 150_000,
      })),
      settle: vi.fn<BrowserGatewayRuntime["settle"]>(async () => ({
        settled: true as const,
        chargedMicros: 38,
      })),
      release: vi.fn(async () => ({ released: true })),
      sweep: vi.fn(async () => ({ released: 0 })),
    };
    const document = await PDFDocument.create();
    document.addPage();
    const bytes = Uint8Array.from(await document.save()).buffer;
    const quickAction = vi.fn(
      async () => new Response(bytes, { headers: { "x-browser-ms-used": "7.5" } }),
    );
    const record = vi.fn<(input: unknown) => Promise<void>>(async () => undefined);
    const getByName = vi.fn<(name: string) => { record: typeof record }>(() => ({ record }));
    const projectLimit = vi.fn<(input: { key: string }) => Promise<{ success: boolean }>>(
      async () => ({ success: true }),
    );
    const authLimit = vi.fn<(input: { key: string }) => Promise<{ success: boolean }>>(
      async () => ({ success: true }),
    );
    const env = {
      BROWSER_RUNTIME: runtime,
      BROWSER: { quickAction },
      BROWSER_SETTLEMENT_JOURNAL: { getByName },
      AUTH_LIMITER: { limit: authLimit },
      PROJECT_LIMITER: { limit: projectLimit },
    };
    const tasks: Promise<unknown>[] = [];
    const call = (key: string) =>
      worker.fetch(
        new Request("https://browser.ohmyho.st/v1/pdf", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ html: "<p>private-document</p>" }),
        }),
        env,
        {
          waitUntil(task) {
            tasks.push(task);
          },
        },
      );
    for (const key of keys) {
      const response = await call(key);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(await response.arrayBuffer()).toEqual(bytes);
    }
    expect((await call(`omh_browser_${projectId}_${"c".repeat(43)}`)).status).toBe(401);
    await Promise.all(tasks);
    expect(authLimit).toHaveBeenCalledTimes(3);
    expect(projectLimit).toHaveBeenCalledTimes(2);
    for (const key of keys)
      expect(runtime.authorizeKey).toHaveBeenCalledWith({ projectId, keySha256: hash(key) });

    const ids = runtime.admit.mock.calls.map(([input]) => input.reservationId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const [index, id] of ids.entries()) {
      expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
      const scope = scopes[index];
      if (scope === undefined) throw new Error("Expected a scoped environment");
      const billScope = {
        organizationId: scope.organizationId,
        projectId,
        environmentId: scope.environmentId,
      };
      expect(runtime.admit).toHaveBeenNthCalledWith(index + 1, { scope, reservationId: id });
      expect(getByName).toHaveBeenNthCalledWith(index + 1, id);
      expect(record).toHaveBeenNthCalledWith(index + 1, {
        scope: billScope,
        reservationId: id,
        browserMs: "7.5",
      });
      expect(runtime.settle).toHaveBeenNthCalledWith(index + 1, {
        scope: billScope,
        reservationId: id,
        browserMs: "7.5",
      });
    }
    expect(quickAction).toHaveBeenCalledTimes(2);
    expect(quickAction).toHaveBeenCalledWith(
      "pdf",
      expect.objectContaining({
        cacheTTL: 0,
        setJavaScriptEnabled: false,
        allowRequestPattern: ["^data:"],
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-document");
    for (const key of keys) expect(JSON.stringify(record.mock.calls)).not.toContain(key);
  });
});
