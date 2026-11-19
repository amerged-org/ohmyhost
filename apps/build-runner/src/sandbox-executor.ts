import type { BuildExecutor, BuildStartCommand, BuildState } from "@ohmyhost/build-broker";

import type { StartBuildResult, StopBuildResult } from "./build-sandbox.js";

/** The RPC surface of one operation's `BuildSandbox` object. */
export interface BuildSandboxStub {
  startBuild(command: BuildStartCommand): Promise<StartBuildResult>;
  readBuild(): Promise<BuildState | null>;
  stopBuild(): Promise<StopBuildResult>;
}

/** The part of a Durable Object namespace binding (`BUILD_SANDBOX`, `BUILD_SANDBOX_EU`) the executor uses. */
export interface BuildSandboxNamespace {
  idFromName(name: string): unknown;
  get(id: unknown, options?: Readonly<{ locationHint: string }>): BuildSandboxStub;
}

/** The sandbox namespace of one build objects bucket and the location hint that places its objects. */
export interface SandboxPlacement {
  readonly bucketName: string;
  readonly namespace: BuildSandboxNamespace;
  readonly locationHint: "enam" | "weur";
}

/** A rejection in the error protocol of the broker's `BuildExecutor` port. */
export class BuildExecutorError extends Error {
  public readonly retryable = false;

  public constructor(public readonly code: string) {
    super(`build_executor:${code}`);
    this.name = "BuildExecutorError";
  }
}

export interface SandboxExecutorDependencies {
  readonly placements: readonly SandboxPlacement[];
  readonly buildProject: string;
}

const OPERATION_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/**
 * The broker's `BuildExecutor` over the `BuildSandbox` objects: the deterministic build id
 * `${buildProject}:${operationId}` names the one object that owns the operation's sandbox, and
 * the command's build objects bucket names the region whose namespace holds that object.
 */
export function createSandboxExecutor(dependencies: SandboxExecutorDependencies): BuildExecutor {
  const { placements, buildProject } = dependencies;

  function sandboxOf(buildId: string, bucket: string): BuildSandboxStub {
    const prefix = `${buildProject}:`;
    if (
      typeof buildId !== "string" ||
      !buildId.startsWith(prefix) ||
      !OPERATION_ID_PATTERN.test(buildId.slice(prefix.length))
    ) {
      throw new BuildExecutorError("InvalidBuildId");
    }
    const placement = placements.find((candidate) => candidate.bucketName === bucket);
    if (placement === undefined) throw new BuildExecutorError("InvalidBucket");
    const operationId = buildId.slice(prefix.length);
    return placement.namespace.get(placement.namespace.idFromName(operationId), {
      locationHint: placement.locationHint,
    });
  }

  const executor: BuildExecutor = {
    async startBuild(command) {
      if (command.buildProject !== buildProject) throw new BuildExecutorError("InvalidBuildId");
      const result = await sandboxOf(command.buildId, command.source.bucket).startBuild(command);
      if (!result.ok) throw new BuildExecutorError(result.code);
      return Object.freeze({ buildId: result.buildId, projectName: result.projectName });
    },

    async batchGetBuilds(command) {
      const states = await Promise.all(
        command.buildIds.map((buildId) => sandboxOf(buildId, command.bucket).readBuild()),
      );
      return Object.freeze(states.filter((state) => state !== null));
    },

    async stopBuild(command) {
      const result = await sandboxOf(command.buildId, command.bucket).stopBuild();
      if (!result.ok) throw new BuildExecutorError(result.code);
      return Object.freeze({ buildId: result.buildId, status: result.status });
    },
  };
  return Object.freeze(executor);
}
