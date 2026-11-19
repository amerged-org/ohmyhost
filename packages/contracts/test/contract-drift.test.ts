import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("OpenAPI semantic validation and drift", () => {
  it("accepts the pinned contract and its checked-in generator input", async () => {
    await expect(
      execute(process.execPath, ["scripts/check-contracts.mjs"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          REDOCLY_SUPPRESS_UPDATE_NOTICE: "true",
          REDOCLY_TELEMETRY: "off",
        },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a broken component reference", async () => {
    await expect(
      execute(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        [
          "exec",
          "redocly",
          "lint",
          "packages/contracts/test/fixtures/invalid-openapi-ref.yaml",
          "--config",
          "redocly.yaml",
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            REDOCLY_SUPPRESS_UPDATE_NOTICE: "true",
            REDOCLY_TELEMETRY: "off",
          },
        },
      ),
    ).rejects.toBeDefined();
  });
});
