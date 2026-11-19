import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);

describe("Control API production dependency graph", () => {
  it("transitively excludes provider administration, local runners, test adapters, and user code", async () => {
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
        "CONTROL_API_RED: add the buildable production Control API graph before proving its transitive security boundary",
        { cause: error },
      );
    }

    expect(stdout).not.toMatch(
      /packages\/(?:testkit|local-runner|providers?|workos-management)\/|apps\/(?:orchestrator|dispatch|workos-management)\/|fake-(?:provider|static-hosting)|fixture\.ts/u,
    );
    expect(stdout).toContain("apps/control-api/src/index.ts");
  });

  it("keeps provider-management credentials and local/test composition out of production source", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const sourceRoot = resolve(packageRoot, "src");
    const source = (
      await Promise.all(
        (await readdir(sourceRoot))
          .filter((name) => name.endsWith(".ts"))
          .map((name) => readFile(resolve(sourceRoot, name), "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(
      /WORKOS_(?:API|MANAGEMENT)_KEY|process\.env|@ohmyhost\/(?:testkit|local-runner|providers?)|workos-management|Turnstile/iu,
    );
  });
});
