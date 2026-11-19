import type { BuildStartCommand, BuildState } from "@ohmyhost/build-broker";
import { describe, expect, it, vi } from "vitest";

import {
  BuildExecutorError,
  createSandboxExecutor,
  type BuildSandboxStub,
} from "../src/sandbox-executor.js";

const OPERATION_ID = "01J00000000000000000000003";
const OTHER_OPERATION_ID = "01J00000000000000000000009";
const signal = new AbortController().signal;
const state: BuildState = {
  buildId: `test-build:${OPERATION_ID}`,
  projectName: "test-build",
  status: "IN_PROGRESS",
  startTime: new Date("2026-09-17T12:00:00.000Z"),
  operationId: OPERATION_ID,
  inputFingerprint: `sha256:${"f".repeat(64)}`,
  usage: null,
};

const BUCKET = "ohmyho-builds-test";
const BUCKET_EU = "ohmyho-builds-test-eu";

function setup() {
  const stubs = new Map<string, BuildSandboxStub>();
  const stubOf = (operationId: string): BuildSandboxStub => {
    const existing = stubs.get(operationId);
    if (existing !== undefined) return existing;
    const stub: BuildSandboxStub = {
      startBuild: vi.fn(async (command: BuildStartCommand) => ({
        ok: true as const,
        buildId: command.buildId,
        projectName: command.buildProject,
      })),
      readBuild: vi.fn(async () => (operationId === OPERATION_ID ? state : null)),
      stopBuild: vi.fn(async () => ({
        ok: true as const,
        buildId: `test-build:${operationId}`,
        status: "STOPPED" as const,
      })),
    };
    stubs.set(operationId, stub);
    return stub;
  };
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn((id: unknown) => stubOf((id as { name: string }).name)),
  };
  const namespaceEu = {
    idFromName: vi.fn((name: string) => ({ name: `eu:${name}` })),
    get: vi.fn((id: unknown) => stubOf((id as { name: string }).name)),
  };
  return {
    namespace,
    namespaceEu,
    stubOf,
    executor: createSandboxExecutor({
      placements: [
        { bucketName: BUCKET, namespace, locationHint: "enam" },
        { bucketName: BUCKET_EU, namespace: namespaceEu, locationHint: "weur" },
      ],
      buildProject: "test-build",
    }),
  };
}

describe("sandbox executor", () => {
  it("routes every call to the object named by the operation of the build id, in North America", async () => {
    const { executor, namespace, namespaceEu, stubOf } = setup();
    const command = {
      buildProject: "test-build",
      buildId: `test-build:${OPERATION_ID}`,
      source: { bucket: BUCKET },
    } as BuildStartCommand;

    await expect(executor.startBuild(command, signal)).resolves.toEqual({
      buildId: command.buildId,
      projectName: "test-build",
    });
    await expect(
      executor.stopBuild({ buildId: command.buildId, bucket: BUCKET }, signal),
    ).resolves.toEqual({ buildId: command.buildId, status: "STOPPED" });

    expect(namespace.idFromName.mock.calls).toEqual([[OPERATION_ID], [OPERATION_ID]]);
    expect(namespace.get).toHaveBeenCalledWith({ name: OPERATION_ID }, { locationHint: "enam" });
    expect(namespaceEu.get).not.toHaveBeenCalled();
    expect(stubOf(OPERATION_ID).startBuild).toHaveBeenCalledWith(command);
    expect(stubOf(OTHER_OPERATION_ID).startBuild).not.toHaveBeenCalled();
  });

  it("routes a build whose archive is in the EU bucket to the EU namespace, in Western Europe", async () => {
    const { executor, namespace, namespaceEu, stubOf } = setup();
    const command = {
      buildProject: "test-build",
      buildId: `test-build:${OPERATION_ID}`,
      source: { bucket: BUCKET_EU },
    } as BuildStartCommand;

    await expect(executor.startBuild(command, signal)).resolves.toEqual({
      buildId: command.buildId,
      projectName: "test-build",
    });
    await expect(
      executor.batchGetBuilds({ buildIds: [command.buildId], bucket: BUCKET_EU }, signal),
    ).resolves.toEqual([]);
    await expect(
      executor.stopBuild({ buildId: command.buildId, bucket: BUCKET_EU }, signal),
    ).resolves.toMatchObject({ status: "STOPPED" });

    expect(namespaceEu.get).toHaveBeenCalledTimes(3);
    expect(namespaceEu.get).toHaveBeenCalledWith(
      { name: `eu:${OPERATION_ID}` },
      { locationHint: "weur" },
    );
    expect(namespace.get).not.toHaveBeenCalled();
    expect(stubOf(`eu:${OPERATION_ID}`).startBuild).toHaveBeenCalledWith(command);
    expect(stubOf(OPERATION_ID).startBuild).not.toHaveBeenCalled();
  });

  it("returns the builds that exist and no entry for one that was never started", async () => {
    const { executor, namespace } = setup();

    await expect(
      executor.batchGetBuilds(
        {
          buildIds: [`test-build:${OPERATION_ID}`, `test-build:${OTHER_OPERATION_ID}`],
          bucket: BUCKET,
        },
        signal,
      ),
    ).resolves.toEqual([state]);
    expect(namespace.idFromName.mock.calls).toEqual([[OPERATION_ID], [OTHER_OPERATION_ID]]);
    await expect(
      executor.batchGetBuilds({ buildIds: [], bucket: BUCKET }, signal),
    ).resolves.toEqual([]);
  });

  it("refuses a build id of another project or without an operation before any object is reached", async () => {
    const { executor, namespace, namespaceEu } = setup();
    const invalid = [
      `other-build:${OPERATION_ID}`,
      "test-build:not-an-operation",
      `test-build:${OPERATION_ID}:extra`,
      OPERATION_ID,
      7 as never as string,
    ];
    for (const buildId of invalid) {
      const failure = await executor
        .stopBuild({ buildId, bucket: BUCKET }, signal)
        .catch((error) => error);
      expect(failure).toBeInstanceOf(BuildExecutorError);
      expect(failure).toMatchObject({ code: "InvalidBuildId", retryable: false });
      await expect(
        executor.batchGetBuilds({ buildIds: [buildId], bucket: BUCKET }, signal),
      ).rejects.toMatchObject({ code: "InvalidBuildId" });
    }
    await expect(
      executor.startBuild(
        {
          buildProject: "other-build",
          buildId: `test-build:${OPERATION_ID}`,
          source: { bucket: BUCKET },
        } as BuildStartCommand,
        signal,
      ),
    ).rejects.toMatchObject({ code: "InvalidBuildId" });
    expect(namespace.get).not.toHaveBeenCalled();
    expect(namespaceEu.get).not.toHaveBeenCalled();
  });

  it("refuses a bucket that belongs to no build region before any object is reached", async () => {
    const { executor, namespace, namespaceEu } = setup();
    const buildId = `test-build:${OPERATION_ID}`;
    for (const bucket of ["ohmyho-builds-other", undefined as never as string]) {
      await expect(executor.stopBuild({ buildId, bucket }, signal)).rejects.toMatchObject({
        code: "InvalidBucket",
        retryable: false,
      });
      await expect(
        executor.batchGetBuilds({ buildIds: [buildId], bucket }, signal),
      ).rejects.toMatchObject({ code: "InvalidBucket" });
      await expect(
        executor.startBuild(
          { buildProject: "test-build", buildId, source: { bucket } } as BuildStartCommand,
          signal,
        ),
      ).rejects.toMatchObject({ code: "InvalidBucket" });
    }
    expect(namespace.get).not.toHaveBeenCalled();
    expect(namespaceEu.get).not.toHaveBeenCalled();
  });

  it("turns the object's refusals into coded rejections the broker understands", async () => {
    const { executor, stubOf } = setup();
    const buildId = `test-build:${OPERATION_ID}`;
    vi.mocked(stubOf(OPERATION_ID).stopBuild).mockResolvedValueOnce({
      ok: false,
      code: "BuildNotRunning",
    });
    vi.mocked(stubOf(OPERATION_ID).startBuild).mockResolvedValueOnce({
      ok: false,
      code: "BuildConflict",
    });

    await expect(executor.stopBuild({ buildId, bucket: BUCKET }, signal)).rejects.toMatchObject({
      code: "BuildNotRunning",
      retryable: false,
    });
    await expect(
      executor.startBuild(
        { buildProject: "test-build", buildId, source: { bucket: BUCKET } } as BuildStartCommand,
        signal,
      ),
    ).rejects.toMatchObject({ code: "BuildConflict", message: "build_executor:BuildConflict" });
  });
});
