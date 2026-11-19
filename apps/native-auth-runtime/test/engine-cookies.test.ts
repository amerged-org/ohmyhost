import { getCookies } from "better-auth/cookies";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createNativeAuthEngineOptions } from "../src/engine.js";

describe("Native Auth cookies", () => {
  it("names every cookie with the __Host- prefix, Secure, Path=/ and no Domain", () => {
    const options = createNativeAuthEngineOptions({
      canonicalOrigin: "https://app.check.omh.st",
      applicationName: "Native Auth",
      secret: "s".repeat(48),
      // A pool that never connects: the cookie names are derived without any database round trip.
      database: new Pool({ connectionString: "postgres://127.0.0.1:1/unused" }),
      sendMail: async () => undefined,
    });
    const cookies = getCookies(options);
    const names = Object.values(cookies).map((cookie) => cookie.name);
    expect(names.length).toBeGreaterThan(0);
    for (const cookie of Object.values(cookies)) {
      expect(cookie.name, cookie.name).toMatch(/^__Host-omh_native\./u);
      expect(cookie.attributes, cookie.name).toMatchObject({ secure: true, path: "/" });
      expect(cookie.attributes.domain, cookie.name).toBeUndefined();
    }
  });
});
