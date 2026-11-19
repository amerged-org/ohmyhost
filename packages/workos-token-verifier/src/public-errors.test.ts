import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { InvalidWorkosTokenError } from "./errors.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("token verifier public error contract", () => {
  it("provides a stable redacted error subpath without exposing pure parsing contracts", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      exports: Record<string, { source: string }>;
    };
    expect(manifest.exports["./errors"]?.source).toBe("./src/errors.ts");

    const error = new InvalidWorkosTokenError("invalid_jwt_claims");
    expect(error).toMatchObject({
      name: "InvalidWorkosTokenError",
      code: "invalid_jwt_claims",
      message: "WorkOS token is invalid",
    });
    const source = await readFile(resolve(packageRoot, "src/errors.ts"), "utf8");
    expect(source).not.toMatch(/workos-auth-contracts|parsing|token value|cause/u);
  });
});
