import { describe, expect, it } from "vitest";

import { VITE_API_COMPANION_CONTRACT } from "./vite-companion-contract.js";

describe("Vite API companion contract", () => {
  it("publishes one deeply frozen source and artifact layout", () => {
    expect(VITE_API_COMPANION_CONTRACT).toEqual({
      schemaVersion: "ohmyhost.vite-api-companion/v1",
      sourceEntryPoint: "src/ohmyhost/companion.ts",
      artifact: {
        outputDirectory: ".ohmyhost/vite-companion",
        entryPoint: ".ohmyhost/vite-companion/worker.js",
        configPath: ".ohmyhost/vite-companion/wrangler.jsonc",
      },
      runtime: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        handlerExport: "default.fetch",
        routePrefix: "/api/",
      },
      bindings: {
        database: "OHMYHOST_DATABASE",
        authSecret: "BETTER_AUTH_SECRET",
      },
    });
    expect(Object.isFrozen(VITE_API_COMPANION_CONTRACT)).toBe(true);
    expect(Object.isFrozen(VITE_API_COMPANION_CONTRACT.artifact)).toBe(true);
    expect(Object.isFrozen(VITE_API_COMPANION_CONTRACT.runtime)).toBe(true);
    expect(Object.isFrozen(VITE_API_COMPANION_CONTRACT.runtime.compatibilityFlags)).toBe(true);
    expect(Object.isFrozen(VITE_API_COMPANION_CONTRACT.bindings)).toBe(true);
  });
});
