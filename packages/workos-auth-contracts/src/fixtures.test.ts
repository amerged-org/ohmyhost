import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseDeviceAuthorization,
  parseWorkosJwks,
  parseWorkosOrganizationSnapshot,
  parseWorkosWebhookEnvelope,
} from "./index.js";

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");
const loadFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(fixtureDirectory, name), "utf8")) as unknown;

describe("checked-in WorkOS contract fixtures", () => {
  it("parses Device Flow, JWKS, organization, and webhook fixtures", async () => {
    const [device, jwks, organization, webhook] = await Promise.all([
      loadFixture("device-authorization.json"),
      loadFixture("jwks.json"),
      loadFixture("organization-snapshot.json"),
      loadFixture("webhook.json"),
    ]);

    expect(parseDeviceAuthorization(device, "https://auth.example.test/device").userCode).toBe(
      "BCDF-GHJK",
    );
    const parsedKeys = parseWorkosJwks(jwks);
    expect(parsedKeys[0]?.kid).toBe("fixture-key");
    const fixtureKey = parsedKeys[0];
    if (fixtureKey === undefined) throw new Error("JWKS fixture did not contain a key");
    await expect(
      globalThis.crypto.subtle.importKey(
        "jwk",
        fixtureKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    ).resolves.toMatchObject({ type: "public" });
    expect(
      parseWorkosOrganizationSnapshot(organization, new Date("2026-08-18T10:00:01Z")).organization
        .id,
    ).toBe("org_fixture");
    expect(parseWorkosWebhookEnvelope(webhook).id).toBe("event_fixture");
  });
});
