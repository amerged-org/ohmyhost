import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const schemaPath = fileURLToPath(new URL("../schemas/ohmyhost.schema.json", import.meta.url));
const fixturesDirectory = new URL("./fixtures/", import.meta.url);

async function loadJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function loadFixture(name: string): Promise<unknown> {
  return parse(await readFile(new URL(name, fixturesDirectory), "utf8")) as unknown;
}

function summarize(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(({ instancePath, keyword }) => `${instancePath || "/"}:${keyword}`);
}

describe("ohmyhost.yaml JSON Schema", () => {
  it("declares JSON Schema 2020-12 and rejects unknown root keys", async () => {
    const schema = await loadJson(schemaPath);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);

    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["additionalProperties"]).toBe(false);
    expect(validate(await loadFixture("invalid-unknown-root.yaml"))).toBe(false);
    expect(summarize(validate.errors)).toContain("/:additionalProperties");
  });

  it("accepts the complete canonical configuration", async () => {
    const schema = await loadJson(schemaPath);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

    expect(validate(await loadFixture("valid-complete.yaml"))).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("keeps customer auth project-local and secret-free", async () => {
    const schema = await loadJson(schemaPath);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const config = (await loadFixture("valid-complete.yaml")) as Record<string, unknown>;

    expect(validate({ ...config, auth: { provider: "none" } })).toBe(true);
    expect(validate({ ...config, auth: { provider: "better-auth" } })).toBe(true);
    expect(validate({ ...config, auth: { provider: "omh-native" } })).toBe(true);
    expect(validate({ ...config, auth: { provider: "omh-native", secret: "forbidden" } })).toBe(
      false,
    );
    expect(validate({ ...config, auth: { provider: "supabase" } })).toBe(false);
    expect(validate({ ...config, auth: { provider: "better-auth", secret: "forbidden" } })).toBe(
      false,
    );
  });

  it("accepts only the private US or EU R2 storage contract", async () => {
    const schema = await loadJson(schemaPath);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const config = (await loadFixture("valid-complete.yaml")) as Record<string, unknown>;

    expect(
      validate({ ...config, storage: { provider: "r2", jurisdiction: "us", public: false } }),
    ).toBe(true);
    expect(
      validate({ ...config, storage: { provider: "r2", jurisdiction: "eu", public: false } }),
    ).toBe(true);
    for (const storage of [
      { provider: "s3", jurisdiction: "us", public: false },
      { provider: "r2", jurisdiction: "default", public: false },
      { provider: "r2", jurisdiction: "apac", public: false },
      { provider: "r2", jurisdiction: "EU", public: false },
      { provider: "r2", jurisdiction: "us", public: true },
      { provider: "r2", jurisdiction: "us", public: false, accessKey: "forbidden" },
    ]) {
      expect(validate({ ...config, storage })).toBe(false);
    }
  });

  it("declares the AI gateway with a jurisdiction required only when enabled", async () => {
    const schema = await loadJson(schemaPath);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const config = (await loadFixture("valid-complete.yaml")) as Record<string, unknown>;

    expect(validate({ ...config, ai: { enabled: true, jurisdiction: "eu" } })).toBe(true);
    expect(validate({ ...config, ai: { enabled: true, jurisdiction: "any" } })).toBe(true);
    expect(validate({ ...config, ai: { enabled: false } })).toBe(true);
    expect(validate({ ...config, ai: { enabled: false, jurisdiction: "eu" } })).toBe(true);
    expect(validate({ ...config, ai: { enabled: true } })).toBe(false);
    expect(summarize(validate.errors)).toContain("/ai:required");
    for (const ai of [
      { enabled: false, jurisdiction: "apac" },
      { enabled: true, jurisdiction: "EU" },
      { enabled: true, jurisdiction: "us", model: "forbidden" },
      { enabled: "yes", jurisdiction: "eu" },
    ]) {
      expect(validate({ ...config, ai })).toBe(false);
    }
  });

  it("accepts only the canonical bounded application-root grammar", async () => {
    const schema = await loadJson(schemaPath);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const config = (await loadFixture("valid-complete.yaml")) as Record<string, unknown>;

    expect(validate({ ...config, applicationRoot: "site" })).toBe(true);
    expect(validate({ ...config, applicationRoot: "." })).toBe(true);
    for (const applicationRoot of [
      "",
      "./site",
      "site/",
      "site//web",
      "../site",
      "/site",
      "site\\web",
      "C:site",
      " site",
      "site ",
      "café",
      "site%2fweb",
      "a/b/c/d/e/f/g/h/i",
      "a".repeat(64),
      `${"a".repeat(32)}/${"b".repeat(32)}`,
    ]) {
      expect(validate({ ...config, applicationRoot })).toBe(false);
    }
  });

  it("accepts the complete fixture and refuses a credits block at the root", async () => {
    const schema = await loadJson(schemaPath);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const config = (await loadFixture("valid-complete.yaml")) as Record<string, unknown>;

    expect(validate(config)).toBe(true);
    expect(validate({ ...config, credits: { monthly_budget: 3000 } })).toBe(false);
    expect(summarize(validate.errors)).toContain("/:additionalProperties");
  });

  it.each([
    ["invalid-unknown-nested.yaml", "/build:additionalProperties"],
    ["invalid-runtime-mode.yaml", "/runtime/mode:enum"],
    ["invalid-database-migrations.yaml", "/database:required"],
    ["invalid-absolute-output.yaml", "/build/output:pattern"],
    ["invalid-windows-absolute-output.yaml", "/build/output:pattern"],
    ["invalid-traversal-output.yaml", "/build/output:pattern"],
    ["invalid-windows-traversal-output.yaml", "/build/output:pattern"],
  ])("rejects %s with %s", async (fixture, expectedError) => {
    const schema = await loadJson(schemaPath);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

    expect(validate(await loadFixture(fixture))).toBe(false);
    expect(summarize(validate.errors)).toContain(expectedError);
  });
});
