import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  inspectR2Provider,
  runSandboxPreflight,
  validateSandboxConfiguration,
} from "../scripts/sandbox-preflight.mjs";

const sandboxConfig = await readFile(
  new globalThis.URL("../wrangler.sandbox.jsonc", import.meta.url),
  "utf8",
);

describe("R2 management sandbox preflight", () => {
  it("accepts only the exact private sandbox configuration", () => {
    expect(validateSandboxConfiguration(sandboxConfig)).toEqual({ ok: true });
    expect(
      validateSandboxConfiguration(
        sandboxConfig.replace('workers_dev": false', 'workers_dev": true'),
      ),
    ).toEqual({ ok: false, reasonCode: "R2_MANAGEMENT_SANDBOX_CONFIG_INVALID" });
    for (const widened of [
      sandboxConfig.replace('"R2ManagementRuntime"', '"OtherRuntime"'),
      sandboxConfig.replace(/"services": \[[^\]]*\],/u, ""),
      sandboxConfig.replace('"vars"', '"d1_databases": [{ "binding": "CONTROL_CORE" }], "vars"'),
    ])
      expect(validateSandboxConfiguration(widened)).toEqual({
        ok: false,
        reasonCode: "R2_MANAGEMENT_SANDBOX_CONFIG_INVALID",
      });
  });

  it("fails before provider access when the service-owned credential is absent", async () => {
    const inspect = vi.fn();
    await expect(
      runSandboxPreflight({ configText: sandboxConfig, apiToken: "", inspect }),
    ).resolves.toEqual({
      ok: false,
      reasonCode: "R2_MANAGEMENT_SANDBOX_CREDENTIAL_MISSING",
    });
    expect(inspect).not.toHaveBeenCalled();
    inspect.mockResolvedValue({ ok: true, bucketCount: 0 });
    await expect(
      runSandboxPreflight({
        configText: sandboxConfig,
        apiToken: "narrow-r2-token-credential",
        inspect,
      }),
    ).resolves.toEqual({ ok: true, bucketCount: 0 });
  });

  it("proves R2 capability by bounded EU bucket inventory readback", async () => {
    const fetch = vi.fn(async (_url, init) => {
      expect(init.headers).toEqual({
        authorization: "Bearer narrow-r2-token-credential",
        "cf-r2-jurisdiction": "eu",
      });
      return new globalThis.Response(
        JSON.stringify({ success: true, result: { buckets: [{ name: "private-bucket" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await expect(
      inspectR2Provider({
        accountId: "00000000000000000000000000000001",
        apiToken: "narrow-r2-token-credential",
        fetch,
      }),
    ).resolves.toEqual({ ok: true, bucketCount: 1 });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000001/r2/buckets?per_page=1",
      expect.any(Object),
    );
  });

  it("returns a redacted failure for denied or malformed provider responses", async () => {
    const result = await inspectR2Provider({
      accountId: "00000000000000000000000000000001",
      apiToken: "must-never-be-returned",
      fetch: vi.fn(
        async () =>
          new globalThis.Response(
            JSON.stringify({ errors: [{ message: "secret provider detail" }] }),
            {
              status: 403,
            },
          ),
      ),
    });
    expect(result).toEqual({ ok: false, reasonCode: "R2_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY" });
    expect(JSON.stringify(result)).not.toMatch(/secret|token|provider detail/iu);
  });
});
