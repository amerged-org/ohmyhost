import { describe, expect, it, vi } from "vitest";

import { createRecoveryRuntime } from "../src/recovery-runtime.js";
import { createRecoveryControlClient } from "../src/control-client.js";
import {
  CONTROL_ERROR_CODES,
  MAX_CONTROL_RESPONSE_BYTES,
  RecoveryControlError,
  decodeBytes,
  decodeControlResult,
  encodeBytes,
  encodeControlBody,
  encodeControlResult,
  isUlid,
  isUuid,
  parseControlBody,
} from "../src/control-wire.js";

const HOLDER = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const sha = new Uint8Array(32).map((_, index) => (index * 7 + 200) % 256);
const archive = {
  sqlFiles: ["dev.sql"],
  bytes: 10,
  sha256: sha,
  capturedAt: "2026-10-28T10:00:00.000Z",
};
const wireArchive = { ...archive, sha256: encodeBytes(sha) };
const fence = { epoch: 1, holderId: HOLDER };
const bad = (method: Parameters<typeof parseControlBody>[0], body: unknown) =>
  expect(() => parseControlBody(method, body)).toThrow(RecoveryControlError);

describe("control wire", () => {
  it("round-trips every byte value exactly and refuses non-canonical encodings", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect([...decodeBytes(encodeBytes(all), 0, 512)]).toEqual([...all]);
    expect(isUlid(ULID)).toBe(true);
    expect(isUlid("nope")).toBe(false);
    expect(isUuid(HOLDER)).toBe(true);
    expect(isUuid(7)).toBe(false);
    for (const value of [7, "!!!", "AQ", "AQ==\n", encodeBytes(all) + "=", " AQ=="])
      expect(() => decodeBytes(value, 0, 512)).toThrow(RecoveryControlError);
    expect(() => decodeBytes(encodeBytes(all), 0, 10)).toThrow(RecoveryControlError);
    expect(() => decodeBytes("AQ==", 2, 10)).toThrow(RecoveryControlError);
    const encoded = JSON.parse(encodeControlResult({ value: all, none: undefined })) as {
      value: { $b64: string };
    };
    expect(encoded.value.$b64).toBe(encodeBytes(all));
    expect(encodeControlResult(undefined)).toBe("null");
    expect(JSON.parse(encodeControlBody({ sha: sha, n: 1 }))).toEqual({
      sha: encodeBytes(sha),
      n: 1,
    });
  });

  it("validates each closed request body and refuses smuggled or foreign fields", () => {
    for (const method of ["readClaimState", "readInventory", "readArchive"] as const) {
      expect(parseControlBody(method, {})).toEqual({});
      bad(method, { organizationId: ULID });
      bad(method, null);
      bad(method, []);
      bad(method, "x");
    }
    expect(parseControlBody("claim", {})).toEqual({});
    expect(parseControlBody("claim", { holderId: HOLDER })).toEqual({ holderId: HOLDER });
    // Inside a fence the claim names the holder AND the epoch its denial releases; nothing else.
    expect(parseControlBody("claim", { ...fence })).toEqual(fence);
    bad("claim", { epoch: 1 });
    bad("claim", { ...fence, extra: 1 });
    bad("claim", { epoch: 0, holderId: HOLDER });
    bad("claim", { holderId: "x" });
    bad("claim", { operationId: ULID });
    bad("claim", 1);
    expect(parseControlBody("acquireFence", { holderId: HOLDER, leaseMilliseconds: 5000 })).toEqual(
      {
        holderId: HOLDER,
        leaseMilliseconds: 5000,
      },
    );
    bad("acquireFence", { holderId: HOLDER, leaseMilliseconds: 999 });
    bad("acquireFence", { holderId: HOLDER, leaseMilliseconds: 900_001 });
    bad("acquireFence", { holderId: HOLDER, leaseMilliseconds: 5000.5 });
    bad("acquireFence", { holderId: HOLDER });
    expect(parseControlBody("renewFence", { ...fence, leaseMilliseconds: 5000 })).toEqual({
      ...fence,
      leaseMilliseconds: 5000,
    });
    bad("renewFence", { ...fence, epoch: 0, leaseMilliseconds: 5000 });
    bad("renewFence", { ...fence, leaseMilliseconds: 5000, extra: 1 });
    expect(parseControlBody("releaseFence", fence)).toEqual(fence);
    bad("releaseFence", { epoch: 1.5, holderId: HOLDER });
    bad("releaseFence", { epoch: 1, holderId: "x" });
    const prepared = parseControlBody("prepareArchive", { archive: wireArchive, fence }) as {
      archive: { sha256: Uint8Array };
    };
    expect([...prepared.archive.sha256]).toEqual([...sha]);
    expect(
      parseControlBody("prepareArchive", {
        archive: {
          ...wireArchive,
          sqlFiles: ["dev.sql", "prod.sql", "auth.sql"],
          nativeManifest: '{"a":1}',
          nativeManifestSha256: encodeBytes(sha),
        },
        fence,
      }),
    ).toMatchObject({ archive: { sqlFiles: ["dev.sql", "prod.sql", "auth.sql"] } });
    bad("prepareArchive", { archive: wireArchive });
    bad("prepareArchive", { archive: { ...wireArchive, sqlFiles: [] }, fence });
    bad("prepareArchive", {
      archive: { ...wireArchive, sqlFiles: ["a.sql", "b.sql", "c.sql"] },
      fence,
    });
    bad("prepareArchive", { archive: { ...wireArchive, sqlFiles: ["../x.sql"] }, fence });
    bad("prepareArchive", { archive: { ...wireArchive, bytes: 0 }, fence });
    bad("prepareArchive", { archive: { ...wireArchive, bytes: 536_870_913 }, fence });
    bad("prepareArchive", {
      archive: { ...wireArchive, sha256: encodeBytes(sha.slice(1)) },
      fence,
    });
    bad("prepareArchive", { archive: { ...wireArchive, capturedAt: "2026-10-28" }, fence });
    expect(parseControlBody("discardArchive", { archive: wireArchive, fence })).toHaveProperty(
      "fence",
    );
    bad("discardArchive", { archive: wireArchive });
    bad("discardArchive", { archive: { ...wireArchive, bytes: 0 }, fence });
    bad("discardArchive", { archive: wireArchive, fence, extra: 1 });
    bad("prepareArchive", {
      archive: { ...wireArchive, capturedAt: "2026-02-31T10:00:00.000Z" },
      fence,
    });
    expect(parseControlBody("finish", { archive: wireArchive, fence })).toHaveProperty("fence");
    expect(parseControlBody("finish", { failureCode: "RECOVERY_IO_FAILED", fence })).toEqual({
      failureCode: "RECOVERY_IO_FAILED",
      fence,
    });
    expect(parseControlBody("finish", { failureCode: "RECOVERY_SCOPE_UNAVAILABLE" })).toEqual({
      failureCode: "RECOVERY_SCOPE_UNAVAILABLE",
    });
    bad("finish", { failureCode: "lower case" });
    bad("finish", { failureCode: "X", extra: 1 });
    bad("finish", { archive: wireArchive });
    bad("finish", { failureCode: "X", fence, extra: 1 });
  });

  it("decodes only well-shaped answers and keeps binary exact", () => {
    const decode = (method: Parameters<typeof decodeControlResult>[0], value: unknown) =>
      decodeControlResult(method, encodeControlResult(value));
    const unavailable = (method: Parameters<typeof decodeControlResult>[0], value: unknown) =>
      expect(() =>
        decodeControlResult(method, typeof value === "string" ? value : encodeControlResult(value)),
      ).toThrow(RecoveryControlError);
    expect(decode("readClaimState", null)).toBeNull();
    expect(decode("readClaimState", { status: "running" })).toEqual({ status: "running" });
    unavailable("readClaimState", { status: "weird" });
    unavailable("readClaimState", "not json");
    expect(decode("claim", { status: "absent" })).toEqual({ status: "absent" });
    expect(decode("discardArchive", { outcome: "discarded" })).toEqual({ outcome: "discarded" });
    expect(decode("discardArchive", { outcome: "replayed" })).toEqual({ outcome: "replayed" });
    unavailable("discardArchive", { outcome: "prepared" });
    const ciphertext = Uint8Array.from({ length: 64 }, (_, index) => 255 - index);
    const nonce = Uint8Array.from({ length: 12 }, (_, index) => index * 21);
    const key = `snapshots/${ULID}/${ULID}/${ULID}.zip`;
    const claimed = {
      status: "claimed",
      preparedArchive: archive,
      expired: false,
      denialCode: "RECOVERY_INPUT_EXPIRED",
      replayed: true,
      archiveBucket: "ohmyho-production-backups",
      archiveKey: key,
      sealedInput: { ciphertext, nonce, keyVersion: 3 },
    };
    const result = decode("claim", claimed) as typeof claimed;
    expect([...result.sealedInput.ciphertext]).toEqual([...ciphertext]);
    expect([...result.sealedInput.nonce]).toEqual([...nonce]);
    expect([...(result.preparedArchive as typeof archive).sha256]).toEqual([...sha]);
    expect(result).toMatchObject({
      denialCode: "RECOVERY_INPUT_EXPIRED",
      replayed: true,
      expired: false,
    });
    expect(
      decode("claim", {
        ...claimed,
        preparedArchive: null,
        sealedInput: null,
        denialCode: null,
        replayed: 0,
      }),
    ).toMatchObject({
      preparedArchive: null,
      sealedInput: null,
      denialCode: null,
      replayed: false,
    });
    unavailable("claim", { ...claimed, archiveBucket: "other" });
    unavailable("claim", { ...claimed, archiveKey: "snapshots/x" });
    unavailable("claim", { ...claimed, denialCode: "OTHER" });
    unavailable("claim", { ...claimed, sealedInput: { ciphertext: "raw", nonce, keyVersion: 1 } });
    unavailable("claim", { ...claimed, sealedInput: { ciphertext, nonce, keyVersion: 0 } });
    const lease = {
      outcome: "acquired",
      epoch: 2,
      holderId: HOLDER,
      leaseExpiresAt: "2026-10-28T10:05:00.000Z",
      sourceOwnershipVersion: 1,
      sourceLifecycleVersion: 4,
    };
    expect(decode("acquireFence", lease)).toEqual(lease);
    expect(decode("renewFence", { ...lease, outcome: "renewed" })).toMatchObject({
      outcome: "renewed",
    });
    unavailable("renewFence", { ...lease, outcome: "x" });
    unavailable("acquireFence", { ...lease, leaseExpiresAt: 7 });
    unavailable("acquireFence", { ...lease, holderId: "x" });
    for (const outcome of ["released", "replayed", "superseded", "absent"])
      expect(decode("releaseFence", { outcome })).toEqual({ outcome });
    unavailable("releaseFence", { outcome: "gone" });
    expect(decode("prepareArchive", { outcome: "prepared" })).toEqual({ outcome: "prepared" });
    unavailable("prepareArchive", { outcome: "x" });
    expect(decode("finish", { outcome: "waiting", status: "running" })).toEqual({
      outcome: "waiting",
      status: "running",
    });
    unavailable("finish", { outcome: "finished", status: "x" });
    expect(decode("readInventory", null)).toBeNull();
    const reference = {
      provider: "pgcf",
      providerProjectId: `prj_${"b".repeat(20)}`,
      databaseId: "a".repeat(20),
      regionId: "eu-dev",
      postgresVersion: "18",
      databaseName: "a".repeat(20),
      roleName: `ohmyho_backup_${ULID.toLowerCase()}`,
      databaseEnvironmentId: ULID,
      targetVersion: 2,
    };
    const inventory = {
      dataMode: "shared",
      ownershipVersion: 1,
      lifecycleVersion: 1,
      environments: [
        { environmentId: ULID, name: "dev", databaseEnvironmentId: ULID, database: reference },
        { environmentId: ULID, name: "prod", databaseEnvironmentId: ULID, database: null },
      ],
    };
    expect(decode("readInventory", inventory)).toEqual(inventory);
    const productionOnly = { ...inventory, environments: [inventory.environments[1]] };
    expect(decode("readInventory", productionOnly)).toEqual(productionOnly);
    unavailable("readInventory", { ...inventory, environments: [] });
    unavailable("readInventory", { ...inventory, environments: [inventory.environments[0]] });
    unavailable("readInventory", {
      ...inventory,
      environments: [inventory.environments[1], inventory.environments[1]],
    });
    unavailable("readInventory", {
      ...inventory,
      environments: [inventory.environments[1], inventory.environments[0]],
    });
    unavailable("readInventory", {
      ...inventory,
      environments: [
        { ...inventory.environments[0], database: { ...reference, provider: "neon" } },
        inventory.environments[1],
      ],
    });
    expect(decode("readArchive", null)).toBeNull();
    const locator = {
      ...archive,
      operationId: ULID,
      bucket: "ohmyho-development-backups",
      key,
      expiresAt: "2026-11-04T10:00:00.000Z",
    };
    expect(decode("readArchive", locator)).toEqual(locator);
    unavailable("readArchive", { ...locator, key: 5 });
    unavailable("readArchive", { ...locator, sqlFiles: "dev.sql" });
    unavailable("readArchive", { ...locator, sha256: ciphertext.slice(0, 31) });
    expect(CONTROL_ERROR_CODES.length).toBeGreaterThan(5);
  });
});

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(encodeControlResult(value), { status: 200, ...init });
const TOKEN = "t".repeat(43);
const client = (fetcher: typeof fetch, attempts = 3) =>
  createRecoveryControlClient({
    token: TOKEN,
    fetch: fetcher,
    attempts,
    sleep: async () => undefined,
  });

describe("control client", () => {
  it("refuses a malformed token and calls only the virtual host with the bearer token", async () => {
    expect(() => createRecoveryControlClient({ token: "short" })).toThrow(TypeError);
    const seen: { url: string; init: RequestInit }[] = [];
    const port = client((async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return json(null);
    }) as unknown as typeof fetch);
    expect(await port.readClaimState()).toBeNull();
    expect(await port.readInventory()).toBeNull();
    expect(await port.readArchive()).toBeNull();
    expect(seen.map((call) => call.url)).toEqual([
      "http://recovery-control.internal/v1/readClaimState",
      "http://recovery-control.internal/v1/readInventory",
      "http://recovery-control.internal/v1/readArchive",
    ]);
    const discarding = client((async () =>
      json({ outcome: "discarded" })) as unknown as typeof fetch);
    expect(
      await discarding.discardArchive({
        archive: {
          sqlFiles: ["dev.sql"],
          bytes: 1,
          sha256: new Uint8Array(32),
          capturedAt: "2026-10-28T10:00:00.000Z",
        },
        fence: { epoch: 1, holderId: HOLDER },
      }),
    ).toEqual({ outcome: "discarded" });
    expect(seen[0]?.init).toMatchObject({ method: "POST", redirect: "error", body: "{}" });
    expect((seen[0]?.init.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("maps every refusal to a closed error and never leaks a body", async () => {
    const answer = (response: () => Response | Promise<Response>, attempts = 1) =>
      client((async () => response()) as unknown as typeof fetch, attempts);
    await expect(
      answer(() => json({ code: "recovery_fence_lost" }, { status: 409 })).readInventory(),
    ).rejects.toMatchObject({ code: "recovery_fence_lost" });
    await expect(
      answer(() => new Response("<html>token=secret</html>", { status: 403 })).readInventory(),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      answer(() => new Response("<html>", { status: 502 })).readInventory(),
    ).rejects.toMatchObject({ code: "control_outcome_unknown", retryable: true });
    await expect(
      answer(() => json({ code: "not-a-code" }, { status: 400 })).readInventory(),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      answer(() => new Response("{}", { status: 200 })).readClaimState(),
    ).rejects.toMatchObject({ code: "control_unavailable" });
    await expect(
      answer(() => new Response(null, { status: 200 })).readClaimState(),
    ).rejects.toMatchObject({ code: "control_unavailable" });
    await expect(
      answer(
        () =>
          new Response("x", {
            status: 200,
            headers: { "content-length": String(MAX_CONTROL_RESPONSE_BYTES + 1) },
          }),
      ).readClaimState(),
    ).rejects.toMatchObject({ code: "control_unavailable" });
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_CONTROL_RESPONSE_BYTES + 1));
          controller.close();
        },
      }),
    );
    await expect(answer(() => oversized).readClaimState()).rejects.toMatchObject({
      code: "control_unavailable",
    });
    const torn = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("reset"));
        },
      }),
    );
    await expect(answer(() => torn).readClaimState()).rejects.toMatchObject({
      code: "control_outcome_unknown",
    });
    const parts = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status"'));
          controller.enqueue(new TextEncoder().encode(':"running"}'));
          controller.close();
        },
      }),
    );
    await expect(answer(() => parts).readClaimState()).resolves.toEqual({ status: "running" });
  });

  it("retries only retryable outcomes, bounded, and sends the closed bodies", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const port = client((async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      calls += 1;
      if (calls < 3) throw new TypeError("reset");
      return json({ outcome: "released" });
    }) as unknown as typeof fetch);
    expect(await port.releaseFence(fence)).toEqual({ outcome: "released" });
    expect(calls).toBe(3);
    calls = -10;
    await expect(port.releaseFence(fence)).rejects.toMatchObject({
      code: "control_outcome_unknown",
    });
    expect(calls).toBe(-7);
    const forbidden = vi.fn(async () => json({ code: "forbidden" }, { status: 403 }));
    await expect(client(forbidden as unknown as typeof fetch).claim()).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(forbidden).toHaveBeenCalledTimes(1);
    const sink = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return json({
        outcome: "acquired",
        epoch: 1,
        holderId: HOLDER,
        leaseExpiresAt: "2026-10-28T10:05:00.000Z",
        sourceOwnershipVersion: 1,
        sourceLifecycleVersion: 1,
      });
    });
    const all = client(sink as unknown as typeof fetch);
    await all.acquireFence({ holderId: HOLDER, leaseMilliseconds: 5000 });
    await all.renewFence({ ...fence, leaseMilliseconds: 5000 });
    sink.mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return json({ outcome: "prepared" });
    });
    await all.prepareArchive({ archive, fence });
    sink.mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return json({ outcome: "finished", status: "succeeded" });
    });
    await all.finish({ archive, fence });
    expect(bodies.at(-1)).toBe(JSON.stringify({ archive: wireArchive, fence }));
    // The default sleeper and the default attempt bound are real.
    const real = createRecoveryControlClient({
      token: TOKEN,
      fetch: (async () => json(null)) as unknown as typeof fetch,
      attempts: 99,
    });
    expect(await real.readClaimState()).toBeNull();
    let flaky = 0;
    const retried = createRecoveryControlClient({
      token: TOKEN,
      fetch: (async () => {
        if (flaky++ === 0) throw new TypeError("connection reset");
        return json(null);
      }) as unknown as typeof fetch,
      attempts: 2,
    });
    expect(await retried.readClaimState()).toBeNull();
    expect(flaky).toBe(2);
    const failing = createRecoveryControlClient({
      token: TOKEN,
      fetch: (async () => {
        throw new TypeError("x");
      }) as unknown as typeof fetch,
      attempts: 1,
    });
    await expect(failing.readClaimState()).rejects.toMatchObject({
      code: "control_outcome_unknown",
    });
  });
});

describe("recovery runtime caller", () => {
  const scope = {
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
    operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
  };
  const now = new Date("2026-10-28T10:00:00.000Z");
  const locator = (operationId: string, expiresAt: string) => ({
    ...archive,
    operationId,
    bucket: "ohmyho-development-backups",
    key: "k",
    expiresAt,
  });
  const runtime = (readArchive: () => Promise<unknown>) => {
    const download = vi.fn(async () => ({
      url: "https://signed.example/x",
      expiresAt: "2026-10-29T10:00:00.000Z",
    }));
    const run = createRecoveryRuntime({
      control: { readArchive } as never,
      archiveDownloads: { download, remove: vi.fn() } as never,
      clock: { now: () => now },
    } as never);
    return { run, download };
  };

  it("serves a download only for this operation's unexpired archive and refuses an unproven purge", async () => {
    const ready = runtime(async () => locator(scope.operationId, "2026-11-04T10:00:00.000Z"));
    expect(await ready.run({ action: "download", ...scope })).toEqual({
      status: "ready",
      operationId: scope.operationId,
      bytes: 10,
      sha256: `sha256:${Buffer.from(sha).toString("hex")}`,
      sqlFiles: ["dev.sql"],
      capturedAt: archive.capturedAt,
      archiveExpiresAt: "2026-11-04T10:00:00.000Z",
      url: "https://signed.example/x",
      downloadExpiresAt: "2026-10-29T10:00:00.000Z",
    });
    expect(ready.download).toHaveBeenCalledWith({
      bucket: "ohmyho-development-backups",
      key: "k",
      archiveExpiresAt: "2026-11-04T10:00:00.000Z",
    });
    for (const archiveValue of [
      null,
      locator("01ARZ3NDEKTSV4RRFFQ69G5FAZ", "2026-11-04T10:00:00.000Z"),
      locator(scope.operationId, "2026-10-29T09:59:59.000Z"),
    ]) {
      const refused = runtime(async () => archiveValue);
      expect(await refused.run({ action: "download", ...scope })).toEqual({
        status: "unavailable",
      });
      expect(refused.download).not.toHaveBeenCalled();
    }
    // Purge stays closed (never a success or a no-op) until the deletion acceptance writer freezes the cleanup inventory.
    await expect(
      ready.run({ action: "purge", ...scope, exportId: scope.operationId }),
    ).rejects.toThrow("recovery_cleanup_scope_unavailable");
  });
});
