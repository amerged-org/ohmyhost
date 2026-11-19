import { createCoreProviderReconciliationDataPort } from "./core-provider-reconciliation.js";
import type {
  ProviderReconciliationDataPort,
  ProviderReconciliationRuntimeBinding,
  ProviderReconciliationServices,
  ProviderReconciliationRequest,
} from "./provider-reconciliation-data-port.js";
import { projectEnvironmentAddress } from "@ohmyhost/project-handles";
import type {
  findProductProviderReconciliationClaim,
  readProductProviderReconciliationAttempt,
  readProductWorkflowReplayAttempt,
  ProductProviderReconciliationContext,
} from "@ohmyhost/database/provisioning-persistence";
import {
  deterministicProductCommandWorkflowId,
  deterministicProviderReconciliationWorkflowId,
  parseProductCommandMessageV1,
  projectProductCommandMessage,
  type ProductCommandIntentProjection,
  parseProductProviderReconciliationMessageV1,
  parseProjectProvisioningMessageV1,
  type ProjectProvisioningMessageV1,
  type ProductProviderReconciliationMessageV1,
  type ProductProviderReconciliationPorts,
} from "@ohmyhost/orchestrator";
import { parseUlid, type Clock, type Ulid } from "@ohmyhost/platform";

import {
  ensureCloudflareProductCommandWorkflow,
  ensureCloudflareProjectProvisioningWorkflow,
} from "./cloudflare-adapters.js";
import { deterministicUlid } from "./deterministic-ulid.js";
import type { CloudflareWorkflowBinding } from "./runtime-types.js";
import { observeAbandonedGateway } from "./abandoned-gateway-recovery.js";

export function createCoreProviderReconciliationPorts(
  bindings: ProviderReconciliationServices,
  runtime: ProviderReconciliationRuntimeBinding,
  clock: Clock,
): ProductProviderReconciliationPorts {
  return createProviderReconciliationPortsWithData(
    bindings,
    createCoreProviderReconciliationDataPort(runtime),
    clock,
  );
}
export function requestCoreProviderReconciliation(
  bindings: ProviderReconciliationServices,
  runtime: ProviderReconciliationRuntimeBinding,
  input: ProviderReconciliationRequest,
  clock: Clock,
) {
  return requestProviderReconciliationWithData(
    bindings,
    createCoreProviderReconciliationDataPort(runtime),
    input,
    clock,
  );
}

function createProviderReconciliationPortsWithData(
  bindings: ProviderReconciliationServices,
  data: ProviderReconciliationDataPort,
  clock: Clock,
): ProductProviderReconciliationPorts {
  return Object.freeze({
    load: async (rawMessage: ProductProviderReconciliationMessageV1) => {
      const message = parseProductProviderReconciliationMessageV1(rawMessage);
      const context = await data.readProductProviderReconciliationContext(() => ({
        organizationId: message.organizationId,
        projectId: message.projectId,
        environmentId: message.environmentId,
        operationId: message.operationId,
        claimId: message.claimId,
      }));
      if (context === null) throw new Error("Provider reconciliation context is unavailable");
      return context as unknown as Readonly<Record<string, unknown>>;
    },
    observe: async (rawContext: unknown) => {
      const context = rawContext as unknown as ProductProviderReconciliationContext;
      const target = exactWfpTarget(context);
      const wfp = await observeWfpTarget(bindings, context, target);
      const directGateway = await observeGatewayTarget(bindings, context, target, clock);
      return requireProviderObservation({
        gateway:
          directGateway.state === "unknown"
            ? await observeRetainedGateway(bindings, context, target, clock, directGateway)
            : directGateway,
        wfp,
      });
    },
    prepare: async ({
      message: rawMessage,
      context: rawContext,
      observation: rawObservation,
    }: Parameters<ProductProviderReconciliationPorts["prepare"]>[0]) => {
      const message = parseProductProviderReconciliationMessageV1(rawMessage);
      const context = rawContext as unknown as ProductProviderReconciliationContext;
      const observation = requireProviderObservation(rawObservation);
      const preparedAt = canonicalNow(clock);
      const mode = shouldAbandon(context, observation) ? "abandon" : "retry";
      const physicalWorkflowId = `product-provider-reconcile-v1-${message.attemptId}`;
      const observationId = await deterministicUlid(`${message.attemptId}:observation`);
      const startedOperationEventId = await deterministicUlid(
        `${message.attemptId}:operation-started-event`,
      );
      const operationEventId = await deterministicUlid(`${message.attemptId}:operation-event`);
      const auditEventId = await deterministicUlid(`${message.attemptId}:audit-event`);
      const evidenceDigest = await observationDigest(observation);
      const result = await data.prepareProductProviderReconciliation(() => ({
        attemptId: message.attemptId,
        observationId,
        claimId: message.claimId,
        organizationId: message.organizationId,
        projectId: message.projectId,
        environmentId: message.environmentId,
        operationId: message.operationId,
        eventId: context.eventId,
        logicalWorkflowId: context.logicalWorkflowId,
        physicalWorkflowId,
        mode,
        idempotencyDigest: digestBytes(message.idempotencySha256),
        evidenceDigest,
        gateway: observation.gateway,
        wfp: observation.wfp,
        actorId: message.actorId,
        startedOperationEventId,
        operationEventId,
        auditEventId,
        preparedAt,
      }));
      return result;
    },
    resume: async ({
      physicalWorkflowId,
      originalMessage,
    }: Parameters<ProductProviderReconciliationPorts["resume"]>[0]) => {
      const state = await startOriginalWorkflow(
        bindings,
        physicalWorkflowId,
        parseProductCommandMessageV1(originalMessage),
      );
      return state === "errored" || state === "terminated" ? "uncertain" : state;
    },
  });
}
function exactWfpTarget(
  context: ProductProviderReconciliationContext,
): ProductProviderReconciliationContext["wfpTarget"] {
  const target = context.wfpTarget;
  if (target === null || target === undefined) return null;
  const expected = context.providerHint;
  if (
    (expected.expectedArtifactDigest !== null &&
      expected.expectedArtifactDigest !== undefined &&
      expected.expectedArtifactDigest !== target.candidate.artifactDigest) ||
    (expected.phase === "wfp" &&
      expected.currentProviderTag !== null &&
      expected.currentProviderTag !== undefined &&
      expected.currentProviderTag !== target.candidate.providerTag) ||
    (expected.currentProductDeploymentId !== null &&
      expected.currentProductDeploymentId !== undefined &&
      expected.currentProductDeploymentId !== target.candidate.productDeploymentId)
  ) {
    return null;
  }
  return target;
}
async function observeWfpTarget(
  bindings: ProviderReconciliationServices,
  context: ProductProviderReconciliationContext,
  target: ProductProviderReconciliationContext["wfpTarget"],
): Promise<ProviderObservation["wfp"]> {
  if (target === null) return Object.freeze({ state: "unknown" });
  try {
    const artifactDigest = optionalDigest(target.candidate.artifactDigest);
    if (artifactDigest === null) return Object.freeze({ state: "unknown" });
    const record = requireRecord(
      await bindings.WFP_MANAGEMENT.observeCandidate({
        scope: wfpScope(context),
        candidate: target.candidate,
      }),
      "WFP candidate observation",
    );
    const observedAt = requiredTimestamp(record["observedAt"]);
    if (record["state"] === "metadata_absent") {
      if (
        record["scriptName"] !== target.candidate.scriptName ||
        record["providerTag"] !== null ||
        record["productDeploymentId"] !== null ||
        record["artifactDigest"] !== null
      ) {
        return Object.freeze({ state: "unknown" });
      }
      return Object.freeze({ state: "absent", observedAt });
    }
    if (
      record["state"] !== "ready" ||
      record["scriptName"] !== target.candidate.scriptName ||
      record["providerTag"] !== target.candidate.providerTag ||
      record["productDeploymentId"] !== target.candidate.productDeploymentId ||
      record["artifactDigest"] !== artifactDigest
    ) {
      return Object.freeze({ state: "unknown" });
    }
    return Object.freeze({
      state: "ready",
      providerTag: target.candidate.providerTag,
      productDeploymentId: target.candidate.productDeploymentId,
      artifactDigest,
      observedAt,
    });
  } catch {
    return Object.freeze({ state: "unknown" });
  }
}
async function observeGatewayTarget(
  bindings: ProviderReconciliationServices,
  context: ProductProviderReconciliationContext,
  target: ProductProviderReconciliationContext["wfpTarget"],
  clock: Clock,
  expectedGateway?: NonNullable<ProductProviderReconciliationContext["wfpTarget"]>["gateway"],
): Promise<ProviderObservation["gateway"]> {
  if (target === null) return Object.freeze({ state: "unknown" });
  try {
    const record = requireRecord(
      await bindings.WFP_MANAGEMENT.observeActivation({
        organizationId: context.organizationId,
        scope: wfpScope(context),
        candidate: target.candidate,
        runtimePolicy: target.runtimePolicy,
        ...(expectedGateway === undefined ? {} : { expectedGateway }),
      }),
      "project gateway observation",
    );
    if (record["status"] === "absent") {
      return Object.freeze({ state: "absent", observedAt: canonicalNow(clock) });
    }
    if (
      record["status"] === "reconciliation_required" &&
      (record["reconciliationPhase"] === "gateway" || record["reconciliationPhase"] === "health")
    ) {
      const providerTag = optionalString(record["currentProviderTag"]);
      return Object.freeze({
        state: "unknown" as const,
        ...(providerTag === null ? {} : { providerTag }),
      });
    }
    if (
      record["status"] !== "activated" &&
      record["status"] !== "unhealthy" &&
      record["status"] !== "observed"
    ) {
      return Object.freeze({ state: "unknown" });
    }
    const candidate = requireRecord(record["candidate"], "observed WFP candidate");
    const gateway = requireRecord(record["gateway"], "observed project gateway");
    const health =
      record["status"] === "observed"
        ? null
        : requireRecord(record["health"], "observed project gateway health");
    const address = projectEnvironmentAddress({
      projectId: context.projectId,
      handle: context.handle,
      environmentName: context.environmentName,
      platform: target.candidate.namespace === "ohmyho-production" ? "production" : "development",
    });
    const expectedGatewayHost = expectedGateway?.hostname ?? address.hostname;
    const expectedPublicOrigin = expectedGateway?.publicOrigin ?? address.origin;
    const origin = new URL(String(record["deploymentUrl"]));
    if (
      (health !== null &&
        (!Number.isInteger(health["status"]) ||
          Number(health["status"]) < 100 ||
          Number(health["status"]) > 599 ||
          (record["status"] === "activated" && health["status"] !== 200) ||
          (record["status"] === "unhealthy" &&
            Number(health["status"]) >= 200 &&
            Number(health["status"]) < 300))) ||
      candidate["scriptName"] !== target.candidate.scriptName ||
      candidate["providerTag"] !== target.candidate.providerTag ||
      candidate["productDeploymentId"] !== target.candidate.productDeploymentId ||
      candidate["artifactDigest"] !== target.candidate.artifactDigest ||
      gateway["hostname"] !== expectedGatewayHost ||
      gateway["targetScriptName"] !== target.candidate.scriptName ||
      gateway["targetProviderTag"] !== target.candidate.providerTag ||
      gateway["targetDeploymentId"] !== target.candidate.productDeploymentId ||
      gateway["targetArtifactDigest"] !== target.candidate.artifactDigest ||
      gateway["provider"] !== "ohmyhost-shared-gateway" ||
      gateway["publicOrigin"] !== expectedPublicOrigin ||
      record["deploymentUrl"] !== expectedPublicOrigin ||
      origin.origin !== expectedPublicOrigin ||
      typeof gateway["targetProviderTag"] !== "string" ||
      (context.providerHint.phase === "gateway" &&
        context.providerHint.currentProviderTag !== undefined &&
        context.providerHint.currentProviderTag !== null &&
        gateway["targetProviderTag"] !== context.providerHint.currentProviderTag)
    ) {
      return Object.freeze({ state: "unknown" });
    }
    return Object.freeze({
      state: "ready",
      providerTag: gateway["targetProviderTag"],
      observedAt: requiredTimestamp(gateway["observedAt"]),
    });
  } catch {
    return Object.freeze({ state: "unknown" });
  }
}
async function observeRetainedGateway(
  bindings: ProviderReconciliationServices,
  context: ProductProviderReconciliationContext,
  target: ProductProviderReconciliationContext["wfpTarget"],
  clock: Clock,
  fallback: ProviderObservation["gateway"],
): Promise<ProviderObservation["gateway"]> {
  if (target === null) return fallback;
  if (context.eventType === "DeploymentRollbackRequestedV1") {
    const retained = context.retainedWfpTarget;
    return retained == null
      ? fallback
      : observeGatewayTarget(bindings, context, retained, clock, retained.gateway);
  }
  if (context.hasActiveGateway === false) {
    const recovered = await observeAbandonedGateway(
      bindings.WFP_MANAGEMENT,
      context,
      context.abandonedWfpTargets ?? [],
    );
    return recovered === null
      ? fallback
      : Object.freeze({
          state: "ready" as const,
          providerTag: String(recovered.gateway["targetProviderTag"]),
          observedAt: requiredTimestamp(recovered.gateway["observedAt"]),
        });
  }
  for (const candidate of [...context.knownDeployments].reverse()) {
    if (candidate.productDeploymentId === target.candidate.productDeploymentId) continue;
    const observation = await observeGatewayTarget(
      bindings,
      context,
      Object.freeze({ candidate, runtimePolicy: target.runtimePolicy }),
      clock,
    );
    if (observation.state === "ready") return observation;
  }
  return fallback;
}
function wfpScope(context: ProductProviderReconciliationContext) {
  return Object.freeze({
    projectId: context.projectId,
    environmentId: context.environmentId,
    environmentName: context.environmentName,
    handle: context.handle,
  });
}
async function requestProviderReconciliationWithData(
  bindings: ProviderReconciliationServices,
  data: ProviderReconciliationDataPort,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly actorId: string;
    readonly idempotencySha256: `sha256:${string}`;
  },
  clock: Clock,
): Promise<{
  readonly attemptId: Ulid;
  readonly operationId: Ulid;
  readonly state: "completed" | "pending" | "uncertain" | "exhausted" | "unmatched";
}> {
  const organizationId = parseUlid(input.organizationId);
  const operationId = parseUlid(input.operationId);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.idempotencySha256)) {
    throw new TypeError("Provider reconciliation idempotency digest is invalid");
  }
  const attemptId = await deterministicUlid(
    `${organizationId}:${operationId}:${input.actorId}:${input.idempotencySha256}`,
  );
  const queueRecovery = await requestProjectProvisioningQueueDeliveryRecovery(
    bindings,
    data,
    {
      organizationId,
      operationId,
      reconciliationId: attemptId,
      actorId: input.actorId,
      idempotencySha256: input.idempotencySha256,
    },
    clock,
  );
  if (queueRecovery !== null) return queueRecovery;
  const sourceLinkQueueRecovery = await requestSourceLinkQueueDeliveryRecovery(
    bindings,
    data,
    {
      organizationId,
      operationId,
      reconciliationId: attemptId,
      actorId: input.actorId,
      idempotencySha256: input.idempotencySha256,
    },
    clock,
  );
  if (sourceLinkQueueRecovery !== null) return sourceLinkQueueRecovery;
  const deploymentQueueRecovery = await requestDeploymentQueueDeliveryRecovery(
    bindings,
    data,
    {
      organizationId,
      operationId,
      reconciliationId: attemptId,
      actorId: input.actorId,
      idempotencySha256: input.idempotencySha256,
    },
    clock,
  );
  if (deploymentQueueRecovery !== null) return deploymentQueueRecovery;
  const lostCommand = await abandonLostProductCommandIfNeverStarted(
    bindings,
    data,
    { organizationId, operationId, attemptId, actorId: input.actorId },
    clock,
  );
  if (lostCommand !== null) return lostCommand;
  const idempotencyDigest = digestBytes(input.idempotencySha256);
  const replay = await data.readProductProviderReconciliationAttempt(() => ({
    organizationId,
    operationId,
    attemptId,
    actorId: input.actorId,
    idempotencyDigest,
  }));
  if (replay?.outcome === "completed") {
    return Object.freeze({ attemptId, operationId, state: "completed" as const });
  }
  if (replay?.outcome === "prepared") {
    const state = await readOrStartOriginalWorkflow(
      bindings,
      replay.physicalWorkflowId,
      parseProductCommandMessageV1(replay.originalMessage),
    );
    if (state === "errored" || state === "terminated") {
      await recoverTerminalAttempt(data, replay, input.actorId, state, clock);
      return Object.freeze({ attemptId, operationId, state: "completed" as const });
    }
    return Object.freeze({ attemptId, operationId, state });
  }
  let claim = await data.findProductProviderReconciliationClaim(() => ({
    organizationId,
    operationId,
  }));
  if (claim === null) {
    const workflowReplay = await data.readProductWorkflowReplayAttempt(() => ({
      organizationId,
      operationId,
      attemptId,
      actorId: input.actorId,
      idempotencyDigest,
    }));
    if (workflowReplay?.outcome === "completed") {
      return Object.freeze({ attemptId, operationId, state: "completed" as const });
    }
    if (workflowReplay?.outcome === "prepared") {
      const state = await readOrStartWorkflowReplay(
        bindings,
        workflowReplay.physicalWorkflowId,
        parseProductCommandMessageV1(workflowReplay.originalMessage),
      );
      if (state === "errored" || state === "terminated") {
        await recoverTerminalWorkflowReplay(data, workflowReplay, input.actorId, state, clock);
        return Object.freeze({ attemptId, operationId, state: "completed" as const });
      }
      return Object.freeze({ attemptId, operationId, state });
    }
    const replayCandidate = await data.findProductWorkflowReplayCandidate(() => ({
      organizationId,
      operationId,
    }));
    if (replayCandidate !== null) {
      if (replayCandidate.queueHandoffPending) {
        const outcome = await ensureCloudflareProductCommandWorkflow(bindings.DEPLOYMENT_WORKFLOW, {
          workflowId: replayCandidate.logicalWorkflowId,
          message: replayCommand(replayCandidate),
        });
        if (outcome === "uncertain") {
          return Object.freeze({ attemptId, operationId, state: "uncertain" as const });
        }
        await data.finalizeProjectDeletionQueueHandoff(() => ({
          ...replayCandidate,
          auditEventId: attemptId,
          actorId: input.actorId,
          acknowledgedAt: canonicalNow(clock),
        }));
        return Object.freeze({ attemptId, operationId, state: "pending" as const });
      }
      const logicalState = await readWorkflowState(
        bindings.DEPLOYMENT_WORKFLOW,
        replayCandidate.logicalWorkflowId,
      );
      if (logicalState === "pending" || logicalState === "uncertain") {
        return Object.freeze({ attemptId, operationId, state: logicalState });
      }
      const physicalWorkflowId = `product-command-replay-v1-${attemptId}`;
      const prepared = await data.prepareProductWorkflowReplay(() => ({
        ...replayCandidate,
        attemptId,
        physicalWorkflowId,
        actorId: input.actorId,
        idempotencyDigest,
        preparedAt: canonicalNow(clock),
      }));
      if (prepared === "exhausted") {
        return Object.freeze({ attemptId, operationId, state: "exhausted" as const });
      }
      const state = await startWorkflowReplay(
        bindings,
        physicalWorkflowId,
        replayCommand(replayCandidate),
      );
      return Object.freeze({
        attemptId,
        operationId,
        state: state === "errored" || state === "terminated" ? "uncertain" : state,
      });
    }
    const candidate = await data.findClaimlessProductProviderReconciliationCandidate(() => ({
      organizationId,
      operationId,
    }));
    if (candidate === null) {
      // An event exhausted before its Workflow run existed. Accepting its current attempt gives it the
      // run the handoff matches; the next reconcile then hands it off. Anything else is unmatched, which is not retryable.
      const runless = await data.findRunlessProductDispatch(() => ({
        organizationId,
        operationId,
      }));
      if (runless === null)
        return Object.freeze({ attemptId, operationId, state: "unmatched" as const });
      const message = projectProductCommandMessage(
        {
          eventId: runless.eventId,
          organizationId: runless.organizationId,
          projectId: runless.projectId,
          operationId: runless.operationId,
          billingEpochId: runless.billingEpochId,
        },
        {
          eventType: runless.eventType,
          organizationId: runless.organizationId,
          projectId: runless.projectId,
          environmentId: runless.environmentId,
          operationId: runless.operationId,
          billingEpochId: runless.billingEpochId,
          planId: runless.planId,
          requestedHandle: runless.requestedHandle,
          dataChange: runless.dataChange as NonNullable<
            ProductCommandIntentProjection["dataChange"]
          > | null,
        },
      );
      await data.acceptRunlessProductDispatch(() => ({
        organizationId: runless.organizationId,
        projectId: runless.projectId,
        environmentId: runless.environmentId,
        operationId: runless.operationId,
        eventId: runless.eventId,
        attemptId: runless.attemptId,
        workflowId: deterministicProductCommandWorkflowId(message),
        acceptedAt: canonicalNow(clock),
      }));
      return Object.freeze({ attemptId, operationId, state: "pending" as const });
    }
    const claimId = await deterministicUlid(
      `${candidate.logicalWorkflowId}:provider-mutation-claim`,
    );
    await data.claimProductProviderMutation(() => ({ ...candidate, claimId }));
    claim = await data.findProductProviderReconciliationClaim(() => ({
      organizationId,
      operationId,
    }));
    if (claim === null) throw new Error("Provider reconciliation claim recovery failed");
  }
  if (claim.workflowState === "queued") {
    const logicalState = await readWorkflowState(
      bindings.DEPLOYMENT_WORKFLOW,
      claim.logicalWorkflowId,
    );
    if (logicalState === "pending" || logicalState === "uncertain") {
      return Object.freeze({ attemptId, operationId, state: logicalState });
    }
    await recoverInitialTerminalWorkflow(data, claim, input.actorId, logicalState, clock);
  }
  const message = parseProductProviderReconciliationMessageV1({
    version: 1,
    attemptId,
    claimId: claim.claimId,
    organizationId,
    projectId: claim.projectId,
    environmentId: claim.environmentId,
    operationId,
    actorId: input.actorId,
    idempotencySha256: input.idempotencySha256,
  });
  const state = await startReconciliationWorkflow(bindings, message);
  return Object.freeze({ attemptId, operationId, state });
}
async function requestProjectProvisioningQueueDeliveryRecovery(
  bindings: ProviderReconciliationServices,
  data: ProviderReconciliationDataPort,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly reconciliationId: Ulid;
    readonly actorId: string;
    readonly idempotencySha256: `sha256:${string}`;
  },
  clock: Clock,
): Promise<{
  readonly attemptId: Ulid;
  readonly operationId: Ulid;
  readonly state: "completed" | "pending" | "uncertain";
} | null> {
  const preparedAuditEventId = await deterministicUlid(
    `${input.reconciliationId}:project-provisioning-queue-delivery-recovery-prepared`,
  );
  const finalAuditEventId = await deterministicUlid(
    `${input.reconciliationId}:project-provisioning-queue-delivery-recovered`,
  );
  const prepared = await data.prepareProjectProvisioningQueueDeliveryRecovery(() => ({
    organizationId: input.organizationId,
    operationId: input.operationId,
    reconciliationId: input.reconciliationId,
    preparedAuditEventId,
    finalAuditEventId,
    actorId: input.actorId,
    idempotencySha256: input.idempotencySha256,
    preparedAt: canonicalNow(clock),
  }));
  if (prepared.outcome === "not_applicable") return null;
  if (prepared.outcome === "recovered") {
    return Object.freeze({
      attemptId: prepared.reconciliationId,
      operationId: prepared.operationId,
      state: prepared.state,
    });
  }
  const message = projectProvisioningMessageFromPreparedRecovery(prepared);
  const outcome = await ensureCloudflareProjectProvisioningWorkflow(
    bindings.PROJECT_PROVISIONING_WORKFLOW,
    { workflowId: prepared.workflowId, message },
  );
  if (outcome === "uncertain") {
    return Object.freeze({
      attemptId: prepared.reconciliationId,
      operationId: prepared.operationId,
      state: "uncertain",
    });
  }
  const finalized = await data.finalizeProjectProvisioningQueueDeliveryRecovery(() => ({
    organizationId: prepared.organizationId,
    operationId: prepared.operationId,
    reconciliationId: prepared.reconciliationId,
    preparedAuditEventId,
    finalAuditEventId,
    actorId: input.actorId,
    idempotencySha256: input.idempotencySha256,
    projectId: prepared.projectId,
    requestEventId: prepared.requestEventId,
    deliveryAttemptId: prepared.deliveryAttemptId,
    workflowId: prepared.workflowId,
    recoveredAt: canonicalNow(clock),
    workflowOutcome: outcome,
  }));
  return Object.freeze({
    attemptId: finalized.reconciliationId,
    operationId: finalized.operationId,
    state: finalized.state,
  });
}
function projectProvisioningMessageFromPreparedRecovery(prepared: {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly requestEventId: Ulid;
}): ProjectProvisioningMessageV1 {
  return parseProjectProvisioningMessageV1({
    version: 1,
    eventType: "ProjectProvisioningRequested",
    eventId: prepared.requestEventId,
    organizationId: prepared.organizationId,
    projectId: prepared.projectId,
    operationId: prepared.operationId,
  });
}
async function requestSourceLinkQueueDeliveryRecovery(
  bindings: ProviderReconciliationServices,
  data: ProviderReconciliationDataPort,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly reconciliationId: Ulid;
    readonly actorId: string;
    readonly idempotencySha256: `sha256:${string}`;
  },
  clock: Clock,
): Promise<{
  readonly attemptId: Ulid;
  readonly operationId: Ulid;
  readonly state: "completed" | "pending" | "uncertain";
} | null> {
  const closed = await data.readClosedSourceLinkQueueDeliveryRecovery(() => ({
    organizationId: input.organizationId,
    operationId: input.operationId,
  }));
  if (closed !== null) {
    const route = await closedSourceLinkWorkflowReplayRoute(data, input, closed);
    if (route.kind === "continue") return null;
    if (route.kind === "completed") {
      return Object.freeze({
        attemptId: route.attemptId,
        operationId: closed.operationId,
        state: "completed" as const,
      });
    }
    return Object.freeze({
      attemptId: closed.reconciliationId,
      operationId: closed.operationId,
      state: closed.state,
    });
  }
  const preparedAuditEventId = await deterministicUlid(
    `${input.reconciliationId}:source-link-queue-delivery-recovery-prepared`,
  );
  const finalAuditEventId = await deterministicUlid(
    `${input.reconciliationId}:source-link-queue-delivery-recovered`,
  );
  const prepared = await data.prepareSourceLinkQueueDeliveryRecovery(() => ({
    organizationId: input.organizationId,
    operationId: input.operationId,
    reconciliationId: input.reconciliationId,
    preparedAuditEventId,
    finalAuditEventId,
    actorId: input.actorId,
    idempotencySha256: input.idempotencySha256,
    preparedAt: canonicalNow(clock),
  }));
  if (prepared.outcome === "not_applicable") return null;
  if (prepared.outcome === "recovered") {
    const route = await closedSourceLinkWorkflowReplayRoute(data, input, prepared);
    if (route.kind === "continue") return null;
    if (route.kind === "completed") {
      return Object.freeze({
        attemptId: route.attemptId,
        operationId: prepared.operationId,
        state: "completed" as const,
      });
    }
    return Object.freeze({
      attemptId: prepared.reconciliationId,
      operationId: prepared.operationId,
      state: prepared.state,
    });
  }
  const command = parseProductCommandMessageV1(prepared.originalMessage);
  if (
    command.eventType !== "SourceLinkRequestedV1" ||
    command.eventId !== prepared.requestEventId ||
    command.organizationId !== prepared.organizationId ||
    command.projectId !== prepared.projectId ||
    command.billingEpochId !== prepared.billingEpochId ||
    command.environmentId !== prepared.environmentId ||
    command.operationId !== prepared.operationId
  ) {
    throw new Error("SourceLink Queue recovery original command does not match durable evidence");
  }
  const outcome = await ensureCloudflareProductCommandWorkflow(bindings.DEPLOYMENT_WORKFLOW, {
    workflowId: prepared.workflowId,
    message: command,
  });
  if (outcome === "uncertain") {
    return Object.freeze({
      attemptId: prepared.reconciliationId,
      operationId: prepared.operationId,
      state: "uncertain",
    });
  }
  const finalized = await data.finalizeSourceLinkQueueDeliveryRecovery(() => ({
    organizationId: prepared.organizationId,
    operationId: prepared.operationId,
    reconciliationId: prepared.reconciliationId,
    preparedAuditEventId,
    finalAuditEventId,
    actorId: input.actorId,
    idempotencySha256: input.idempotencySha256,
    projectId: prepared.projectId,
    environmentId: prepared.environmentId,
    billingEpochId: prepared.billingEpochId,
    requestEventId: prepared.requestEventId,
    deliveryAttemptId: prepared.deliveryAttemptId,
    workflowId: prepared.workflowId,
    recoveredAt: canonicalNow(clock),
    workflowOutcome: outcome,
  }));
  const finalizedRoute = await closedSourceLinkWorkflowReplayRoute(data, input, finalized);
  if (finalizedRoute.kind === "continue") return null;
  if (finalizedRoute.kind === "completed") {
    return Object.freeze({
      attemptId: finalizedRoute.attemptId,
      operationId: finalized.operationId,
      state: "completed" as const,
    });
  }
  return Object.freeze({
    attemptId: finalized.reconciliationId,
    operationId: finalized.operationId,
    state: finalized.state,
  });
}
async function closedSourceLinkWorkflowReplayRoute(
  data: ProviderReconciliationDataPort,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly reconciliationId: Ulid;
    readonly actorId: string;
    readonly idempotencySha256: `sha256:${string}`;
  },
  closed: {
    readonly reconciliationId: Ulid;
    readonly continueProductWorkflowReplay?: true;
    readonly continueProductWorkflowReplayWithNewKey?: true;
    readonly continueProductWorkflowReplayAttemptIds?: readonly Ulid[];
    readonly completedProductWorkflowReplayAttemptIds?: readonly Ulid[];
  },
): Promise<
  | Readonly<{
      readonly kind: "continue";
    }>
  | Readonly<{
      readonly kind: "completed";
      readonly attemptId: Ulid;
    }>
  | Readonly<{
      readonly kind: "stored";
    }>
> {
  if (closed.completedProductWorkflowReplayAttemptIds?.includes(input.reconciliationId)) {
    const completed = await data.readTerminalSourceLinkWorkflowReplayAttempt(() => ({
      organizationId: input.organizationId,
      operationId: input.operationId,
      attemptId: input.reconciliationId,
      actorId: input.actorId,
      idempotencyDigest: digestBytes(input.idempotencySha256),
    }));
    return completed === null
      ? Object.freeze({ kind: "stored" as const })
      : Object.freeze({ kind: "completed" as const, attemptId: completed.attemptId });
  }
  if (
    closed.continueProductWorkflowReplay === true &&
    closed.reconciliationId === input.reconciliationId
  ) {
    return Object.freeze({ kind: "continue" as const });
  }
  if (closed.continueProductWorkflowReplayAttemptIds?.includes(input.reconciliationId)) {
    const replay = await data.readProductWorkflowReplayAttempt(() => ({
      organizationId: input.organizationId,
      operationId: input.operationId,
      attemptId: input.reconciliationId,
      actorId: input.actorId,
      idempotencyDigest: digestBytes(input.idempotencySha256),
    }));
    if (replay !== null) return Object.freeze({ kind: "continue" as const });
  }
  if (
    closed.continueProductWorkflowReplayWithNewKey === true &&
    closed.reconciliationId !== input.reconciliationId
  ) {
    return Object.freeze({ kind: "continue" as const });
  }
  return Object.freeze({ kind: "stored" as const });
}
async function requestDeploymentQueueDeliveryRecovery(
  bindings: ProviderReconciliationServices,
  data: ProviderReconciliationDataPort,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly reconciliationId: Ulid;
    readonly actorId: string;
    readonly idempotencySha256: `sha256:${string}`;
  },
  clock: Clock,
): Promise<{
  readonly attemptId: Ulid;
  readonly operationId: Ulid;
  readonly state: "completed" | "pending" | "uncertain";
} | null> {
  const preparedAuditEventId = await deterministicUlid(
    `${input.reconciliationId}:deployment-queue-delivery-recovery-prepared`,
  );
  const finalAuditEventId = await deterministicUlid(
    `${input.reconciliationId}:deployment-queue-delivery-recovered`,
  );
  const prepared = await data.prepareDeploymentQueueDeliveryRecovery(() => ({
    organizationId: input.organizationId,
    operationId: input.operationId,
    reconciliationId: input.reconciliationId,
    preparedAuditEventId,
    finalAuditEventId,
    actorId: input.actorId,
    idempotencySha256: input.idempotencySha256,
    preparedAt: canonicalNow(clock),
  }));
  if (prepared.outcome === "not_applicable") return null;
  if (prepared.outcome === "recovered") {
    if (prepared.continueProviderReconciliation === true) return null;
    return Object.freeze({
      attemptId: prepared.reconciliationId,
      operationId: prepared.operationId,
      state: prepared.state,
    });
  }
  const command = parseProductCommandMessageV1(prepared.originalMessage);
  const isRecoverableDeploymentCommand =
    command.eventType === "DeploymentRequestedV1" ||
    command.eventType === "DeploymentRollbackRequestedV1" ||
    command.eventType === "DeploymentPromotionRequestedV1";
  if (
    !isRecoverableDeploymentCommand ||
    command.eventId !== prepared.requestEventId ||
    command.organizationId !== prepared.organizationId ||
    command.projectId !== prepared.projectId ||
    command.billingEpochId !== prepared.billingEpochId ||
    command.environmentId !== prepared.environmentId ||
    command.operationId !== prepared.operationId ||
    (command.eventType === "DeploymentRequestedV1"
      ? command.planId !== prepared.planId
      : prepared.planId !== null)
  ) {
    throw new Error("Deployment Queue recovery original command does not match durable evidence");
  }
  const outcome = await ensureCloudflareProductCommandWorkflow(bindings.DEPLOYMENT_WORKFLOW, {
    workflowId: prepared.workflowId,
    message: command,
  });
  if (outcome === "uncertain") {
    return Object.freeze({
      attemptId: prepared.reconciliationId,
      operationId: prepared.operationId,
      state: "uncertain",
    });
  }
  const finalized = await data.finalizeDeploymentQueueDeliveryRecovery(() => ({
    organizationId: prepared.organizationId,
    operationId: prepared.operationId,
    reconciliationId: prepared.reconciliationId,
    preparedAuditEventId,
    finalAuditEventId,
    actorId: input.actorId,
    idempotencySha256: input.idempotencySha256,
    projectId: prepared.projectId,
    environmentId: prepared.environmentId,
    billingEpochId: prepared.billingEpochId,
    requestEventId: prepared.requestEventId,
    deliveryAttemptId: prepared.deliveryAttemptId,
    eventType: command.eventType,
    planId: prepared.planId,
    deploymentId: prepared.deploymentId,
    workflowId: prepared.workflowId,
    recoveredAt: canonicalNow(clock),
    workflowOutcome: outcome,
  }));
  if (finalized.continueProviderReconciliation === true) return null;
  return Object.freeze({
    attemptId: finalized.reconciliationId,
    operationId: finalized.operationId,
    state: finalized.state,
  });
}
interface ProviderObservation {
  readonly gateway: {
    readonly state: "unknown" | "absent" | "ready";
    readonly providerTag?: string;
    readonly observedAt?: string;
  };
  readonly wfp: {
    readonly state: "unknown" | "absent" | "ready";
    readonly providerTag?: string;
    readonly productDeploymentId?: Ulid;
    readonly artifactDigest?: `sha256:${string}`;
    readonly observedAt?: string;
  };
}
function requireProviderObservation(value: unknown): ProviderObservation {
  const record = requireRecord(value, "provider observation");
  return Object.freeze({
    gateway: parseGatewayObservation(record["gateway"]),
    wfp: parseWfpObservation(record["wfp"]),
  });
}
function parseGatewayObservation(value: unknown): ProviderObservation["gateway"] {
  const record = requireRecord(value, "gateway observation");
  const state = observationState(record["state"]);
  const providerTag = optionalString(record["providerTag"]);
  const observedAt = optionalTimestamp(record["observedAt"]);
  return Object.freeze({
    state,
    ...(providerTag === null ? {} : { providerTag }),
    ...(observedAt === null ? {} : { observedAt }),
  });
}
function parseWfpObservation(value: unknown): ProviderObservation["wfp"] {
  const record = requireRecord(value, "WFP observation");
  const state = wfpObservationState(record["state"]);
  const providerTag = optionalString(record["providerTag"]);
  const productDeploymentId =
    record["productDeploymentId"] === null || record["productDeploymentId"] === undefined
      ? null
      : parseUlid(String(record["productDeploymentId"]));
  const artifactDigest = optionalDigest(record["artifactDigest"]);
  const observedAt = optionalTimestamp(record["observedAt"]);
  return Object.freeze({
    state,
    ...(providerTag === null ? {} : { providerTag }),
    ...(productDeploymentId === null ? {} : { productDeploymentId }),
    ...(artifactDigest === null ? {} : { artifactDigest }),
    ...(observedAt === null ? {} : { observedAt }),
  });
}
function shouldAbandon(
  context: ProductProviderReconciliationContext,
  observation: ProviderObservation,
): boolean {
  return (
    context.wfpTarget !== null &&
    context.wfpTarget !== undefined &&
    (observation.gateway.state === "absent" ||
      (context.eventType === "DeploymentRollbackRequestedV1" &&
        observation.gateway.state === "ready")) &&
    observation.wfp.state === "absent"
  );
}
async function startReconciliationWorkflow(
  bindings: ProviderReconciliationServices,
  message: ProductProviderReconciliationMessageV1,
) {
  const workflowId = deterministicProviderReconciliationWorkflowId(message);
  const state = await startWorkflow(bindings.PROVIDER_RECONCILIATION_WORKFLOW, workflowId, message);
  return state === "errored" || state === "terminated" ? "uncertain" : state;
}
async function startOriginalWorkflow(
  bindings: ProviderReconciliationServices,
  physicalWorkflowId: string,
  originalMessage: ReturnType<typeof parseProductCommandMessageV1>,
) {
  const attemptId = physicalWorkflowId.slice("product-provider-reconcile-v1-".length);
  return startWorkflow(bindings.DEPLOYMENT_WORKFLOW, physicalWorkflowId, {
    command: originalMessage,
    reconciliationAttemptId: attemptId,
  });
}
async function startWorkflowReplay(
  bindings: ProviderReconciliationServices,
  physicalWorkflowId: string,
  originalMessage: ReturnType<typeof parseProductCommandMessageV1>,
) {
  const attemptId = physicalWorkflowId.slice("product-command-replay-v1-".length);
  return startWorkflow(bindings.DEPLOYMENT_WORKFLOW, physicalWorkflowId, {
    command: originalMessage,
    replayAttemptId: attemptId,
  });
}
async function readOrStartWorkflowReplay(
  bindings: ProviderReconciliationServices,
  physicalWorkflowId: string,
  originalMessage: ReturnType<typeof parseProductCommandMessageV1>,
) {
  try {
    const instance = await bindings.DEPLOYMENT_WORKFLOW.get(physicalWorkflowId);
    return workflowStatus(await instance.status());
  } catch {
    return startWorkflowReplay(bindings, physicalWorkflowId, originalMessage);
  }
}
/**
 * Ends a rename lost before it ever ran (observed Prod operation 01M36H2WAH5W46XFSVNSM15AFR) instead
 * of re-driving its stale intent. Without a recorded run no Workflow can exist. With one, a Queue
 * send may have reached its Workflow, so only a Workflow observed errored or terminated is ended; a
 * running one stays pending, and an unreadable or unknown status (a get failure is not a typed
 * not-found signal) stays uncertain without any change.
 */
async function abandonLostProductCommandIfNeverStarted(
  bindings: ProviderReconciliationServices,
  data: ProviderReconciliationDataPort,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly attemptId: Ulid;
    readonly actorId: string;
  },
  clock: Clock,
): Promise<{
  readonly attemptId: Ulid;
  readonly operationId: Ulid;
  readonly state: "completed" | "pending" | "uncertain";
} | null> {
  const outcome = (state: "completed" | "pending" | "uncertain") =>
    Object.freeze({ attemptId: input.attemptId, operationId: input.operationId, state });
  const lost = await data.findLostProductCommand(() => input);
  if (lost === null) return null;
  if (lost.state === "abandoned") return outcome("completed");
  if (lost.workflowId !== null) {
    const workflow = await readWorkflowState(bindings.DEPLOYMENT_WORKFLOW, lost.workflowId);
    if (workflow === "pending") return outcome("pending");
    if (workflow !== "errored" && workflow !== "terminated") return outcome("uncertain");
  }
  const ids = await Promise.all(
    [1, 2, 3, 4].map((index) => deterministicUlid(`${input.attemptId}:lost-command:${index}`)),
  );
  const abandoned = await data.abandonLostProductCommand(() => ({
    organizationId: input.organizationId,
    operationId: input.operationId,
    workflowId: lost.workflowId,
    reconciliationId: input.attemptId,
    actorId: input.actorId,
    abandonedAt: canonicalNow(clock),
    eventIds: ids,
  }));
  return outcome(abandoned === "changed" ? "uncertain" : "completed");
}
async function readOrStartOriginalWorkflow(
  bindings: ProviderReconciliationServices,
  physicalWorkflowId: string,
  originalMessage: ReturnType<typeof parseProductCommandMessageV1>,
) {
  try {
    const instance = await bindings.DEPLOYMENT_WORKFLOW.get(physicalWorkflowId);
    return workflowStatus(await instance.status());
  } catch {
    return startOriginalWorkflow(bindings, physicalWorkflowId, originalMessage);
  }
}
async function startWorkflow(
  binding: CloudflareWorkflowBinding<unknown>,
  workflowId: string,
  params: unknown,
): Promise<"completed" | "pending" | "uncertain" | "errored" | "terminated"> {
  let instance;
  try {
    await binding.create({ id: workflowId, params });
    return "pending";
  } catch {
    try {
      instance = await binding.get(workflowId);
    } catch {
      return "uncertain";
    }
  }
  try {
    return workflowStatus(await instance.status());
  } catch {
    return "uncertain";
  }
}
async function readWorkflowState(
  binding: CloudflareWorkflowBinding<unknown>,
  workflowId: string,
): Promise<"completed" | "pending" | "uncertain" | "errored" | "terminated"> {
  try {
    const instance = await binding.get(workflowId);
    return workflowStatus(await instance.status());
  } catch {
    return "uncertain";
  }
}
function workflowStatus(
  value: unknown,
): "completed" | "pending" | "uncertain" | "errored" | "terminated" {
  const status = requireRecord(value, "Workflow status")["status"];
  if (status === "complete") return "completed";
  if (status === "errored" || status === "terminated") return status;
  if (
    typeof status === "string" &&
    ["queued", "running", "paused", "waiting", "waitingForPause"].includes(status)
  ) {
    return "pending";
  }
  return "uncertain";
}
async function recoverTerminalAttempt(
  data: ProviderReconciliationDataPort,
  replay: Extract<
    NonNullable<Awaited<ReturnType<typeof readProductProviderReconciliationAttempt>>>,
    {
      outcome: "prepared";
    }
  >,
  actorId: string,
  terminalStatus: "errored" | "terminated",
  clock: Clock,
) {
  const original = parseProductCommandMessageV1(replay.originalMessage);
  const observationId = await deterministicUlid(
    `${replay.attemptId}:terminal-execution-observation`,
  );
  const auditEventId = await deterministicUlid(`${replay.attemptId}:terminal-execution-audit`);
  const evidenceDigest = await sha256Bytes(
    JSON.stringify({
      attemptId: replay.attemptId,
      physicalWorkflowId: replay.physicalWorkflowId,
      terminalStatus,
    }),
  );
  return data.recoverTerminalProductProviderReconciliationAttempt(() => ({
    attemptId: replay.attemptId,
    observationId,
    auditEventId,
    physicalWorkflowId: replay.physicalWorkflowId,
    organizationId: original.organizationId,
    operationId: original.operationId,
    actorId,
    terminalStatus,
    evidenceDigest,
    recoveredAt: canonicalNow(clock),
  }));
}
async function recoverTerminalWorkflowReplay(
  data: ProviderReconciliationDataPort,
  replay: Extract<
    NonNullable<Awaited<ReturnType<typeof readProductWorkflowReplayAttempt>>>,
    {
      outcome: "prepared";
    }
  >,
  actorId: string,
  terminalStatus: "errored" | "terminated",
  clock: Clock,
) {
  const failureId = await deterministicUlid(`${replay.attemptId}:terminal-replay-failure`);
  const evidenceDigest = await sha256Bytes(
    JSON.stringify({
      attemptId: replay.attemptId,
      physicalWorkflowId: replay.physicalWorkflowId,
      terminalStatus,
    }),
  );
  const command = parseProductCommandMessageV1(replay.originalMessage);
  return data.recoverTerminalProductWorkflowReplay(() => ({
    failureId,
    attemptId: replay.attemptId,
    organizationId: command.organizationId,
    operationId: command.operationId,
    actorId,
    terminalStatus,
    evidenceDigest,
    recoveredAt: canonicalNow(clock),
  }));
}
function replayCommand(candidate: {
  readonly eventType:
    | "SourceLinkRequestedV1"
    | "ProjectDeletionRequestedV1"
    | "DeploymentRollbackRequestedV1"
    | "DeploymentPromotionRequestedV1"
    | "ProjectDataChangeRequestedV1";
  readonly dataChange?: string | null;
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly billingEpochId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
}) {
  return parseProductCommandMessageV1({
    version: 1,
    eventType: candidate.eventType,
    eventId: candidate.eventId,
    organizationId: candidate.organizationId,
    projectId: candidate.projectId,
    billingEpochId: candidate.billingEpochId,
    environmentId: candidate.environmentId,
    operationId: candidate.operationId,
    ...(candidate.eventType === "ProjectDataChangeRequestedV1"
      ? { dataChange: candidate.dataChange }
      : {}),
  });
}
async function recoverInitialTerminalWorkflow(
  data: ProviderReconciliationDataPort,
  claim: NonNullable<Awaited<ReturnType<typeof findProductProviderReconciliationClaim>>>,
  actorId: string,
  terminalStatus: "completed" | "errored" | "terminated",
  clock: Clock,
) {
  const recoveredAt = canonicalNow(clock);
  const observationId = await deterministicUlid(
    `${claim.logicalWorkflowId}:terminal-provider-observation`,
  );
  const auditEventId = await deterministicUlid(
    `${claim.logicalWorkflowId}:terminal-provider-audit`,
  );
  const evidenceDigest = await sha256Bytes(
    JSON.stringify({
      logicalWorkflowId: claim.logicalWorkflowId,
      providerPhase: claim.providerPhase,
      terminalStatus,
    }),
  );
  await data.reconcileProductCommand(() => ({
    workflowId: claim.logicalWorkflowId,
    organizationId: parseUlid(claim.organizationId),
    projectId: claim.projectId,
    environmentId: claim.environmentId,
    operationId: claim.operationId,
    outboxEventId: claim.eventId,
    auditEventId,
    actorId,
    errorCode: "WORKFLOW_TERMINAL_BEFORE_RECONCILIATION",
    reconciledAt: recoveredAt,
    providerReconciliation: {
      observationId,
      evidenceDigest,
      hint: { phase: claim.providerPhase },
    },
  }));
}
async function observationDigest(value: ProviderObservation): Promise<Uint8Array> {
  return sha256Bytes(JSON.stringify(value));
}
async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function digestBytes(value: `sha256:${string}`): Uint8Array {
  return Uint8Array.from(value.slice(7).match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}
function canonicalNow(clock: Clock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Provider reconciliation clock is invalid");
  }
  return value.toISOString();
}
function observationState(value: unknown): "unknown" | "absent" | "ready" {
  if (value !== "unknown" && value !== "absent" && value !== "ready") {
    throw new TypeError("Gateway observation state is invalid");
  }
  return value;
}
function wfpObservationState(value: unknown): "unknown" | "absent" | "ready" {
  if (value === "metadata_absent") return "absent";
  return observationState(value);
}
function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new TypeError("Provider observation identity is invalid");
  }
  return value;
}
function optionalDigest(value: unknown): `sha256:${string}` | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Provider observation digest is invalid");
  }
  return value as `sha256:${string}`;
}
function optionalTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new TypeError("Provider observation time is invalid");
  return date.toISOString();
}
function requiredTimestamp(value: unknown): string {
  const timestamp = optionalTimestamp(value);
  if (timestamp === null) throw new TypeError("Provider observation time is invalid");
  return timestamp;
}
function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}
