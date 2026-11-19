import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);

describe("Product CLI production dependency graph", () => {
  it("transitively contains only the generated SDK and login-specific client boundaries", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let stdout: string;

    try {
      ({ stdout } = await executeFile("pnpm", [
        "exec",
        "tsc",
        "--project",
        resolve(packageRoot, "tsconfig.build.json"),
        "--listFilesOnly",
      ]));
    } catch (error) {
      throw new Error(
        "PRODUCT_CLI_RED: add the buildable product CLI and generated SDK graph before proving transitive boundary exclusions",
        { cause: error },
      );
    }

    // The shared admission rules reach the CLI only through @ohmyhost/contracts, never through a
    // framework adapter or SourceFetcher.
    expect(stdout).toMatch(/packages\/contracts\/dist\/framework-source-rules\.d\.ts/u);
    expect(stdout).not.toMatch(
      /packages\/(?:adapter-[a-z]+|database|platform|testkit|local-runner|providers?|workos-token-verifier)\/|apps\/(?:control-api|orchestrator|source-fetcher|workos-management|webhook-ingress)\/|\/hono\/|\/pg\//u,
    );
  });

  it("declares only the generated SDK, public auth contract, and native keyring at runtime", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@napi-rs/keyring",
      "@ohmyhost/contracts",
      "@ohmyhost/postgres-bridge",
      "@ohmyhost/sdk-ts",
      "@ohmyhost/workos-auth-contracts",
      "ignore",
      "isomorphic-git",
    ]);
  });

  it("exports only the supported native credential-store subpath for local agent clients", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      readonly exports?: Readonly<Record<string, unknown>>;
    };

    expect(manifest.exports).toMatchObject({
      "./credential-store": {
        source: "./src/credential-store.ts",
        types: "./dist/credential-store.d.ts",
        import: "./dist/credential-store.js",
      },
    });
  });

  it("lets login read only the account profile and never mutate a product resource", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(resolve(packageRoot, "src/cli.ts"), "utf8");
    const login = source.slice(
      source.indexOf("private async login"),
      source.indexOf("private unverifiedLogin"),
    );
    expect(login.length).toBeGreaterThan(0);

    expect(login).not.toMatch(/createProject|getOperation|Idempotency-Key|\/v1\//u);
    // Login holds no product API at all. It reads the workspaces through one narrow
    // read-only dependency, which is what keeps the isolation proof in
    // scripts/check-product-cli-boundary.mjs true without exempting an identifier.
    expect([...login.matchAll(/api\.([A-Za-z]+)\(/gu)].map(([, method]) => method)).toEqual([]);
    expect(login).not.toMatch(/authenticatedApi|productApi|GeneratedSdkProductApi/u);
    expect(login).toMatch(/this\.dependencies\.accountProfile\(/u);
    // The fresh login is verified through the same kind of narrow read-only dependency.
    expect(login).toMatch(/this\.dependencies\.currentIdentity/u);
    // The selection itself stays free of HTTP and product-resource detail.
    expect(await readFile(resolve(packageRoot, "src/workspace.ts"), "utf8")).not.toMatch(
      /fetch\s*\(|["'`]\/v1\/|Idempotency-Key|@ohmyhost\/sdk-ts/u,
    );
  });

  it("keeps product resource HTTP details inside the generated SDK", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(resolve(packageRoot, "src/product-api.ts"), "utf8");

    expect(source).toContain('from "@ohmyhost/sdk-ts"');
    expect(source).not.toMatch(/fetch\s*\(|["'`]\/v1\//u);
  });
});
