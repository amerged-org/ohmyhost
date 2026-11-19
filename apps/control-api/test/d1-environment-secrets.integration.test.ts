import { createHash } from "node:crypto";

import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import {
  seedProject,
  losingWriteResponses,
} from "../../control-store/test/support/platform-fixtures.js";
import {
  releaseProviderClaim,
  seedProviderClaim,
} from "../../control-store/test/support/accepted-operation.js";
import {
  createD1EnvironmentSecretsPort,
  isD1EnvironmentSecretsRuntime,
} from "../src/d1-environment-secrets.js";
import { createEnvironmentSecretCipherKeyring } from "../src/environment-secret-cipher.js";
import { EnvironmentSecretMutationBlockedError } from "../src/environment-secrets.js";
import { IdempotencyKeyReusedError } from "../src/contracts.js";

it("keeps public secret receipts, ciphertext and delivery generations atomic through replay, rollback and lost responses", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control),
      store = createControlStore(control.bindings),
      clock = { now: () => new Date("2026-10-28T10:30:00.000Z") },
      cipher = createEnvironmentSecretCipherKeyring({
        primaryKeyBase64: Buffer.alloc(32, 0x63).toString("base64"),
        currentKeyVersion: 1,
        crypto: globalThis.crypto,
      }),
      port = createD1EnvironmentSecretsPort({ runtime: store.secrets, clock, cipher }),
      scope = {
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        environmentId: parseUlid(project.prodEnvironmentId),
        principalId: "user:fixture",
        requestId: "req-secret",
      },
      request = {
        ...scope,
        name: "PRIVATE_VALUE",
        value: "private input remains API only",
        idempotencyKey: "first",
        canonicalRequestDigest: new Uint8Array(32).fill(9),
      };
    expect(isD1EnvironmentSecretsRuntime(store.secrets)).toBe(true);
    expect(isD1EnvironmentSecretsRuntime({})).toBe(false);
    const first = await port.put(request);
    expect(first).toMatchObject({
      name: "PRIVATE_VALUE",
      revision: 1,
      desiredGeneration: 1,
      appliedGeneration: 0,
      state: "not_deployed",
    });
    expect(await port.put(request)).toEqual(first);
    const page = await port.list(scope);
    expect(page.items).toHaveLength(1);
    expect(page.delivery.desiredGeneration).toBe(1);
    const encrypted = await control.core
      .prepare(
        "SELECT ciphertext,nonce,value_sha256,key_version FROM environment_secrets WHERE organization_id=? AND environment_id=? AND name=?",
      )
      .bind(project.organizationId, project.prodEnvironmentId, request.name)
      .first<{
        ciphertext: number[];
        nonce: number[];
        value_sha256: number[];
        key_version: number;
      }>();
    expect(encrypted).not.toBeNull();
    // The stored digests are keyed: neither is the unsalted SHA-256 of the value or of the request.
    const storedDigest = Uint8Array.from(encrypted?.value_sha256 ?? []);
    expect(storedDigest).toEqual(
      await cipher.keyedDigest("value", new TextEncoder().encode(request.value)),
    );
    expect(
      Buffer.from(storedDigest).equals(createHash("sha256").update(request.value).digest()),
    ).toBe(false);
    const receipt = await control.core
      .prepare(
        "SELECT request_sha256 FROM environment_secret_requests WHERE organization_id=? AND project_id=? AND environment_id=? AND action='set' AND idempotency_key='first'",
      )
      .bind(project.organizationId, project.projectId, project.prodEnvironmentId)
      .first<{ request_sha256: number[] }>();
    expect(Uint8Array.from(receipt?.request_sha256 ?? [])).toEqual(
      await cipher.keyedDigest("request", request.canonicalRequestDigest),
    );
    expect(
      await cipher.openEnvironmentSecret({
        ...scope,
        name: request.name,
        ciphertext: Uint8Array.from(encrypted?.ciphertext ?? []),
        nonce: Uint8Array.from(encrypted?.nonce ?? []),
        valueSha256: storedDigest,
        keyVersion: encrypted?.key_version ?? 0,
      }),
    ).toBe(request.value);
    await expect(
      port.put({ ...request, canonicalRequestDigest: new Uint8Array(32).fill(10) }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    await seedProviderClaim(project, project.prodEnvironmentId);
    await expect(port.remove({ ...request, idempotencyKey: "blocked" })).rejects.toBeInstanceOf(
      EnvironmentSecretMutationBlockedError,
    );
    await releaseProviderClaim(project);
    await control.core
      .prepare(
        "CREATE TRIGGER api_secret_late_failure BEFORE INSERT ON environment_secret_requests WHEN NEW.idempotency_key='late' BEGIN SELECT RAISE(ABORT,'late secret receipt failure'); END",
      )
      .run();
    await expect(
      port.put({ ...request, name: "LATE_VALUE", idempotencyKey: "late" }),
    ).rejects.toThrow();
    expect((await port.list(scope)).delivery.desiredGeneration).toBe(1);
    expect((await port.list(scope)).items.map((item) => item.name)).toEqual([request.name]);
    const lost = createD1EnvironmentSecretsPort({
      runtime: createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) }).secrets,
      clock,
      cipher,
    });
    expect(await lost.remove({ ...request, idempotencyKey: "remove" })).toMatchObject({
      name: request.name,
      status: "deleted",
      desiredGeneration: 2,
    });
    expect((await port.list(scope)).items).toEqual([]);
    expect(await port.remove({ ...request, idempotencyKey: "remove" })).toMatchObject({
      status: "deleted",
      desiredGeneration: 2,
    });
    expect(await port.remove({ ...request, idempotencyKey: "absent" })).toMatchObject({
      status: "absent",
      desiredGeneration: 2,
    });
    expect(
      await port.list({ ...scope, organizationId: parseUlid("00000000000000000000000001") }),
    ).toEqual({ items: [], delivery: expect.objectContaining({ state: "not_deployed" }) });
  } finally {
    await control.dispose();
  }
}, 30000);
