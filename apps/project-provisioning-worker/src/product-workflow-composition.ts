import type { DeploymentInventoryPort } from "./deployment-inventory-port.js";
import type { DeploymentCandidatePort } from "./deployment-candidate-port.js";
import type { DeploymentAttemptPort } from "./deployment-attempt-port.js";
import type { DeploymentWorkflowDataPorts } from "./deployment-workflow-data-ports.js";
import type { DeploymentSourceCustodyPort } from "./deployment-source-port.js";
import { completionCommon, derivedIds, canonicalDate } from "./workflow-identities.js";
import { createWorkflowContextReader } from "./workflow-context-reader.js";
import type { DeploymentPersistenceReaderPort } from "./deployment-persistence-port.js";
import { normalizeCrons } from "@ohmyhost/contracts/functions";
import { parseBrowserPolicy, type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import {
  deterministicProductCommandWorkflowId,
  type ProductBuildFailure,
  type ProductHealthVerdict,
  type ProductCommandWorkflowPorts,
  type ProductProviderReconciliationHint,
} from "@ohmyhost/orchestrator";
import {
  readPgcfPostgresTarget,
  type recordWfpCandidateOperationCleanupReceipt,
  type recordEnvironmentFunctionSchedule,
  DeploymentPersistenceConflictError,
  type ProductWorkflowContext,
  type ProductWorkflowDeletionEnvironment,
  type ProductWorkflowDeletionDataEnvironment,
  type ProductWorkflowGatewayReceipt,
  type ProductWorkflowWfpReceipt,
} from "@ohmyhost/database/provisioning-persistence";
import {
  AI_KEY_NAME,
  BROWSER_KEY_NAME,
  createOperationDeploymentResult,
  DatabaseMigrationAdmissionError,
  admitMigrationsAfterAppliedPrefix,
  firstNotAdmittedMigrationPath,
  isRecordedBetterAuthVersion,
  parseUlid,
  type RecordedBetterAuthVersion,
  type Ulid,
  parseSharedGatewayReceipt,
  sharedGatewayScriptName,
} from "@ohmyhost/platform";
import type { VerifiedFunctionsRequirement } from "@ohmyhost/build-broker";

import type { DeploymentWorkflowServiceBindings } from "./bindings.js";
import { retireNextCacheScopes } from "./next-cache-retirement.js";
import { deterministicUlid } from "./deterministic-ulid.js";
import { createPrivateDeploymentServices } from "./private-service-adapters.js";
import { observeAbandonedGateway } from "./abandoned-gateway-recovery.js";

export function createDeploymentWorkflowPorts(
  bindings: DeploymentWorkflowServiceBindings,
  data: DeploymentWorkflowDataPorts,
  now: () => Date,
): ProductCommandWorkflowPorts {
  const services = createPrivateDeploymentServices(bindings);
  const {
    readers,
    terminals,
    custody,
    sourceCompletion,
    authorization,
    finalization,
    cleanup: cleanupPersistence,
    candidate: candidatePersistence,
    inventory: inventoryPersistence,
  } = data;
  const readContext = createWorkflowContextReader(readers);
  const context = (command: Command) => readContext(command);
  const finishPendingNativePolicy = async (
    command: Command,
  ): Promise<
    | boolean
    | {
        readonly state: "cleanup_required";
        readonly headVersion: number;
        readonly targetDeploymentId: string;
        readonly publication: Readonly<Record<string, unknown>>;
        readonly bindingRefreshSnapshot: Readonly<Record<string, unknown>>;
      }
  > => {
    const scope = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      environmentId: command.environmentId,
      operationId: command.operationId,
      claimId: await providerMutationClaimId(command),
    };
    const raw = await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.readPendingNativePolicySync(scope);
    if (raw === null) return false;
    const basic = requireRecord(raw, "Native policy synchronization");
    if (basic["state"] === "cleanup_required") {
      const cleanup = exactRecord(
        raw,
        [
          "organizationId",
          "projectId",
          "environmentId",
          "operationId",
          "claimId",
          "state",
          "headVersion",
          "targetDeploymentId",
          "publication",
          "bindingRefreshSnapshot",
        ],
        "Native policy synchronization",
      );
      if (
        Object.entries(scope).some(([key, value]) => cleanup[key] !== value) ||
        !positiveSafe(cleanup["headVersion"]) ||
        !isUlid(cleanup["targetDeploymentId"])
      )
        throw new TypeError("Native policy synchronization is invalid");
      return {
        state: "cleanup_required",
        headVersion: Number(cleanup["headVersion"]),
        targetDeploymentId: String(cleanup["targetDeploymentId"]),
        publication: requireRecord(cleanup["publication"], "Native publication"),
        bindingRefreshSnapshot: requireRecord(
          cleanup["bindingRefreshSnapshot"],
          "Native refresh snapshot",
        ),
      };
    }
    if (basic["state"] === "completed") {
      const completed = exactRecord(
        raw,
        ["organizationId", "projectId", "environmentId", "operationId", "claimId", "state"],
        "Native policy synchronization",
      );
      if (Object.entries(scope).some(([key, value]) => completed[key] !== value))
        throw new TypeError("Native policy synchronization is invalid");
      return true;
    }
    const pending = exactRecord(
      raw,
      [
        "organizationId",
        "projectId",
        "environmentId",
        "operationId",
        "claimId",
        "state",
        "headVersion",
        "targetDeploymentId",
        "configurationRevision",
        "revocationEpoch",
        "ownerEnabled",
        "canonicalOrigin",
        "registryVersion",
        "region",
      ],
      "Native policy synchronization",
    );
    if (pending["state"] !== "pending")
      throw new TypeError("Native policy synchronization is invalid");
    if (
      Object.entries(scope).some(([key, value]) => pending[key] !== value) ||
      !positiveSafe(pending["headVersion"]) ||
      !isUlid(pending["targetDeploymentId"]) ||
      (pending["region"] !== "us" && pending["region"] !== "eu") ||
      (pending["canonicalOrigin"] !== null && typeof pending["canonicalOrigin"] !== "string")
    )
      throw new TypeError("Native policy synchronization is invalid");
    const registryVersion = pending["registryVersion"];
    if (registryVersion !== null) {
      if (
        !positiveSafe(registryVersion) ||
        !positiveSafe(pending["configurationRevision"]) ||
        !positiveSafe(pending["revocationEpoch"]) ||
        typeof pending["ownerEnabled"] !== "boolean"
      )
        throw new TypeError("Native policy synchronization is invalid");
      const admin =
        pending["region"] === "eu" ? bindings.NATIVE_AUTH_ADMIN_EU : bindings.NATIVE_AUTH_ADMIN_US;
      const applied = requireRecord(
        await admin.applyRealmPolicy({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          configurationRevision: pending["configurationRevision"],
          revocationEpoch: pending["revocationEpoch"],
          enabled: pending["ownerEnabled"],
          canonicalOrigin: pending["canonicalOrigin"],
        }),
        "Native policy acknowledgement",
      );
      if (applied["outcome"] !== "applied")
        throw new Error("Native policy synchronization is unavailable");
    }
    const completed = await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.completeNativePolicySync({
      ...scope,
      headVersion: pending["headVersion"],
      configurationRevision: pending["configurationRevision"],
      revocationEpoch: pending["revocationEpoch"],
      ownerEnabled: pending["ownerEnabled"],
      canonicalOrigin: pending["canonicalOrigin"],
      registryVersion,
      acknowledgement: registryVersion === null ? "unprovisioned" : "applied",
    });
    if (completed !== "completed" && completed !== "replayed")
      throw new TypeError("Native policy completion is invalid");
    return true;
  };
  const recoverHandle = async (
    command: Extract<Command, { eventType: "ProjectHandleChangeRequestedV1" }>,
  ) => {
    const request = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
    };
    const raw = await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.beginHandleDomainRecovery(request);
    if (raw === null) return;
    const recovery = exactRecord(
      raw,
      ["organizationId", "projectId", "kind", "identity", "recoveryId"],
      "Native domain recovery",
    );
    if (
      recovery["organizationId"] !== request.organizationId ||
      recovery["projectId"] !== request.projectId ||
      recovery["kind"] !== "handle_change" ||
      !isUlid(recovery["identity"]) ||
      recovery["recoveryId"] !== request.operationId
    )
      throw new Error("Native domain recovery unavailable");
    const rows = await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.readDomainPolicySync(recovery);
    if (!Array.isArray(rows) || rows.length > 2)
      throw new Error("Native domain recovery unavailable");
    for (const rawRow of rows) {
      const row = requireRecord(rawRow, "Native domain recovery policy");
      if (
        !isUlid(row["environmentId"]) ||
        (row["region"] !== "us" && row["region"] !== "eu") ||
        !positiveSafe(row["configurationRevision"]) ||
        !positiveSafe(row["revocationEpoch"]) ||
        typeof row["ownerEnabled"] !== "boolean" ||
        row["canonicalOrigin"] !== null ||
        !(row["registryVersion"] === null || positiveSafe(row["registryVersion"]))
      )
        throw new Error("Native domain recovery unavailable");
      if (row["registryVersion"] !== null) {
        const service =
          row["region"] === "eu" ? bindings.NATIVE_AUTH_ADMIN_EU : bindings.NATIVE_AUTH_ADMIN_US;
        const applied = requireRecord(
          await service.applyRealmPolicy({
            organizationId: request.organizationId,
            projectId: request.projectId,
            environmentId: row["environmentId"],
            configurationRevision: row["configurationRevision"],
            revocationEpoch: row["revocationEpoch"],
            enabled: row["ownerEnabled"],
            canonicalOrigin: null,
          }),
          "Native domain recovery acknowledgement",
        );
        if (applied["outcome"] !== "applied") throw new Error("Native domain recovery unavailable");
      }
      const ack = await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.ackDomainPolicySync({
        ...recovery,
        environmentId: row["environmentId"],
        configurationRevision: row["configurationRevision"],
        revocationEpoch: row["revocationEpoch"],
        ownerEnabled: row["ownerEnabled"],
        registryVersion: row["registryVersion"],
        acknowledgement: row["registryVersion"] === null ? "unprovisioned" : "applied",
      });
      if (ack !== "acknowledged" && ack !== "replayed")
        throw new Error("Native domain recovery unavailable");
    }
    if (
      (await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.completeHandleDomainRecovery(recovery)) !==
      "completed"
    )
      throw new Error("Native domain recovery unavailable");
  };
  const ports: ProductCommandWorkflowPorts = {
    persistence: {
      readPromotionStaleness: async (command) =>
        (await readContext(command, true)).promotionStale ?? null,
      authorizeActivation: async (command, candidate) => {
        await authorization.assertExecution(command);
        if (candidate === undefined) return authorization.authorizeActivation(command);
        const current = await context(command);
        const persisted = await candidatePersistenceRecord(command, current, candidate);
        return authorization.authorizeActivation({
          organizationId: command.organizationId,
          projectId: command.projectId,
          operationId: command.operationId,
          candidateReceiptId: persisted.candidateReceiptId,
        });
      },
      recordCandidate: async ({ executionId, command, candidate, evidence }) => {
        const current = await context(command);
        const persisted = await candidatePersistenceRecord(command, current, candidate);
        const deploymentEvidence =
          command.eventType === "DeploymentRequestedV1" &&
          current.intent.bindingRefreshSnapshot == null
            ? await productDeploymentEvidence(command, current, executionId, evidence, custody)
            : null;
        const result = await candidatePersistence.recordCandidate({
          eventType: command.eventType,
          candidate: persisted,
          deploymentEvidence,
        });
        return {
          persistence: result === "created" ? ("applied" as const) : ("duplicate" as const),
          candidateReceiptId: persisted.candidateReceiptId,
        };
      },
      readGatewayAddressMoves: async (command) => {
        await recoverHandle(command);
        const current = await context(command);
        // Only environments with a published gateway move; one without has no address to change.
        return current.deletionEnvironments
          .filter((environment) => environment.activeGateway !== null)
          .map((environment) =>
            Object.freeze({
              environmentId: environment.environmentId,
              environmentName: environment.environmentName,
              handle: current.handle,
              publicOrigin: environment.activeGateway?.publicOrigin ?? "",
            }),
          );
      },
      finalizeHandleChange: async (input) => {
        const first = await data.handle.finalizeHandleChange(input);
        if (first !== "pending") return first;
        const scope = {
          organizationId: input.command.organizationId,
          projectId: input.command.projectId,
          kind: "handle_change",
          identity: input.command.operationId,
        };
        const rows = await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.readDomainPolicySync(scope);
        if (!Array.isArray(rows) || rows.length > 2)
          throw new Error("Native domain policy synchronization unavailable");
        for (const raw of rows) {
          const row = requireRecord(raw, "Native domain policy synchronization");
          if (
            !isUlid(row["environmentId"]) ||
            (row["region"] !== "us" && row["region"] !== "eu") ||
            !positiveSafe(row["configurationRevision"]) ||
            !positiveSafe(row["revocationEpoch"]) ||
            typeof row["ownerEnabled"] !== "boolean" ||
            row["canonicalOrigin"] !== null ||
            !(row["registryVersion"] === null || positiveSafe(row["registryVersion"]))
          )
            throw new Error("Native domain policy synchronization unavailable");
          if (row["registryVersion"] !== null) {
            const service =
              row["region"] === "eu"
                ? bindings.NATIVE_AUTH_ADMIN_EU
                : bindings.NATIVE_AUTH_ADMIN_US;
            const ack = requireRecord(
              await service.applyRealmPolicy({
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: row["environmentId"],
                configurationRevision: row["configurationRevision"],
                revocationEpoch: row["revocationEpoch"],
                enabled: row["ownerEnabled"],
                canonicalOrigin: null,
              }),
              "Native domain policy acknowledgement",
            );
            if (ack["outcome"] !== "applied")
              throw new Error("Native domain policy synchronization unavailable");
          }
          const acknowledged = await bindings.NATIVE_AUTH_RESOURCE_RUNTIME.ackDomainPolicySync({
            ...scope,
            environmentId: row["environmentId"],
            configurationRevision: row["configurationRevision"],
            revocationEpoch: row["revocationEpoch"],
            ownerEnabled: row["ownerEnabled"],
            registryVersion: row["registryVersion"],
            acknowledgement: row["registryVersion"] === null ? "unprovisioned" : "applied",
          });
          if (acknowledged !== "acknowledged" && acknowledged !== "replayed")
            throw new Error("Native domain policy synchronization unavailable");
        }
        const completed = await data.handle.finalizeHandleChange(input);
        if (completed === "pending")
          throw new Error("Native domain policy synchronization unavailable");
        return completed;
      },
      finalizeCandidate: async ({ workflowId, executionId, command, evidence }) => {
        if (
          command.eventType !== "DeploymentRequestedV1" &&
          command.eventType !== "DeploymentPromotionRequestedV1"
        )
          throw new TypeError("WFP finalization command type is invalid");
        const pendingNative = await finishPendingNativePolicy(command);
        if (pendingNative === true) return "applied" as const;
        if (pendingNative) return { status: "binding_refresh_pending" as const };
        const current = await context(command);
        const persisted = await candidatePersistenceRecord(
          command,
          current,
          candidateFromFinalEvidence(evidence, command),
        );
        const receipt = parseWfpReceipt(evidence["wfp"], command);
        const gateway = parseCandidateGateway(evidence["gateway"], command, current, receipt);
        const runtimePolicy = parseScheduledRuntimePolicy(evidence["runtimePolicy"]);
        const domain = exactRecord(
          await services.domains.ensureEnvironment({
            organizationId: command.organizationId,
            projectId: command.projectId,
            environmentId: command.environmentId,
            operationId: command.operationId,
            deploymentId: receipt.productDeploymentId,
            environmentName: current.environmentName,
            gatewayScriptName: sharedGatewayScriptName(receipt.namespace),
            healthCheckPath: runtimePolicy.healthCheckPath,
          }),
          [
            "dnsRecordId",
            "environmentName",
            "hostname",
            "observedAt",
            "probe",
            "publicUrl",
            "routeId",
            "status",
          ],
          "Cloudflare project domain",
        );
        const expectedOrigin = new URL(gateway.publicOrigin);
        const expectedProbeUrl = await sharedGatewayProbeUrl({
          projectId: command.projectId,
          environmentId: command.environmentId,
          operationId: command.operationId,
          deploymentId: receipt.productDeploymentId,
          publicOrigin: expectedOrigin,
          healthCheckPath: runtimePolicy.healthCheckPath,
        });
        const probe = parsePublicDomainProbe(domain["probe"], expectedProbeUrl);
        if (
          (domain["status"] !== "ready" && domain["status"] !== "pending") ||
          domain["environmentName"] !== current.environmentName ||
          domain["hostname"] !== expectedOrigin.hostname ||
          domain["publicUrl"] !== expectedOrigin.origin ||
          typeof domain["dnsRecordId"] !== "string" ||
          !/^[a-f0-9]{32}$/u.test(domain["dnsRecordId"]) ||
          typeof domain["routeId"] !== "string" ||
          !/^[a-f0-9]{32}$/u.test(domain["routeId"]) ||
          !canonicalTimestamp(domain["observedAt"])
        ) {
          throw new TypeError("Cloudflare project domain result is invalid");
        }
        if (domain["status"] === "pending") {
          throw new Error("Cloudflare project domain is pending");
        }
        if (probe === null || probe.status !== 404) {
          throw new TypeError("Cloudflare project domain result is invalid");
        }
        const operationResult =
          command.eventType === "DeploymentRequestedV1"
            ? await createWfpOperationResult(
                command,
                current,
                current.intent.bindingRefreshSnapshot == null
                  ? parseWfpLifecycleArtifact(evidence["artifact"], command)
                  : parseBindingRefreshArtifact(evidence["artifact"], current),
                receipt,
                httpsUrl(evidence["deploymentUrl"]),
              )
            : null;
        const completion = await completionCommon(workflowId, executionId, command, now);
        try {
          await finalization.finalizeCandidate({
            eventType: command.eventType,
            publication: {
              candidateReceiptId: persisted.candidateReceiptId,
              wfpReceiptId: command.operationId,
              revisionId: command.operationId,
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              productDeploymentId: receipt.productDeploymentId,
              expectedHeadVersion:
                current.intent.bindingRefreshSnapshot?.expectedHeadVersion ?? current.headVersion,
              deploymentUrl: httpsUrl(evidence["deploymentUrl"]),
              publishedAt: receipt.deployedAt,
              gateway,
            },
            schedule: functionScheduleInput({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              deploymentId: receipt.productDeploymentId,
              candidateReceiptId: persisted.candidateReceiptId,
              runtimePolicy: evidence["runtimePolicy"],
              functions: evidence["scheduledFunctions"],
              recordedAt: receipt.deployedAt,
            }),
            bindingRefreshSnapshot: current.intent.bindingRefreshSnapshot ?? null,
            completion:
              operationResult !== null && current.intent.bindingRefreshSnapshot == null
                ? {
                    ...completion,
                    eventType: "DeploymentRequestedV1",
                    terminalEvidence: {
                      result: operationResult,
                      runtimePolicy: evidence["runtimePolicy"],
                    },
                    revisionId: command.operationId,
                    acceptedLifecycleVersion: current.projectLifecycleVersion,
                    expectedHeadVersion: current.headVersion,
                    url: operationResult.url,
                    artifactDigest: digestBytes(operationResult.artifactSha256),
                    finalizedWfpResult: operationResult,
                    completedAt: receipt.deployedAt,
                  }
                : command.eventType === "DeploymentPromotionRequestedV1"
                  ? {
                      ...completion,
                      eventType: "DeploymentPromotionRequestedV1",
                      terminalEvidence: {
                        runtimePolicy: evidence["runtimePolicy"],
                        promotion: {
                          deploymentId: receipt.productDeploymentId,
                          url: httpsUrl(evidence["deploymentUrl"]),
                          artifactDigest: receipt.artifactDigest,
                          buildReused: true,
                        },
                      },
                      revisionId: command.operationId,
                      acceptedLifecycleVersion: current.projectLifecycleVersion,
                      expectedHeadVersion: current.headVersion,
                      url: httpsUrl(evidence["deploymentUrl"]),
                      artifactDigest: digestBytes(receipt.artifactDigest),
                      completedAt: receipt.deployedAt,
                    }
                  : null,
          });
          if (current.intent.bindingRefreshSnapshot != null)
            return { status: "binding_refresh_pending" as const };
          const nativeSync = await finishPendingNativePolicy(command);
          const sourcePlan =
            command.eventType === "DeploymentPromotionRequestedV1"
              ? current.promotionArtifact?.frameworkPlan
              : current.frameworkPlan;
          if (sourcePlan?.auth.provider === "omh-native" && nativeSync !== true)
            throw new Error("Native policy acknowledgement is unavailable");
          return "applied" as const;
        } catch (error) {
          if (error instanceof DeploymentPersistenceConflictError)
            return Object.freeze({ status: "conflict" as const, reason: error.message });
          throw error;
        }
      },
      finishBindingRefresh: async ({ workflowId, executionId, command, artifact: value }) => {
        const pendingNative = await finishPendingNativePolicy(command);
        if (pendingNative === true) return "applied" as const;
        const current = await context(command);
        if (current.intent.bindingRefreshSnapshot != null && current.bindingRefreshCompleted)
          return "duplicate" as const;
        const snapshot = current.intent.bindingRefreshSnapshot;
        if (
          snapshot == null ||
          !current.bindingRefreshPublished ||
          current.activeDeployment === null ||
          current.activeGateway === null
        )
          throw new Error("Binding refresh has no published current head");
        if (
          pendingNative &&
          (pendingNative.targetDeploymentId !== current.activeDeployment.productDeploymentId ||
            pendingNative.headVersion !== current.headVersion ||
            !sameJsonValue(pendingNative.bindingRefreshSnapshot, snapshot) ||
            pendingNative.publication["expectedHeadVersion"] !== snapshot.expectedHeadVersion ||
            pendingNative.publication["productDeploymentId"] !==
              current.activeDeployment.productDeploymentId)
        )
          throw new Error("Native binding refresh snapshot changed");
        const artifact = parseBindingRefreshArtifact(value, current);
        const claimId = await claimProviderMutation(readers, command, current);
        await finalization.assertBindingRefresh({
          ...command,
          snapshot,
          allowPublished: true,
        });
        const locator = `${snapshot.sourceNamespace}/${snapshot.sourceScriptName}`;
        const inventory = current.deletionInventory.filter(
          (item) =>
            item.provider === "cloudflare" &&
            item.resourceKind === "wfp-script" &&
            decodeCleanupLocator(item.cleanupLocator) === locator,
        );
        if (inventory.length !== 1 || inventory[0] === undefined)
          throw new Error("Binding refresh source retirement inventory is absent");
        if (
          inventory[0].cleanupOutcome !== "removed" &&
          inventory[0].cleanupOutcome !== "not_found"
        ) {
          const source = current.knownDeployments.find(
            (item) =>
              item.productDeploymentId === snapshot.sourceDeploymentId &&
              item.namespace === snapshot.sourceNamespace &&
              item.scriptName === snapshot.sourceScriptName &&
              item.providerTag === snapshot.sourceProviderTag,
          );
          if (source === undefined) throw new Error("Binding refresh source receipt is absent");
          let removed: Readonly<Record<string, unknown>>;
          try {
            removed = requireRecord(
              await services.wfp.removeCandidate({
                organizationId: command.organizationId,
                operationId: command.operationId,
                claimId,
                candidateReceiptId: snapshot.sourceCandidateReceiptId,
                scope: {
                  projectId: command.projectId,
                  environmentId: command.environmentId,
                  environmentName: current.environmentName,
                  handle: current.handle,
                },
                candidate: toRpcReceipt(source),
              }),
              "binding refresh source retirement",
            );
          } catch {
            return { status: "uncertain" as const };
          }
          if (
            removed["status"] !== "removed" ||
            (removed["outcome"] !== "removed" && removed["outcome"] !== "not_found")
          )
            return { status: "uncertain" as const };
          await recordDeletionAttempt(
            inventoryPersistence,
            command,
            current,
            "cloudflare",
            "wfp-script",
            locator,
            removed["outcome"],
            now,
          );
        }
        const result = await createWfpOperationResult(
          command,
          current,
          artifact,
          current.activeDeployment,
          current.activeGateway.publicOrigin,
        );
        const custody = current.bindingRefreshArtifact;
        if (custody == null) throw new Error("Binding refresh artifact policy is absent");
        const runtimePolicy = Object.freeze({
          healthCheckPath: custody.frameworkPlan.runtimePolicy.healthCheckPath,
          egressAllowedOrigins: current.activeGateway.egressAllowedOrigins,
          ...(current.activeGateway.browserPolicy === undefined
            ? {}
            : { browser: current.activeGateway.browserPolicy }),
        });
        const completion = await completionCommon(workflowId, executionId, command, now);
        const completed = await finalization.finishBindingRefresh({
          ...completion,
          eventType: "DeploymentRequestedV1",
          terminalEvidence: { result, runtimePolicy },
          revisionId: command.operationId,
          acceptedLifecycleVersion: current.projectLifecycleVersion,
          expectedHeadVersion: snapshot.expectedHeadVersion,
          url: result.url,
          artifactDigest: digestBytes(result.artifactSha256),
          finalizedWfpResult: result,
          completedAt: canonicalDate(now),
        });
        if (completed === "native_policy_pending") {
          if ((await finishPendingNativePolicy(command)) !== true)
            throw new Error("Native policy acknowledgement is unavailable");
          return "applied" as const;
        }
        return completionOutcome(completed);
      },
      finalizeRollback: async ({ workflowId, executionId, command, evidence }) => {
        const pendingNative = await finishPendingNativePolicy(command);
        if (pendingNative === true) return "applied" as const;
        if (pendingNative) throw new Error("Unexpected Native cleanup state");
        const current = await context(command);
        const intent = current.intent;
        if (
          intent.deploymentId === null ||
          intent.targetDeploymentId === null ||
          intent.targetRevisionId === null
        )
          throw new Error("Rollback Workflow context is incomplete");
        const rollbackDeploymentId = intent.deploymentId;
        const targetDeploymentId = intent.targetDeploymentId;
        const targetRevisionId = intent.targetRevisionId;
        const target = await candidatePersistence.resolveRollback({
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          targetDeploymentId,
          targetRevisionId,
        });
        if (target === null) throw new Error("Rollback candidate is unavailable");
        const gateway = requireRecord(evidence["gateway"], "rollback gateway");
        const parsedGateway = parseCandidateGateway(gateway, command, current, {
          productDeploymentId: targetDeploymentId,
          scriptName: target.candidate.immutableScriptName,
        });
        const runtimePolicy = parseScheduledRuntimePolicy(evidence["runtimePolicy"]);
        const domain = exactRecord(
          await services.domains.ensureEnvironment({
            organizationId: command.organizationId,
            projectId: command.projectId,
            environmentId: command.environmentId,
            operationId: command.operationId,
            deploymentId: targetDeploymentId,
            environmentName: current.environmentName,
            gatewayScriptName: sharedGatewayScriptName(target.candidate.namespace),
            healthCheckPath: runtimePolicy.healthCheckPath,
          }),
          [
            "dnsRecordId",
            "environmentName",
            "hostname",
            "observedAt",
            "probe",
            "publicUrl",
            "routeId",
            "status",
          ],
          "Cloudflare rollback domain",
        );
        const expectedOrigin = new URL(parsedGateway.publicOrigin);
        const probe = parsePublicDomainProbe(
          domain["probe"],
          await sharedGatewayProbeUrl({
            projectId: command.projectId,
            environmentId: command.environmentId,
            operationId: command.operationId,
            deploymentId: targetDeploymentId,
            publicOrigin: expectedOrigin,
            healthCheckPath: runtimePolicy.healthCheckPath,
          }),
        );
        if (
          (domain["status"] !== "ready" && domain["status"] !== "pending") ||
          domain["environmentName"] !== current.environmentName ||
          domain["hostname"] !== expectedOrigin.hostname ||
          domain["publicUrl"] !== expectedOrigin.origin ||
          typeof domain["dnsRecordId"] !== "string" ||
          !/^[a-f0-9]{32}$/u.test(domain["dnsRecordId"]) ||
          typeof domain["routeId"] !== "string" ||
          !/^[a-f0-9]{32}$/u.test(domain["routeId"]) ||
          !canonicalTimestamp(domain["observedAt"])
        ) {
          throw new TypeError("Cloudflare rollback domain result is invalid");
        }
        if (domain["status"] === "pending") throw new Error("Rollback domain is not ready");
        if (probe === null || probe.status !== 404) {
          throw new TypeError("Cloudflare rollback domain result is invalid");
        }
        const rollbackActivationReceiptId = await deterministicUlid(
          `${command.operationId}:rollback-activation`,
        );
        const targetArtifactDigest = Buffer.from(target.candidate.artifactDigest);
        const targetArtifactDigestString = `sha256:${targetArtifactDigest.toString("hex")}`;
        const completion = await completionCommon(workflowId, executionId, command, now);
        try {
          await finalization.finalizeRollback({
            activation: {
              rollbackActivationReceiptId,
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              rollbackDeploymentId,
              targetDeploymentId: target.targetDeploymentId,
              targetRevisionId: target.targetRevisionId,
              candidateReceiptId: target.candidate.candidateReceiptId,
              wfpReceiptId: target.wfpReceiptId,

              gateway: parsedGateway,
              expectedHeadVersion: current.headVersion,
              completedAt: current.acceptedAt,
            },
            schedule: functionScheduleInput({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              deploymentId: target.targetDeploymentId,
              candidateReceiptId: target.candidate.candidateReceiptId,
              runtimePolicy: evidence["runtimePolicy"],
              functions: evidence["scheduledFunctions"],
              recordedAt: current.acceptedAt,
            }),
            completion: {
              ...completion,
              eventType: "DeploymentRollbackRequestedV1",
              terminalEvidence: {
                runtimePolicy: evidence["runtimePolicy"],
                rollback: {
                  deploymentId: rollbackDeploymentId,
                  targetDeploymentId,
                  artifactDigest: targetArtifactDigestString,
                  url: parsedGateway.publicOrigin,
                  buildReused: true,
                },
              },
              revisionId: targetRevisionId,
              acceptedLifecycleVersion: current.projectLifecycleVersion,
              expectedHeadVersion: current.headVersion,
              url: parsedGateway.publicOrigin,
              artifactDigest: targetArtifactDigest,
              finalizedRollbackResult: true,
              completedAt: current.acceptedAt,
            },
          });
          await finishPendingNativePolicy(command);
          return "applied" as const;
        } catch (error) {
          if (error instanceof DeploymentPersistenceConflictError) {
            console.warn("rollback-finalization-conflict", error.message);
            return "conflict" as const;
          }
          throw error;
        }
      },
      prepareCandidateCleanup: async ({ command, candidate, reason, supersededById }) => {
        const current = await context(command);
        const persisted = await candidatePersistenceRecord(command, current, candidate);
        const cleanupReceiptId = await deterministicUlid(
          `${persisted.candidateReceiptId}:cleanup-receipt`,
        );
        const claimId = await deterministicUlid(`${persisted.candidateReceiptId}:cleanup-claim`);
        const cleanupRequestId = await deterministicUlid(
          `${persisted.candidateReceiptId}:cleanup-request:${reason}`,
        );
        const requestedAt = current.acceptedAt;
        // The lease starts when the cleanup is claimed, not when the operation was accepted:
        // a build runs for minutes, so an acceptance-anchored lease is expired before its first use.
        const leaseExpiresAt = new Date(
          now().getTime() + CLEANUP_CLAIM_LEASE_MILLISECONDS,
        ).toISOString();
        const claim = await cleanupPersistence.prepare({
          cleanupRequestId,
          candidate: persisted,
          reason,
          ...(supersededById === null ? {} : { supersededById: parseUlid(supersededById) }),
          requestedAt,
          claimId,
          leaseExpiresAt,
        });
        return {
          claimId: claim.claimId,
          candidateReceiptId: claim.candidateReceiptId,
          cleanupReceiptId,
          candidate,
          supersededById,
          expectedResources: claim.expectedResources,
        };
      },
      claimCandidateCleanup: async (command) => {
        const current = await context(command);
        const claimId = await deterministicUlid(`${command.operationId}:pending-cleanup-claim`);
        const claimedAt = canonicalDate(now);
        // The removal step may run its full timeout and retry window, so the lease outlives both.
        const leaseExpiresAt = new Date(
          Date.parse(claimedAt) + CLEANUP_CLAIM_LEASE_MILLISECONDS,
        ).toISOString();
        const claim = await cleanupPersistence.claim({
          organizationId: command.organizationId,
          projectId: command.projectId,
          claimId,
          claimedAt,
          leaseExpiresAt,
        });
        if (claim === null) return null;
        return {
          claimId: claim.claimId,
          candidateReceiptId: claim.candidateReceiptId,
          cleanupReceiptId: await deterministicUlid(`${claim.candidateReceiptId}:cleanup-receipt`),
          candidate: candidateFromPersistence(claim.candidate, current),
          supersededById: null,
          expectedResources: claim.expectedResources,
        };
      },
      recordCandidateCleanup: async ({ command, claim, cleanup }) => {
        const current = await context(command);
        const absence = requireRecord(cleanup.candidateAbsence, "candidate absence receipt");
        const observedAt = new Date(
          String(absence["observedAt"] ?? current.acceptedAt),
        ).toISOString();
        const resources = Array.isArray(cleanup.operationResources)
          ? cleanup.operationResources
          : [];
        const recordedResources: Parameters<typeof recordWfpCandidateOperationCleanupReceipt>[1][] =
          [];
        for (const [index, resource] of resources.entries()) {
          const record = requireRecord(resource, "operation cleanup evidence");
          recordedResources.push({
            operationCleanupReceiptId: await deterministicUlid(
              `${claim.candidateReceiptId}:operation-cleanup:${index}`,
            ),
            candidateReceiptId: parseUlid(claim.candidateReceiptId),
            organizationId: command.organizationId,
            projectId: command.projectId,
            operationId: parseUlid(claim.candidate.operationId),
            provider: "cloudflare",
            resourceKind: record["resourceKind"] as "source-archive" | "build-artifact",
            resourceIdentityDigest:
              record["resourceIdentityDigest"] instanceof Uint8Array
                ? record["resourceIdentityDigest"]
                : await sha256Bytes(record["identity"]),
            outcome: record["outcome"] as "removed" | "not_found",
            observedAt,
          });
        }
        const created = await cleanupPersistence.record({
          receipt: {
            cleanupReceiptId: parseUlid(claim.cleanupReceiptId),
            candidateReceiptId: parseUlid(claim.candidateReceiptId),
            organizationId: command.organizationId,
            projectId: command.projectId,
            claimId: parseUlid(claim.claimId),
            outcome: cleanup.outcome,
            observedProviderTag: parseCandidateOwnReceipt(
              claim.candidate.receipt,
              command.projectId,
            ).providerTag,
            observedAt,
          },
          gateway: cleanup.gateway === null ? null : parseCandidateCleanupGateway(cleanup.gateway),
          resources: recordedResources,
        });
        return created === "created" ? "applied" : "duplicate";
      },
      markCandidateSuperseded: async ({ command, candidate, claim }) => {
        if (claim.supersededById === null)
          throw new Error("Superseded candidate has no exact successor");
        const supersededById = claim.supersededById;
        const current = await context(command);
        const persisted = await candidatePersistenceRecord(command, current, candidate);
        const outcome = await cleanupPersistence.supersede({
          organizationId: command.organizationId,
          projectId: command.projectId,
          operationId: command.operationId,
          candidateReceiptId: persisted.candidateReceiptId,
          cleanupReceiptId: parseUlid(claim.cleanupReceiptId),
          supersededById: parseUlid(supersededById),
          terminalAt: current.acceptedAt,
        });
        return outcome === "superseded" ? "applied" : "duplicate";
      },
      complete: async ({ workflowId, executionId, command, evidence }) => {
        if (command.eventType === "SourceLinkRequestedV1")
          return sourceCompletion.complete({ workflowId, executionId, command, evidence });
        if (
          command.eventType === "ProjectHandleChangeRequestedV1" ||
          command.eventType === "ProjectDataChangeRequestedV1" ||
          command.eventType === "ProjectDeletionRequestedV1"
        )
          return data.lifecycle.complete({ workflowId, executionId, command, evidence });
        throw new Error("WFP deployment commands require their original typed finalization group");
      },
      requireReconciliation: (input) => data.reconciliation.requireReconciliation(input),
      fail: terminals.fail,
      rejectAuthorization: async ({
        workflowId,
        executionId,
        command,
        candidate,
        candidateEvidence,
        activation,
        activationAttempted,
      }) => {
        let target = candidate,
          observedActivation = activation;
        if (target !== null && activationAttempted && observedActivation === null) {
          const observed = await ports.wfp.observeActivation(command, target);
          if (observed.status === "uncertain") return observed;
          if (observed.status === "activated" || observed.status === "unhealthy")
            observedActivation = {
              candidateReceipt: observed.candidateReceipt,
              gateway: observed.gateway,
              deploymentUrl: observed.deploymentUrl,
            };
        }
        if (target !== null && command.eventType === "DeploymentRollbackRequestedV1") {
          if (observedActivation !== null) {
            const restored = await ports.wfp.restoreGateway(command, target, observedActivation);
            if (restored.status === "uncertain") return restored;
          }
        } else if (target !== null) {
          if (target.candidateReceiptId === null) {
            if (candidateEvidence === null)
              throw new Error("Rejected candidate has no durable source custody");
            const stored = await ports.persistence.recordCandidate({
              workflowId,
              executionId,
              command,
              candidate: target,
              evidence: candidateEvidence,
            });
            target = { ...target, candidateReceiptId: stored.candidateReceiptId };
          }
          const claim = await ports.persistence.prepareCandidateCleanup({
            command,
            candidate: target,
            reason: observedActivation === null ? "failed" : "compensate",
            supersededById: null,
          });
          const cleaned =
            observedActivation === null
              ? await ports.wfp.removeCandidate(command, claim)
              : await ports.wfp.compensate(command, claim, observedActivation);
          if (cleaned.status === "uncertain") return cleaned;
          const resources = await ports.cleanup.removeOperationArtifacts(command, claim);
          if (resources.status === "uncertain") return resources;
          await ports.persistence.recordCandidateCleanup({
            command,
            claim,
            cleanup: { ...cleaned, operationResources: resources.evidence },
          });
        }
        const persistence = await ports.persistence.fail({
          workflowId,
          executionId,
          command,
          errorCode: "AUTHORIZATION_CHANGED",
        });
        return { status: "failed" as const, persistence };
      },
      recordHealthFailure: terminals.recordHealthFailure,
      retainDeletionTombstone: (input) => data.lifecycle.retainDeletionTombstone(input),
    },
    source: {
      observeLink: async (command) => {
        const current = await context(command);
        const intent = current.intent;
        const authorizedRepositoryId = requireString(
          current.authorizedRepositoryId,
          "customer-authorized repository ID",
        );
        const response = await services.source.validateRepositoryLink({
          organizationId: command.organizationId,
          billingEpochId: command.billingEpochId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          operationId: command.operationId,
          installationId: positiveInteger(intent.installationId, "installation ID"),
          owner: requireString(intent.repositoryOwner, "repository owner"),
          name: requireString(intent.repositoryName, "repository name"),
        });
        const evidence = parseRepositoryLink(response);
        if (evidence.externalRepositoryId !== authorizedRepositoryId)
          throw new Error("GitHub repository identity changed after customer consent");
        return { status: "observed" as const, evidence };
      },
      fetchExactArchive: async (command) => {
        const current = await context(command);
        await claimProviderMutation(readers, command, current);
        const intent = current.intent;
        const grant = current.sourceGrant;
        if (grant === null || intent.sourceConnectionId === null)
          throw new Error("Deployment Workflow has no active source grant");
        const sourceConnectionId = intent.sourceConnectionId;
        const archive = await services.source.acquireExact({
          ...(grant.provider === "managed" ? { provider: "managed" } : {}),
          organizationId: command.organizationId,
          billingEpochId: command.billingEpochId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          operationId: command.operationId,
          idempotencyKey: `product-workflow:${command.eventId}`,
          sourceConnectionId,
          region: current.region,
          knownArchiveSha256: null,
          expectedSourceSha256: digestHex(intent.sourceDigest, "source digest"),
          repository: {
            owner: grant.repositoryOwner,
            name: grant.repositoryName,
            externalRepositoryId: grant.externalRepositoryId,
          },
          commitSha: requireString(intent.commitSha, "commit SHA"),
          grant: {
            status: "approved",
            grantId: grant.grantId,
            organizationId: command.organizationId,
            billingEpochId: command.billingEpochId,
            projectId: command.projectId,
            sourceConnectionId,
            installationId:
              grant.provider === "managed"
                ? null
                : positiveInteger(grant.installationId, "installation ID"),
            repositoryId:
              grant.provider === "managed"
                ? grant.externalRepositoryId
                : positiveInteger(grant.externalRepositoryId, "repository ID"),
            owner: grant.repositoryOwner,
            repository: grant.repositoryName,
            permission: "contents:read",
            grantedAt: grant.grantedAt,
            revokedAt: null,
          },
        });
        const parsed = parseSourceArchive(archive, command);
        const commitSha = requireString(intent.commitSha, "commit SHA");
        const sourceSha256 = digestHex(intent.sourceDigest, "source digest");
        await custody.recordArchive({
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          operationId: command.operationId,
          billingEpochId: command.billingEpochId,
          sourceConnectionId,
          provider: grant.provider,
          externalRepositoryId: grant.externalRepositoryId,
          commitSha,
          sourceSha256,
          archive: {
            bucket: parsed.archive.bucket,
            key: parsed.archive.key,
            versionId: parsed.archive.versionId,
            archiveId: parsed.archiveId,
            eTag: parsed.archive.eTag,
            byteLength: parsed.byteLength,
          },
          recordedAt: current.acceptedAt,
        });
        return { status: "observed" as const, archive: parsed };
      },
    },
    build: {
      readBindingRefresh: async (command) => {
        const current = await context(command);
        const snapshot = current.intent.bindingRefreshSnapshot;
        if (snapshot == null) return null;
        if (current.bindingRefreshCompleted) return { completed: true as const };
        await claimProviderMutation(readers, command, current);
        await finalization.assertBindingRefresh({
          ...command,
          snapshot,
          allowPublished: true,
        });
        const expectation = current.bindingRefreshArtifact;
        if (expectation == null)
          throw new Error("Binding refresh has no verified artifact custody");
        const { output, ...custody } = expectation;
        const artifact = parseBindingRefreshArtifact(
          await services.build.readBuildArtifact({ expectation: custody, bucket: output.bucket }),
          current,
        );
        return {
          artifact,
          artifactDigest: artifact.provenance.artifactDigest,
          published: current.bindingRefreshPublished === true,
        };
      },
      start: async (command, value) => {
        const current = await context(command);
        const archive = parseSourceArchive(value, command);
        if (current.frameworkPlan === null)
          throw new Error("Deployment Workflow has no exact framework plan");
        await authorization.assertExecution(command);
        const result = await services.build.startBuild({
          scope: providerScope(command),
          archive: archive.archive,
          deploymentId: requireString(current.intent.deploymentId, "deployment ID"),
          commitSha: requireString(current.intent.commitSha, "commit SHA"),
          buildPlanSha256: digestHex(current.intent.buildPlanDigest, "build plan digest"),
          frameworkPlan: current.frameworkPlan,
        });
        if (
          isRecord(result) &&
          result["status"] === "failed" &&
          result["errorCode"] === "BUILD_NOT_STARTED" &&
          Object.keys(result).length === 2
        ) {
          return { status: "failed" as const, errorCode: "BUILD_NOT_STARTED" as const };
        }
        return { status: "started" as const, receipt: parseBuildReceipt(result, command) };
      },
      observe: async (command, value) => {
        const current = await context(command);
        const receipt = parseBuildReceipt(value, command);
        const bucket = operationBuildBucket(current, command);
        const observation = requireRecord(
          await services.build.readBuild({ receipt, bucket }),
          "build observation",
        );
        if (observation["status"] === "running") return { status: "running" as const };
        if (observation["status"] === "failed" || observation["status"] === "stopped") {
          return {
            status: "failed" as const,
            errorCode: "BUILD_FAILED" as const,
            failure: parseBuildFailure(observation["failure"]),
          };
        }
        if (observation["status"] !== "succeeded")
          throw new TypeError("Build observation status is invalid");
        if (current.frameworkPlan === null)
          throw new Error("Deployment Workflow has no exact framework plan");
        const expectation = {
          receipt,
          deploymentId: requireString(current.intent.deploymentId, "deployment ID"),
          commitSha: requireString(current.intent.commitSha, "commit SHA"),
          sourceSha256: digestHex(current.intent.sourceDigest, "source digest"),
          buildPlanSha256: digestHex(current.intent.buildPlanDigest, "build plan digest"),
          frameworkPlan: current.frameworkPlan,
        };
        const artifact = parseArtifact(
          await services.build.readBuildArtifact({ expectation, bucket }),
          command,
        );
        const manifest = parseManifest(artifact.manifestBody);
        return {
          status: "observed" as const,
          artifact: Object.freeze({
            schemaVersion: "ohmyhost.verified-artifact-reference/v1" as const,
            expectation: Object.freeze(expectation),
            manifestDigest: artifact.manifestDigest,
            sbomDigest: manifest.sbomDigest,
            provenance: artifact.provenance,
          }),
          artifactDigest: artifact.provenance.artifactDigest,
        };
      },
    },
    database: {
      ensure: async (command, value) => {
        const current = await context(command);
        let artifactValue = value;
        if (command.eventType === "DeploymentPromotionRequestedV1") {
          if (value !== undefined || current.promotionArtifact === null) {
            throw new TypeError("Promotion target resources have no exact source artifact");
          }
          const { output, ...expectation } = current.promotionArtifact;
          artifactValue = await services.build.readBuildArtifact({
            expectation,
            bucket: output.bucket,
          });
        }
        const reference = isArtifactReference(artifactValue)
          ? parseArtifactReference(artifactValue, command)
          : null;
        const artifact =
          reference === null
            ? parseArtifact(
                artifactValue,
                command.eventType === "DeploymentPromotionRequestedV1" ||
                  current.intent.bindingRefreshSnapshot != null
                  ? undefined
                  : command,
              )
            : reference.provenance.database.enabled
              ? await readReferencedArtifact(services, reference, command)
              : null;
        const provenance = reference?.provenance ?? artifact?.provenance;
        if (provenance === undefined) {
          throw new TypeError("Verified artifact provenance is unavailable");
        }
        const nativeAuthEnabled = provenance.auth.provider === "omh-native";
        const databaseEnabled = provenance.database.enabled;
        const authEnabled = provenance.auth.provider === "better-auth";
        const storageEnabled = provenance.storage.enabled;
        // A promotion has no new plan; its capability requirements belong to the verified source plan.
        const capabilityFrameworkPlan =
          command.eventType === "DeploymentPromotionRequestedV1"
            ? current.promotionArtifact?.frameworkPlan
            : current.frameworkPlan;
        const mailEnabled =
          capabilityFrameworkPlan !== null &&
          capabilityFrameworkPlan !== undefined &&
          "mail" in capabilityFrameworkPlan &&
          capabilityFrameworkPlan.mail.enabled;
        const aiEnabled =
          capabilityFrameworkPlan !== null &&
          capabilityFrameworkPlan !== undefined &&
          capabilityFrameworkPlan.ai !== undefined;
        const browserEnabled =
          capabilityFrameworkPlan !== null &&
          capabilityFrameworkPlan !== undefined &&
          capabilityFrameworkPlan.browser !== undefined;
        if (
          !databaseEnabled &&
          !authEnabled &&
          !nativeAuthEnabled &&
          !mailEnabled &&
          !storageEnabled &&
          !aiEnabled &&
          !browserEnabled
        ) {
          return { status: "ready" as const, receipt: null };
        }
        const promotionClaimId =
          command.eventType === "DeploymentPromotionRequestedV1"
            ? await claimProviderMutation(readers, command, current)
            : null;
        if (databaseEnabled) {
          if (artifact === null) {
            throw new TypeError("Verified artifact migrations are unavailable");
          }
          // Only the structure: this Worker cannot read the database ledger, so the SQL policy of an already applied
          // file is never decided here. The executor admits the pending files under the migrations lock.
          const appliedCount = artifact.migrations.length;
          try {
            admitMigrationsAfterAppliedPrefix(artifact.migrations, appliedCount);
          } catch (error) {
            if (error instanceof DatabaseMigrationAdmissionError) {
              return {
                status: "failed" as const,
                errorCode: "DATABASE_MIGRATION_FAILED" as const,
                migration: {
                  reason: "not_admitted" as const,
                  path: firstNotAdmittedMigrationPath(artifact.migrations, appliedCount),
                },
              };
            }
            throw error;
          }
        }
        const claimId =
          promotionClaimId ?? (await claimProviderMutation(readers, command, current));
        let nativeAuthRegistration: Readonly<Record<string, unknown>> | null = null;
        if (nativeAuthEnabled) {
          const scope = {
            organizationId: command.organizationId,
            projectId: command.projectId,
            environmentId: command.environmentId,
            operationId: command.operationId,
            claimId,
          };
          const placed = requireRecord(
            await services.neon.placeNativeAuthDatabase(scope),
            "Native Auth database placement",
          );
          if (placed["status"] === "origin_pending")
            throw new Error("Native Auth requires an approved application origin");
          if (placed["status"] === "reconciliation_required")
            return { status: "uncertain" as const };
          if (placed["status"] !== "ready")
            throw new TypeError("Native Auth database placement is invalid");
          const prepared = requireRecord(
            await services.neon.prepareNativeAuthRealm(scope),
            "Native Auth realm preparation",
          );
          if (prepared["status"] === "reconciliation_required")
            return { status: "uncertain" as const };
          const registration = requireRecord(prepared["registration"], "Native Auth registration");
          const policy = requireRecord(prepared["policy"], "Native Auth policy");
          if (
            prepared["status"] !== "ready" ||
            registration["status"] !== "active" ||
            registration["organizationId"] !== command.organizationId ||
            registration["projectId"] !== command.projectId ||
            registration["environmentId"] !== command.environmentId ||
            typeof policy["canonicalOrigin"] !== "string"
          )
            throw new TypeError("Native Auth realm preparation is invalid");
          nativeAuthRegistration = Object.freeze({ ...registration });
        }
        let storageBucket: Readonly<Record<string, unknown>> | null = null;
        let storageGatewayKey: Readonly<Record<string, unknown>> | null = null;
        if (provenance.storage.enabled) {
          const ensured = requireRecord(
            await services.r2.ensureBucket({
              jurisdiction: provenance.storage.jurisdiction,
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
            }),
            "R2 bucket",
          );
          if (ensured["status"] === "reconciliation_required") {
            return { status: "uncertain" as const };
          }
          if (ensured["status"] === "conflict") {
            return {
              status: "failed" as const,
              errorCode: "STORAGE_JURISDICTION_CONFLICT" as const,
            };
          }
          const receipt = requireRecord(ensured["receipt"], "R2 bucket receipt");
          const expectedBucket = `ohmyho-${command.projectId.toLowerCase()}-${command.environmentId.toLowerCase()}`;
          if (
            ensured["status"] !== "ready" ||
            receipt["bucketName"] !== expectedBucket ||
            typeof receipt["bucketId"] !== "string" ||
            !/^[0-9a-f]{32}$/u.test(receipt["bucketId"]) ||
            receipt["jurisdiction"] !== provenance.storage.jurisdiction ||
            receipt["storageClass"] !== "Standard" ||
            receipt["publicAccess"] !== false
          ) {
            throw new TypeError("R2 bucket result is invalid");
          }
          storageBucket = Object.freeze({ ...receipt });
          const gatewayKey = requireRecord(
            await services.runtimeSecrets.ensureStorageGatewayKey({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
            }),
            "storage gateway key",
          );
          if (
            gatewayKey["name"] !== "OHMYHOST_STORAGE_KEY" ||
            !positiveSafe(gatewayKey["revision"]) ||
            !positiveSafe(gatewayKey["keyVersion"])
          ) {
            throw new TypeError("Storage gateway key result is invalid");
          }
          storageGatewayKey = Object.freeze({ ...gatewayKey });
        }
        let placement: Readonly<Record<string, unknown>> | null = null;
        let migration: Readonly<Record<string, unknown>> | null = null;
        if (
          databaseEnabled &&
          (command.eventType !== "DeploymentPromotionRequestedV1" ||
            current.dataMode === "isolated")
        ) {
          if (artifact === null) {
            throw new TypeError("Verified artifact migrations are unavailable");
          }
          const placed = requireRecord(
            await services.neon.placeProject({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
            }),
            "database placement",
          );
          if (placed["status"] === "reconciliation_required") {
            return placed["reason"] === "provider_provisioning"
              ? { status: "provisioning_pending" as const }
              : { status: "uncertain" as const };
          }
          if (
            placed["status"] !== "ready" ||
            typeof placed["providerProjectId"] !== "string" ||
            (placed["provider"] === "pgcf"
              ? typeof placed["databaseId"] !== "string" ||
                !/^[a-z0-9]{20}$/u.test(placed["databaseId"])
              : typeof placed["defaultBranchId"] !== "string")
          ) {
            throw new TypeError("Database placement result is invalid");
          }
          placement = Object.freeze({ ...placed });
          const migrated = requireRecord(
            await services.neon.migrateProject({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
              migrations: artifact.migrations,
              auth: provenance.auth,
            }),
            "Neon migration",
          );
          if (migrated["status"] === "reconciliation_required") {
            return { status: "uncertain" as const };
          }
          if (
            migrated["status"] === "failed" &&
            migrated["errorCode"] === "DATABASE_MIGRATION_FAILED"
          ) {
            return {
              status: "failed" as const,
              errorCode: "DATABASE_MIGRATION_FAILED" as const,
              migration: parseMigrationFailure(migrated["migration"]),
            };
          }
          if (
            migrated["status"] !== "ready" ||
            !Array.isArray(migrated["appliedPaths"]) ||
            !Array.isArray(migrated["replayedPaths"])
          ) {
            throw new TypeError("Neon migration result is invalid");
          }
          migration = Object.freeze({ ...migrated });
        }
        let authSecret: Readonly<Record<string, unknown>> | null = null;

        let mailDomain: Readonly<Record<string, unknown>> | null = null;
        let mailGatewayKey: Readonly<Record<string, unknown>> | null = null;
        let aiGatewayKey: Readonly<Record<string, unknown>> | null = null;
        let browserGatewayKey: Readonly<Record<string, unknown>> | null = null;
        if (authEnabled) {
          const installed = requireRecord(
            await services.runtimeSecrets.ensureCustomerAuthSecret({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
            }),
            "customer auth secret",
          );
          if (
            installed["name"] !== "BETTER_AUTH_SECRET" ||
            !positiveSafe(installed["revision"]) ||
            !positiveSafe(installed["keyVersion"])
          ) {
            throw new TypeError("Customer auth secret result is invalid");
          }
          authSecret = Object.freeze({ ...installed });
        }
        // Only a declared Mail capability provisions a sender; Better Auth alone does not.
        if (mailEnabled) {
          if (current.mailDomain === null) {
            throw new TypeError("Mail-enabled deployment has no configured sender domain");
          }
          const domain = requireRecord(
            await services.ses.ensureMailDomain({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
              acceptedLifecycleVersion: current.projectLifecycleVersion,
              domain: current.mailDomain,
            }),
            "Managed mail domain",
          );
          if (
            domain["status"] === "failed" &&
            (domain["errorCode"] === "PAID_PLAN_REQUIRED" ||
              domain["errorCode"] === "INSUFFICIENT_ORGANIZATION_CREDITS")
          )
            return { status: "failed" as const, errorCode: domain["errorCode"] };
          if (domain["status"] === "reconciliation_required" || domain["status"] === "failed")
            return { status: "uncertain" as const };
          if (domain["status"] === "verification_pending")
            return { status: "verification_pending" as const };
          const domainReceipt = requireRecord(domain["receipt"], "Managed mail receipt");
          if (
            domain["status"] !== "ready" ||
            domainReceipt["provider"] !== "resend" ||
            domainReceipt["organizationId"] !== command.organizationId ||
            domainReceipt["projectId"] !== command.projectId ||
            domainReceipt["environmentId"] !== command.environmentId ||
            domainReceipt["domain"] !== current.mailDomain ||
            typeof domainReceipt["providerDomainId"] !== "string"
          )
            throw new TypeError("Managed mail domain result is invalid");
          mailDomain = Object.freeze({ ...domainReceipt });
          const gatewayKey = requireRecord(
            await services.runtimeSecrets.ensureMailGatewayKey({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
            }),
            "mail gateway key",
          );
          if (
            gatewayKey["name"] !== "OHMYHOST_MAIL_KEY" ||
            !positiveSafe(gatewayKey["revision"]) ||
            !positiveSafe(gatewayKey["keyVersion"])
          ) {
            throw new TypeError("Mail gateway key result is invalid");
          }
          mailGatewayKey = Object.freeze({ ...gatewayKey });
        }
        // The AI key is installed for the declared capability; the Core decides delivery from the plan.
        if (aiEnabled) {
          const gatewayKey = requireRecord(
            await services.runtimeSecrets.ensureAiGatewayKey({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
            }),
            "AI gateway key",
          );
          if (
            gatewayKey["name"] !== AI_KEY_NAME ||
            !positiveSafe(gatewayKey["revision"]) ||
            !positiveSafe(gatewayKey["keyVersion"])
          ) {
            throw new TypeError("AI gateway key result is invalid");
          }
          aiGatewayKey = Object.freeze({ ...gatewayKey });
        }
        // The Browser key is installed for the declared capability; the Core decides delivery from the plan.
        if (browserEnabled) {
          const gatewayKey = requireRecord(
            await services.runtimeSecrets.ensureBrowserGatewayKey({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              claimId,
            }),
            "Browser gateway key",
          );
          if (
            gatewayKey["name"] !== BROWSER_KEY_NAME ||
            !positiveSafe(gatewayKey["revision"]) ||
            !positiveSafe(gatewayKey["keyVersion"])
          ) {
            throw new TypeError("Browser gateway key result is invalid");
          }
          browserGatewayKey = Object.freeze({ ...gatewayKey });
        }
        return {
          status: "ready" as const,
          receipt: Object.freeze({
            placement,
            migration,
            authSecret,
            nativeAuthRegistration,

            mailDomain,
            mailGatewayKey,
            storageBucket,
            storageGatewayKey,
            aiGatewayKey,
            ...(browserGatewayKey === null ? {} : { browserGatewayKey }),
          }),
        };
      },
    },
    wfp: {
      stage: async (command, value) => {
        const current = await context(command);
        if (current.activeDeploymentId !== null && current.activeGateway === null) {
          throw new Error("Deployment Workflow has no exact active project gateway receipt");
        }
        let artifact: ArtifactBundle | ArtifactReference;
        if (value !== undefined) {
          artifact = isArtifactReference(value)
            ? parseArtifactReference(value, command)
            : current.intent.bindingRefreshSnapshot == null
              ? parseArtifact(value, command)
              : parseBindingRefreshArtifact(value, current);
        } else {
          if (
            command.eventType !== "DeploymentPromotionRequestedV1" ||
            current.promotionArtifact === null
          ) {
            throw new Error("WFP candidate staging has no exact artifact");
          }
          if (
            current.intent.expectedTargetHeadVersion === null ||
            current.headVersion !== current.intent.expectedTargetHeadVersion
          )
            throw new Error("Promotion target head changed");
          const { output, ...expectation } = current.promotionArtifact;
          artifact = parseArtifact(
            await services.build.readBuildArtifact({ expectation, bucket: output.bucket }),
            undefined,
          );
        }
        const claimId = await claimProviderMutation(readers, command, current);
        if (current.intent.bindingRefreshSnapshot != null)
          await finalization.assertBindingRefresh({
            ...command,
            snapshot: current.intent.bindingRefreshSnapshot as NonNullable<
              typeof current.intent.bindingRefreshSnapshot
            >,
            allowPublished: false,
          });
        let previousGateway = current.activeGateway;
        if (current.activeDeploymentId === null && previousGateway === null) {
          // Re-read under the operation's provider claim; a pre-claim context is not authority.
          const claimed = await context(command);
          const recovered = await observeAbandonedGateway(
            bindings.WFP_MANAGEMENT,
            { ...command, environmentName: claimed.environmentName, handle: claimed.handle },
            claimed.abandonedWfpTargets ?? [],
          );
          if (recovered !== null) {
            const verifiedGateway = parseGatewayReceipt(recovered.gateway, command, claimed);
            const auditEventId = await deterministicUlid(
              `${command.operationId}:abandoned-gateway:${recovered.target.candidateReceiptId}:${verifiedGateway.revision}`,
            );
            await candidatePersistence.recordAbandonedGateway({
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: command.environmentId,
              operationId: command.operationId,
              candidateReceiptId: recovered.target.candidateReceiptId,
              sharedGatewayRevision: verifiedGateway.revision,
              auditEventId,
              observedAt: verifiedGateway.observedAt,
            });
            previousGateway = verifiedGateway;
          }
        }
        const databaseBinding = await projectDatabaseBinding(services, command, artifact);
        if (
          command.eventType === "DeploymentPromotionRequestedV1" &&
          artifact.provenance.storage.enabled
        ) {
          const bucket = await ensureProjectStorageBucket(
            services,
            command,
            claimId,
            artifact.provenance.storage.jurisdiction,
          );
          if (bucket === "conflict") {
            return {
              status: "failed" as const,
              errorCode: "STORAGE_JURISDICTION_CONFLICT" as const,
            };
          }
          if (bucket === "uncertain") {
            return {
              status: "uncertain" as const,
              providerHint: emptyCompositionProviderHint("storage"),
            };
          }
        }
        const storageBucketName = await projectStorageBucketName(services, command, artifact);
        const storageDataEnvironmentId =
          storageBucketName === null
            ? null
            : await projectStorageDataEnvironmentId(candidatePersistence, command, databaseBinding);
        const stage =
          command.eventType === "DeploymentPromotionRequestedV1"
            ? services.runtimeSecrets.stagePromotionCandidate
            : services.runtimeSecrets.stageCandidate;
        const result = requireRecord(
          await stage({
            scope: runtimeSecretDeliveryScope(command, current),
            deploymentId: requireString(current.intent.deploymentId, "deployment ID"),
            artifact,
            knownDeployments: current.knownDeployments.map(toRpcReceipt),
            ...(previousGateway === null
              ? {}
              : { previousGateway: toRpcGatewayReceipt(previousGateway) }),
            ...(databaseBinding ?? {}),
            ...(storageBucketName === null ? {} : { storageBucketName }),
            ...(storageDataEnvironmentId === null ? {} : { storageDataEnvironmentId }),
            ...(command.eventType === "DeploymentPromotionRequestedV1"
              ? { artifactReuse: "promotion" as const }
              : current.intent.bindingRefreshSnapshot != null
                ? { artifactReuse: "binding-refresh" as const }
                : {}),
          }),
          "WFP candidate staging",
        );
        if (result["status"] === "reconciliation_required") {
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              artifact.provenance.artifactDigest,
              command.eventType === "DeploymentPromotionRequestedV1" ||
                current.intent.bindingRefreshSnapshot != null
                ? parseUlid(requireString(current.intent.deploymentId, "deployment ID"))
                : artifact.provenance.deploymentId,
              result["activationRuntimePolicy"],
            ),
          };
        }
        if (result["status"] === "rejected") {
          return { status: "failed" as const, errorCode: "RUNTIME_CANDIDATE_REJECTED" as const };
        }
        if (result["status"] !== "staged" && result["status"] !== "replayed")
          throw new TypeError("WFP candidate staging result is invalid");
        validateRuntimeSecretDelivery(result);
        const candidate = parseWfpReceipt(result["candidate"], command);
        return {
          status: result["status"] as "staged" | "replayed",
          candidateReceiptId: null,
          operationId: command.operationId,
          receipt: candidate,
          previousGateway:
            result["priorGateway"] === null
              ? null
              : parseGatewayReceipt(result["priorGateway"], command, current),
          runtimePolicy: requireRecord(
            result["activationRuntimePolicy"],
            "activation runtime policy",
          ),
          runtimeSecretDeliveryStage: result["runtimeSecretDeliveryStage"],
          scheduledFunctions: artifact.provenance.functions,
          deploymentUrl: httpsUrl(result["deploymentUrl"]),
          artifactDigest: candidate.artifactDigest,
        };
      },
      recordStagedCandidate: async (command, candidateReceiptId, candidate) => {
        const current = await context(command);
        const receipt = parseWfpReceipt(candidate.receipt, command);
        const result = requireRecord(
          await services.runtimeSecrets.recordStagedCandidate({
            scope: runtimeSecretDeliveryScope(command, current),
            candidateReceiptId: parseUlid(candidateReceiptId),
            candidate: toRpcReceipt(receipt),
            runtimeSecretDeliveryStage: requireRuntimeSecretStage(candidate),
          }),
          "runtime secret candidate stage",
        );
        if (result["status"] === "reconciliation_required")
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              receipt.artifactDigest,
              receipt.productDeploymentId,
              candidate.runtimePolicy,
            ),
          };
        if (result["status"] !== "recorded" && result["status"] !== "replayed")
          throw new TypeError("Runtime secret candidate stage result is invalid");
        return {
          status: result["status"] as "recorded" | "replayed",
          runtimeSecretDeliveryStage: result["runtimeSecretDeliveryStage"],
        };
      },
      recordActivatedCandidate: async (command, candidate, activation) => {
        const current = await context(command);
        const receipt = parseWfpReceipt(candidate.receipt, command);
        const result = requireRecord(
          await services.runtimeSecrets.recordActivatedCandidate({
            scope: runtimeSecretDeliveryScope(command, current),
            candidate: toRpcReceipt(receipt),
            gateway: toRpcGatewayReceipt(parseGatewayReceipt(activation.gateway, command, current)),
            runtimeSecretDeliveryStage: requireRuntimeSecretStage(candidate),
          }),
          "runtime secret candidate activation",
        );
        if (result["status"] === "reconciliation_required")
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              receipt.artifactDigest,
              receipt.productDeploymentId,
              candidate.runtimePolicy,
            ),
          };
        if (result["status"] !== "activated" && result["status"] !== "existing")
          throw new TypeError("Runtime secret candidate activation result is invalid");
        return { status: result["status"] as "activated" | "existing" };
      },
      prepareRollback: async (command) => {
        const current = await context(command);
        if (current.rollbackArtifact === null)
          throw new Error("Rollback Workflow has no immutable target artifact");
        if (current.intent.targetDeploymentId === null || current.intent.targetRevisionId === null)
          throw new Error("Rollback Workflow has no immutable target identity");
        const targetDeploymentId = current.intent.targetDeploymentId;
        const targetRevisionId = current.intent.targetRevisionId;
        const rollbackTarget = await candidatePersistence.resolveRollback({
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          targetDeploymentId,
          targetRevisionId,
        });
        if (rollbackTarget === null) throw new Error("Rollback candidate is unavailable");
        const { output, ...rollbackExpectation } = current.rollbackArtifact;
        const artifact = parseArtifact(
          await services.build.readBuildArtifact({
            expectation: rollbackExpectation,
            bucket: output.bucket,
          }),
          undefined,
        );
        const previous = current.knownDeployments.find(
          (receipt) =>
            receipt.productDeploymentId === targetDeploymentId &&
            receipt.artifactDigest === artifact.provenance.artifactDigest,
        );
        if (previous === undefined) throw new Error("Rollback target has no WFP receipt");
        if (current.activeGateway === null) {
          throw new Error("Rollback Workflow has no exact active project gateway receipt");
        }
        await claimProviderMutation(readers, command, current);
        const rollbackDataScope = {
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          deploymentId: targetDeploymentId,
          revisionId: targetRevisionId,
        };
        const dataTarget = await data.rollbackData.readRollbackDataTarget(rollbackDataScope);
        if (dataTarget === null || dataTarget.dataChanged || dataTarget.dataChangeInProgress)
          throw new Error("Rollback target data changed");
        const databaseBinding = await projectDatabaseBinding(services, command, artifact);
        const storageBucketName = await projectStorageBucketName(services, command, artifact);
        const storageDataEnvironmentId =
          storageBucketName === null
            ? null
            : await projectStorageDataEnvironmentId(candidatePersistence, command, databaseBinding);
        const result = requireRecord(
          await services.runtimeSecrets.prepareExistingCandidate({
            scope: runtimeSecretDeliveryScope(command, current),
            artifact,
            artifactSourceDeploymentId: rollbackExpectation.deploymentId,
            candidate: toRpcReceipt(previous),
            ...(databaseBinding === null
              ? {}
              : { databaseRegistration: databaseBinding.databaseRegistration }),
            ...(storageBucketName === null ? {} : { storageBucketName }),
            ...(storageDataEnvironmentId === null ? {} : { storageDataEnvironmentId }),
          }),
          "WFP rollback candidate",
        );
        if (result["status"] === "reconciliation_required") {
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              artifact.provenance.artifactDigest,
              artifact.provenance.deploymentId,
              result["activationRuntimePolicy"],
            ),
          };
        }
        if (result["status"] !== "prepared" && result["status"] !== "replayed")
          throw new TypeError("WFP rollback result is invalid");
        validateRuntimeSecretDelivery(result);
        const receipt = parseWfpReceipt(result["candidate"], command);
        return {
          status: "replayed" as const,
          candidateReceiptId: rollbackTarget.candidate.candidateReceiptId,
          operationId: command.operationId,
          receipt,
          previousGateway: parseGatewayReceipt(current.activeGateway, command, current),
          runtimePolicy: requireRecord(
            result["activationRuntimePolicy"],
            "rollback runtime policy",
          ),
          runtimeSecretDeliveryStage: result["runtimeSecretDeliveryStage"],
          scheduledFunctions: artifact.provenance.functions,
          deploymentUrl: httpsUrl(current.activeGateway.publicOrigin),
          artifactDigest: receipt.artifactDigest,
        };
      },
      activate: async (command, candidate) => {
        const current = await context(command);
        const receipt = parseWfpReceipt(candidate.receipt, command);
        requireRuntimeSecretStage(candidate);
        if (candidate.candidateReceiptId === null)
          throw new TypeError("WFP activation requires a persisted candidate receipt");
        const result = requireRecord(
          await services.wfp.activateCandidate({
            organizationId: command.organizationId,
            operationId: command.operationId,
            claimId: await claimProviderMutation(readers, command, current),
            candidateReceiptId: parseUlid(candidate.candidateReceiptId),
            scope: wfpManagementScope(command, current),
            candidate: toRpcReceipt(receipt),
            ...(candidate.previousGateway === null
              ? {}
              : {
                  previousGateway: toRpcGatewayReceipt(
                    parseGatewayReceipt(candidate.previousGateway, command, current),
                  ),
                }),
            runtimePolicy: candidate.runtimePolicy,
          }),
          "WFP candidate activation",
        );
        if (result["status"] === "reconciliation_required") {
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              receipt.artifactDigest,
              receipt.productDeploymentId,
              candidate.runtimePolicy,
            ),
          };
        }
        if (result["status"] !== "activated" && result["status"] !== "unhealthy")
          throw new TypeError("WFP activation result is invalid");
        const gateway = parseGatewayReceipt(result["gateway"], command, current);
        const deploymentUrl = new URL(httpsUrl(result["deploymentUrl"])).origin;
        if (deploymentUrl !== gateway.publicOrigin)
          throw new TypeError("WFP activation evidence is invalid");
        return {
          status: result["status"] as "activated" | "unhealthy",
          candidateReceipt: receipt,
          gateway,
          deploymentUrl,
          ...(result["status"] === "unhealthy"
            ? { health: parseHealthVerdict(result["health"]) }
            : {}),
        };
      },
      moveGatewayAddress: async (command, environment, handle) => {
        const current = await context(command);
        const claimId = await claimProviderMutation(readers, command, current);
        const moving = current.deletionEnvironments.find(
          (candidate) => candidate.environmentId === environment.environmentId,
        );
        if (
          moving?.activeDeployment == null ||
          moving.activeGateway === null ||
          moving.activeRuntimePolicy === null
        ) {
          throw new TypeError("A gateway can only move an environment that has one");
        }
        const result = requireRecord(
          await services.wfp.activateCandidate({
            organizationId: command.organizationId,
            operationId: command.operationId,
            claimId,
            candidateReceiptId: moving.activeGateway.candidateReceiptId,
            // The scope carries the address being published — the chosen one on the way out, the
            // stored one when a lost rename is put back — so the provider rebuilds the module, the
            // public origin and the host check around it.
            scope: {
              projectId: command.projectId,
              environmentId: environment.environmentId,
              environmentName: environment.environmentName,
              handle,
            },
            candidate: toRpcReceipt(moving.activeDeployment),
            previousGateway: toRpcGatewayReceipt(moving.activeGateway),
            runtimePolicy: moving.activeRuntimePolicy,
          }),
          "project address move",
        );
        if (result["status"] === "reconciliation_required") {
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              moving.activeDeployment.artifactDigest,
              moving.activeDeployment.productDeploymentId,
              moving.activeRuntimePolicy,
            ),
          };
        }
        if (result["status"] !== "activated" && result["status"] !== "unhealthy")
          throw new TypeError("Project address move result is invalid");
        const deploymentUrl = new URL(httpsUrl(result["deploymentUrl"])).origin;
        return {
          status: "moved" as const,
          publicOrigin: deploymentUrl,
          gateway: result["gateway"],
        };
      },
      observeActivation: async (command, candidate) => {
        const current = await context(command);
        const receipt = parseWfpReceipt(candidate.receipt, command);
        requireRuntimeSecretStage(candidate);
        const result = requireRecord(
          await services.wfp.observeActivation({
            organizationId: command.organizationId,
            scope: wfpManagementScope(command, current),
            candidate: toRpcReceipt(receipt),
            runtimePolicy: candidate.runtimePolicy,
          }),
          "WFP activation observation",
        );
        if (result["status"] === "reconciliation_required")
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              receipt.artifactDigest,
              receipt.productDeploymentId,
              candidate.runtimePolicy,
            ),
          };
        if (result["status"] === "absent") return { status: "absent" as const };
        if (result["status"] !== "activated" && result["status"] !== "unhealthy")
          throw new TypeError("WFP activation observation is invalid");
        return {
          status: result["status"] as "activated" | "unhealthy",
          candidateReceipt: receipt,
          gateway: parseGatewayReceipt(result["gateway"], command, current),
          deploymentUrl: httpsUrl(result["deploymentUrl"]),
          ...(result["status"] === "unhealthy"
            ? { health: parseHealthVerdict(result["health"]) }
            : {}),
        };
      },
      compensate: async (command, claim, activation) => {
        const current = await context(command);
        const candidate = claim.candidate;
        const receipt = parseWfpReceipt(candidate.receipt, command);
        const result = requireRecord(
          await services.runtimeSecrets.compensateActivation({
            scope: runtimeSecretDeliveryScope(command, current),
            claimId: await providerMutationClaimId(command),
            cleanupClaimId: parseUlid(claim.claimId),
            candidate: toRpcReceipt(receipt),
            runtimeSecretDeliveryStage: requireRuntimeSecretStage(candidate),
            expectedGateway: toRpcGatewayReceipt(
              parseGatewayReceipt(activation.gateway, command, current),
            ),
            ...(candidate.previousGateway === null
              ? {}
              : {
                  previousGateway: toRpcGatewayReceipt(
                    parseGatewayReceipt(candidate.previousGateway, command, current),
                  ),
                }),
          }),
          "WFP activation compensation",
        );
        if (result["status"] === "reconciliation_required")
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              receipt.artifactDigest,
              receipt.productDeploymentId,
              candidate.runtimePolicy,
            ),
          };
        if (result["status"] !== "compensated")
          throw new TypeError("WFP compensation result is invalid");
        return {
          status: "compensated" as const,
          outcome: "removed" as const,
          candidateAbsence: result["candidate"],
          gateway: result["gateway"],
        };
      },
      restoreGateway: async (command, candidate, activation) => {
        const current = await context(command);
        const receipt = parseWfpReceipt(candidate.receipt, command);
        if (candidate.previousGateway === null)
          throw new TypeError("Rollback gateway compensation requires a previous gateway");
        const result = requireRecord(
          await services.runtimeSecrets.compensateGatewayActivation({
            scope: runtimeSecretDeliveryScope(command, current),
            claimId: await providerMutationClaimId(command),
            candidate: toRpcReceipt(receipt),
            runtimeSecretDeliveryStage: requireRuntimeSecretStage(candidate),
            expectedGateway: toRpcGatewayReceipt(
              parseGatewayReceipt(activation.gateway, command, current),
            ),
            previousGateway: toRpcGatewayReceipt(
              parseGatewayReceipt(candidate.previousGateway, command, current),
            ),
          }),
          "rollback gateway compensation",
        );
        if (result["status"] === "reconciliation_required")
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              receipt.artifactDigest,
              receipt.productDeploymentId,
              candidate.runtimePolicy,
            ),
          };
        return { status: "restored" as const, gateway: result["gateway"] };
      },
      removeCandidate: async (command, claim) => {
        const current = await context(command);
        const candidate = claim.candidate;
        const receipt = parseWfpReceipt(candidate.receipt, command);
        const result = requireRecord(
          await services.runtimeSecrets.removeCandidate({
            scope: runtimeSecretDeliveryScope(command, current),
            claimId: parseUlid(claim.claimId),
            candidate: toRpcReceipt(receipt),
            runtimeSecretDeliveryStage: requireRuntimeSecretStage(candidate),
          }),
          "WFP candidate removal",
        );
        if (result["status"] === "reconciliation_required")
          return {
            status: "uncertain" as const,
            providerHint: parseProviderReconciliationHint(
              result,
              receipt.artifactDigest,
              receipt.productDeploymentId,
              candidate.runtimePolicy,
            ),
          };
        if (!["removed", "not_found"].includes(String(result["outcome"])))
          throw new TypeError("WFP candidate removal is invalid");
        return {
          status: result["outcome"] as "removed" | "not_found",
          outcome: result["outcome"] as "removed" | "not_found",
          candidateAbsence: result,
          gateway: null,
        };
      },
      removeClaimedCandidate: async (command, claim) => {
        const current = await context(command);
        const receipt = parseCandidateOwnReceipt(claim.candidate.receipt, command.projectId);
        const environmentName = candidateEnvironmentName(receipt);
        const result = requireRecord(
          await services.runtimeSecrets.removePersistedCandidate({
            scope: {
              organizationId: command.organizationId,
              projectId: command.projectId,
              environmentId: receipt.environmentId,
              environmentName,
              handle: current.handle,
              operationId: claim.candidate.operationId,
            },
            candidateReceiptId: parseUlid(claim.candidateReceiptId),
            claimId: parseUlid(claim.claimId),
            candidate: toRpcReceipt(receipt),
          }),
          "claimed runtime-secret candidate removal",
        );
        if (result["status"] === "reconciliation_required")
          return {
            status: "uncertain" as const,
            providerHint: emptyCompositionProviderHint("wfp"),
          };
        if (result["status"] !== "removed")
          throw new TypeError("Persisted candidate removal is invalid");
        if (result["outcome"] !== "removed" && result["outcome"] !== "not_found")
          throw new TypeError("Persisted candidate removal outcome is invalid");
        const outcome = result["outcome"];
        return {
          status: outcome,
          outcome,
          candidateAbsence: result["candidateAbsence"],
          gateway: result["gateway"] ?? null,
        };
      },
      tombstone: async (command) => {
        const current = await context(command);
        const environments = requireDeletionEnvironments(current);
        const deletion = await inventoryPersistence.readDeletionEvidence({
          organizationId: command.organizationId,
          projectId: command.projectId,
        });
        const receipts: string[] = [];
        validateDatabaseDeletionInventory(current, command.projectId);
        for (const environment of environments) {
          if (environment.activeGateway === null || environment.activeDeployment === null) continue;
          const result = requireRecord(
            await services.wfp.finalizeRemoval({
              organizationId: command.organizationId,
              operationId: command.operationId,
              claimId: deletionAuthority(current),
              scope: {
                projectId: command.projectId,
                environmentId: environment.environmentId,
                environmentName: environment.environmentName,
                handle: current.handle,
              },
              deploymentId: environment.activeDeployment.productDeploymentId,
              expectedGateway: toRpcGatewayReceipt(environment.activeGateway),
            }),
            "project WFP exact removal",
          );
          if (result["status"] !== "removed" && result["status"] !== "replayed")
            return {
              status: "uncertain" as const,
              ...(result["reason"] === "stale_edge" || result["reason"] === "provider_conflict"
                ? { reason: result["reason"] }
                : {}),
            };
          const inventoryLocator = wfpInventoryLocator(
            current,
            environment.activeDeployment.scriptName,
          );
          if (inventoryLocator !== null) {
            await recordDeletionAttempt(
              inventoryPersistence,
              command,
              current,
              "cloudflare",
              "wfp-script",
              inventoryLocator,
              result["status"] === "removed" ? "removed" : "not_found",
              now,
            );
          }
          receipts.push(`${environment.environmentName}:${String(result["status"])}`);
        }
        for (const candidate of deletion.candidates) {
          const environment = environments.find(
            (item) => item.environmentId === candidate.environmentId,
          );
          if (environment === undefined)
            throw new Error("Deletion candidate environment is absent");
          const persistedCandidate = candidateFromPersistence(candidate, current);
          const removed = requireRecord(
            await services.runtimeSecrets.removePersistedCandidate({
              scope: {
                organizationId: command.organizationId,
                projectId: command.projectId,
                environmentId: candidate.environmentId,
                environmentName: environment.environmentName,
                handle: current.handle,
                operationId: command.operationId,
              },
              candidateReceiptId: candidate.candidateReceiptId,
              claimId: deletionAuthority(current),
              candidate: toRpcReceipt(persistedCandidate.receipt as ProductWorkflowWfpReceipt),
            }),
            "project runtime-secret candidate removal",
          );
          if (
            removed["status"] !== "removed" ||
            (removed["outcome"] !== "removed" && removed["outcome"] !== "not_found")
          )
            return { status: "uncertain" as const };
          const inventoryLocator = wfpInventoryLocator(current, candidate.immutableScriptName);
          if (inventoryLocator !== null) {
            await recordDeletionAttempt(
              inventoryPersistence,
              command,
              current,
              "cloudflare",
              "wfp-script",
              inventoryLocator,
              removed["outcome"],
              now,
            );
          }
        }
        const tombstoneReceiptId =
          receipts.length === 0
            ? `wfp:absent:${command.projectId}:${environments
                .map(({ environmentId }) => environmentId)
                .sort()
                .join(",")}`
            : receipts.join("|");
        return {
          status: "observed" as const,
          tombstoneReceiptId,
          consecutive404s: 3,
        };
      },
      cleanupInventory: async (command) => {
        const current = await context(command);
        if (
          !(await retireNextCacheScopes(bindings.NEXT_CACHE_RETIREMENT, inventoryPersistence, {
            organizationId: command.organizationId,
            projectId: command.projectId,
            operationId: command.operationId,
            cleanupRunId: deletionAuthority(current),
          }))
        )
          return { status: "uncertain" as const };
        return cleanupProjectInventory(services, inventoryPersistence, command, current, now);
      },
      observeRoute404: async (_command, removal) => {
        return removal.consecutive404s >= 3
          ? { status: "observed" as const, consecutive404s: removal.consecutive404s }
          : { status: "uncertain" as const };
      },
      finalizeRemoval: async (command) => {
        const current = await context(command);
        const environments = requireDeletionEnvironments(current);
        const gatewayAbsence: unknown[] = [];
        validateDatabaseDeletionInventory(current, command.projectId);
        for (const environment of environments) {
          if (environment.activeGateway === null || environment.activeDeployment === null) {
            gatewayAbsence.push(null);
            continue;
          }
          const result = requireRecord(
            await services.wfp.finalizeRemoval({
              organizationId: command.organizationId,
              operationId: command.operationId,
              claimId: deletionAuthority(current),
              scope: {
                projectId: command.projectId,
                environmentId: environment.environmentId,
                environmentName: environment.environmentName,
                handle: current.handle,
              },
              deploymentId: environment.activeDeployment.productDeploymentId,
              expectedGateway: toRpcGatewayReceipt(environment.activeGateway),
            }),
            "project gateway exact absence",
          );
          if (result["status"] !== "removed" && result["status"] !== "replayed")
            return {
              status: "uncertain" as const,
              ...(result["reason"] === "stale_edge" || result["reason"] === "provider_conflict"
                ? { reason: result["reason"] }
                : {}),
            };
          await recordDeletionAttempt(
            inventoryPersistence,
            command,
            current,
            "ohmyhost",
            "gateway-route",
            environment.environmentId,
            result["status"] === "removed" ? "removed" : "not_found",
            now,
          );
          gatewayAbsence.push(result["gateway"] ?? null);
        }
        return {
          status: "observed" as const,
          consecutive404s: 3,
          gatewayAbsence,
        };
      },
    },
    cleanup: {
      removeOperationArtifacts: async (command, claim) => {
        // The artifacts belong to the operation and environment that staged the claimed candidate,
        // which is an older one whenever the next deployment drains it, possibly from the other
        // environment. Reading the running command's own would find nothing and report the
        // cleanup as uncertain forever (Sebmer Prod draining a Dev candidate, 2026-09-25).
        const candidateEnvironmentId = parseCandidateOwnReceipt(
          claim.candidate.receipt,
          command.projectId,
        ).environmentId;
        const claimedOperationId = parseUlid(claim.candidate.operationId);
        const staged = await inventoryPersistence.readCleanupResources({
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: candidateEnvironmentId,
          operationId: claimedOperationId,
        });
        const evidence: Array<{
          readonly resourceKind: "source-archive" | "build-artifact";
          readonly identity: unknown;
          readonly resourceIdentityDigest: Uint8Array;
          readonly outcome: "removed" | "not_found";
        }> = [];
        for (const archive of staged.sourceArchives.filter(
          (candidate) => candidate.scope.operationId === claimedOperationId,
        )) {
          const identity = await cleanupResourceIdentity(
            "source-archive",
            `${archive.bucket}/${archive.key}/${archive.versionId}`,
          );
          const expected = claim.expectedResources.find(
            (resource) =>
              resource.resourceKind === "source-archive" &&
              equalBytes(resource.resourceIdentityDigest, identity),
          );
          if (expected === undefined) continue;
          const result = requireRecord(
            await services.build.removeArchive(archive),
            "archive removal",
          );
          if (result["state"] !== "absent")
            return {
              status: "uncertain" as const,
              providerHint: emptyCompositionProviderHint("build"),
            };
          evidence.push({
            resourceKind: "source-archive",
            identity: archive,
            resourceIdentityDigest: expected.resourceIdentityDigest,
            outcome: "not_found",
          });
        }
        for (const artifact of staged.artifactExpectations.filter(
          (candidate) => candidate.output.scope.operationId === claimedOperationId,
        )) {
          const identity = await cleanupResourceIdentity(
            "build-artifact",
            `r2-version:${artifact.output.bucket}/${artifact.output.key}#${artifact.output.versionId}`,
          );
          const expected = claim.expectedResources.find(
            (resource) =>
              resource.resourceKind === "build-artifact" &&
              equalBytes(resource.resourceIdentityDigest, identity),
          );
          if (expected === undefined) continue;
          const result = requireRecord(
            await services.build.removeBuildArtifactObject(artifact.output),
            "build artifact removal",
          );
          if (result["state"] !== "absent")
            return {
              status: "uncertain" as const,
              providerHint: emptyCompositionProviderHint("build"),
            };
          evidence.push({
            resourceKind: "build-artifact",
            identity: artifact.output,
            resourceIdentityDigest: expected.resourceIdentityDigest,
            outcome: "not_found",
          });
        }
        if (evidence.length !== claim.expectedResources.length)
          return {
            status: "uncertain" as const,
            providerHint: emptyCompositionProviderHint("build"),
          };
        return { status: "removed" as const, evidence: Object.freeze(evidence) };
      },
    },
    dataChange: {
      readPlan: async (command) => {
        const current = await context(command),
          snapshot = requireDataChangeSnapshot(command, current);
        await claimProviderMutation(readers, command, current);
        await inventoryPersistence.startDataChange({
          organizationId: command.organizationId,
          projectId: command.projectId,
          operationId: command.operationId,
          claimId: await providerMutationClaimId(command),
          snapshot,
          now: canonicalDate(now),
        });
        return {
          dataModeAfter: snapshot.transition.after.dataMode,
          redeployEnvironments: snapshot.transition.redeployEnvironments,
          removeDevDeployment: snapshot.transition.removeDevDeployment,
          retiredDataEnvironmentIds: snapshot.transition.retiredDataEnvironmentIds,
          reauthorizations: snapshot.transition.reauthorizations,
        };
      },
      revokeDatabaseAccess: async (command) => {
        const snapshot = requireDataChangeSnapshot(command, await context(command));
        const losing =
          command.dataChange === "isolate_dev_keeps_data"
            ? snapshot.transition.before.prod
            : snapshot.transition.before.dev;
        const result = requireRecord(
          await services.neon.revokeDataChangeAccess({
            organizationId: command.organizationId,
            projectId: command.projectId,
            environmentId: command.environmentId,
            operationId: command.operationId,
            claimId: await providerMutationClaimId(command),
            losingEnvironmentId: losing.environmentId,
          }),
          "data change SQL login revocation",
        );
        if (result["status"] !== "completed") return { status: "uncertain" as const };
        if (!Number.isSafeInteger(result["revoked"]) || Number(result["revoked"]) < 0)
          throw new TypeError("Data change revocation count is invalid");
        return { status: "ready" as const };
      },
      reauthorize: async (command, dataEnvironmentId, direction) => {
        const current = await context(command),
          snapshot = requireDataChangeSnapshot(command, current);
        const target = snapshot.transition.reauthorizations.find(
          (target) =>
            target.dataEnvironmentId === dataEnvironmentId && target.direction === direction,
        );
        if (target === undefined) throw new Error("Data change registration target is absent");
        const generation = snapshot.registrationGenerations.find(
          (generation) => generation.dataEnvironmentId === dataEnvironmentId,
        );
        if (generation === undefined)
          throw new Error("Data change registration generation is absent");
        if (generation.registrationVersion === 0) {
          const state = await readers.readDatabaseTarget({
            organizationId: command.organizationId,
            projectId: command.projectId,
            physicalEnvironmentId: dataEnvironmentId,
          });
          if (state.providerTarget === null && state.databaseRegistration === null)
            return { status: "ready" as const };
        }
        const result = requireRecord(
          await services.neon.reauthorizeDataEnvironment({
            organizationId: command.organizationId,
            projectId: command.projectId,
            environmentId: command.environmentId,
            operationId: command.operationId,
            claimId: await providerMutationClaimId(command),
            physicalEnvironmentId: dataEnvironmentId,
            authorizedEnvironmentIds: target.authorizedEnvironmentIds,
          }),
          "data change registration",
        );
        return {
          status: result["status"] === "ready" ? ("ready" as const) : ("uncertain" as const),
        };
      },
      switchAssignments: async (command) => {
        const current = await context(command),
          snapshot = requireDataChangeSnapshot(command, current);
        const switched = await inventoryPersistence.switchAssignments({
          organizationId: command.organizationId,
          projectId: command.projectId,
          operationId: command.operationId,
          claimId: await providerMutationClaimId(command),
          snapshot,
          now: canonicalDate(now),
        });
        return switched === "created" ? "applied" : "duplicate";
      },
      removeDevDeployment: async (command) => {
        const current = await context(command),
          snapshot = requireDataChangeSnapshot(command, current);
        if (!snapshot.transition.removeDevDeployment)
          throw new Error("Data change does not remove Dev");
        const evidence = await inventoryPersistence.readDeletionEvidence({
          organizationId: command.organizationId,
          projectId: command.projectId,
        });
        const claimId = await providerMutationClaimId(command);
        for (const gateway of evidence.activeGateways.filter(
          (gateway) => gateway.environmentName === "dev" && gateway.active,
        )) {
          const result = requireRecord(
            await services.wfp.finalizeRemoval({
              organizationId: command.organizationId,
              operationId: command.operationId,
              claimId,
              scope: {
                projectId: command.projectId,
                environmentId: command.environmentId,
                environmentName: "dev",
                handle: current.handle,
              },
              deploymentId: gateway.targetDeploymentId,
              expectedGateway: toRpcGatewayReceipt({
                ...gateway,
                observedAt: gateway.observedAt.toISOString(),
              }),
            }),
            "data change Dev gateway removal",
          );
          if (result["status"] !== "removed" && result["status"] !== "replayed")
            return { status: "uncertain" as const };
        }
        for (const candidate of evidence.candidates.filter(
          (candidate) => candidate.environmentId === command.environmentId,
        )) {
          const inventory = current.deletionInventory.find(
            (item) =>
              item.provider === "cloudflare" &&
              item.resourceKind === "wfp-script" &&
              decodeCleanupLocator(item.cleanupLocator) ===
                `${candidate.namespace}/${candidate.immutableScriptName}`,
          );
          if (!inventory) throw new Error("Data change Dev candidate has no frozen inventory");
          if (inventory.cleanupOutcome === "removed" || inventory.cleanupOutcome === "not_found")
            continue;
          const result = requireRecord(
            await services.wfp.removeCandidate({
              organizationId: command.organizationId,
              operationId: command.operationId,
              claimId,
              candidateReceiptId: candidate.candidateReceiptId,
              scope: {
                projectId: command.projectId,
                environmentId: command.environmentId,
                environmentName: "dev",
                handle: current.handle,
              },
              candidate: toRpcReceipt(
                candidateFromPersistence(candidate, current).receipt as ProductWorkflowWfpReceipt,
              ),
            }),
            "data change Dev candidate removal",
          );
          if (
            result["status"] !== "removed" ||
            (result["outcome"] !== "removed" && result["outcome"] !== "not_found")
          )
            return { status: "uncertain" as const };
          await recordDeletionAttempt(
            inventoryPersistence,
            command,
            current,
            "cloudflare",
            "wfp-script",
            `${candidate.namespace}/${candidate.immutableScriptName}`,
            result["outcome"],
            now,
          );
        }
        return { status: "ready" as const };
      },
      purgeFiles: async (command, dataEnvironmentId) => {
        const snapshot = requireDataChangeSnapshot(command, await context(command));
        if (!snapshot.transition.retiredDataEnvironmentIds.includes(dataEnvironmentId))
          throw new Error("Data change files do not belong to a retired database");
        const result = requireRecord(
          await services.storageData.purgeRetiredData({
            organizationId: command.organizationId,
            projectId: command.projectId,
            environmentId: command.environmentId,
            operationId: command.operationId,
            claimId: await providerMutationClaimId(command),
            dataEnvironmentId,
          }),
          "retired data files purge",
        );
        if (result["status"] === "pending") {
          if (
            !Number.isSafeInteger(result["retryAfterSeconds"]) ||
            Number(result["retryAfterSeconds"]) < 1 ||
            Number(result["retryAfterSeconds"]) > 300 ||
            (result["progress"] !== undefined && result["progress"] !== "page_completed")
          )
            throw new TypeError("Retired upload expiry is invalid");
          return {
            status: "pending" as const,
            retryAfterSeconds: Number(result["retryAfterSeconds"]),
            ...(result["progress"] === "page_completed"
              ? { progress: "page_completed" as const }
              : {}),
          };
        }
        if (result["status"] !== "ready") return { status: "uncertain" as const };
        if (!Number.isSafeInteger(result["deletedFiles"]) || Number(result["deletedFiles"]) < 0)
          throw new TypeError("Retired file count is invalid");
        return { status: "ready" as const, deletedFiles: Number(result["deletedFiles"]) };
      },
      retireDatabase: async (command, dataEnvironmentId) => {
        const current = await context(command),
          snapshot = requireDataChangeSnapshot(command, current);
        if (!snapshot.transition.retiredDataEnvironmentIds.includes(dataEnvironmentId))
          throw new Error("Data change database is not retired");
        const state = await readers.readDatabaseTarget({
          organizationId: command.organizationId,
          projectId: command.projectId,
          physicalEnvironmentId: dataEnvironmentId,
        });
        if (state.providerTarget?.provider === "neon" && state.providerTarget.state === "retired")
          return { status: "ready" as const, deletedDatabase: false };
        if (state.providerTarget?.provider === "pgcf") {
          const outcome = await deletePgcfWorkflowDatabase(services, command, current, state);
          if (outcome === null) return { status: "uncertain" as const };
          await recordDeletionAttempt(
            inventoryPersistence,
            command,
            current,
            "pgcf",
            "database",
            state.providerTarget.databaseId,
            outcome,
            now,
          );
          return { status: "ready" as const, deletedDatabase: true };
        }
        const target = { placement: state.neonPlacement, registration: state.databaseRegistration };
        if (target.placement === null) {
          if (target.registration !== null)
            throw new Error("Retired registration has no Neon placement");
          return { status: "ready" as const, deletedDatabase: false };
        }
        const result = requireRecord(
          await services.neon.deleteProject({
            organizationId: command.organizationId,
            projectId: command.projectId,
            operationId: command.operationId,
            providerProjectId: target.placement.providerProjectId,
            defaultBranchId: target.placement.defaultBranchId,
            physicalEnvironmentId: dataEnvironmentId,
            registrationVersion:
              target.registration === null
                ? null
                : target.registration.status === "revoked"
                  ? target.registration.registrationVersion - 1
                  : target.registration.registrationVersion,
          }),
          "retired Neon database deletion",
        );
        if (
          result["status"] !== "ready" ||
          result["provider"] !== "neon" ||
          result["providerProjectId"] !== target.placement.providerProjectId ||
          !["deleted", "already_absent", "reconciled_absent"].includes(String(result["outcome"]))
        )
          return { status: "uncertain" as const };
        if (target.registration === null) {
          if (result["databaseRegistration"] !== null)
            throw new TypeError("Unexpected retired registration");
        } else
          parseDatabaseRevocationEvidence(
            result["databaseRegistration"],
            target.registration,
            command.operationId,
          );
        await recordDeletionAttempt(
          inventoryPersistence,
          command,
          current,
          "neon",
          "project",
          target.placement.providerProjectId,
          result["outcome"] === "deleted" ? "removed" : "not_found",
          now,
        );
        return { status: "ready" as const, deletedDatabase: true };
      },
    },
    schedules: {
      remove: async (command) => {
        const removed = await inventoryPersistence.deleteSchedules({
          organizationId: command.organizationId,
          projectId: command.projectId,
        });
        return { removed };
      },
    },
  };
  return Object.freeze(ports);
}

export async function activateDeploymentReconciliationAttempt(
  attempts: DeploymentAttemptPort,
  input: {
    readonly attemptId: string;
    readonly physicalWorkflowId: string;
    readonly command: Command;
  },
) {
  const eventType = input.command.eventType;
  if (
    eventType !== "DeploymentRequestedV1" &&
    eventType !== "DeploymentRollbackRequestedV1" &&
    eventType !== "DeploymentPromotionRequestedV1"
  ) {
    throw new TypeError("Provider reconciliation command type is invalid");
  }
  return attempts.activateReconciliation({
    attemptId: parseUlid(input.attemptId),
    physicalWorkflowId: input.physicalWorkflowId,
    organizationId: input.command.organizationId,
    projectId: input.command.projectId,
    environmentId: input.command.environmentId,
    operationId: input.command.operationId,
    eventId: input.command.eventId,
    eventType,
  });
}

export async function activateDeploymentReplayAttempt(
  attempts: DeploymentAttemptPort,
  input: {
    readonly attemptId: string;
    readonly physicalWorkflowId: string;
    readonly command: Command;
  },
) {
  if (
    input.command.eventType !== "SourceLinkRequestedV1" &&
    input.command.eventType !== "ProjectDeletionRequestedV1" &&
    input.command.eventType !== "DeploymentRollbackRequestedV1" &&
    input.command.eventType !== "DeploymentPromotionRequestedV1" &&
    input.command.eventType !== "ProjectDataChangeRequestedV1"
  ) {
    throw new TypeError("Product Workflow replay command type is invalid");
  }
  return attempts.activateReplay({
    attemptId: parseUlid(input.attemptId),
    physicalWorkflowId: input.physicalWorkflowId,
    organizationId: input.command.organizationId,
    projectId: input.command.projectId,
    environmentId: input.command.environmentId,
    operationId: input.command.operationId,
    eventId: input.command.eventId,
  });
}

type Command = Parameters<
  ProductCommandWorkflowPorts["persistence"]["requireReconciliation"]
>[0]["command"];

function requireDataChangeSnapshot(
  command: Extract<Command, { eventType: "ProjectDataChangeRequestedV1" }>,
  current: ProductWorkflowContext,
) {
  const snapshot = current.intent.dataChangeSnapshot;
  if (
    snapshot == null ||
    current.intent.dataChange !== command.dataChange ||
    snapshot.transition.change !== command.dataChange ||
    snapshot.transition.before.dev.environmentId !== command.environmentId
  )
    throw new Error("Data change has no exact frozen snapshot");
  return snapshot;
}

function providerScope(command: Command) {
  return {
    projectId: command.projectId,
    environmentId: command.environmentId,
    operationId: command.operationId,
  };
}

function runtimeSecretDeliveryScope(command: Command, context: ProductWorkflowContext) {
  return {
    organizationId: command.organizationId,
    projectId: command.projectId,
    environmentId: command.environmentId,
    environmentName: context.environmentName,
    handle: context.handle,
    operationId: command.operationId,
  };
}

function wfpManagementScope(command: Command, context: ProductWorkflowContext) {
  return {
    projectId: command.projectId,
    environmentId: command.environmentId,
    environmentName: context.environmentName,
    handle: context.handle,
  };
}

function validateRuntimeSecretDelivery(value: Readonly<Record<string, unknown>>): void {
  const delivery = requireRecord(value["runtimeSecretDelivery"], "runtime secret delivery");
  if (
    !Number.isSafeInteger(delivery["generation"]) ||
    Number(delivery["generation"]) < 0 ||
    !Number.isSafeInteger(delivery["secretCount"]) ||
    Number(delivery["secretCount"]) < 0 ||
    Number(delivery["secretCount"]) > 128 ||
    !digest(delivery["manifestDigest"]) ||
    value["runtimeSecretManifestDigest"] !== delivery["manifestDigest"]
  ) {
    throw new TypeError("Runtime secret delivery evidence is invalid");
  }
}

function parseRepositoryLink(value: unknown) {
  const record = requireRecord(value, "repository link");
  if (
    record["permission"] !== "contents:read" ||
    typeof record["externalRepositoryId"] !== "string"
  )
    throw new TypeError("Repository link observation is invalid");
  return { externalRepositoryId: record["externalRepositoryId"] };
}

interface SourceArchive {
  readonly archiveId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly archive: Readonly<Record<string, unknown>> & {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
    readonly eTag: string;
    readonly byteLength: number;
    readonly sourceSha256: string;
  };
}

function parseSourceArchive(value: unknown, command: Command): SourceArchive {
  const record = requireRecord(value, "source archive");
  const archive = requireRecord(record["archive"], "source archive object");
  const scope = requireRecord(archive["scope"], "source archive scope");
  if (
    typeof record["archiveId"] !== "string" ||
    !record["archiveId"].startsWith("r2-version:") ||
    !positiveSafe(record["byteLength"]) ||
    !hex64(record["sha256"]) ||
    typeof archive["bucket"] !== "string" ||
    typeof archive["key"] !== "string" ||
    typeof archive["versionId"] !== "string" ||
    typeof archive["eTag"] !== "string" ||
    archive["byteLength"] !== record["byteLength"] ||
    archive["sourceSha256"] !== record["sha256"] ||
    scope["projectId"] !== command.projectId ||
    scope["environmentId"] !== command.environmentId ||
    scope["operationId"] !== command.operationId
  )
    throw new TypeError("Source archive receipt is invalid");
  return record as unknown as SourceArchive;
}

interface BuildReceipt {
  readonly buildId: string;
  readonly projectName: string;
  readonly scope: ReturnType<typeof providerScope>;
}

/** A cleanup claim must outlive the provider call it protects, not the step that took it. */
const CLEANUP_CLAIM_LEASE_MILLISECONDS = 15 * 60_000;
const BUILD_FAILURE_EXCERPT_MAX_CHARACTERS = 16384;
const BUILD_FAILURE_EXCERPT_FORBIDDEN = /(?![\t\n])\p{Cc}|\p{Cs}/u;

const HEALTH_EXCERPT_MAX_CHARACTERS = 4096;

/** What the health check answered, so a candidate that is already removed can still explain itself. */
function parseHealthVerdict(value: unknown): ProductHealthVerdict | null {
  if (value === null || value === undefined) return null;
  const record = exactRecord(value, ["status", "path", "excerpt", "truncated"], "health verdict");
  const status = record["status"];
  const path = record["path"];
  const excerpt = record["excerpt"];
  if (
    !Number.isInteger(status) ||
    Number(status) < 100 ||
    Number(status) > 599 ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.length > 512 ||
    typeof record["truncated"] !== "boolean" ||
    (excerpt !== null &&
      (typeof excerpt !== "string" ||
        excerpt.length === 0 ||
        excerpt.length > HEALTH_EXCERPT_MAX_CHARACTERS ||
        excerpt !== excerpt.trimEnd() ||
        BUILD_FAILURE_EXCERPT_FORBIDDEN.test(excerpt)))
  ) {
    throw new TypeError("health verdict is invalid");
  }
  return Object.freeze({
    status: Number(status),
    path,
    excerpt: excerpt === null ? null : String(excerpt),
    truncated: record["truncated"],
  });
}

/** The broker's customer-safe build excerpt; absent for stopped builds and older brokers. */
function parseBuildFailure(value: unknown): ProductBuildFailure | null {
  if (value === null || value === undefined) return null;
  const record = exactRecord(value, ["excerpt", "truncated"], "build failure excerpt");
  const excerpt = record["excerpt"];
  if (
    typeof excerpt !== "string" ||
    excerpt.length === 0 ||
    excerpt.length > BUILD_FAILURE_EXCERPT_MAX_CHARACTERS ||
    excerpt !== excerpt.trimEnd() ||
    BUILD_FAILURE_EXCERPT_FORBIDDEN.test(excerpt) ||
    typeof record["truncated"] !== "boolean"
  ) {
    throw new TypeError("build failure excerpt is invalid");
  }
  return Object.freeze({ excerpt, truncated: record["truncated"] });
}

/** The build objects bucket of an operation: the one its source archive was stored in. */
function parseMigrationFailure(value: unknown) {
  const input = requireRecord(value, "migration failure");
  const reason = input["reason"],
    path = input["path"],
    statementIndex = input["statementIndex"],
    sqlstate = input["sqlstate"];
  const hasStatementIndex = Object.hasOwn(input, "statementIndex"),
    hasSqlstate = Object.hasOwn(input, "sqlstate");
  if (
    !Object.hasOwn(input, "reason") ||
    !Object.hasOwn(input, "path") ||
    Object.keys(input).some(
      (key) => !["path", "reason", "statementIndex", "sqlstate"].includes(key),
    ) ||
    (reason !== "catalog_changed" &&
      reason !== "execution_failed" &&
      reason !== "ledger_conflict" &&
      reason !== "not_admitted") ||
    (path !== null &&
      (typeof path !== "string" ||
        path.length > 512 ||
        !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/u.test(path))) ||
    hasStatementIndex !== hasSqlstate ||
    (hasStatementIndex &&
      (reason !== "execution_failed" ||
        path === null ||
        typeof statementIndex !== "number" ||
        !Number.isSafeInteger(statementIndex) ||
        statementIndex < 1)) ||
    (hasSqlstate &&
      (typeof sqlstate !== "string" ||
        !/^[0-9A-Z]{5}$/u.test(sqlstate) ||
        sqlstate.startsWith("08") ||
        /^57P0[123]$/u.test(sqlstate)))
  )
    throw new TypeError("Neon migration failure is invalid");
  return Object.freeze({
    reason,
    path,
    ...(hasStatementIndex ? { statementIndex: statementIndex as number } : {}),
    ...(hasSqlstate ? { sqlstate: sqlstate as string } : {}),
  });
}

function operationBuildBucket(context: ProductWorkflowContext, command: Command): string {
  const archive = context.sourceArchives.find(
    (candidate) => candidate.scope.operationId === command.operationId,
  );
  if (archive === undefined) throw new Error("Deployment Workflow has no source archive");
  return archive.bucket;
}

function parseBuildReceipt(value: unknown, command: Command): BuildReceipt {
  const record = requireRecord(value, "build receipt");
  const scope = requireRecord(record["scope"], "build scope");
  if (
    typeof record["buildId"] !== "string" ||
    typeof record["projectName"] !== "string" ||
    scope["projectId"] !== command.projectId ||
    scope["environmentId"] !== command.environmentId ||
    scope["operationId"] !== command.operationId
  )
    throw new TypeError("Build receipt is invalid");
  return record as unknown as BuildReceipt;
}

interface ArtifactBundle {
  readonly manifestDigest: string;
  readonly manifestBody: Uint8Array;
  readonly migrations: readonly Readonly<{
    readonly path: string;
    readonly digest: `sha256:${string}`;
    readonly size: number;
    readonly body: Uint8Array;
  }>[];
  readonly provenance: Readonly<{
    readonly artifactDigest: string;
    readonly sourceCommit: string;
    readonly sourceDigest: string;
    readonly buildPlanDigest: string;
    readonly lifecycleEvidence: BuildLifecycleEvidence;
    readonly deploymentId: Ulid;
    readonly buildId: string;
    readonly scope: ReturnType<typeof providerScope>;
    readonly database:
      | Readonly<{ readonly enabled: false }>
      | Readonly<{ readonly enabled: true; readonly migrations: string }>;
    readonly auth:
      | Readonly<{ readonly provider: "none" }>
      | Readonly<{
          readonly provider: "omh-native";
          readonly routePath: "/api/auth/v1";
          readonly bindingName: "OHMYHOST_AUTH";
        }>
      | Readonly<{
          readonly provider: "better-auth";
          readonly version: RecordedBetterAuthVersion;
          readonly deployment: "embedded" | "companion";
        }>;
    readonly storage:
      | Readonly<{ readonly enabled: false }>
      | Readonly<{
          readonly enabled: true;
          readonly provider: "r2";
          readonly jurisdiction: "eu" | "us";
          readonly public: false;
        }>;
    readonly functions?: VerifiedFunctionsRequirement;
    readonly output: Readonly<{
      readonly bucket: string;
      readonly key: string;
      readonly versionId: string;
      readonly eTag: string;
      readonly byteLength: number;
      readonly sha256: string;
    }>;
  }>;
}

interface BuildLifecycleEvidence {
  readonly configurationDigest: string;
  readonly frozenInstall: Readonly<{
    packageManager: string;
    packageManagerVersion: string;
    lockfile: string;
    lockfileSha256: string;
    installCommandSha256: string;
    dependencyInventorySha256: string;
  }>;
  readonly frameworkBuild: Readonly<{
    framework: string;
    runtime: "static" | "edge" | "functions";
    buildCommandSha256: string;
    frameworkPlanSha256: string;
    buildOutputSha256: string;
  }>;
  readonly buildSandbox: Readonly<{
    buildId: string;
    projectName: string;
    buildInputFingerprint: string;
    sourceArchiveSha256: string;
    terminalStatus: "SUCCEEDED";
  }>;
  readonly credentialScan: Readonly<{
    scannerSha256: string;
    rulesSha256: string;
    findingsCount: 0;
  }>;
}

interface ArtifactReference {
  readonly schemaVersion: "ohmyhost.verified-artifact-reference/v1";
  readonly expectation: Readonly<Record<string, unknown>>;
  readonly manifestDigest: `sha256:${string}`;
  readonly sbomDigest: `sha256:${string}`;
  readonly provenance: ArtifactBundle["provenance"];
}

interface WfpLifecycleArtifact {
  readonly manifestDigest: string;
  readonly sbomDigest: string;
  readonly provenance: ArtifactBundle["provenance"];
}

async function projectDatabaseBinding(
  services: ReturnType<typeof createPrivateDeploymentServices>,
  command: Command,
  artifact: Pick<ArtifactBundle, "provenance">,
): Promise<Readonly<{
  databaseRegistration: Readonly<Record<string, unknown>>;
  databaseOriginHost: string;
}> | null> {
  if (!artifact.provenance.database.enabled) return null;
  const result = exactRecord(
    await services.neon.readRuntimeBinding({
      organizationId: command.organizationId,
      projectId: command.projectId,
      environmentId: command.environmentId,
    }),
    ["status", "databaseRegistration"],
    "project database registration",
  );
  const registration = requireRecord(
    result["databaseRegistration"],
    "project database registration",
  );
  const host = registration["originHost"];
  const pgcf = registration["provider"] === "pgcf";
  if (pgcf) {
    readPgcfPostgresTarget(
      JSON.stringify({
        provider: "pgcf",
        host,
        databaseId: registration["databaseId"],
        role: registration["originUser"],
      }),
    );
    if (registration["originDatabase"] !== registration["databaseId"])
      throw new TypeError("Project database identity is unavailable");
  }
  if (
    result["status"] !== "ready" ||
    registration["organizationId"] !== command.organizationId ||
    registration["projectId"] !== command.projectId ||
    typeof registration["physicalEnvironmentId"] !== "string" ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(registration["physicalEnvironmentId"]) ||
    !Number.isSafeInteger(registration["registrationVersion"]) ||
    Number(registration["registrationVersion"]) < 1 ||
    (registration["region"] !== "us" && registration["region"] !== "eu") ||
    !Array.isArray(registration["authorizedEnvironmentIds"]) ||
    !registration["authorizedEnvironmentIds"].includes(command.environmentId) ||
    typeof host !== "string" ||
    host.length > 253 ||
    (!pgcf && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+neon\.tech$/u.test(host))
  )
    throw new TypeError("Project database registration is unavailable");
  return Object.freeze({ databaseRegistration: registration, databaseOriginHost: host });
}

async function projectStorageDataEnvironmentId(
  candidatePersistence: DeploymentCandidatePort,
  command: Command,
  databaseBinding: Awaited<ReturnType<typeof projectDatabaseBinding>>,
): Promise<Ulid> {
  const identity = await candidatePersistence.readDataEnvironment({
    organizationId: command.organizationId,
    projectId: command.projectId,
    environmentId: command.environmentId,
  });
  if (
    identity === null ||
    (databaseBinding !== null &&
      databaseBinding.databaseRegistration["physicalEnvironmentId"] !== identity)
  )
    throw new TypeError("Storage data assignment disagrees with the database registration");
  return parseUlid(identity);
}

async function projectStorageBucketName(
  services: ReturnType<typeof createPrivateDeploymentServices>,
  command: Command,
  artifact: Pick<ArtifactBundle, "provenance">,
): Promise<string | null> {
  if (!artifact.provenance.storage.enabled) return null;
  const result = requireRecord(
    await services.r2.readRuntimeBinding({
      organizationId: command.organizationId,
      projectId: command.projectId,
      environmentId: command.environmentId,
    }),
    "project R2 binding",
  );
  const expected = `ohmyho-${command.projectId.toLowerCase()}-${command.environmentId.toLowerCase()}`;
  if (
    result["status"] !== "ready" ||
    result["bucketName"] !== expected ||
    result["jurisdiction"] !== artifact.provenance.storage.jurisdiction
  ) {
    throw new TypeError("Project R2 binding is unavailable");
  }
  return expected;
}

async function ensureProjectStorageBucket(
  services: ReturnType<typeof createPrivateDeploymentServices>,
  command: Command,
  claimId: Ulid,
  jurisdiction: "eu" | "us",
): Promise<"ready" | "uncertain" | "conflict"> {
  const result = requireRecord(
    await services.r2.ensureBucket({
      jurisdiction,
      organizationId: command.organizationId,
      projectId: command.projectId,
      environmentId: command.environmentId,
      operationId: command.operationId,
      claimId,
    }),
    "R2 bucket",
  );
  if (result["status"] === "reconciliation_required") return "uncertain";
  if (result["status"] === "conflict") return "conflict";
  const receipt = requireRecord(result["receipt"], "R2 bucket receipt");
  const expectedBucket = `ohmyho-${command.projectId.toLowerCase()}-${command.environmentId.toLowerCase()}`;
  if (
    result["status"] !== "ready" ||
    receipt["bucketName"] !== expectedBucket ||
    typeof receipt["bucketId"] !== "string" ||
    !/^[0-9a-f]{32}$/u.test(receipt["bucketId"]) ||
    receipt["jurisdiction"] !== jurisdiction ||
    receipt["storageClass"] !== "Standard" ||
    receipt["publicAccess"] !== false
  ) {
    throw new TypeError("R2 bucket result is invalid");
  }
  return "ready";
}

async function cleanupProjectInventory(
  services: ReturnType<typeof createPrivateDeploymentServices>,
  inventoryPersistence: DeploymentInventoryPort,
  command: Extract<Command, { eventType: "ProjectDeletionRequestedV1" }>,
  context: ProductWorkflowContext,
  now: () => Date,
) {
  const environments = requireDeletionEnvironments(context);
  validateDatabaseDeletionInventory(context, command.projectId);
  const record = async (
    provider: string,
    resourceKind: string,
    locator: string,
    outcome: "removed" | "not_found" | "failed",
    errorCode?: string,
  ) => {
    const matches = context.deletionInventory.filter(
      (candidate) =>
        candidate.provider === provider &&
        candidate.resourceKind === resourceKind &&
        decodeCleanupLocator(candidate.cleanupLocator) === locator,
    );
    if (matches.length !== 1) throw new Error("Cleanup target is missing from deletion inventory");
    const inventory = matches[0];
    if (inventory === undefined)
      throw new Error("Cleanup target is missing from deletion inventory");
    const attemptedAt = canonicalDate(now);
    const cleanupAttemptId = await deterministicUlid(
      `${inventory.resourceRecordId}:${outcome}:${errorCode ?? ""}:${attemptedAt}`,
    );
    await inventoryPersistence.recordCleanupAttempt({
      cleanupAttemptId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
      provider,
      resourceKind,
      externalRefHash: inventory.externalRefHash,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      attemptedAt,
    });
  };
  const nativeDatabases = context.deletionInventory.filter(
    (item) => item.provider === "pgcf" && item.resourceKind === "native-auth-database",
  );
  // Restore pins live in the shared platform backup bucket. Only the exact frozen
  // object is retired; the bucket and caller-supplied locators are never forwarded.
  for (const item of context.deletionInventory) {
    if (item.provider !== "cloudflare" || item.resourceKind !== "native-auth-restore-pin") continue;
    if (item.cleanupOutcome === "removed" || item.cleanupOutcome === "not_found") continue;
    const locator = decodeCleanupLocator(item.cleanupLocator);
    const prefix = `restore-pins/${command.organizationId}/${command.projectId}/`;
    const slash = locator.indexOf("/");
    const bucket = locator.slice(0, slash);
    const key = locator.slice(slash + 1);
    if (
      !/^ohmyho-(development|production)-backups$/u.test(bucket) ||
      !key.startsWith(prefix) ||
      !key.endsWith(".zip")
    )
      throw new Error("Native restore pin cleanup target is invalid");
    const restoreId = parseUlid(key.slice(prefix.length, -4));
    if (key !== `${prefix}${restoreId}.zip`)
      throw new Error("Native restore pin cleanup target is invalid");
    const result = await services.recovery.invokeRecovery({
      action: "purge-restore-pin",
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
      restoreId,
    });
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== "restoreId,status" ||
      Reflect.get(result, "status") !== "absent" ||
      Reflect.get(result, "restoreId") !== restoreId
    )
      throw new Error("Native restore pin cleanup absence is unverified");
    await record("cloudflare", "native-auth-restore-pin", locator, "not_found");
  }
  const nativeRegistries = context.deletionInventory.filter(
    (item) => item.provider === "ohmyhost" && item.resourceKind === "native-auth-registry",
  );
  if (nativeDatabases.length > 1 || (nativeRegistries.length > 0 && nativeDatabases.length !== 1))
    throw new Error("Native Auth deletion inventory is incomplete");
  if (nativeDatabases.length === 1) {
    const result = requireRecord(
      await services.neon.deleteNativeAuthProject({
        organizationId: command.organizationId,
        projectId: command.projectId,
        operationId: command.operationId,
      }),
      "Native Auth project deletion",
    );
    if (result["status"] === "reconciliation_required") return { status: "uncertain" as const };
    const nativeDatabase = nativeDatabases[0];
    if (!nativeDatabase) throw new Error("Native Auth deletion inventory is incomplete");
    const database = decodeCleanupLocator(nativeDatabase.cleanupLocator);
    const refs = nativeRegistries.map((item) => decodeCleanupLocator(item.cleanupLocator));
    const registries = result["registries"];
    if (
      result["status"] !== "absent" ||
      result["databaseId"] !== database ||
      !Array.isArray(registries) ||
      registries.length !== refs.length ||
      refs.some((ref) => !registries.includes(ref))
    )
      throw new Error("Native Auth deletion absence is unverified");
    await record("pgcf", "native-auth-database", database, "not_found");
    for (const ref of refs) await record("ohmyhost", "native-auth-registry", ref, "not_found");
  }
  for (const item of context.deletionInventory) {
    if (item.provider !== "cloudflare" || item.resourceKind !== "sql-export") continue;
    const locator = decodeCleanupLocator(item.cleanupLocator);
    const match = /\/([0-9A-HJKMNP-TV-Z]{26})\.zip$/u.exec(locator);
    if (!match?.[1]) throw new Error("SQL export cleanup target is invalid");
    const exportId = parseUlid(match[1]);
    const result = await services.recovery.invokeRecovery({
      action: "purge",
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
      exportId,
    });
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== "exportId,status" ||
      !("status" in result) ||
      result.status !== "absent" ||
      !("exportId" in result) ||
      result.exportId !== exportId
    )
      throw new Error("SQL export cleanup absence is unverified");
    await record("cloudflare", "sql-export", locator, "not_found");
  }
  const mailCleanup = parseSesMailCleanup(
    await services.ses.deleteMailProject({
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
    }),
    command,
  );
  for (const provider of ["aws", "resend", "cloudflare"] as const) {
    const kinds =
      provider === "aws"
        ? ["ses-configuration-set", "ses-event-destination", "ses-tenant"]
        : provider === "resend"
          ? ["mail-domain", "mail-api-key"]
          : ["mail-dns-record"];
    requireExactCleanupInventory(
      context,
      provider,
      kinds,
      mailCleanup.filter((item) => item.provider === provider),
    );
  }
  for (const item of mailCleanup)
    await record(item.provider, item.resourceKind, item.locator, item.outcome);
  const domainCleanup = parseCloudflareDomainCleanup(
    await services.domains.deleteProject({
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
    }),
    command,
  );
  requireExactCleanupInventory(context, "cloudflare", ["domain-receipt"], domainCleanup);
  for (const item of domainCleanup) {
    await record("cloudflare", item.resourceKind, item.locator, item.outcome);
  }
  const managed = await inventoryPersistence.readManagedSourceInventory({
    organizationId: command.organizationId,
    projectId: command.projectId,
    operationId: command.operationId,
  });
  for (const repository of managed.repos) {
    const locator = `artifacts:${repository.namespace}/${repository.repositoryName}`;
    if (
      context.deletionInventory.filter(
        (item) =>
          item.provider === "cloudflare" &&
          item.resourceKind === "managed-source-repository" &&
          decodeCleanupLocator(item.cleanupLocator) === locator,
      ).length !== 1
    )
      throw new Error("Managed repository is missing from frozen deletion inventory");
    await services.source.removeManagedRepository({
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
      repository: { namespace: repository.namespace, repositoryName: repository.repositoryName },
    });
    await record("cloudflare", "managed-source-repository", locator, "not_found");
  }
  for (const operation of managed.blobOperations) {
    const blobs = [
      ...new Map(
        operation.blobs.map((blob) => [`${blob.bucket}/${blob.key}/${blob.versionId}`, blob]),
      ).values(),
    ];
    for (const blob of blobs) {
      if (
        context.deletionInventory.filter(
          (item) =>
            item.provider === "cloudflare" &&
            item.resourceKind === "managed-source-blob" &&
            decodeCleanupLocator(item.cleanupLocator) ===
              `${blob.bucket}/${blob.key}/${blob.versionId}`,
        ).length !== 1
      )
        throw new Error("Managed staging object is missing from frozen deletion inventory");
    }
    await services.source.removeManagedBlobOperation({
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: operation.operationId,
      region: context.region,
      blobs,
    });
    for (const blob of blobs)
      await record(
        "cloudflare",
        "managed-source-blob",
        `${blob.bucket}/${blob.key}/${blob.versionId}`,
        "not_found",
      );
  }
  for (const environment of environments) {
    for (const expectation of environment.deletionBuildArtifacts) {
      const result = requireRecord(
        await services.build.removeBuildArtifactObject(expectation.output),
        "artifact removal",
      );
      const absent = result["state"] === "absent";
      await record(
        "cloudflare",
        "build-artifact",
        `r2-version:${expectation.output.bucket}/${expectation.output.key}#${expectation.output.versionId}`,
        absent ? "not_found" : "failed",
        absent ? undefined : "BUILD_ARTIFACT_NOT_ABSENT",
      );
      if (!absent) return { status: "uncertain" as const };
    }
    for (const archive of environment.sourceArchives) {
      const result = requireRecord(await services.build.removeArchive(archive), "archive removal");
      const absent = result["state"] === "absent";
      await record(
        "cloudflare",
        "source-object",
        `${archive.bucket}/${archive.key}/${archive.versionId}`,
        absent ? "not_found" : "failed",
        absent ? undefined : "BUILD_ARCHIVE_NOT_ABSENT",
      );
      if (!absent) return { status: "uncertain" as const };
    }
    if (environment.r2Bucket !== null) {
      const result = requireRecord(
        await services.r2.purgeAndDeleteBucket(environment.r2Bucket),
        "R2 bucket deletion",
      );
      if (result["status"] === "reconciliation_required") {
        await record(
          "cloudflare",
          "r2-bucket",
          environment.r2Bucket.bucketName,
          "failed",
          "R2_BUCKET_DELETION_UNCERTAIN",
        );
        return { status: "uncertain" as const };
      }
      const absent =
        result["status"] === "absent" &&
        (result["outcome"] === "deleted" || result["outcome"] === "replayed");
      await record(
        "cloudflare",
        "r2-bucket",
        environment.r2Bucket.bucketName,
        absent && result["outcome"] === "deleted" ? "removed" : "not_found",
      );
      if (!absent) return { status: "uncertain" as const };
    }
  }
  for (const data of context.deletionDataEnvironments) {
    // Retired Neon heads are immutable migration provenance, never cleanup authority.
    if (data.providerTarget?.provider === "neon" && data.providerTarget.state === "retired")
      continue;
    if (data.providerTarget?.provider === "pgcf") {
      const providerTarget = data.providerTarget;
      if (
        providerTarget.state === "retired" &&
        !context.deletionInventory.some(
          (item) =>
            item.provider === "pgcf" &&
            item.resourceKind === "database" &&
            decodeCleanupLocator(item.cleanupLocator) === providerTarget.databaseId,
        )
      ) {
        // A previous data change already deleted this database; only its revoked registration remains in project history.
        if (data.databaseRegistration !== null) {
          if (data.databaseRegistration.status !== "revoked")
            throw new Error("Retired PGCF registration is still active");
          await record("ohmyhost", "database-registration", data.dataEnvironmentId, "not_found");
        }
        continue;
      }
      const outcome = await deletePgcfWorkflowDatabase(services, command, context, data);
      if (outcome === null) return { status: "uncertain" as const };
      if (data.databaseRegistration !== null)
        await record("ohmyhost", "database-registration", data.dataEnvironmentId, "removed");
      await record("pgcf", "database", data.providerTarget.databaseId, outcome);
      continue;
    }
    const placement = data.neonPlacement;
    const target = data.databaseRegistration;
    if (placement === null && target === null) continue;
    if (
      placement === null ||
      (target !== null &&
        (target.providerProjectId !== placement.providerProjectId ||
          "provider" in target ||
          target.branchId !== placement.defaultBranchId))
    )
      throw new Error("Deletion Workflow database cleanup evidence is incomplete");
    const request = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
      providerProjectId: placement.providerProjectId,
      defaultBranchId: placement.defaultBranchId,
      physicalEnvironmentId: data.dataEnvironmentId,
      registrationVersion:
        target === null
          ? null
          : target.status === "revoked"
            ? target.registrationVersion - 1
            : target.registrationVersion,
    };
    const result = requireRecord(
      await services.neon.deleteProject(request),
      "Neon project deletion",
    );
    if (result["status"] === "reconciliation_required") {
      if (result["phase"] === "neon") {
        if (target !== null) {
          parseDatabaseRevocationEvidence(
            result["databaseRegistration"],
            target,
            command.operationId,
          );
          await record("ohmyhost", "database-registration", data.dataEnvironmentId, "removed");
        }
        await record(
          "neon",
          "project",
          placement.providerProjectId,
          "failed",
          "NEON_PROJECT_DELETION_UNCERTAIN",
        );
      } else if (result["phase"] === "database" && target !== null) {
        await record(
          "ohmyhost",
          "database-registration",
          data.dataEnvironmentId,
          "failed",
          "DATABASE_REGISTRATION_REVOCATION_UNCERTAIN",
        );
      } else throw new TypeError("Database cleanup reconciliation phase is invalid");
      return { status: "uncertain" as const };
    }
    if (target !== null) {
      parseDatabaseRevocationEvidence(result["databaseRegistration"], target, command.operationId);
      await record("ohmyhost", "database-registration", data.dataEnvironmentId, "removed");
    } else if (result["databaseRegistration"] !== null)
      throw new TypeError("Unexpected database revocation evidence");
    const absent =
      result["status"] === "ready" &&
      result["provider"] === "neon" &&
      result["providerProjectId"] === placement.providerProjectId &&
      ["deleted", "already_absent", "reconciled_absent"].includes(String(result["outcome"]));
    await record(
      "neon",
      "project",
      placement.providerProjectId,
      absent ? (result["outcome"] === "deleted" ? "removed" : "not_found") : "failed",
      absent ? undefined : "NEON_PROJECT_DELETION_INVALID",
    );
    if (!absent) return { status: "uncertain" as const };
  }

  return { status: "observed" as const, inventoryClean: true };
}

interface ProviderCleanupEvidence {
  readonly resourceKind: string;
  readonly locator: string;
  readonly outcome: "removed" | "not_found";
}

function parseCloudflareDomainCleanup(
  value: unknown,
  command: Extract<Command, { eventType: "ProjectDeletionRequestedV1" }>,
): readonly ProviderCleanupEvidence[] {
  const result = exactRecord(
    value,
    ["oauthGrant", "observedAt", "operationId", "outcome", "receipts"],
    "Cloudflare domain deletion",
  );
  if (
    result["operationId"] !== command.operationId ||
    (result["outcome"] !== "deleted" && result["outcome"] !== "absent") ||
    (result["oauthGrant"] !== "revoked" && result["oauthGrant"] !== "absent") ||
    !canonicalTimestamp(result["observedAt"]) ||
    !Array.isArray(result["receipts"])
  ) {
    throw new TypeError("Cloudflare domain deletion result is invalid");
  }
  return Object.freeze(
    result["receipts"].map((value) => {
      const receipt = exactRecord(
        value,
        ["kind", "outcome", "providerResourceId", "receiptId"],
        "Cloudflare domain deletion receipt",
      );
      if (
        !isUlid(receipt["receiptId"]) ||
        !["custom_hostname", "dns_record", "ssl", "worker_route"].includes(
          String(receipt["kind"]),
        ) ||
        typeof receipt["providerResourceId"] !== "string" ||
        receipt["providerResourceId"].length < 1 ||
        receipt["providerResourceId"].length > 64 ||
        (receipt["outcome"] !== "deleted" && receipt["outcome"] !== "absent")
      ) {
        throw new TypeError("Cloudflare domain deletion receipt is invalid");
      }
      return Object.freeze({
        resourceKind: "domain-receipt",
        locator: String(receipt["receiptId"]),
        outcome: receipt["outcome"] === "deleted" ? ("removed" as const) : ("not_found" as const),
      });
    }),
  );
}

function parseSesMailCleanup(
  value: unknown,
  command: Extract<Command, { eventType: "ProjectDeletionRequestedV1" }>,
): readonly (ProviderCleanupEvidence & { provider: "aws" | "resend" | "cloudflare" })[] {
  const result = requireRecord(value, "SES mail deletion");
  const keys = Object.keys(result).sort().join(",");
  if (
    keys !== "cleanup,projectId,resourcesAbsent,status" ||
    (result["status"] !== "absent" && result["status"] !== "deleted") ||
    result["projectId"] !== command.projectId ||
    result["resourcesAbsent"] !== true ||
    !Array.isArray(result["cleanup"])
  ) {
    throw new TypeError("SES mail deletion result is invalid");
  }
  const allowedKinds = new Set([
    "ses-configuration-set",
    "ses-event-destination",
    "ses-tenant",
    "mail-domain",
    "mail-api-key",
    "mail-dns-record",
  ]);
  return Object.freeze(
    result["cleanup"].map((value) => {
      const item = exactRecord(
        value,
        ["locator", "outcome", "provider", "resourceKind"],
        "SES mail cleanup evidence",
      );
      if (
        !["aws", "resend", "cloudflare"].includes(String(item["provider"])) ||
        (item["provider"] === "resend" &&
          !["mail-domain", "mail-api-key"].includes(String(item["resourceKind"]))) ||
        (item["provider"] === "cloudflare" && item["resourceKind"] !== "mail-dns-record") ||
        (item["provider"] === "aws" &&
          ["mail-domain", "mail-api-key", "mail-dns-record"].includes(
            String(item["resourceKind"]),
          )) ||
        !allowedKinds.has(String(item["resourceKind"])) ||
        typeof item["locator"] !== "string" ||
        item["locator"].length < 1 ||
        item["locator"].length > 1_024 ||
        (item["outcome"] !== "removed" && item["outcome"] !== "not_found")
      ) {
        throw new TypeError("SES mail cleanup evidence is invalid");
      }
      return Object.freeze({
        provider: item["provider"] as "aws" | "resend" | "cloudflare",
        resourceKind: String(item["resourceKind"]),
        locator: item["locator"],
        outcome: item["outcome"] as "not_found" | "removed",
      });
    }),
  );
}

function requireExactCleanupInventory(
  context: ProductWorkflowContext,
  provider: string,
  resourceKinds: readonly string[],
  actual: readonly ProviderCleanupEvidence[],
): void {
  const kinds = new Set(resourceKinds);
  const inventory = context.deletionInventory.filter(
    (item) => item.provider === provider && kinds.has(item.resourceKind),
  );
  const expected = inventory.map(
    (item) => `${item.resourceKind}\0${decodeCleanupLocator(item.cleanupLocator)}`,
  );
  const observed = actual.map((item) => `${item.resourceKind}\0${item.locator}`).sort();
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  if (
    expectedSet.size !== expected.length ||
    observedSet.size !== observed.length ||
    observed.some((key) => !expectedSet.has(key)) ||
    inventory.some(
      (item) =>
        !observedSet.has(`${item.resourceKind}\0${decodeCleanupLocator(item.cleanupLocator)}`) &&
        item.cleanupOutcome !== "removed" &&
        item.cleanupOutcome !== "not_found",
    )
  ) {
    throw new Error("Provider cleanup evidence does not match deletion inventory");
  }
}

function decodeCleanupLocator(value: string): string {
  if (!value.startsWith("encoded/")) {
    throw new Error("Deletion inventory locator is not reversible");
  }
  const encoded = value.slice("encoded/".length).replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
  return new TextDecoder().decode(
    Uint8Array.from(atob(`${encoded}${padding}`), (char) => char.charCodeAt(0)),
  );
}

function wfpInventoryLocator(context: ProductWorkflowContext, scriptName: string): string | null {
  const matches = context.deletionInventory
    .filter((record) => record.provider === "cloudflare" && record.resourceKind === "wfp-script")
    .map((record) => decodeCleanupLocator(record.cleanupLocator))
    .filter((locator) => locator.endsWith(`/${scriptName}`));
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error("Cleanup target is ambiguous");
  return matches[0];
}

function validateDatabaseDeletionInventory(context: ProductWorkflowContext, projectId: Ulid): void {
  const expected: string[] = [];
  const identities = new Set<string>();
  for (const data of context.deletionDataEnvironments) {
    if (identities.has(data.dataEnvironmentId))
      throw new Error("Deletion data identity is duplicated");
    identities.add(data.dataEnvironmentId);
    const registration = data.databaseRegistration,
      placement = data.neonPlacement;
    const provider = data.providerTarget;
    if (
      provider &&
      (provider.organizationId !== context.intent.organizationId ||
        provider.projectId !== projectId ||
        provider.physicalEnvironmentId !== data.dataEnvironmentId)
    )
      throw new Error("Deletion Workflow provider scope is invalid");
    if (
      provider?.provider === "pgcf" &&
      registration &&
      (!("provider" in registration) ||
        registration.provider !== "pgcf" ||
        registration.databaseId !== provider.databaseId ||
        registration.providerProjectId !== provider.providerProjectId)
    )
      throw new Error("Deletion Workflow PGCF registration scope is invalid");
    if (
      provider?.provider !== "pgcf" &&
      placement !== null &&
      (placement.organizationId !== context.intent.organizationId ||
        placement.projectId !== projectId ||
        placement.environmentId !== data.dataEnvironmentId)
    )
      throw new Error("Deletion Workflow database placement scope is invalid");
    if (provider?.provider === "neon" && provider.state === "retired") continue;
    if (registration === null) continue;
    if (
      registration.organizationId !== context.intent.organizationId ||
      registration.projectId !== projectId ||
      registration.physicalEnvironmentId !== data.dataEnvironmentId
    )
      throw new Error("Deletion Workflow database scope is invalid");
    expected.push(data.dataEnvironmentId);
  }
  const activeNeon = context.deletionDataEnvironments.filter(
    (data) =>
      data.neonPlacement !== null &&
      (data.providerTarget === undefined ||
        (data.providerTarget?.provider === "neon" && data.providerTarget.state === "active")),
  );
  const frozenNeon = context.deletionInventory.filter(
    (item) => item.provider === "neon" && item.resourceKind === "project",
  );
  if (
    frozenNeon.length !== activeNeon.length ||
    frozenNeon.some(
      (item) =>
        activeNeon.filter(
          (data) =>
            data.neonPlacement?.providerProjectId === decodeCleanupLocator(item.cleanupLocator),
        ).length !== 1,
    )
  )
    throw new Error("Deletion Workflow Neon inventory has no active provider target");
  const actual = context.deletionInventory
    .filter(
      (record) => record.provider === "ohmyhost" && record.resourceKind === "database-registration",
    )
    .map((record) => decodeCleanupLocator(record.cleanupLocator));
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((value) => !expected.includes(value))
  )
    throw new Error("Deletion Workflow database cleanup target is invalid");
}

/** Use the frozen provider head and inventory, never the historical Neon receipt. */
async function deletePgcfWorkflowDatabase(
  services: ReturnType<typeof createPrivateDeploymentServices>,
  command: Extract<
    Command,
    { eventType: "ProjectDeletionRequestedV1" | "ProjectDataChangeRequestedV1" }
  >,
  context: ProductWorkflowContext,
  data: ProductWorkflowDeletionDataEnvironment,
): Promise<"removed" | "not_found" | null> {
  const target = data.providerTarget,
    registration = data.databaseRegistration;
  if (
    target?.provider !== "pgcf" ||
    target.organizationId !== command.organizationId ||
    target.projectId !== command.projectId ||
    target.physicalEnvironmentId !== data.dataEnvironmentId ||
    context.deletionInventory.filter(
      (item) =>
        item.provider === "pgcf" &&
        item.resourceKind === "database" &&
        decodeCleanupLocator(item.cleanupLocator) === target.databaseId,
    ).length !== 1 ||
    (registration &&
      (!("provider" in registration) ||
        registration.provider !== "pgcf" ||
        registration.providerProjectId !== target.providerProjectId ||
        registration.databaseId !== target.databaseId))
  )
    throw new Error("Deletion Workflow PGCF cleanup evidence is incomplete");
  const result = requireRecord(
    await services.neon.deleteProject({
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
      providerProjectId: target.providerProjectId,
      databaseId: target.databaseId,
      physicalEnvironmentId: data.dataEnvironmentId,
      registrationVersion:
        registration === null
          ? null
          : registration.status === "revoked"
            ? registration.registrationVersion - 1
            : registration.registrationVersion,
    }),
    "PGCF database deletion",
  );
  if (registration !== null)
    parseDatabaseRevocationEvidence(
      result["databaseRegistration"],
      registration,
      command.operationId,
    );
  else if (result["databaseRegistration"] !== null)
    throw new TypeError("Unexpected PGCF registration revocation");
  if (result["status"] === "reconciliation_required" && result["phase"] === "pgcf") return null;
  if (
    result["status"] !== "absent" ||
    result["provider"] !== "pgcf" ||
    result["providerProjectId"] !== target.providerProjectId ||
    result["databaseId"] !== target.databaseId ||
    (result["outcome"] !== "deleted" && result["outcome"] !== "replayed")
  )
    return null;
  return result["outcome"] === "deleted" ? "removed" : "not_found";
}

function parseDatabaseRevocationEvidence(
  value: unknown,
  expected: NonNullable<ProductWorkflowDeletionDataEnvironment["databaseRegistration"]>,
  operationId: string,
): void {
  const record = requireRecord(value, "Database revocation evidence");
  const expectedVersion =
    expected.status === "revoked" ? expected.registrationVersion : expected.registrationVersion + 1;
  if (
    record["operationId"] !==
      (expected.status === "revoked" ? expected.operationId : operationId) ||
    record["status"] !== "revoked" ||
    record["registrationVersion"] !== expectedVersion ||
    (
      [
        "organizationId",
        "projectId",
        "physicalEnvironmentId",
        "region",
        "providerProjectId",
        "originHost",
        "originDatabase",
        "originUser",
      ] as const
    ).some((key) => record[key] !== expected[key]) ||
    ("provider" in expected
      ? record["provider"] !== "pgcf" ||
        record["databaseId"] !== expected.databaseId ||
        "branchId" in record
      : "provider" in record || record["branchId"] !== expected.branchId) ||
    JSON.stringify(record["authorizedEnvironmentIds"]) !==
      JSON.stringify(expected.authorizedEnvironmentIds)
  ) {
    throw new TypeError("Database revocation evidence is invalid");
  }
}

async function recordDeletionAttempt(
  inventoryPersistence: DeploymentInventoryPort,
  command: Extract<
    Command,
    {
      eventType:
        | "ProjectDeletionRequestedV1"
        | "ProjectDataChangeRequestedV1"
        | "DeploymentRequestedV1";
    }
  >,
  context: ProductWorkflowContext,
  provider: string,
  resourceKind: string,
  locator: string,
  outcome: "removed" | "not_found" | "failed",
  now: () => Date,
): Promise<void> {
  const inventory = context.deletionInventory.filter(
    (candidate) =>
      candidate.provider === provider &&
      candidate.resourceKind === resourceKind &&
      decodeCleanupLocator(candidate.cleanupLocator) === locator,
  );
  if (inventory.length !== 1 || inventory[0] === undefined) {
    throw new Error("Cleanup target is missing from deletion inventory");
  }
  const target = inventory[0];
  const attemptedAt = canonicalDate(now);
  const cleanupAttemptId = await deterministicUlid(
    `${target.resourceRecordId}:${outcome}:${attemptedAt}`,
  );
  await inventoryPersistence.recordCleanupAttempt({
    cleanupAttemptId,
    organizationId: command.organizationId,
    projectId: command.projectId,
    operationId: command.operationId,
    provider: target.provider,
    resourceKind: target.resourceKind,
    externalRefHash: target.externalRefHash,
    outcome,
    attemptedAt,
  });
}

function canonicalTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  return canonical(left) === canonical(right);
}

function parseArtifact(value: unknown, command: Command | undefined): ArtifactBundle {
  const record = requireRecord(value, "verified artifact");
  const provenance = requireRecord(record["provenance"], "artifact provenance");
  const output = requireRecord(provenance["output"], "artifact output");
  const scope = requireRecord(provenance["scope"], "artifact scope");
  const database = requireRecord(provenance["database"], "artifact database requirement");
  const auth = requireRecord(provenance["auth"], "artifact customer auth requirement");
  const storage = requireRecord(provenance["storage"], "artifact storage requirement");
  const lifecycleEvidence = parseBuildLifecycleEvidence(provenance["lifecycleEvidence"]);
  const migrations = record["migrations"];
  if (
    !digest(record["manifestDigest"]) ||
    !(record["manifestBody"] instanceof Uint8Array) ||
    !Array.isArray(migrations) ||
    !digest(provenance["artifactDigest"]) ||
    typeof provenance["sourceCommit"] !== "string" ||
    !/^[0-9a-f]{40}$/u.test(provenance["sourceCommit"]) ||
    !digest(provenance["sourceDigest"]) ||
    !digest(provenance["buildPlanDigest"]) ||
    lifecycleEvidence.frameworkBuild.frameworkPlanSha256 !==
      String(provenance["buildPlanDigest"]).slice("sha256:".length) ||
    lifecycleEvidence.buildSandbox.sourceArchiveSha256 !==
      String(provenance["sourceDigest"]).slice("sha256:".length) ||
    !isUlid(provenance["deploymentId"]) ||
    typeof provenance["buildId"] !== "string" ||
    !(
      (database["enabled"] === false && Object.keys(database).length === 1) ||
      (database["enabled"] === true &&
        typeof database["migrations"] === "string" &&
        database["migrations"].length > 0 &&
        Object.keys(database).length === 2)
    ) ||
    !(
      (auth["provider"] === "none" && Object.keys(auth).length === 1) ||
      (auth["provider"] === "omh-native" &&
        Object.keys(auth).sort().join(",") === "bindingName,provider,routePath" &&
        auth["routePath"] === "/api/auth/v1" &&
        auth["bindingName"] === "OHMYHOST_AUTH") ||
      (auth["provider"] === "better-auth" &&
        Object.keys(auth).sort().join(",") ===
          "authSecretName,databaseBindingName,databaseSchema,deployment,provider,routePath,version" &&
        isRecordedBetterAuthVersion(auth["version"]) &&
        (auth["deployment"] === "embedded" || auth["deployment"] === "companion") &&
        auth["routePath"] === "/api/auth" &&
        auth["databaseSchema"] === "auth" &&
        auth["databaseBindingName"] === "OHMYHOST_DATABASE" &&
        auth["authSecretName"] === "BETTER_AUTH_SECRET")
    ) ||
    (auth["provider"] === "better-auth" && database["enabled"] !== true) ||
    !validStorageRequirement(storage) ||
    !validVerifiedScheduledFunctions(provenance["functions"]) ||
    !hex64(output["sha256"]) ||
    typeof output["bucket"] !== "string" ||
    typeof output["key"] !== "string" ||
    typeof output["versionId"] !== "string" ||
    typeof output["eTag"] !== "string" ||
    !positiveSafe(output["byteLength"]) ||
    (command !== undefined &&
      (scope["projectId"] !== command.projectId ||
        scope["environmentId"] !== command.environmentId ||
        scope["operationId"] !== command.operationId))
  )
    throw new TypeError("Verified artifact bundle is invalid");
  if (
    (database["enabled"] === false && migrations.length !== 0) ||
    (database["enabled"] === true && migrations.length === 0) ||
    migrations.some((migration) => {
      if (typeof migration !== "object" || migration === null || Array.isArray(migration)) {
        return true;
      }
      const candidate = migration as Record<string, unknown>;
      return (
        typeof candidate["path"] !== "string" ||
        !digest(candidate["digest"]) ||
        !positiveSafe(candidate["size"]) ||
        !(candidate["body"] instanceof Uint8Array) ||
        candidate["body"].byteLength !== candidate["size"]
      );
    })
  ) {
    throw new TypeError("Verified artifact migrations are invalid");
  }
  return record as unknown as ArtifactBundle;
}

function parseBuildLifecycleEvidence(value: unknown): BuildLifecycleEvidence {
  const record = exactRecord(
    value,
    ["buildSandbox", "configurationDigest", "credentialScan", "frameworkBuild", "frozenInstall"],
    "build lifecycle evidence",
  );
  const frozenInstall = exactRecord(
    record["frozenInstall"],
    [
      "dependencyInventorySha256",
      "installCommandSha256",
      "lockfile",
      "lockfileSha256",
      "packageManager",
      "packageManagerVersion",
    ],
    "frozen install evidence",
  );
  const frameworkBuild = exactRecord(
    record["frameworkBuild"],
    ["buildCommandSha256", "buildOutputSha256", "framework", "frameworkPlanSha256", "runtime"],
    "framework build evidence",
  );
  const buildSandbox = exactRecord(
    record["buildSandbox"],
    ["buildId", "buildInputFingerprint", "projectName", "sourceArchiveSha256", "terminalStatus"],
    "build sandbox evidence",
  );
  const credentialScan = exactRecord(
    record["credentialScan"],
    ["findingsCount", "rulesSha256", "scannerSha256"],
    "credential scan evidence",
  );
  const digestValues = [
    record["configurationDigest"],
    frozenInstall["lockfileSha256"],
    frozenInstall["installCommandSha256"],
    frozenInstall["dependencyInventorySha256"],
    frameworkBuild["buildCommandSha256"],
    frameworkBuild["frameworkPlanSha256"],
    frameworkBuild["buildOutputSha256"],
    buildSandbox["buildInputFingerprint"],
    buildSandbox["sourceArchiveSha256"],
    credentialScan["scannerSha256"],
    credentialScan["rulesSha256"],
  ];
  if (
    !digestValues.every(hex64) ||
    ![
      frozenInstall["packageManager"],
      frozenInstall["packageManagerVersion"],
      frozenInstall["lockfile"],
    ].every((candidate) => typeof candidate === "string" && candidate.length > 0) ||
    typeof frameworkBuild["framework"] !== "string" ||
    (frameworkBuild["runtime"] !== "static" &&
      frameworkBuild["runtime"] !== "edge" &&
      frameworkBuild["runtime"] !== "functions") ||
    typeof buildSandbox["buildId"] !== "string" ||
    typeof buildSandbox["projectName"] !== "string" ||
    buildSandbox["terminalStatus"] !== "SUCCEEDED" ||
    credentialScan["findingsCount"] !== 0
  ) {
    throw new TypeError("Build lifecycle evidence is invalid");
  }
  return record as unknown as BuildLifecycleEvidence;
}

function parseArtifactReference(value: unknown, command: Command): ArtifactReference {
  const record = exactRecord(
    value,
    ["expectation", "manifestDigest", "provenance", "sbomDigest", "schemaVersion"],
    "verified artifact reference",
  );
  const expectation = requireRecord(record["expectation"], "artifact expectation");
  const provenance = requireRecord(record["provenance"], "artifact provenance");
  const output = requireRecord(provenance["output"], "artifact output");
  const scope = requireRecord(provenance["scope"], "artifact scope");
  const database = requireRecord(provenance["database"], "artifact database requirement");
  const auth = requireRecord(provenance["auth"], "artifact customer auth requirement");
  const storage = requireRecord(provenance["storage"], "artifact storage requirement");
  const lifecycleEvidence = parseBuildLifecycleEvidence(provenance["lifecycleEvidence"]);
  const receipt = parseBuildReceipt(expectation["receipt"], command);
  if (
    record["schemaVersion"] !== "ohmyhost.verified-artifact-reference/v1" ||
    !digest(record["manifestDigest"]) ||
    !digest(record["sbomDigest"]) ||
    !digest(provenance["artifactDigest"]) ||
    provenance["sourceCommit"] !== expectation["commitSha"] ||
    provenance["sourceDigest"] !== `sha256:${String(expectation["sourceSha256"])}` ||
    provenance["buildPlanDigest"] !== `sha256:${String(expectation["buildPlanSha256"])}` ||
    lifecycleEvidence.frameworkBuild.frameworkPlanSha256 !== expectation["buildPlanSha256"] ||
    lifecycleEvidence.buildSandbox.sourceArchiveSha256 !== expectation["sourceSha256"] ||
    !isUlid(provenance["deploymentId"]) ||
    expectation["deploymentId"] !== provenance["deploymentId"] ||
    typeof expectation["commitSha"] !== "string" ||
    !/^[0-9a-f]{40}$/u.test(expectation["commitSha"]) ||
    !hex64(expectation["sourceSha256"]) ||
    !hex64(expectation["buildPlanSha256"]) ||
    !isRecordValue(expectation["frameworkPlan"]) ||
    receipt.buildId !== provenance["buildId"] ||
    scope["projectId"] !== command.projectId ||
    scope["environmentId"] !== command.environmentId ||
    scope["operationId"] !== command.operationId ||
    !(
      (database["enabled"] === false && Object.keys(database).length === 1) ||
      (database["enabled"] === true &&
        typeof database["migrations"] === "string" &&
        database["migrations"].length > 0 &&
        Object.keys(database).length === 2)
    ) ||
    !(
      (auth["provider"] === "none" && Object.keys(auth).length === 1) ||
      (auth["provider"] === "omh-native" &&
        Object.keys(auth).sort().join(",") === "bindingName,provider,routePath" &&
        auth["routePath"] === "/api/auth/v1" &&
        auth["bindingName"] === "OHMYHOST_AUTH") ||
      (auth["provider"] === "better-auth" &&
        isRecordedBetterAuthVersion(auth["version"]) &&
        (auth["deployment"] === "embedded" || auth["deployment"] === "companion") &&
        auth["routePath"] === "/api/auth" &&
        auth["databaseSchema"] === "auth" &&
        auth["databaseBindingName"] === "OHMYHOST_DATABASE" &&
        auth["authSecretName"] === "BETTER_AUTH_SECRET")
    ) ||
    (auth["provider"] === "better-auth" && database["enabled"] !== true) ||
    !validStorageRequirement(storage) ||
    !validVerifiedScheduledFunctions(provenance["functions"]) ||
    !hex64(output["sha256"]) ||
    typeof output["bucket"] !== "string" ||
    typeof output["key"] !== "string" ||
    typeof output["versionId"] !== "string" ||
    typeof output["eTag"] !== "string" ||
    !positiveSafe(output["byteLength"])
  ) {
    throw new TypeError("Verified artifact reference is invalid");
  }
  return record as unknown as ArtifactReference;
}

function parseBindingRefreshArtifact(
  value: unknown,
  current: ProductWorkflowContext,
): ArtifactBundle & WfpLifecycleArtifact {
  const snapshot = current.intent.bindingRefreshSnapshot;
  const expected = current.bindingRefreshArtifact;
  if (snapshot == null || expected == null)
    throw new TypeError("Binding refresh artifact custody is absent");
  const artifact = parseArtifact(value, undefined);
  const provenance = artifact.provenance;
  if (
    provenance.artifactDigest !== `sha256:${snapshot.sourceArtifactSha256}` ||
    provenance.deploymentId !== expected.deploymentId ||
    provenance.scope.projectId !== expected.receipt.scope.projectId ||
    provenance.scope.environmentId !== expected.receipt.scope.environmentId ||
    provenance.scope.operationId !== expected.receipt.scope.operationId ||
    provenance.buildId !== expected.receipt.buildId ||
    provenance.sourceCommit !== expected.commitSha ||
    provenance.sourceDigest !== `sha256:${expected.sourceSha256}` ||
    provenance.buildPlanDigest !== `sha256:${expected.buildPlanSha256}` ||
    provenance.output.bucket !== expected.output.bucket ||
    provenance.output.key !== expected.output.key ||
    provenance.output.versionId !== expected.output.versionId
  )
    throw new TypeError("Binding refresh artifact custody changed");
  return Object.freeze({
    ...artifact,
    sbomDigest: parseManifest(artifact.manifestBody).sbomDigest,
  });
}

function parseWfpLifecycleArtifact(value: unknown, command: Command): WfpLifecycleArtifact {
  if (isArtifactReference(value)) {
    const reference = parseArtifactReference(value, command);
    return Object.freeze({
      manifestDigest: reference.manifestDigest,
      sbomDigest: reference.sbomDigest,
      provenance: reference.provenance,
    });
  }
  const artifact = parseArtifact(value, command);
  return Object.freeze({
    manifestDigest: artifact.manifestDigest,
    sbomDigest: parseManifest(artifact.manifestBody).sbomDigest,
    provenance: artifact.provenance,
  });
}

function isArtifactReference(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>)["schemaVersion"] ===
      "ohmyhost.verified-artifact-reference/v1"
  );
}

function isRecordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStorageRequirement(value: Readonly<Record<string, unknown>>): boolean {
  if (value["enabled"] === false) return Object.keys(value).length === 1;
  return (
    Object.keys(value).sort().join(",") === "enabled,jurisdiction,provider,public" &&
    value["enabled"] === true &&
    value["provider"] === "r2" &&
    (value["jurisdiction"] === "eu" || value["jurisdiction"] === "us") &&
    value["public"] === false
  );
}

function validVerifiedScheduledFunctions(value: unknown): value is VerifiedFunctionsRequirement {
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    Object.keys(value).join(",") !== "crons" ||
    !Array.isArray(value["crons"])
  )
    return false;
  try {
    return JSON.stringify(normalizeCrons(value["crons"])) === JSON.stringify(value["crons"]);
  } catch {
    return false;
  }
}

async function readReferencedArtifact(
  services: ReturnType<typeof createPrivateDeploymentServices>,
  reference: ArtifactReference,
  command: Command,
): Promise<ArtifactBundle> {
  const artifact = parseArtifact(
    await services.build.readBuildArtifact({
      expectation: reference.expectation,
      bucket: reference.provenance.output.bucket,
    }),
    command,
  );
  const manifest = parseManifest(artifact.manifestBody);
  if (
    artifact.manifestDigest !== reference.manifestDigest ||
    manifest.sbomDigest !== reference.sbomDigest ||
    artifact.provenance.artifactDigest !== reference.provenance.artifactDigest ||
    artifact.provenance.output.versionId !== reference.provenance.output.versionId
  ) {
    throw new TypeError("Verified artifact reference changed");
  }
  return artifact;
}

function parseWfpReceipt(value: unknown, command: Command): ProductWorkflowWfpReceipt {
  return parseWfpReceiptScope(value, command.projectId, command.environmentId);
}

/**
 * A claimed cleanup can belong to the project's other environment, which every later command drains
 * first, so its receipt is checked in the environment it was staged in (Sebmer Prod, 2026-09-27).
 */
function parseCandidateOwnReceipt(value: unknown, projectId: Ulid): ProductWorkflowWfpReceipt {
  const record = requireRecord(value, "persisted WFP candidate");
  const environmentId = parseUlid(
    requireString(record["environmentId"], "candidate environment ID"),
  );
  return parseWfpReceiptScope(value, projectId, environmentId);
}

function parseWfpReceiptScope(
  value: unknown,
  projectId: Ulid,
  environmentId: Ulid,
): ProductWorkflowWfpReceipt {
  const record = requireRecord(value, "WFP receipt");
  const deployedAt = record["deployedAt"];
  const date = deployedAt instanceof Date ? deployedAt : new Date(String(deployedAt));
  const hasBindingSetDigest = Object.hasOwn(record, "bindingSetDigest");
  const bindingSetDigest = hasBindingSetDigest ? record["bindingSetDigest"] : undefined;
  if (
    Object.keys(record).sort().join(",") !==
      (hasBindingSetDigest
        ? "artifactDigest,bindingSetDigest,buildReused,deployedAt,environmentId,namespace,productDeploymentId,projectId,provider,providerTag,scriptName"
        : "artifactDigest,buildReused,deployedAt,environmentId,namespace,productDeploymentId,projectId,provider,providerTag,scriptName") ||
    record["provider"] !== "cloudflare-wfp" ||
    typeof record["namespace"] !== "string" ||
    typeof record["scriptName"] !== "string" ||
    record["projectId"] !== projectId ||
    record["environmentId"] !== environmentId ||
    !isUlid(record["productDeploymentId"]) ||
    typeof record["providerTag"] !== "string" ||
    !digest(record["artifactDigest"]) ||
    (hasBindingSetDigest && !digest(bindingSetDigest)) ||
    typeof record["buildReused"] !== "boolean" ||
    !Number.isFinite(date.getTime())
  )
    throw new TypeError("WFP receipt is invalid");
  return {
    provider: "cloudflare-wfp",
    namespace: record["namespace"],
    scriptName: record["scriptName"],
    projectId,
    environmentId,
    productDeploymentId: record["productDeploymentId"],
    providerTag: record["providerTag"],
    artifactDigest: record["artifactDigest"],
    ...(digest(bindingSetDigest) ? { bindingSetDigest } : {}),
    buildReused: record["buildReused"],
    deployedAt: date.toISOString(),
  };
}

function candidateEnvironmentName(receipt: ProductWorkflowWfpReceipt): "dev" | "prod" {
  for (const environmentName of ["dev", "prod"] as const) {
    if (
      receipt.scriptName ===
      `p-${receipt.projectId.toLowerCase()}-${environmentName}-${receipt.productDeploymentId.toLowerCase()}`
    )
      return environmentName;
  }
  throw new TypeError("Persisted WFP candidate environment is invalid");
}

async function candidatePersistenceRecord(
  command: Extract<
    Command,
    {
      eventType:
        | "DeploymentRequestedV1"
        | "DeploymentRollbackRequestedV1"
        | "DeploymentPromotionRequestedV1";
    }
  >,
  context: ProductWorkflowContext,
  candidate: import("@ohmyhost/orchestrator").ProductWfpCandidate,
) {
  const receipt = parseWfpReceipt(candidate.receipt, command);
  const artifactId =
    command.eventType === "DeploymentPromotionRequestedV1"
      ? context.intent.sourceArtifactId
      : command.eventType === "DeploymentRequestedV1"
        ? (context.intent.bindingRefreshSnapshot?.sourceArtifactId ?? command.operationId)
        : null;
  if (artifactId === null) throw new Error("WFP candidate has no persisted artifact identity");
  return Object.freeze({
    candidateReceiptId: await deterministicUlid(
      `${deterministicProductCommandWorkflowId(command)}:wfp-candidate`,
    ),
    organizationId: command.organizationId,
    projectId: command.projectId,
    environmentId: command.environmentId,
    operationId: command.operationId,
    productDeploymentId: receipt.productDeploymentId,
    artifactId,
    namespace: receipt.namespace,
    immutableScriptName: receipt.scriptName,
    artifactDigest: digestBytes(receipt.artifactDigest),
    ...(receipt.bindingSetDigest === undefined
      ? {}
      : { bindingSetDigest: digestBytes(receipt.bindingSetDigest) }),
    providerTag: receipt.providerTag,
    buildReused: receipt.buildReused,
    stagedAt: receipt.deployedAt,
  });
}

async function productDeploymentEvidence(
  command: Extract<Command, { eventType: "DeploymentRequestedV1" }>,
  context: ProductWorkflowContext,
  executionId: string,
  value: Readonly<Record<string, unknown>>,
  custodyPort: DeploymentSourceCustodyPort,
) {
  const archive = parseSourceArchive(value["archive"], command);
  const build = parseBuildReceipt(value["build"], command);
  const artifact = parseWfpLifecycleArtifact(value["artifact"], command);
  const intent = context.intent;
  const custody =
    context.sourceGrant === null
      ? await custodyPort.observeArchive({
          organizationId: command.organizationId,
          projectId: command.projectId,
          operationId: command.operationId,
        })
      : null;
  const origin = context.sourceGrant ?? custody;
  if (
    intent.deploymentId === null ||
    intent.planId === null ||
    intent.sourceConnectionId === null ||
    intent.commitSha === null ||
    intent.sourceDigest === null ||
    intent.buildPlanDigest === null ||
    origin === null ||
    origin.sourceConnectionId !== intent.sourceConnectionId ||
    (custody !== null &&
      (custody.requestedCommitSha !== intent.commitSha ||
        custody.resolvedCommitSha !== intent.commitSha ||
        !Buffer.from(custody.sha256).equals(intent.sourceDigest))) ||
    artifact.provenance.deploymentId !== intent.deploymentId ||
    artifact.provenance.sourceCommit !== intent.commitSha ||
    artifact.provenance.sourceDigest !== `sha256:${intent.sourceDigest.toString("hex")}` ||
    artifact.provenance.buildPlanDigest !== `sha256:${intent.buildPlanDigest.toString("hex")}`
  ) {
    throw new DeploymentPersistenceConflictError("Product deployment evidence changed");
  }
  const ids = await derivedIds(executionId);
  const output = artifact.provenance.output;
  return Object.freeze({
    organizationId: command.organizationId,
    projectId: command.projectId,
    environmentId: command.environmentId,
    operationId: command.operationId,
    billingEpochId: command.billingEpochId,
    deploymentId: intent.deploymentId,
    planId: intent.planId,
    uploadId: command.operationId,
    uploadClaimId: ids.operationEventId,
    buildExecutionId: command.operationId,
    artifactId: command.operationId,
    revisionId: command.operationId,
    sourceConnectionId: intent.sourceConnectionId,
    provider: origin.provider,
    externalRepositoryId: origin.externalRepositoryId,
    commitSha: intent.commitSha,
    sourceSha256: intent.sourceDigest.toString("hex"),
    buildPlanSha256: intent.buildPlanDigest.toString("hex"),
    archive: {
      bucket: archive.archive.bucket,
      key: archive.archive.key,
      versionId: archive.archive.versionId,
      archiveId: archive.archiveId,
      eTag: archive.archive.eTag,
      byteLength: archive.byteLength,
    },
    build: { buildId: build.buildId, projectName: build.projectName },
    artifact: {
      artifactDigest: artifact.provenance.artifactDigest,
      manifestDigest: artifact.manifestDigest,
      sbomDigest: artifact.sbomDigest,
      outputVersionRef: `r2-version:${output.bucket}/${output.key}#${output.versionId}`,
    },
    recordedAt: context.acceptedAt,
  });
}

/** Records the activated deployment's crons for the private scheduler; no crons removes the schedule. */
function functionScheduleInput(input: {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly deploymentId: Ulid;
  readonly candidateReceiptId: Ulid;
  readonly runtimePolicy: unknown;
  readonly functions: unknown;
  readonly recordedAt: string;
}): Parameters<typeof recordEnvironmentFunctionSchedule>[1] {
  if (!validVerifiedScheduledFunctions(input.functions))
    throw new TypeError("Scheduled function evidence is invalid");
  const crons = input.functions?.crons ?? [];
  const runtimePolicy =
    crons.length === 0 ? null : parseScheduledRuntimePolicy(input.runtimePolicy);
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    deploymentId: input.deploymentId,
    candidateReceiptId: input.candidateReceiptId,
    crons,
    egressAllowedOrigins: runtimePolicy?.egressAllowedOrigins ?? [],
    now: input.recordedAt,
  };
}

function parseScheduledRuntimePolicy(value: unknown): Readonly<{
  healthCheckPath: string;
  egressAllowedOrigins: readonly string[];
  browser?: BrowserPolicy;
}> {
  const record = requireRecord(value, "scheduled runtime policy");
  const healthCheckPath = record["healthCheckPath"];
  const origins = record["egressAllowedOrigins"];
  if (
    ![
      "egressAllowedOrigins,healthCheckPath",
      "browser,egressAllowedOrigins,healthCheckPath",
    ].includes(Object.keys(record).sort().join(",")) ||
    typeof healthCheckPath !== "string" ||
    !Array.isArray(origins) ||
    origins.length > 16 ||
    origins.some((origin, index) => {
      if (typeof origin !== "string" || (index > 0 && String(origins[index - 1]) >= origin))
        return true;
      try {
        const parsed = new URL(origin);
        return (
          parsed.protocol !== "https:" ||
          parsed.origin !== origin ||
          parsed.pathname !== "/" ||
          parsed.search !== "" ||
          parsed.hash !== ""
        );
      } catch {
        return true;
      }
    })
  )
    throw new TypeError("Scheduled runtime policy is invalid");
  return Object.freeze({
    healthCheckPath,
    egressAllowedOrigins: Object.freeze(origins.map(String)),
    ...(Object.hasOwn(record, "browser") ? { browser: parseBrowserPolicy(record["browser"]) } : {}),
  });
}

function candidateFromPersistence(
  value: import("@ohmyhost/database").WfpCandidateReceipt,
  context: ProductWorkflowContext,
): import("@ohmyhost/orchestrator").ProductWfpCandidate {
  const hasBindingSetDigest = Object.hasOwn(value, "bindingSetDigest");
  const bindingSetDigest = hasBindingSetDigest ? value.bindingSetDigest : undefined;
  if (
    hasBindingSetDigest &&
    (!(bindingSetDigest instanceof Uint8Array) || bindingSetDigest.byteLength !== 32)
  )
    throw new TypeError("Persisted WFP binding digest is invalid");
  return Object.freeze({
    candidateReceiptId: value.candidateReceiptId,
    operationId: value.operationId,
    receipt: Object.freeze({
      provider: "cloudflare-wfp",
      namespace: value.namespace,
      scriptName: value.immutableScriptName,
      projectId: value.projectId,
      environmentId: value.environmentId,
      productDeploymentId: value.productDeploymentId,
      providerTag: value.providerTag,
      artifactDigest: `sha256:${Buffer.from(value.artifactDigest).toString("hex")}`,
      ...(bindingSetDigest === undefined
        ? {}
        : { bindingSetDigest: `sha256:${Buffer.from(bindingSetDigest).toString("hex")}` }),
      buildReused: value.buildReused,
      deployedAt: new Date(value.stagedAt),
    }),
    previousGateway: context.activeGateway,
    runtimePolicy: Object.freeze({}),
    deploymentUrl: context.activeGateway?.publicOrigin ?? "https://candidate.invalid",
    artifactDigest: `sha256:${Buffer.from(value.artifactDigest).toString("hex")}`,
  });
}

function candidateFromFinalEvidence(
  evidence: Readonly<Record<string, unknown>>,
  command: Command,
): import("@ohmyhost/orchestrator").ProductWfpCandidate {
  return Object.freeze({
    candidateReceiptId: null,
    operationId: command.operationId,
    receipt: evidence["wfp"],
    previousGateway: null,
    runtimePolicy: Object.freeze({}),
    deploymentUrl: httpsUrl(evidence["deploymentUrl"]),
    artifactDigest: requireString(evidence["artifactDigest"], "candidate artifact digest"),
  });
}

function requireRuntimeSecretStage(
  candidate: import("@ohmyhost/orchestrator").ProductWfpCandidate,
): unknown {
  if (
    candidate.runtimeSecretDeliveryStage === undefined ||
    candidate.runtimeSecretDeliveryStage === null
  )
    throw new TypeError("WFP candidate has no recorded runtime-secret stage");
  return candidate.runtimeSecretDeliveryStage;
}

function parseCandidateCleanupGateway(value: unknown): {
  readonly compensatedTargetScriptName: string | null;
  readonly sharedGatewayRevision: number | null;
} {
  if (value === null)
    return Object.freeze({ compensatedTargetScriptName: null, sharedGatewayRevision: null });
  const gateway = parseSharedGatewayReceipt(value);
  // A compensation that closed the route (a first activation) leaves no active route to name;
  // the cleanup then books none, as for a removal (Sebmer Prod, 2026-09-27).
  return Object.freeze(
    gateway.active
      ? {
          compensatedTargetScriptName: gateway.targetScriptName,
          sharedGatewayRevision: gateway.revision,
        }
      : { compensatedTargetScriptName: null, sharedGatewayRevision: null },
  );
}

function parseCandidateGateway(
  value: unknown,
  command: Command,
  context: ProductWorkflowContext,
  receipt: Pick<ProductWorkflowWfpReceipt, "productDeploymentId" | "scriptName">,
) {
  const gateway = parseGatewayReceipt(value, command, context);
  if (
    gateway.targetDeploymentId !== receipt.productDeploymentId ||
    gateway.targetScriptName !== receipt.scriptName ||
    !gateway.active
  )
    throw new TypeError("Candidate gateway target is invalid");
  return Object.freeze({ ...gateway, observedAt: new Date(gateway.observedAt) });
}

/**
 * Domain management probes a separate host under the environment's wildcard so an exact legacy
 * route cannot answer; derive that same host (Dev finalization refused it on 2026-09-23).
 */
async function sharedGatewayProbeUrl(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly deploymentId: string;
  readonly publicOrigin: URL;
  readonly healthCheckPath: string;
}): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        [
          "shared-gateway-preflight",
          input.projectId,
          input.environmentId,
          input.operationId,
          input.deploymentId,
        ].join("\0"),
      ),
    ),
  );
  const label = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
  const zone = input.publicOrigin.hostname.split(".").slice(1).join(".");
  return new URL(input.healthCheckPath, `https://gateway-probe-${label}.${zone}/`).href;
}

function parsePublicDomainProbe(value: unknown, expectedUrl: string) {
  if (value === null) return null;
  const probe = exactRecord(
    value,
    ["observedAt", "status", "url"],
    "Cloudflare project domain probe",
  );
  if (
    probe["url"] !== expectedUrl ||
    !Number.isInteger(probe["status"]) ||
    Number(probe["status"]) < 100 ||
    Number(probe["status"]) > 599 ||
    !canonicalTimestamp(probe["observedAt"])
  ) {
    throw new TypeError("Cloudflare project domain result is invalid");
  }
  return Object.freeze({
    url: expectedUrl,
    status: Number(probe["status"]),
    observedAt: String(probe["observedAt"]),
  });
}

async function createWfpOperationResult(
  command: Extract<Command, { eventType: "DeploymentRequestedV1" }>,
  context: ProductWorkflowContext,
  artifact: WfpLifecycleArtifact,
  receipt: ProductWorkflowWfpReceipt,
  deploymentUrl: string,
) {
  const intent = context.intent;
  if (
    intent.planId === null ||
    intent.deploymentId === null ||
    intent.commitSha === null ||
    intent.sourceDigest === null ||
    intent.buildPlanDigest === null ||
    intent.deploymentId !== receipt.productDeploymentId ||
    (artifact.provenance.deploymentId !== receipt.productDeploymentId &&
      context.intent.bindingRefreshSnapshot == null) ||
    artifact.provenance.artifactDigest !== receipt.artifactDigest ||
    artifact.provenance.sourceCommit !== intent.commitSha ||
    artifact.provenance.sourceDigest !== `sha256:${intent.sourceDigest.toString("hex")}` ||
    artifact.provenance.buildPlanDigest !== `sha256:${intent.buildPlanDigest.toString("hex")}`
  ) {
    throw new DeploymentPersistenceConflictError("WFP lifecycle provenance changed");
  }
  const artifactDigest = receipt.artifactDigest.slice("sha256:".length);
  return createOperationDeploymentResult({
    operationId: command.operationId,
    deploymentId: intent.deploymentId,
    planId: intent.planId,
    artifactSha256: artifactDigest,
    url: deploymentUrl,
  });
}

async function sha256Bytes(value: unknown): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  );
}

async function cleanupResourceIdentity(
  resourceKind: "source-archive" | "build-artifact",
  locator: string,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`cloudflare\0${resourceKind}\0${locator}`),
    ),
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function toRpcReceipt(value: ProductWorkflowWfpReceipt) {
  return { ...value, deployedAt: new Date(value.deployedAt) };
}

function parseGatewayReceipt(
  value: unknown,
  command: Command,
  context: Pick<ProductWorkflowContext, "environmentName" | "handle">,
) {
  const gateway = parseSharedGatewayReceipt(value);
  if (
    gateway.organizationId !== command.organizationId ||
    gateway.projectId !== command.projectId ||
    gateway.environmentId !== command.environmentId ||
    gateway.environmentName !== context.environmentName ||
    gateway.handle !== context.handle ||
    !gateway.active
  )
    throw new TypeError("Shared gateway receipt scope is invalid");
  return Object.freeze({ ...gateway, observedAt: gateway.observedAt.toISOString() });
}

function requireDeletionEnvironments(
  context: Pick<ProductWorkflowContext, "deletionEnvironments">,
): readonly ProductWorkflowDeletionEnvironment[] {
  const environments = context.deletionEnvironments;
  if (
    environments.length === 0 ||
    environments.at(-1)?.environmentName !== "prod" ||
    environments.slice(0, -1).some((environment) => environment.environmentName !== "dev") ||
    new Set(environments.map((environment) => environment.environmentId)).size !==
      environments.length
  )
    throw new Error("Deletion Workflow requires unique dev environments followed by prod");
  return environments;
}

function parseManifest(body: Uint8Array): { sbomDigest: string } {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new TypeError("Artifact manifest is invalid");
  }
  const manifest = requireRecord(value, "artifact manifest");
  const sbom = requireRecord(manifest["sbom"], "artifact SBOM");
  if (!digest(sbom["digest"])) throw new TypeError("Artifact SBOM digest is invalid");
  return { sbomDigest: sbom["digest"] };
}

function toRpcGatewayReceipt(value: ProductWorkflowGatewayReceipt) {
  return parseSharedGatewayReceipt(value);
}

/** A deletion owns no provider-mutation claim; its running cleanup run is the gateway authority. */
function deletionAuthority(current: ProductWorkflowContext): Ulid {
  if (current.intent.cleanupRunId === null)
    throw new TypeError("Project deletion has no cleanup run");
  return current.intent.cleanupRunId;
}

async function claimProviderMutation(
  persistence: DeploymentPersistenceReaderPort,
  command: Extract<
    Command,
    {
      eventType:
        | "DeploymentRequestedV1"
        | "DeploymentRollbackRequestedV1"
        | "DeploymentPromotionRequestedV1"
        | "ProjectHandleChangeRequestedV1"
        | "ProjectDataChangeRequestedV1";
    }
  >,
  context: ProductWorkflowContext,
): Promise<Ulid> {
  const workflowId = deterministicProductCommandWorkflowId(command);
  const claimId = await providerMutationClaimId(command);
  await persistence.claimProviderMutation({
    claimId,
    organizationId: command.organizationId,
    projectId: command.projectId,
    environmentId: command.environmentId,
    operationId: command.operationId,
    eventType: command.eventType,
    eventId: command.eventId,
    logicalWorkflowId: workflowId,
    acceptedLifecycleVersion: context.projectLifecycleVersion,
  });
  return claimId;
}

/**
 * The operation's provider-mutation claim, as claimed before activation. Route compensation acts
 * under this same claim; the shared gateway refuses a route change under any other.
 */
async function providerMutationClaimId(command: Command): Promise<Ulid> {
  return deterministicUlid(
    `${deterministicProductCommandWorkflowId(command)}:provider-mutation-claim`,
  );
}

function parseProviderReconciliationHint(
  result: Readonly<Record<string, unknown>>,
  expectedArtifactDigest: string,
  expectedProductDeploymentId: Ulid,
  activationRuntimePolicy?: unknown,
): ProductProviderReconciliationHint {
  const providerPhase = result["reconciliationPhase"];
  const reason = result["reason"];
  if (
    Object.hasOwn(result, "reason") &&
    (providerPhase !== "candidate" || reason !== "candidate_bindings_outdated")
  )
    throw new TypeError("Provider reconciliation reason is invalid");
  const phase =
    providerPhase === "candidate" || providerPhase === "secrets"
      ? "wfp"
      : providerPhase === "health"
        ? "gateway"
        : providerPhase;
  if (phase !== undefined && phase !== "database" && phase !== "gateway" && phase !== "wfp") {
    throw new TypeError("Provider reconciliation phase is invalid");
  }
  const currentProviderTag = result["currentProviderTag"];
  const currentProductDeploymentId = result["currentProductDeploymentId"];
  if (
    currentProviderTag !== undefined &&
    currentProviderTag !== null &&
    typeof currentProviderTag !== "string"
  ) {
    throw new TypeError("Provider reconciliation tag is invalid");
  }
  if (
    currentProductDeploymentId !== undefined &&
    currentProductDeploymentId !== null &&
    (!isUlid(currentProductDeploymentId) ||
      currentProductDeploymentId !== expectedProductDeploymentId)
  ) {
    throw new TypeError("Provider reconciliation deployment is invalid");
  }
  const runtimePolicy =
    activationRuntimePolicy === undefined || (phase !== "gateway" && phase !== "wfp")
      ? null
      : parseScheduledRuntimePolicy(activationRuntimePolicy);
  return Object.freeze({
    phase: phase ?? "runtime-secrets",
    expectedArtifactDigest,
    currentProviderTag: currentProviderTag ?? null,
    currentProductDeploymentId: currentProductDeploymentId ?? null,
    ...(reason === undefined ? {} : { reason: "candidate_bindings_outdated" as const }),
    ...(runtimePolicy === null ? {} : { activationRuntimePolicy: runtimePolicy }),
  });
}

function emptyCompositionProviderHint(
  phase: ProductProviderReconciliationHint["phase"],
): ProductProviderReconciliationHint {
  return Object.freeze({
    phase,
    expectedArtifactDigest: null,
    currentProviderTag: null,
    currentProductDeploymentId: null,
  });
}

export async function initialProviderReconciliationEvidence(
  workflowId: string,
  hint: ProductProviderReconciliationHint,
) {
  if (
    Object.hasOwn(hint, "reason") &&
    (hint.phase !== "wfp" || hint.reason !== "candidate_bindings_outdated")
  )
    throw new TypeError("Provider reconciliation reason is invalid");
  const normalized = Object.freeze({
    phase: hint.phase,
    ...(hint.expectedArtifactDigest === null
      ? {}
      : { expectedArtifactDigest: hint.expectedArtifactDigest as `sha256:${string}` }),
    ...(hint.currentProviderTag === null ? {} : { currentProviderTag: hint.currentProviderTag }),
    ...(hint.currentProductDeploymentId === null
      ? {}
      : { currentProductDeploymentId: parseUlid(hint.currentProductDeploymentId) }),
    ...(hint.activationRuntimePolicy === undefined
      ? {}
      : { activationRuntimePolicy: hint.activationRuntimePolicy }),
  });
  const evidenceDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalized))),
  );
  return Object.freeze({
    observationId: await deterministicUlid(`${workflowId}:initial-provider-observation`),
    evidenceDigest,
    hint: normalized,
  });
}

function completionOutcome(value: "completed" | "replayed") {
  return value === "replayed" ? ("duplicate" as const) : ("applied" as const);
}

function digestHex(value: Buffer | null, label: string): string {
  if (value === null || value.byteLength !== 32)
    throw new Error(`Product Workflow has no ${label}`);
  return value.toString("hex");
}

function digestBytes(value: string): Uint8Array {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!hex64(hex)) throw new TypeError("Digest is invalid");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
}

function hex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function positiveSafe(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (!positiveSafe(number)) throw new TypeError(`${label} is invalid`);
  return number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Product Workflow has no ${label}`);
  return value;
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Deployment URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Deployment URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new TypeError("Deployment URL is invalid");
  }
  return url.origin;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} is invalid`);
  return value as Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string) {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} is invalid`);
  }
  return record;
}
