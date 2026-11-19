import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import {
  createRecoveryControlHandler,
  sha256Hex,
} from "../../recovery-container/src/control-mediator.js";
import { createRecoveryControlClient } from "../src/control-client.js";
import { createRecoveryArchiveStore } from "../src/r2-archives.js";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";

it("reconciles an uncertain restore pin through scoped control and a permanent conditional marker", async () => {
  const organizationId = "00000000000000000000000001",
    projectId = "00000000000000000000000002",
    restoreId = "00000000000000000000000003",
    principalId = "owner-fixture",
    bucket = "ohmyho-development-backups",
    token = "t".repeat(43);
  const scope = { organizationId, projectId, restoreId },
    key = `restore-pins/${organizationId}/${projectId}/${restoreId}.zip`;
  const archive = new Uint8Array(10);
  const digest = createHash("sha256").update(archive).digest();
  let object: { bytes: Buffer; type: string } | undefined,
    state: "reserved" | "tombstoned" = "reserved";
  const store = createRecoveryArchiveStore(
    {
      accountId: "a".repeat(32),
      bucket,
      accessKeyId: "b".repeat(32),
      apiToken: "fixture-private-token-long",
      now: () => new Date(),
    },
    {
      async send(command: unknown) {
        if (command instanceof GetBucketLifecycleConfigurationCommand)
          throw Object.assign(new Error(), { name: "NoSuchLifecycleConfiguration" });
        if (command instanceof GetObjectCommand) {
          if (!object) throw { $metadata: { httpStatusCode: 404 } };
          return {
            Body: Readable.from([object.bytes]),
            ContentLength: object.bytes.length,
            ContentType: object.type,
          };
        }
        if (command instanceof PutObjectCommand) {
          if (object) throw { $metadata: { httpStatusCode: 412 } };
          expect(command.input.IfNoneMatch).toBe("*");
          object = {
            bytes: Buffer.from(command.input.Body as Uint8Array),
            type: String(command.input.ContentType),
          };
          return {};
        }
        throw new Error("unexpected provider operation");
      },
      destroy() {},
    } as never,
  );
  const authority = {
    async readPinReconciliation(value: unknown) {
      expect(value).toEqual({ ...scope, principalId });
      return { bucket, key, bytes: 10, sha256: digest.toString("hex"), state };
    },
    async completePinReconciliation(value: unknown) {
      expect(value).toEqual({ ...scope, principalId, outcome: "tombstoned" });
      if (!object) throw new Error("marker missing");
      state = "tombstoned";
      return { status: state };
    },
  };
  const handler = createRecoveryControlHandler<object>({
    clock: { now: () => new Date("2026-11-04T00:00:00.000Z") },
    dependencies: () => ({
      store: {} as never,
      restore: {
        store: authority as never,
        admin: () => {
          throw new Error("unexpected admin");
        },
        preparation: () => {
          throw new Error("unexpected preparation");
        },
      },
    }),
  });
  const grant = {
    containerId: "fixture",
    action: "reconcile-restore-pin",
    organizationId,
    projectId,
    operationId: restoreId,
    principalId,
    tokenSha256: await sha256Hex(token),
    expiresAtMs: Date.parse("2026-11-04T01:00:00.000Z"),
  };
  const client = createRecoveryControlClient({
    token,
    attempts: 1,
    fetch: (async (url: string | URL | Request, init?: RequestInit) =>
      handler(
        new Request(url, init),
        {},
        { containerId: "fixture", className: "RecoverySandbox", params: grant },
      )) as typeof fetch,
  });
  const runtime = createRecoveryRuntime({
    control: client,
    archives: store,
    archiveDownloads: store,
    clock: { now: () => new Date() },
    cipher: {} as never,
    database: {} as never,
  });
  const command = { action: "reconcile-restore-pin", ...scope, principalId };
  await expect(runtime(command)).resolves.toEqual({ status: "tombstoned", restoreId });
  await expect(runtime(command)).resolves.toEqual({ status: "tombstoned", restoreId });
  await expect(
    store.pinVerified({
      bucket,
      scope,
      archive,
      bytes: 10,
      sha256: digest,
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toThrow();
  expect(state).toBe("tombstoned");
  store.close();
});
