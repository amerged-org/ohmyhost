import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  inspectWfpSandbox,
  runSandboxPreflight,
  validateSandboxConfiguration,
} from "../scripts/sandbox-preflight.mjs";

const sandboxConfig = await readFile(
  new globalThis.URL("../wrangler.sandbox.jsonc", import.meta.url),
  "utf8",
);
const providerTag = "33e2244f9dec426aa7330ba66b44ebf0";
const gatewayOrigin = "https://dev-calm-river-studio.your-omh-account.workers.dev";

describe("WFP management sandbox preflight", () => {
  it("accepts only the exact private management configuration", () => {
    expect(validateSandboxConfiguration(sandboxConfig)).toEqual({ ok: true });
    expect(
      validateSandboxConfiguration(
        sandboxConfig.replace('workers_dev": false', 'workers_dev": true'),
      ),
    ).toEqual({ ok: false, reasonCode: "WFP_MANAGEMENT_SANDBOX_CONFIG_INVALID" });
    for (const [current, replaced] of [
      // The sandbox reads only the Dev build bucket and keeps no binding to an AWS egress.
      ['"bucket_name": "ohmyho-builds-development"', '"bucket_name": "ohmyho-builds-production"'],
      ['"jurisdiction": "us"', '"jurisdiction": "eu"'],
      [
        '"services": [',
        '"services": [{ "binding": "UNEXPECTED_EGRESS", "service": "ohmyho-unexpected-sandbox", "entrypoint": "UnexpectedService" },',
      ],
      ['"WFP_WORKERS_DEV_SUBDOMAIN": "your-omh-account",', ""],
    ]) {
      expect(sandboxConfig).toContain(current);
      expect(validateSandboxConfiguration(sandboxConfig.replace(current, replaced))).toEqual({
        ok: false,
        reasonCode: "WFP_MANAGEMENT_SANDBOX_CONFIG_INVALID",
      });
    }
  });

  it("fails before provider access when the narrow token is absent", async () => {
    const inspect = vi.fn();
    await expect(
      runSandboxPreflight({ configText: sandboxConfig, apiToken: "", inspect }),
    ).resolves.toEqual({
      ok: false,
      reasonCode: "WFP_MANAGEMENT_SANDBOX_CREDENTIAL_MISSING",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("proves the exact namespace, retained tombstone, and sustained public 404", async () => {
    const fetchImplementation = vi.fn(async (url, init) => {
      if (url.endsWith("/workers/dispatch/namespaces")) {
        expect(init.headers.authorization).toBe("Bearer narrow-wfp-token");
        return jsonResponse({
          success: true,
          result: [
            {
              namespace_id: "5866f088-54b4-4fc8-8c85-c8fc40ea2553",
              namespace_name: "ohmyho-sandbox",
              script_count: 1,
            },
          ],
        });
      }
      if (url.endsWith("/workers/dispatch/namespaces/ohmyho-sandbox/scripts")) {
        return jsonResponse({
          success: true,
          result: [{ id: "p-01arz3ndektsv4rrffq69g5faw", tag: providerTag }],
        });
      }
      expect(url).toMatch(
        /^https:\/\/dev-calm-river-studio\.your-omh-account\.workers\.dev\/\?preflight=[123]$/u,
      );
      return new globalThis.Response("Not Found", { status: 404 });
    });

    const result = await inspectWfpSandbox({
      apiToken: "narrow-wfp-token",
      gatewayOrigin,
      fetch: fetchImplementation,
    });

    expect(result).toEqual({
      ok: true,
      namespaceId: "5866f088-54b4-4fc8-8c85-c8fc40ea2553",
      tombstone: {
        scriptId: "p-01arz3ndektsv4rrffq69g5faw",
        providerTag,
      },
      dispatchSamples: 3,
    });
    expect(JSON.stringify(result)).not.toContain("narrow-wfp-token");
  });

  it("accepts an empty namespace after final tombstone removal", async () => {
    const fetchImplementation = vi.fn(async (url) => {
      if (url.endsWith("/workers/dispatch/namespaces")) {
        return jsonResponse({
          success: true,
          result: [
            {
              namespace_id: "5866f088-54b4-4fc8-8c85-c8fc40ea2553",
              namespace_name: "ohmyho-sandbox",
              script_count: 0,
            },
          ],
        });
      }
      return jsonResponse({ success: true, result: [] });
    });

    await expect(
      inspectWfpSandbox({ apiToken: "narrow-wfp-token", fetch: fetchImplementation }),
    ).resolves.toEqual({
      ok: true,
      namespaceId: "5866f088-54b4-4fc8-8c85-c8fc40ea2553",
      tombstone: null,
      dispatchSamples: 0,
    });
  });

  it("fails closed on missing namespace or unexpected provider inventory", async () => {
    for (const body of [
      { success: true, result: [] },
      {
        success: true,
        result: [
          {
            namespace_id: "5866f088-54b4-4fc8-8c85-c8fc40ea2553",
            namespace_name: "ohmyho-sandbox",
            script_count: 2,
          },
        ],
      },
    ]) {
      await expect(
        inspectWfpSandbox({
          apiToken: "narrow-wfp-token",
          fetch: vi.fn(async () => jsonResponse(body)),
        }),
      ).resolves.toEqual({
        ok: false,
        reasonCode: "WFP_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY",
      });
    }
  });

  it("refuses deployment when the retained public route is not consistently safe", async () => {
    let request = 0;
    await expect(
      inspectWfpSandbox({
        apiToken: "narrow-wfp-token",
        gatewayOrigin,
        fetch: vi.fn(async () => {
          request += 1;
          if (request === 1) {
            return jsonResponse({
              success: true,
              result: [
                {
                  namespace_id: "5866f088-54b4-4fc8-8c85-c8fc40ea2553",
                  namespace_name: "ohmyho-sandbox",
                  script_count: 1,
                },
              ],
            });
          }
          if (request === 2) {
            return jsonResponse({
              success: true,
              result: [{ id: "p-01arz3ndektsv4rrffq69g5faw", tag: providerTag }],
            });
          }
          return new globalThis.Response("old app", { status: request === 4 ? 200 : 404 });
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      reasonCode: "WFP_MANAGEMENT_SANDBOX_TOMBSTONE_ROUTE_UNSAFE",
    });
  });
});

function jsonResponse(body) {
  return new globalThis.Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
