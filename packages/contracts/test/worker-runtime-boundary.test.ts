import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const productionSource = new URL("../src/index.ts", import.meta.url);
const frameworkFamilySource = new URL("../src/framework-family.ts", import.meta.url);

describe("contracts Worker runtime boundary", () => {
  it("bundles the configuration schema without a production filesystem dependency", async () => {
    const source = await readFile(productionSource, "utf8");

    expect(source).not.toContain('from "node:fs"');
    expect(source).not.toContain("readFileSync(");
    expect(source).toContain('from "../schemas/ohmyhost.schema.json" with { type: "json" }');
  });

  it("keeps framework-family classification pure and runtime-neutral", async () => {
    const source = await readFile(frameworkFamilySource, "utf8");

    expect(source).not.toMatch(/(?:from|import\s*\()\s*["']node:/u);
    expect(source).not.toMatch(/^import\s/mu);
    expect(source).not.toMatch(/process\.|fetch\s*\(/u);
  });
});
