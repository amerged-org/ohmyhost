import { describe, expect, it } from "vitest";
import { MANAGED_BETTER_AUTH_VERSION } from "@ohmyhost/contracts/framework-source-rules";
import { migrationBundleDigest, parseMigrationRequest } from "../src/request-parsing.js";

const scope = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
};
const omhNative = {
  provider: "omh-native",
  routePath: "/api/auth/v1",
  bindingName: "OHMYHOST_AUTH",
};
const betterAuth = {
  provider: "better-auth",
  version: MANAGED_BETTER_AUTH_VERSION,
  deployment: "embedded",
  routePath: "/api/auth",
  databaseSchema: "auth",
  databaseBindingName: "OHMYHOST_DATABASE",
  authSecretName: "BETTER_AUTH_SECRET",
};

async function migration() {
  const body = new TextEncoder().encode(
    "CREATE TABLE public.request_parsing_example(id integer PRIMARY KEY);\n",
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return {
    path: "20261112120000_request_parsing.sql",
    digest:
      `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as const,
    size: body.byteLength,
    body,
  };
}

function request(auth: unknown, migrations: unknown[] = []) {
  return { ...scope, migrations, auth };
}

describe("parseMigrationRequest customer auth", () => {
  it("accepts the omh-native requirement and returns only its provider", () => {
    expect(parseMigrationRequest(request(omhNative)).auth).toEqual({ provider: "omh-native" });
  });

  it("rejects every other shape that names omh-native", () => {
    for (const auth of [
      { ...omhNative, extra: true },
      { provider: "omh-native", routePath: "/api/auth/v1" },
      { ...omhNative, routePath: "/api/auth" },
      { ...omhNative, bindingName: "OHMYHOST_DATABASE" },
      { ...omhNative, provider: "none" },
      { ...omhNative, provider: "better-auth" },
      { ...betterAuth, provider: "omh-native" },
    ]) {
      expect(() => parseMigrationRequest(request(auth))).toThrow(
        "Customer auth requirement is invalid",
      );
    }
  });

  it("still accepts none and the exact better-auth requirement", () => {
    expect(parseMigrationRequest(request({ provider: "none" })).auth).toEqual({
      provider: "none",
    });
    expect(parseMigrationRequest(request(betterAuth)).auth).toEqual({
      provider: "better-auth",
    });
  });
});

describe("migrationBundleDigest for customer auth", () => {
  it("digests omh-native as sha256 of the manifest and the omh-native provider, not as none", async () => {
    const migrations = [await migration()];
    const parsed = parseMigrationRequest(request(omhNative, migrations));
    const expected = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({
            migrations: migrations.map(({ path, digest, size }) => ({ path, digest, size })),
            auth: { provider: "omh-native" },
          }),
        ),
      ),
    );
    const native = await migrationBundleDigest(parsed.migrations, parsed.auth);
    expect(native).toEqual(expected);
    expect(native).not.toEqual(await migrationBundleDigest(migrations, { provider: "none" }));
  });
});
