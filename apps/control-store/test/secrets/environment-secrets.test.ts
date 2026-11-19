import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  bytes,
  seedProject,
  freezeOwnership,
  losingWriteResponses,
  type SeededProject,
} from "../support/platform-fixtures.js";
import { releaseProviderClaim, seedProviderClaim } from "../support/accepted-operation.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

// Mutations follow the seeded environment/state creation at10:00, as the original PostgreSQL time constraint requires.
const sealedSecret = (project: SeededProject, overrides: Record<string, unknown> = {}) => ({
  organizationId: project.organizationId,
  projectId: project.projectId,
  environmentId: project.prodEnvironmentId,
  name: "DATABASE_URL",
  ciphertext: bytes(32, 0xa1),
  nonce: bytes(12, 0xb2),
  valueSha256: bytes(32, 0xc3),
  keyVersion: 1,
  writtenAt: "2026-10-28T10:30:00.000Z",
  ...overrides,
});

const generation = async (project: SeededProject) =>
  (
    await project.shard
      .prepare(
        "SELECT desired_generation AS g FROM runtime_secret_delivery_states WHERE organization_id = ? AND environment_id = ?",
      )
      .bind(project.organizationId, project.prodEnvironmentId)
      .first<{ g: number }>()
  )?.g;

describe("secrets.putEnvironmentSecret", () => {
  it("creates, replays, rotates and lists a sealed secret while advancing the delivery generation", async () => {
    const project = await seedProject(control);
    const first = sealedSecret(project);
    expect(await store.secrets.putEnvironmentSecret(first)).toMatchObject({
      outcome: "created",
      metadata: { name: "DATABASE_URL", revision: 1, keyVersion: 1 },
    });
    expect(await store.secrets.putEnvironmentSecret(first)).toMatchObject({
      outcome: "existing",
      metadata: { revision: 1 },
    });
    expect(await generation(project)).toBe(1);
    expect(
      await store.secrets.putEnvironmentSecret(
        sealedSecret(project, {
          ciphertext: bytes(48, 0xd4),
          nonce: bytes(12, 0xe5),
          valueSha256: bytes(32, 0xf6),
          keyVersion: 2,
          writtenAt: "2026-10-28T10:31:00.000Z",
        }),
      ),
    ).toMatchObject({
      outcome: "updated",
      metadata: { revision: 2, keyVersion: 2, updatedAt: "2026-10-28T10:31:00.000Z" },
    });
    expect(await generation(project)).toBe(2);
    expect(
      await store.secrets.listEnvironmentSecrets({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
      }),
    ).toEqual([expect.objectContaining({ name: "DATABASE_URL", revision: 2, keyVersion: 2 })]);
    const row = await project.shard
      .prepare(
        "SELECT hex(ciphertext) AS c, hex(nonce) AS n, hex(value_sha256) AS v FROM environment_secrets WHERE organization_id = ? AND name = 'DATABASE_URL'",
      )
      .bind(project.organizationId)
      .first<{ c: string; n: string; v: string }>();
    expect(row).toEqual({ c: "D4".repeat(48), n: "E5".repeat(12), v: "F6".repeat(32) });
  });

  it("keeps the Postgres ciphertext contract of 17..65552 bytes and stores multibyte envelopes byte-exact", async () => {
    // The public limit is 5120 UTF-8 bytes, not characters: 1280 four-byte characters are 5120 bytes (+16 tag = 5136),
    // while the same value counted in characters would be 1280. Historical rows may exceed 5136 up to 65552 bytes.
    const multibyte = "😀".repeat(1280);
    const sealedLength = new TextEncoder().encode(multibyte).byteLength + 16;
    expect([multibyte.length, sealedLength]).toEqual([2560, 5136]);
    const project = await seedProject(control);
    const names = ["EDGE_MIN", "EDGE_PUBLIC_MAX", "EDGE_HISTORICAL_MAX"];
    const lengths = [17, sealedLength, 65_552];
    for (const [index, length] of lengths.entries()) {
      const ciphertext = Uint8Array.from({ length }, (_, at) => (at * 7 + index) & 0xff);
      await store.secrets.putEnvironmentSecret(
        sealedSecret(project, { name: names[index], ciphertext }),
      );
      const row = await project.shard
        .prepare(
          "SELECT length(ciphertext) AS n, hex(ciphertext) AS c FROM environment_secrets WHERE organization_id = ? AND name = ?",
        )
        .bind(project.organizationId, names[index])
        .first<{ n: number; c: string }>();
      expect(row?.n).toBe(length);
      expect(row?.c).toBe(
        [...ciphertext]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase(),
      );
    }
    for (const length of [16, 65_553]) {
      await expect(
        store.secrets.putEnvironmentSecret(
          sealedSecret(project, { name: "EDGE_OUT", ciphertext: bytes(length, 1) }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      project.shard
        .prepare(
          "INSERT INTO environment_secrets(organization_id, project_id, environment_id, name, ciphertext, nonce, value_sha256, key_version, revision, created_at, updated_at) VALUES (?1, ?2, ?3, 'EDGE_DDL', ?4, ?5, ?6, 1, 1, '2026-10-28T10:30:00.000000Z', '2026-10-28T10:30:00.000000Z')",
        )
        .bind(
          project.organizationId,
          project.projectId,
          project.prodEnvironmentId,
          bytes(65_553, 1),
          bytes(12, 1),
          bytes(32, 1),
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("lists nothing for another organization and fails closed when the scope is not active", async () => {
    const project = await seedProject(control);
    const other = await seedProject(control);
    await store.secrets.putEnvironmentSecret(sealedSecret(project));
    expect(
      await store.secrets.listEnvironmentSecrets({
        organizationId: other.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
      }),
    ).toEqual([]);
    await freezeOwnership(project);
    await expect(
      store.secrets.putEnvironmentSecret(sealedSecret(project, { name: "OTHER" })),
    ).rejects.toMatchObject({ code: "environment_secret_scope_inactive" });
    expect(
      await store.secrets.listEnvironmentSecrets({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
      }),
    ).toEqual([]);
  });

  it("rejects malformed input before touching the store", async () => {
    const project = await seedProject(control);
    await expect(
      store.secrets.putEnvironmentSecret(sealedSecret(project, { name: "lowercase" })),
    ).rejects.toThrow();
    await expect(
      store.secrets.putEnvironmentSecret(sealedSecret(project, { nonce: bytes(11, 1) })),
    ).rejects.toThrow();
  });

  it("never rewrites an envelope without a revision bump (database trigger)", async () => {
    const project = await seedProject(control);
    await store.secrets.putEnvironmentSecret(sealedSecret(project));
    await expect(
      project.shard
        .prepare(
          "UPDATE environment_secrets SET ciphertext = ?1 WHERE organization_id = ?2 AND name = 'DATABASE_URL'",
        )
        .bind(bytes(32, 9), project.organizationId)
        .run(),
    ).rejects.toThrow(/envelope changes only with a revision bump/u);
    await expect(
      project.shard
        .prepare(
          "UPDATE environment_secrets SET name = 'RENAMED' WHERE organization_id = ?1 AND name = 'DATABASE_URL'",
        )
        .bind(project.organizationId)
        .run(),
    ).rejects.toThrow(/secret identity is immutable/u);
  });

  it("authorizes platform writes by the project's current provider mutation claim", async () => {
    const project = await seedProject(control);
    const claim = await seedProviderClaim(project, project.prodEnvironmentId);
    expect(
      await store.secrets.authorizeProviderEnvironmentSecret({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
        ...claim,
      }),
    ).toEqual({ authorized: true });
    expect(
      await store.secrets.putEnvironmentSecret(
        sealedSecret(project, { name: "OHMYHOST_PLATFORM_KEY", claim }),
      ),
    ).toMatchObject({ outcome: "created" });
    await expect(
      store.secrets.putEnvironmentSecret(
        sealedSecret(project, {
          name: "OTHER_KEY",
          claim: { ...claim, claimId: "0".repeat(26) },
        }),
      ),
    ).rejects.toMatchObject({ code: "environment_secret_scope_inactive" });
    await expect(
      store.secrets.authorizeProviderEnvironmentSecret({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.devEnvironmentId,
        ...claim,
      }),
    ).rejects.toMatchObject({ code: "environment_secret_scope_inactive" });
  });
});

describe("secrets.ensureEnvironmentSecret", () => {
  it("lets exactly one candidate win concurrently and bumps the delivery generation once", async () => {
    const project = await seedProject(control);
    const before = await generation(project);
    const outcomes = await Promise.all(
      [1, 2].map((index) =>
        store.secrets.ensureEnvironmentSecret(
          sealedSecret(project, {
            name: "BETTER_AUTH_SECRET",
            ciphertext: bytes(48, index),
            nonce: bytes(12, index + 10),
            valueSha256: bytes(32, index + 20),
            writtenAt: `2026-10-28T10:3${index}:00.000Z`,
          }),
        ),
      ),
    );
    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["created", "existing"]);
    expect(outcomes.every(({ metadata }) => metadata.revision === 1)).toBe(true);
    expect(await generation(project)).toBe((before ?? 0) + 1);
  });
});

describe("secrets.mutateEnvironmentSecret", () => {
  const mutation = (project: SeededProject, overrides: Record<string, unknown> = {}) => ({
    ...sealedSecret(project),
    action: "set",
    idempotencyKey: "secret-set-1",
    requestSha256: bytes(32, 0x72),
    requestedAt: "2026-10-28T10:40:00.000Z",
    ...overrides,
  });
  const deletion = (project: SeededProject, overrides: Record<string, unknown> = {}) => ({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    name: "DATABASE_URL",
    action: "delete",
    idempotencyKey: "secret-delete-1",
    requestSha256: bytes(32, 0x74),
    requestedAt: "2026-10-28T10:41:00.000Z",
    ...overrides,
  });

  it("stores the effect and its receipt together, replays by digest and refuses a changed request", async () => {
    const project = await seedProject(control);
    const stored = await store.secrets.mutateEnvironmentSecret(mutation(project));
    expect(stored).toMatchObject({
      status: "stored",
      secret: { name: "DATABASE_URL", revision: 1, createdAt: "2026-10-28T10:30:00.000Z" },
    });
    expect(await store.secrets.mutateEnvironmentSecret(mutation(project))).toEqual(stored);
    await expect(
      store.secrets.mutateEnvironmentSecret(mutation(project, { requestSha256: bytes(32, 0x73) })),
    ).rejects.toMatchObject({ code: "environment_secret_idempotency_conflict" });
    const receipt = await project.shard
      .prepare("SELECT response FROM environment_secret_requests WHERE organization_id = ?")
      .bind(project.organizationId)
      .first<{ response: string }>();
    expect(receipt?.response).not.toContain("ciphertext");
    expect(await generation(project)).toBe(1);
  });

  it("deletes once and reports a repeated delete with a new key as absent", async () => {
    const project = await seedProject(control);
    await store.secrets.mutateEnvironmentSecret(mutation(project));
    expect(await store.secrets.mutateEnvironmentSecret(deletion(project))).toEqual({
      status: "deleted",
      name: "DATABASE_URL",
    });
    expect(
      await store.secrets.mutateEnvironmentSecret(
        deletion(project, { idempotencyKey: "secret-delete-2" }),
      ),
    ).toEqual({ status: "absent", name: "DATABASE_URL" });
    expect(await store.secrets.mutateEnvironmentSecret(deletion(project))).toEqual({
      status: "deleted",
      name: "DATABASE_URL",
    });
    expect(await generation(project)).toBe(2);
  });

  it("is blocked while a deployment holds the project's provider claim", async () => {
    const project = await seedProject(control);
    await seedProviderClaim(project, project.prodEnvironmentId);
    await expect(store.secrets.mutateEnvironmentSecret(mutation(project))).rejects.toMatchObject({
      code: "environment_secret_mutation_blocked",
    });
    await releaseProviderClaim(project);
    expect(await store.secrets.mutateEnvironmentSecret(mutation(project))).toMatchObject({
      status: "stored",
    });
  });

  it("applies a committed mutation once when the response is lost and the same command is re-sent", async () => {
    const project = await seedProject(control);
    const flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    const stored = await flaky.secrets.mutateEnvironmentSecret(mutation(project));
    expect(stored).toMatchObject({ status: "stored", secret: { revision: 1 } });
    expect(await generation(project)).toBe(1);
  });

  it("serializes racing twins of one request into a single effect", async () => {
    const project = await seedProject(control);
    const results = await Promise.all([
      store.secrets.mutateEnvironmentSecret(mutation(project)),
      store.secrets.mutateEnvironmentSecret(mutation(project)),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await generation(project)).toBe(1);
  });
});

describe("secrets ownership, replay-by-value and delete races", () => {
  it("never writes a secret through another organization's scope or a foreign project id", async () => {
    const project = await seedProject(control);
    const other = await seedProject(control, { shard: 1 });
    await expect(
      store.secrets.putEnvironmentSecret(
        sealedSecret(project, { organizationId: other.organizationId }),
      ),
    ).rejects.toMatchObject({ code: "environment_secret_scope_inactive" });
    await expect(
      store.secrets.putEnvironmentSecret(sealedSecret(project, { projectId: other.projectId })),
    ).rejects.toMatchObject({ code: "environment_secret_scope_inactive" });
    await expect(
      store.secrets.putEnvironmentSecret(
        sealedSecret(project, { environmentId: other.prodEnvironmentId }),
      ),
    ).rejects.toMatchObject({ code: "environment_secret_scope_inactive" });
    for (const owner of [project, other]) {
      const row = await owner.shard
        .prepare("SELECT count(*) AS n FROM environment_secrets WHERE organization_id IN (?1, ?2)")
        .bind(project.organizationId, other.organizationId)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
  });

  it("treats a set of the identical value under a new idempotency key as a stored no-op that still records its receipt", async () => {
    const project = await seedProject(control);
    const set = (key: string) => ({
      ...sealedSecret(project),
      action: "set",
      idempotencyKey: key,
      requestSha256: bytes(32, 0x80),
      requestedAt: "2026-10-28T10:40:00.000Z",
    });
    const first = await store.secrets.mutateEnvironmentSecret(set("same-value-1"));
    const second = await store.secrets.mutateEnvironmentSecret(set("same-value-2"));
    expect(second).toEqual(first);
    expect(await generation(project)).toBe(1);
    const receipts = await project.shard
      .prepare("SELECT count(*) AS n FROM environment_secret_requests WHERE organization_id = ?")
      .bind(project.organizationId)
      .first<{ n: number }>();
    expect(receipts?.n).toBe(2);
    await freezeOwnership(project);
    await expect(store.secrets.mutateEnvironmentSecret(set("same-value-3"))).rejects.toMatchObject({
      code: "environment_secret_scope_inactive",
    });
  });

  it("advances the delivery generation once when two different delete requests race for one secret", async () => {
    const project = await seedProject(control);
    await store.secrets.putEnvironmentSecret(sealedSecret(project));
    const before = await generation(project);
    const deletion = (key: string) => ({
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
      name: "DATABASE_URL",
      action: "delete",
      idempotencyKey: key,
      requestSha256: bytes(32, 0x75),
      requestedAt: "2026-10-28T10:41:00.000Z",
    });
    const results = await Promise.all([
      store.secrets.mutateEnvironmentSecret(deletion("race-1")),
      store.secrets.mutateEnvironmentSecret(deletion("race-2")),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["absent", "deleted"]);
    expect(await generation(project)).toBe((before ?? 0) + 1);
  });

  it("revokes a provider claim's authority when its operation finishes", async () => {
    const project = await seedProject(control);
    const claim = await seedProviderClaim(project, project.prodEnvironmentId);
    await project.shard
      .prepare(
        "UPDATE operations SET state = 'succeeded', result_deployment_id = '0' || substr(?3, 2), result_url = 'https://x.example', result_artifact_sha256 = ?4 WHERE organization_id = ?1 AND operation_id = ?2",
      )
      .bind(project.organizationId, claim.operationId, claim.operationId, bytes(32, 1))
      .run();
    await expect(
      store.secrets.authorizeProviderEnvironmentSecret({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
        ...claim,
      }),
    ).rejects.toMatchObject({ code: "environment_secret_scope_inactive" });
  });
});
