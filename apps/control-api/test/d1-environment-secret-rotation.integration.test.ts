import { expect, it } from "vitest";
import { AI_KEY_NAME, parseUlid } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { createD1EnvironmentSecretsPort } from "../src/d1-environment-secrets.js";
import { createEnvironmentSecretCipherKeyring } from "../src/environment-secret-cipher.js";
import { EnvironmentSecretNotInstalledError } from "../src/environment-secrets.js";

it("rotates an installed platform key to a sealed value whose stored digest is the plain SHA-256 of that value", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control),
      store = createControlStore(control.bindings),
      clock = { now: () => new Date("2026-11-14T11:00:00.000Z") },
      cipher = createEnvironmentSecretCipherKeyring({
        primaryKeyBase64: Buffer.alloc(32, 0x64).toString("base64"),
        currentKeyVersion: 1,
        crypto: globalThis.crypto,
      }),
      port = createD1EnvironmentSecretsPort({ runtime: store.secrets, clock, cipher }),
      scope = {
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        environmentId: parseUlid(project.prodEnvironmentId),
        principalId: "user:fixture",
        requestId: "req-rotate",
      };
    const identity = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    const stored = async (name: string) => {
      const row = await control.core
        .prepare(
          "SELECT ciphertext, nonce, value_sha256, key_version FROM environment_secrets WHERE organization_id=? AND environment_id=? AND name=?",
        )
        .bind(project.organizationId, project.prodEnvironmentId, name)
        .first<{
          ciphertext: ArrayBuffer | number[];
          nonce: ArrayBuffer | number[];
          value_sha256: ArrayBuffer | number[];
          key_version: number;
        }>();
      if (row === null) throw new Error(`${name} is not stored`);
      return {
        ciphertext: Uint8Array.from(row.ciphertext as ArrayLike<number>),
        nonce: Uint8Array.from(row.nonce as ArrayLike<number>),
        valueSha256: Uint8Array.from(row.value_sha256 as ArrayLike<number>),
        keyVersion: row.key_version,
      };
    };
    // The install is the ordinary write of a value; the owner's rotation then replaces it with a generated key.
    await port.put({
      ...scope,
      name: AI_KEY_NAME,
      value: "installed-before-rotation",
      idempotencyKey: "install-ai",
      canonicalRequestDigest: new Uint8Array(32).fill(1),
    });
    const rotated = await port.rotate({
      ...scope,
      name: AI_KEY_NAME,
      idempotencyKey: "rotate-ai-1",
      canonicalRequestDigest: new Uint8Array(32).fill(2),
    });
    expect(rotated).toMatchObject({
      name: AI_KEY_NAME,
      revision: 2,
      desiredGeneration: 2,
      appliedGeneration: 0,
    });
    expect(JSON.stringify(rotated)).not.toContain("omh_ai_");
    const row = await stored(AI_KEY_NAME);
    // `decrypt` verifies the stored digest against the opened plaintext, so this proves the digest is the plain SHA-256.
    const value = await cipher.decrypt({ ...identity, name: AI_KEY_NAME, ...row });
    expect(value).toMatch(new RegExp(`^omh_ai_${project.projectId}_[A-Za-z0-9_-]{43}$`, "u"));
    expect(value).not.toBe("installed-before-rotation");

    // Another installed key rotates to a fresh 43-character base64url value of its own.
    await port.put({
      ...scope,
      name: "BETTER_AUTH_SECRET",
      value: "auth-before-rotation",
      idempotencyKey: "install-auth",
      canonicalRequestDigest: new Uint8Array(32).fill(3),
    });
    await port.rotate({
      ...scope,
      name: "BETTER_AUTH_SECRET",
      idempotencyKey: "rotate-auth-1",
      canonicalRequestDigest: new Uint8Array(32).fill(4),
    });
    const auth = await cipher.decrypt({
      ...identity,
      name: "BETTER_AUTH_SECRET",
      ...(await stored("BETTER_AUTH_SECRET")),
    });
    expect(auth).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(auth).not.toBe("auth-before-rotation");

    // A key that was never installed is not rotated into existence.
    await expect(
      port.rotate({
        ...scope,
        name: "OHMYHOST_MAIL_KEY",
        idempotencyKey: "rotate-absent",
        canonicalRequestDigest: new Uint8Array(32).fill(5),
      }),
    ).rejects.toBeInstanceOf(EnvironmentSecretNotInstalledError);
  } finally {
    await control.dispose();
  }
});
