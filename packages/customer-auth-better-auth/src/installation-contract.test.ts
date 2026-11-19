import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SUPPORTED_BETTER_AUTH_VERSION } from "@ohmyhost/platform";

import { CUSTOMER_AUTH_INSTALLATION_CONTRACT } from "./installation-contract.js";

describe("customer Better Auth installation contract", () => {
  it("exports one deeply frozen pinned schema, identity, route, and binding contract", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(CUSTOMER_AUTH_INSTALLATION_CONTRACT.package.version).toBe(SUPPORTED_BETTER_AUTH_VERSION);
    expect(manifest.dependencies["better-auth"]).toBe(SUPPORTED_BETTER_AUTH_VERSION);
    expect(manifest.dependencies).not.toHaveProperty("@ohmyhost/platform");
    expect(CUSTOMER_AUTH_INSTALLATION_CONTRACT).toEqual({
      package: { name: "better-auth", version: "1.7.7" },
      database: {
        schema: "auth",
        idGeneration: "uuid",
        tables: ["account", "rateLimit", "session", "user", "verification"],
        binding: "OHMYHOST_DATABASE",
      },
      http: { routePath: "/api/auth", handlerExport: "fetch" },
      secrets: ["BETTER_AUTH_SECRET"],
    });
    expect(Object.isFrozen(CUSTOMER_AUTH_INSTALLATION_CONTRACT)).toBe(true);
    expect(Object.isFrozen(CUSTOMER_AUTH_INSTALLATION_CONTRACT.package)).toBe(true);
    expect(Object.isFrozen(CUSTOMER_AUTH_INSTALLATION_CONTRACT.database)).toBe(true);
    expect(Object.isFrozen(CUSTOMER_AUTH_INSTALLATION_CONTRACT.database.tables)).toBe(true);
    expect(Object.isFrozen(CUSTOMER_AUTH_INSTALLATION_CONTRACT.http)).toBe(true);
    expect(Object.isFrozen(CUSTOMER_AUTH_INSTALLATION_CONTRACT.secrets)).toBe(true);
  });
});
