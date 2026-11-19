import { createHash } from "node:crypto";

import {
  creditMicros,
  type Clock,
  type DeploymentApplyInput,
  type DeploymentPlanInput,
  type ObservedResource,
  type ProviderPlan,
  type ProviderMutationContext,
  type ProviderRef,
  type ProviderRemoveInput,
  type ProviderResource,
  type StaticHostingProvider,
} from "@ohmyhost/platform";

import {
  FakeProviderStore,
  FakeProviderStoreConflictError,
  type FakeCreateOrReplayResult,
  type FakeStaticResourceRecord,
} from "./fake-provider-store.js";

const PROVIDER = "fake-static";

export type FakeProviderScenario =
  | "success"
  | "failure-before-commit"
  | "timeout-after-commit"
  | "drift";

export interface FakeStaticHostingProviderDependencies {
  readonly store: FakeProviderStore;
  readonly clock: Clock;
  readonly scenario?: FakeProviderScenario;
}

export class FakeProviderConflictError extends Error {
  public constructor(message = "Idempotency key was already used with different input") {
    super(message);
    this.name = "FakeProviderConflictError";
  }
}

export class FakeProviderFailureError extends Error {
  public constructor() {
    super("Fake provider failed before commit");
    this.name = "FakeProviderFailureError";
  }
}

export class FakeProviderTimeoutError extends Error {
  public constructor() {
    super("Fake provider timed out after commit");
    this.name = "FakeProviderTimeoutError";
  }
}

export class FakeStaticHostingProvider implements StaticHostingProvider {
  private readonly scenario: FakeProviderScenario;
  private readonly returnedResources = new Map<string, ProviderResource<"static-hosting">>();

  public constructor(private readonly dependencies: FakeStaticHostingProviderDependencies) {
    this.scenario = dependencies.scenario ?? "success";
  }

  public async plan(input: DeploymentPlanInput): Promise<ProviderPlan<"static-hosting">> {
    validateDigest(input.artifactDigest);
    validateFrameworkPlan(input.frameworkPlan);
    return Object.freeze({
      capability: "static-hosting",
      actions: Object.freeze([
        `build:${input.frameworkPlan.buildCommand}`,
        `publish:${input.artifactDigest}:${input.frameworkPlan.outputDirectory}`,
      ]),
      estimatedCreditCharge: creditMicros(0n),
    });
  }

  public async apply(
    input: DeploymentApplyInput<"static-hosting">,
  ): Promise<ProviderResource<"static-hosting">> {
    validateApplyInput(input);
    const fingerprint = fingerprintInput(input);
    const resource = Object.freeze({
      capability: "static-hosting" as const,
      provider: PROVIDER,
      externalId: `fake-static-${fingerprint.slice(0, 24)}`,
      createdAt: new Date(this.dependencies.clock.now()),
    });
    const record: FakeStaticResourceRecord = {
      operationId: input.context.operationId,
      projectId: input.context.projectId,
      environmentId: input.context.environmentId,
      idempotencyKey: input.context.idempotencyKey,
      inputFingerprint: fingerprint,
      resource,
      observedState: this.scenario === "drift" ? "failed" : "ready",
    };
    let result: FakeCreateOrReplayResult;
    try {
      result = await this.dependencies.store.createOrReplay(record, () => {
        if (this.scenario === "failure-before-commit") {
          throw new FakeProviderFailureError();
        }
      });
    } catch (error) {
      if (error instanceof FakeProviderStoreConflictError) {
        throw new FakeProviderConflictError(error.message);
      }
      throw error;
    }
    const remembered = this.remember(result.record.resource);
    if (result.created && this.scenario === "timeout-after-commit") {
      throw new FakeProviderTimeoutError();
    }
    return remembered;
  }

  public async observe(
    ref: ProviderRef<"static-hosting">,
  ): Promise<ObservedResource<"static-hosting">> {
    validateRef(ref);
    const record = await this.dependencies.store.getByExternalId(ref.externalId);
    return this.observed(ref, record?.observedState ?? "removed");
  }

  public async observeByMutation(
    context: ProviderMutationContext,
  ): Promise<ObservedResource<"static-hosting"> | null> {
    validateMutationContext(context);
    const record = await this.dependencies.store.getByMutation(
      context.operationId,
      context.idempotencyKey,
    );
    if (record === undefined) {
      return null;
    }
    if (record.projectId !== context.projectId || record.environmentId !== context.environmentId) {
      throw new FakeProviderConflictError("Observe context does not match resource scope");
    }
    return this.observed(record.resource, record.observedState);
  }

  public async remove(input: ProviderRemoveInput<"static-hosting">): Promise<void> {
    validateRef(input.ref);
    validateMutationContext(input.context);
    const record = await this.dependencies.store.getByExternalId(input.ref.externalId);
    if (record === undefined) {
      return;
    }
    if (
      record.projectId !== input.context.projectId ||
      record.environmentId !== input.context.environmentId
    ) {
      throw new FakeProviderConflictError("Remove context does not match resource scope");
    }
    if (record.observedState === "removed") {
      return;
    }
    await this.dependencies.store.put({
      ...record,
      observedState: "removed",
      removal: {
        operationId: input.context.operationId,
        idempotencyKey: input.context.idempotencyKey,
      },
    });
  }

  private remember(
    resource: ProviderResource<"static-hosting">,
  ): ProviderResource<"static-hosting"> {
    const remembered = this.returnedResources.get(resource.externalId);
    if (remembered !== undefined) {
      return remembered;
    }
    const frozen = Object.freeze({ ...resource, createdAt: new Date(resource.createdAt) });
    this.returnedResources.set(resource.externalId, frozen);
    return frozen;
  }

  private observed(
    ref: ProviderRef<"static-hosting">,
    state: FakeStaticResourceRecord["observedState"],
  ): ObservedResource<"static-hosting"> {
    return Object.freeze({
      ref: Object.freeze({
        capability: "static-hosting" as const,
        provider: ref.provider,
        externalId: ref.externalId,
      }),
      state,
      observedAt: new Date(this.dependencies.clock.now()),
    });
  }
}

function validateApplyInput(input: DeploymentApplyInput<"static-hosting">): void {
  validateDigest(input.artifactDigest);
  validateMutationContext(input.context);
  validateFrameworkPlan(input.frameworkPlan);
  if (input.plan.capability !== "static-hosting") {
    throw new TypeError("plan capability must be static-hosting");
  }
}

function validateMutationContext(context: ProviderMutationContext): void {
  if (context.idempotencyKey.trim().length === 0) {
    throw new TypeError("idempotency key must not be empty");
  }
  validateUlid(context.operationId, "operationId");
  validateUlid(context.projectId, "projectId");
  validateUlid(context.environmentId, "environmentId");
}

function validateUlid(value: string, field: string): void {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)) {
    throw new TypeError(`${field} must be a canonical ULID`);
  }
}

function validateFrameworkPlan(plan: DeploymentPlanInput["frameworkPlan"]): void {
  if (plan.runtime !== "static") {
    throw new TypeError("static hosting requires a static framework plan");
  }
  if (
    typeof plan.buildCommand !== "string" ||
    plan.buildCommand.trim().length === 0 ||
    typeof plan.outputDirectory !== "string" ||
    plan.outputDirectory.trim().length === 0
  ) {
    throw new TypeError("framework plan must include build command and output directory");
  }
}

function validateDigest(digest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError("artifact digest must be a complete sha256 digest");
  }
}

function validateRef(ref: ProviderRef<"static-hosting">): void {
  if (ref.capability !== "static-hosting" || ref.provider !== PROVIDER) {
    throw new TypeError("Unsupported provider reference");
  }
}

function fingerprintInput(input: DeploymentApplyInput<"static-hosting">): string {
  const canonical = JSON.stringify({
    artifactDigest: input.artifactDigest,
    context: {
      environmentId: input.context.environmentId,
      operationId: input.context.operationId,
      projectId: input.context.projectId,
    },
    frameworkPlan: {
      adapter: input.frameworkPlan.adapter,
      runtime: input.frameworkPlan.runtime,
      installCommand: input.frameworkPlan.installCommand,
      buildCommand: input.frameworkPlan.buildCommand,
      outputDirectory: input.frameworkPlan.outputDirectory,
    },
    plan: {
      actions: [...input.plan.actions],
      capability: input.plan.capability,
      estimatedCreditCharge: input.plan.estimatedCreditCharge.toString(10),
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}
