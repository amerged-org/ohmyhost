import { readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  inspectGithubFixtureInstallation,
  normalizeGithubPrivateKeyBase64,
  runSandboxPreflight,
  validateSandboxConfiguration,
} from "../scripts/sandbox-preflight.mjs";

const sandboxConfig = await readFile(
  new globalThis.URL("../wrangler.sandbox.jsonc", import.meta.url),
  "utf8",
);

describe("source fetcher sandbox preflight", () => {
  it("normalizes a base64-wrapped PKCS#8 PEM key to canonical DER base64", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pemBase64 = globalThis.Buffer.from(
      privateKey.export({ format: "pem", type: "pkcs8" }),
    ).toString("base64");
    const expectedDerBase64 = globalThis.Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");

    expect(normalizeGithubPrivateKeyBase64(pemBase64)).toBe(expectedDerBase64);
    expect(normalizeGithubPrivateKeyBase64(expectedDerBase64)).toBe(expectedDerBase64);
    expect(() => normalizeGithubPrivateKeyBase64("not-base64")).toThrowError(
      "SOURCE_FETCHER_SANDBOX_CREDENTIAL_FORMAT_INVALID",
    );
  });

  it("accepts only the exact private sandbox configuration", () => {
    expect(validateSandboxConfiguration(sandboxConfig)).toEqual({
      ok: true,
      appClientId: "Iv23Example000000001",
    });
    expect(
      validateSandboxConfiguration(
        sandboxConfig.replace('workers_dev": false', 'workers_dev": true'),
      ),
    ).toEqual({ ok: false, reasonCode: "SOURCE_FETCHER_SANDBOX_CONFIG_INVALID" });
    expect(
      validateSandboxConfiguration(
        sandboxConfig.replace("ohmyho-builds-development-eu", "ohmyho-builds-production-eu"),
      ),
    ).toEqual({ ok: false, reasonCode: "SOURCE_FETCHER_SANDBOX_CONFIG_INVALID" });
  });

  it("fails before GitHub access when the private key is absent", async () => {
    const inspectInstallation = vi.fn();
    await expect(
      runSandboxPreflight({
        configText: sandboxConfig,
        privateKeyBase64: "",
        inspectInstallation,
      }),
    ).resolves.toEqual({
      ok: false,
      reasonCode: "SOURCE_FETCHER_SANDBOX_CREDENTIAL_MISSING",
    });
    expect(inspectInstallation).not.toHaveBeenCalled();
  });

  it("proves selected-repository read-only installation without exposing the JWT", async () => {
    const fetchImplementation = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.github.com/repos/aixyte/ohmyho.st/installation");
      expect(init.headers.authorization).toBe("Bearer github-app-jwt");
      return new globalThis.Response(
        JSON.stringify({
          id: 154_436_099,
          account: { login: "aixyte" },
          repository_selection: "selected",
          permissions: { contents: "read", metadata: "read" },
        }),
        { status: 200 },
      );
    });

    await expect(
      inspectGithubFixtureInstallation({
        appJwt: "github-app-jwt",
        fetch: fetchImplementation,
      }),
    ).resolves.toEqual({
      ok: true,
      installationId: 154_436_099,
      repository: "aixyte/ohmyho.st",
      permissions: ["contents:read", "metadata:read"],
    });
    expect(JSON.stringify(fetchImplementation.mock.results)).not.toContain("github-app-jwt");
  });

  it("accepts an all-repository sandbox installation only while permissions remain read-only", async () => {
    await expect(
      inspectGithubFixtureInstallation({
        appJwt: "github-app-jwt",
        fetch: vi.fn(async () =>
          globalThis.Response.json({
            id: 154_436_099,
            account: { login: "aixyte" },
            repository_selection: "all",
            permissions: { contents: "read", metadata: "read" },
          }),
        ),
      }),
    ).resolves.toEqual({
      ok: true,
      installationId: 154_436_099,
      repository: "aixyte/ohmyho.st",
      permissions: ["contents:read", "metadata:read"],
    });
  });

  it("denies missing, malformed, or overprivileged installation state", async () => {
    for (const response of [
      new globalThis.Response("Not Found", { status: 404 }),
      new globalThis.Response("{}", { status: 200 }),
      new globalThis.Response(
        JSON.stringify({
          id: 154_436_099,
          account: { login: "aixyte" },
          repository_selection: "selected",
          permissions: { contents: "write", metadata: "read" },
        }),
        { status: 200 },
      ),
    ]) {
      await expect(
        inspectGithubFixtureInstallation({
          appJwt: "github-app-jwt",
          fetch: vi.fn(async () => response),
        }),
      ).resolves.toEqual({
        ok: false,
        reasonCode: "SOURCE_FETCHER_SANDBOX_INSTALLATION_NOT_READY",
      });
    }
  });

  it("composes JWT issuance and installation inspection without returning credentials", async () => {
    const issueAppJwt = vi.fn(async (input) => {
      expect(input).toEqual({
        clientId: "Iv23Example000000001",
        privateKeyBase64: "canonical-private-key-base64",
      });
      return "github-app-jwt";
    });
    const inspectInstallation = vi.fn(async (input) => {
      expect(input).toMatchObject({ appJwt: "github-app-jwt" });
      return {
        ok: true,
        installationId: 154_436_099,
        repository: "aixyte/ohmyho.st",
        permissions: ["contents:read", "metadata:read"],
      };
    });

    const result = await runSandboxPreflight({
      configText: sandboxConfig,
      privateKeyBase64: "cGVtLWJhc2U2NA==",
      issueAppJwt,
      inspectInstallation,
      normalizePrivateKey: () => "canonical-private-key-base64",
    });

    expect(result).toEqual({
      ok: true,
      installationId: 154_436_099,
      repository: "aixyte/ohmyho.st",
      permissions: ["contents:read", "metadata:read"],
    });
    expect(JSON.stringify(result)).not.toContain("github-app-jwt");
    expect(JSON.stringify(result)).not.toContain("canonical-private-key-base64");
  });
});
