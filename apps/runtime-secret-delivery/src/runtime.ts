import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import { projectEnvironmentAddress } from "@ohmyhost/project-handles";
import {
  createRuntimeSecretManifest,
  type RuntimeSecretManifest,
} from "@ohmyhost/provider-cloudflare";
import type {
  ClaimRuntimeSecretDeliveryResult,
  EncryptedRuntimeSecret,
  PendingRuntimeSecretDelivery,
  RuntimeSecretDeliveryTrigger,
  RuntimeSecretDeliveryState,
  EnvironmentSecretMetadata,
} from "@ohmyhost/database";
import {
  AI_KEY_NAME,
  BROWSER_KEY_NAME,
  createBrowserKey,
  createAiKey,
  parseSharedGatewayReceipt,
  type SharedGatewayReceipt,
  type EncryptedEnvironmentSecret,
  type EntropySource,
  type Ulid,
} from "@ohmyhost/platform";

const LEASE_MILLISECONDS = 2 * 60 * 1_000;
const SCHEDULED_BATCH_SIZE = 10;
const PROVIDER_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

interface RuntimeSecretScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly runtimeProvider?: "wfp";
}

interface WfpRuntimeSecretScope extends RuntimeSecretScope {
  readonly environmentName: "dev" | "prod";
  readonly handle: string;
}

interface RuntimeSecretOperationScope extends RuntimeSecretScope {
  readonly operationId: Ulid;
}

interface WfpRuntimeSecretOperationScope extends WfpRuntimeSecretScope {
  readonly operationId: Ulid;
}

interface ActiveWfpRuntimeSecretTarget {
  readonly deployment: ReturnType<typeof requireCandidateReceipt>;
  readonly candidateReceiptId: Ulid;
  readonly operationId: Ulid;
  readonly gateway: SharedGatewayReceipt;
}

export interface RuntimeSecretPersistence {
  claim(
    input: RuntimeSecretScope &
      Readonly<{
        operationId?: Ulid;
        force?: boolean;
        trigger: RuntimeSecretDeliveryTrigger;
        runtimeProvider: "wfp";
        leaseId: Ulid;
        claimedAt: string;
        leaseMilliseconds: number;
      }>,
  ): Promise<ClaimRuntimeSecretDeliveryResult>;
  fail(
    input: RuntimeSecretScope &
      Readonly<{
        leaseId: Ulid;
        generation: number;
        releaseSequence: number;
        code: string;
        failedAt: string;
      }>,
  ): Promise<"failed">;
  /** Gives the lease back without a failure code: the candidate was rejected, the secrets were not. */
  release(
    input: RuntimeSecretScope &
      Readonly<{
        leaseId: Ulid;
        generation: number;
        releaseSequence: number;
        releasedAt: string;
      }>,
  ): Promise<"released">;
  readPending(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly PendingRuntimeSecretDelivery[]>;
  /** Stamps a pending scope as tried, so a scope that fails before its claim cannot hold the head of the batch. */
  recordPendingAttempt(input: RuntimeSecretScope & { readonly now: string }): Promise<void>;
  readState(input: RuntimeSecretScope): Promise<RuntimeSecretDeliveryState | undefined>;
  stageWfp?(
    input: RuntimeSecretScope & RuntimeSecretStagePersistenceInput,
  ): Promise<Readonly<{ outcome: "staged" | "existing"; stageReceiptId: Ulid }>>;
  activateWfp?(input: RuntimeSecretScope & RuntimeSecretActivationPersistenceInput): Promise<
    Readonly<{
      outcome: "activated" | "existing";
      activationReceiptId: Ulid;
      activatedAt: string;
    }>
  >;
  compensateWfp?(input: RuntimeSecretScope & RuntimeSecretCompensationPersistenceInput): Promise<
    Readonly<{
      outcome: "compensated" | "existing";
      compensationReceiptId: Ulid;
      compensatedAt: string;
    }>
  >;
  readActiveWfpTarget?(input: RuntimeSecretScope): Promise<unknown | undefined>;
  readRecordedWfpStage?(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentName: "dev" | "prod";
    readonly candidateReceiptId: Ulid;
  }): Promise<unknown | null>;
  installPlatform?(
    input: RuntimeSecretOperationScope &
      Readonly<{ claimId: Ulid; name: "DATABASE_URL" }> &
      EncryptedEnvironmentSecret &
      Readonly<{ writtenAt: string }>,
  ): Promise<EnvironmentSecretMetadata>;
  ensurePlatform?(
    input: RuntimeSecretOperationScope &
      Readonly<{ claimId: Ulid; name: "BETTER_AUTH_SECRET" }> &
      EncryptedEnvironmentSecret &
      Readonly<{ writtenAt: string }>,
  ): Promise<EnvironmentSecretMetadata>;
  ensureMailGateway?(
    input: RuntimeSecretOperationScope &
      Readonly<{ claimId: Ulid; name: "OHMYHOST_MAIL_KEY" }> &
      EncryptedEnvironmentSecret &
      Readonly<{ writtenAt: string }>,
  ): Promise<EnvironmentSecretMetadata>;
  readPromotionMailGatewaySource?(
    input: RuntimeSecretOperationScope & Readonly<{ claimId: Ulid }>,
  ): Promise<({ readonly environmentId: Ulid } & EncryptedEnvironmentSecret) | null>;
  ensureStorageGateway?(
    input: RuntimeSecretOperationScope &
      Readonly<{ claimId: Ulid; name: "OHMYHOST_STORAGE_KEY" }> &
      EncryptedEnvironmentSecret &
      Readonly<{ writtenAt: string }>,
  ): Promise<EnvironmentSecretMetadata>;
  ensureAiGateway?(
    input: RuntimeSecretOperationScope &
      Readonly<{ claimId: Ulid; name: typeof AI_KEY_NAME }> &
      EncryptedEnvironmentSecret &
      Readonly<{ writtenAt: string }>,
  ): Promise<EnvironmentSecretMetadata>;
  ensureBrowserGateway?(
    input: RuntimeSecretOperationScope &
      Readonly<{ claimId: Ulid; name: typeof BROWSER_KEY_NAME }> &
      EncryptedEnvironmentSecret &
      Readonly<{ writtenAt: string }>,
  ): Promise<EnvironmentSecretMetadata>;
}

interface RuntimeSecretStagePersistenceInput {
  readonly stageReceiptId: Ulid;
  readonly operationId: Ulid;
  readonly productDeploymentId: Ulid;
  readonly candidateReceiptId: Ulid;
  readonly leaseId: Ulid;
  readonly generation: number;
  readonly releaseSequence: number;
  readonly trigger: RuntimeSecretDeliveryTrigger;
  readonly providerTag: string;
  readonly appliedSecretNames: readonly string[];
  readonly manifestSha256: Uint8Array;
  readonly manifestSecretCount: number;
  readonly stagedAt: string;
}

interface RuntimeSecretActivationPersistenceInput {
  readonly activationReceiptId: Ulid;
  readonly stageReceiptId: Ulid;
  readonly operationId: Ulid;
  readonly productDeploymentId: Ulid;
  readonly candidateReceiptId: Ulid;
  readonly candidateScriptName: string;
  readonly candidateProviderTag: string;
  readonly candidateArtifactDigest: Uint8Array;
  readonly gateway: SharedGatewayReceipt;
  readonly activatedAt: string;
}

interface RuntimeSecretCompensationPersistenceInput {
  readonly compensationReceiptId: Ulid;
  readonly stageReceiptId: Ulid;
  readonly candidateReceiptId: Ulid;
  readonly failureCode: string;
  readonly compensatedAt: string;
}

interface RuntimeSecretCipher {
  encrypt?(
    secret: RuntimeSecretScope & Readonly<{ name: string; value: string }>,
  ): Promise<EncryptedEnvironmentSecret>;
  openEnvironmentSecret(
    secret: RuntimeSecretScope & Readonly<{ name: string }> & EncryptedEnvironmentSecret,
  ): Promise<string>;
}

interface RuntimeSecretWfpBinding {
  stageVerifiedArtifact(input: unknown): Promise<unknown>;
  prepareExistingCandidate(input: unknown): Promise<unknown>;
  activateCandidate(input: unknown): Promise<unknown>;
  compensateGatewayActivation(input: unknown): Promise<unknown>;
  compensateActivation(input: unknown): Promise<unknown>;
  removeCandidate(input: unknown): Promise<unknown>;
  observeActivation(input: unknown): Promise<unknown>;
  syncRuntimeSecrets(input: unknown): Promise<unknown>;
}

interface DeliveryDependencies {
  readonly persistence: RuntimeSecretPersistence;
  readonly cipher: RuntimeSecretCipher;
  readonly wfp: RuntimeSecretWfpBinding;
  readonly ids: { next(): string };
  readonly clock: { now(): Date };
  readonly entropy: EntropySource;
}

export function createRuntimeSecretDelivery(dependencies: DeliveryDependencies) {
  validateDependencies(dependencies);

  return Object.freeze({
    stageCandidate: (value: unknown) => stageCandidate(value, dependencies),
    stagePromotionCandidate: (value: unknown) => stagePromotionCandidate(value, dependencies),
    recordStagedCandidate: (value: unknown) => recordStagedCandidate(value, dependencies),
    prepareExistingCandidate: (value: unknown) => prepareExistingCandidate(value, dependencies),
    activateCandidate: (value: unknown) => activateCandidate(value, dependencies),
    recordActivatedCandidate: (value: unknown) => recordActivatedCandidate(value, dependencies),
    observeActivation: (value: unknown) => observeActivation(value, dependencies),
    compensateActivation: (value: unknown) =>
      compensateCandidate(value, "compensateActivation", dependencies),
    compensateGatewayActivation: (value: unknown) =>
      compensateCandidate(value, "compensateGatewayActivation", dependencies),
    removeCandidate: (value: unknown) =>
      compensateCandidate(value, "removeCandidate", dependencies),
    removePersistedCandidate: (value: unknown) => removePersistedCandidate(value, dependencies),
    syncPendingOne: () => syncPendingOne(dependencies),
    reconcileRuntimeSecrets: (value: unknown) => reconcileWfpRuntimeSecrets(value, dependencies),
    installPlatformSecret: (value: unknown) => installPlatformSecret(value, dependencies),
    ensureCustomerAuthSecret: (value: unknown) => ensureCustomerAuthSecret(value, dependencies),
    ensureMailGatewayKey: (value: unknown) => ensureMailGatewayKey(value, dependencies),
    ensureStorageGatewayKey: (value: unknown) => ensureStorageGatewayKey(value, dependencies),
    ensureAiGatewayKey: (value: unknown) => ensureAiGatewayKey(value, dependencies),
    ensureBrowserGatewayKey: (value: unknown) => ensureBrowserGatewayKey(value, dependencies),
  });
}

async function prepareExistingCandidate(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, [
    "artifact",
    "artifactSourceDeploymentId",
    "candidate",
    "databaseRegistration?",
    "scope",
    "storageBucketName?",
    "storageDataEnvironmentId?",
  ]);
  const scope = parseWfpOperationScope(input["scope"]);
  const artifactSourceDeploymentId = parseUlid(input["artifactSourceDeploymentId"]);
  const storageDataEnvironmentId =
    input["storageDataEnvironmentId"] === undefined
      ? undefined
      : parseUlid(input["storageDataEnvironmentId"]);
  const candidateRecord = requireRecord(input["candidate"]);
  const candidate = requireCandidateReceipt(
    candidateRecord,
    scope,
    candidateRecord["productDeploymentId"],
  );
  const claim = await acquireClaim(dependencies, scope, "rollback");
  if (claim.outcome !== "claimed") {
    return Object.freeze({
      status: "reconciliation_required" as const,
      runtimeSecretDelivery: redactedClaim(claim),
    });
  }
  try {
    const manifest = await decryptManifest(dependencies.cipher, scope, claim.secrets);
    const result = requireRecord(
      await dependencies.wfp.prepareExistingCandidate({
        artifactSourceDeploymentId,
        organizationId: scope.organizationId,
        scope: wfpScope(scope),
        candidate,
        artifact: input["artifact"],
        runtimeSecretManifest: manifest,
        ...(input["databaseRegistration"] === undefined
          ? {}
          : { databaseRegistration: input["databaseRegistration"] }),
        ...(input["storageBucketName"] === undefined
          ? {}
          : { storageBucketName: input["storageBucketName"] }),
        ...(storageDataEnvironmentId === undefined ? {} : { storageDataEnvironmentId }),
      }),
    );
    if (result["status"] === "reconciliation_required") {
      await fail(dependencies, scope, claim);
      return redactedProviderReconciliation(result, claim);
    }
    if (
      result["status"] !== "prepared" ||
      result["runtimeSecretManifestDigest"] !== manifest.digest
    ) {
      throw new TypeError("WFP existing candidate preparation result is invalid");
    }
    requireExactRecord(result, [
      "activationRuntimePolicy",
      "candidate",
      "runtimeSecretManifestDigest",
      "status",
    ]);
    const prepared = requireCandidateReceipt(
      result["candidate"],
      scope,
      candidate.productDeploymentId,
    );
    if (prepared.bindingSetDigest !== candidate.bindingSetDigest)
      throw new TypeError("WFP existing candidate preparation result is invalid");
    const activationRuntimePolicy = canonicalRuntimePolicy(result["activationRuntimePolicy"]);
    const runtimeSecretDeliveryStage = createPendingStage(
      dependencies,
      scope,
      claim,
      manifest,
      prepared,
    );
    return Object.freeze({
      status: result["status"],
      candidate: prepared,
      activationRuntimePolicy,
      runtimeSecretManifestDigest: manifest.digest,
      runtimeSecretDelivery: Object.freeze({
        generation: claim.generation,
        secretCount: manifest.secrets.length,
        manifestDigest: manifest.digest,
      }),
      runtimeSecretDeliveryStage,
    });
  } catch (error) {
    await fail(dependencies, scope, claim);
    throw redactDeliveryError(error);
  }
}

async function stageCandidate(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  return stageCandidateWithTrigger(value, "deploy", dependencies);
}

async function stagePromotionCandidate(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  return stageCandidateWithTrigger(value, "promotion", dependencies);
}

async function stageCandidateWithTrigger(
  value: unknown,
  trigger: "deploy" | "promotion",
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, [
    "artifact",
    "artifactReuse?",
    "databaseRegistration?",
    "databaseOriginHost?",
    "deploymentId",
    "knownDeployments",
    "previousGateway?",
    "scope",
    "storageBucketName?",
    "storageDataEnvironmentId?",
  ]);
  if (
    (trigger === "promotion" && input["artifactReuse"] !== "promotion") ||
    (trigger !== "promotion" &&
      input["artifactReuse"] !== undefined &&
      input["artifactReuse"] !== "binding-refresh")
  ) {
    throw new TypeError("Runtime secret delivery input is invalid");
  }
  const scope = parseWfpOperationScope(input["scope"]);
  const storageDataEnvironmentId =
    input["storageDataEnvironmentId"] === undefined
      ? undefined
      : parseUlid(input["storageDataEnvironmentId"]);
  const deploymentId = parseUlid(input["deploymentId"]);
  const claim = await acquireClaim(dependencies, scope, trigger);
  if (claim.outcome !== "claimed") {
    return Object.freeze({
      status: "reconciliation_required" as const,
      runtimeSecretDelivery: redactedClaim(claim),
    });
  }
  try {
    const manifest = await decryptManifest(dependencies.cipher, scope, claim.secrets);
    const result = requireRecord(
      await dependencies.wfp.stageVerifiedArtifact({
        organizationId: scope.organizationId,
        scope: wfpScope(scope),
        deploymentId,
        artifact: input["artifact"],
        knownDeployments: input["knownDeployments"],
        ...(input["previousGateway"] === undefined
          ? {}
          : { previousGateway: input["previousGateway"] }),
        runtimeSecretManifest: manifest,
        ...(input["databaseRegistration"] === undefined
          ? {}
          : { databaseRegistration: input["databaseRegistration"] }),
        ...(input["databaseOriginHost"] === undefined
          ? {}
          : { databaseOriginHost: input["databaseOriginHost"] }),
        ...(input["storageBucketName"] === undefined
          ? {}
          : { storageBucketName: input["storageBucketName"] }),
        ...(storageDataEnvironmentId === undefined ? {} : { storageDataEnvironmentId }),
        ...(input["artifactReuse"] === undefined ? {} : { artifactReuse: input["artifactReuse"] }),
      }),
    );
    if (result["status"] === "reconciliation_required") {
      await fail(dependencies, scope, claim);
      return redactedProviderReconciliation(result, claim);
    }
    if (result["status"] === "rejected") {
      const rejection = redactedCandidateRejection(result);
      await release(dependencies, scope, claim);
      return rejection;
    }
    if (
      (result["status"] !== "staged" && result["status"] !== "replayed") ||
      result["runtimeSecretManifestDigest"] !== manifest.digest
    ) {
      throw new TypeError("WFP candidate stage result is invalid");
    }
    requireExactRecord(result, [
      "activationRuntimePolicy",
      "candidate",
      "deploymentUrl",
      "priorGateway",
      "runtimeSecretManifestDigest",
      "status",
    ]);
    const candidate = requireCandidateReceipt(result["candidate"], scope, deploymentId);
    if (result["priorGateway"] !== null) {
      requireGatewayScope(result["priorGateway"], scope);
    }
    const activationRuntimePolicy = canonicalRuntimePolicy(result["activationRuntimePolicy"]);
    const runtimeSecretDeliveryStage = createPendingStage(
      dependencies,
      scope,
      claim,
      manifest,
      candidate,
    );
    return Object.freeze({
      status: result["status"],
      candidate,
      priorGateway: result["priorGateway"] ?? null,
      activationRuntimePolicy,
      deploymentUrl: requirePublicDeploymentUrl(result["deploymentUrl"], scope),
      runtimeSecretManifestDigest: manifest.digest,
      runtimeSecretDelivery: Object.freeze({
        generation: claim.generation,
        secretCount: manifest.secrets.length,
        manifestDigest: manifest.digest,
      }),
      runtimeSecretDeliveryStage,
    });
  } catch (error) {
    await fail(dependencies, scope, claim);
    throw redactDeliveryError(error);
  }
}

function createPendingStage(
  dependencies: DeliveryDependencies,
  scope: WfpRuntimeSecretOperationScope,
  claim: Extract<ClaimRuntimeSecretDeliveryResult, { outcome: "claimed" }>,
  manifest: RuntimeSecretManifest,
  candidate: ReturnType<typeof requireCandidateReceipt>,
  providerTag = candidate.providerTag,
) {
  return Object.freeze({
    stageReceiptId: parseUlid(dependencies.ids.next()),
    operationId: scope.operationId,
    productDeploymentId: candidate.productDeploymentId,
    leaseId: claim.leaseId,
    generation: claim.generation,
    releaseSequence: claim.releaseSequence,
    trigger: claim.trigger,
    providerTag,
    appliedSecretNames: Object.freeze(manifest.secrets.map((secret) => secret.name)),
    manifestDigest: manifest.digest,
    manifestSecretCount: manifest.secrets.length,
    stagedAt: canonicalNow(dependencies.clock),
  });
}

async function recordStagedCandidate(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, [
    "candidate",
    "candidateReceiptId",
    "runtimeSecretDeliveryStage",
    "scope",
  ]);
  const scope = parseWfpOperationScope(input["scope"]);
  const candidateRecord = requireRecord(input["candidate"]);
  const candidate = requireCandidateReceipt(
    candidateRecord,
    scope,
    candidateRecord["productDeploymentId"],
  );
  const candidateReceiptId = parseUlid(input["candidateReceiptId"]);
  const stage = parsePendingStage(input["runtimeSecretDeliveryStage"], scope, candidate);
  try {
    const recorded = await persistStage(dependencies, scope, stage, candidateReceiptId);
    return Object.freeze({
      status: recorded.outcome === "staged" ? ("recorded" as const) : ("replayed" as const),
      runtimeSecretDeliveryStage: recorded,
    });
  } catch (error) {
    throw redactDeliveryError(error);
  }
}

async function persistStage(
  dependencies: DeliveryDependencies,
  scope: WfpRuntimeSecretOperationScope,
  stage: ReturnType<typeof parsePendingStage> | ReturnType<typeof createPendingStage>,
  candidateReceiptId: Ulid,
) {
  const persistence = requireWfpPersistence(dependencies.persistence);
  const result = await persistence.stageWfp({
    ...runtimeScope(scope),
    stageReceiptId: stage.stageReceiptId,
    operationId: scope.operationId,
    productDeploymentId: stage.productDeploymentId,
    candidateReceiptId,
    leaseId: stage.leaseId,
    generation: stage.generation,
    releaseSequence: stage.releaseSequence,
    trigger: stage.trigger,
    providerTag: stage.providerTag,
    appliedSecretNames: stage.appliedSecretNames,
    manifestSha256: digestBytes(stage.manifestDigest),
    manifestSecretCount: stage.manifestSecretCount,
    stagedAt: stage.stagedAt,
  });
  return Object.freeze({
    ...stage,
    stageReceiptId: parseUlid(result.stageReceiptId),
    candidateReceiptId,
    outcome: result.outcome,
  });
}

function parsePendingStage(
  value: unknown,
  scope: WfpRuntimeSecretOperationScope,
  candidate: ReturnType<typeof requireCandidateReceipt>,
) {
  const stage = requireExactRecord(value, [
    "appliedSecretNames",
    "generation",
    "leaseId",
    "manifestDigest",
    "manifestSecretCount",
    "operationId",
    "productDeploymentId",
    "providerTag",
    "releaseSequence",
    "stageReceiptId",
    "stagedAt",
    "trigger",
  ]);
  if (
    stage["operationId"] !== scope.operationId ||
    stage["productDeploymentId"] !== candidate.productDeploymentId ||
    stage["providerTag"] !== candidate.providerTag ||
    !Number.isSafeInteger(stage["generation"]) ||
    Number(stage["generation"]) < 0 ||
    !Number.isSafeInteger(stage["releaseSequence"]) ||
    Number(stage["releaseSequence"]) < 1 ||
    (stage["trigger"] !== "deploy" &&
      stage["trigger"] !== "rollback" &&
      stage["trigger"] !== "promotion") ||
    !Array.isArray(stage["appliedSecretNames"]) ||
    stage["appliedSecretNames"].some(
      (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name),
    ) ||
    typeof stage["manifestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(stage["manifestDigest"]) ||
    stage["manifestSecretCount"] !== stage["appliedSecretNames"].length ||
    typeof stage["stagedAt"] !== "string" ||
    new Date(stage["stagedAt"]).toISOString() !== stage["stagedAt"]
  ) {
    throw new TypeError("Runtime secret delivery stage is invalid");
  }
  return Object.freeze({
    stageReceiptId: parseUlid(stage["stageReceiptId"]),
    operationId: scope.operationId,
    productDeploymentId: candidate.productDeploymentId,
    leaseId: parseUlid(stage["leaseId"]),
    generation: Number(stage["generation"]),
    releaseSequence: Number(stage["releaseSequence"]),
    trigger: stage["trigger"] as "deploy" | "rollback" | "promotion",
    providerTag: candidate.providerTag,
    appliedSecretNames: Object.freeze([...stage["appliedSecretNames"]] as string[]),
    manifestDigest: stage["manifestDigest"] as `sha256:${string}`,
    manifestSecretCount: Number(stage["manifestSecretCount"]),
    stagedAt: stage["stagedAt"],
  });
}

async function activateCandidate(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, [
    "candidate",
    "claimId",
    "previousGateway?",
    "runtimePolicy",
    "runtimeSecretDeliveryStage",
    "scope",
  ]);
  const scope = parseWfpOperationScope(input["scope"]);
  const runtimePolicy = canonicalRuntimePolicy(input["runtimePolicy"]);
  const candidate = requireCandidateReceipt(
    input["candidate"],
    scope,
    requireRecord(input["candidate"])["productDeploymentId"],
  );
  const stage = parseRecordedStage(input["runtimeSecretDeliveryStage"], scope, candidate);
  if (input["previousGateway"] !== undefined) {
    requireGatewayScope(input["previousGateway"], scope);
  }
  try {
    const result = await dependencies.wfp.activateCandidate({
      organizationId: scope.organizationId,
      operationId: scope.operationId,
      claimId: parseUlid(input["claimId"]),
      candidateReceiptId: stage.candidateReceiptId,
      scope: wfpScope(scope),
      candidate,
      runtimePolicy,
      ...(input["previousGateway"] === undefined
        ? {}
        : { previousGateway: input["previousGateway"] }),
    });
    assertCredentialFree(result);
    return Object.freeze({
      ...(canonicalCandidateActionResult("activateCandidate", result, scope, candidate) as object),
      runtimeSecretDeliveryStage: stage,
    });
  } catch (error) {
    throw redactDeliveryError(error);
  }
}

async function recordActivatedCandidate(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, [
    "candidate",
    "gateway",
    "runtimeSecretDeliveryStage",
    "scope",
  ]);
  const scope = parseWfpOperationScope(input["scope"]);
  const candidateRecord = requireRecord(input["candidate"]);
  const candidate = requireCandidateReceipt(
    candidateRecord,
    scope,
    candidateRecord["productDeploymentId"],
  );
  const stage = parseRecordedStage(input["runtimeSecretDeliveryStage"], scope, candidate);
  requireGatewayTargetsCandidate(input["gateway"], scope, candidate);
  const gateway = parseSharedGatewayReceipt(input["gateway"]);
  if (
    gateway.operationId !== scope.operationId ||
    gateway.candidateReceiptId !== stage.candidateReceiptId
  )
    throw new TypeError("Runtime secret delivery gateway target is invalid");
  const persistence = requireWfpPersistence(dependencies.persistence);
  try {
    const result = await persistence.activateWfp({
      ...runtimeScope(scope),
      activationReceiptId: stage.stageReceiptId,
      stageReceiptId: stage.stageReceiptId,
      operationId: scope.operationId,
      productDeploymentId: candidate.productDeploymentId,
      candidateReceiptId: stage.candidateReceiptId,
      candidateScriptName: String(candidate["scriptName"]),
      candidateProviderTag: candidate.providerTag,
      candidateArtifactDigest: digestBytes(String(candidate["artifactDigest"])),
      gateway,
      activatedAt: canonicalNow(dependencies.clock),
    });
    return Object.freeze({
      status: result.outcome,
      activationReceiptId: parseUlid(result.activationReceiptId),
      activatedAt: canonicalTimestamp(result.activatedAt),
      runtimeSecretDeliveryStage: stage,
    });
  } catch (error) {
    throw redactDeliveryError(error);
  }
}

async function removePersistedCandidate(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, ["candidate", "candidateReceiptId", "claimId", "scope"]);
  const scope = parseWfpOperationScope(input["scope"]);
  const candidateRecord = requireRecord(input["candidate"]);
  const candidate = requireCandidateReceipt(
    candidateRecord,
    scope,
    candidateRecord["productDeploymentId"],
  );
  const candidateReceiptId = parseUlid(input["candidateReceiptId"]);
  const readStage = dependencies.persistence.readRecordedWfpStage;
  if (typeof readStage !== "function") {
    throw new TypeError("Runtime secret delivery WFP persistence is unavailable");
  }
  const stored = await readStage({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentName: scope.environmentName,
    candidateReceiptId,
  });
  let stage: ReturnType<typeof parseRecordedStage> | null = null;
  if (stored !== null) {
    const storedRecord = requireRecord(stored);
    const originalScope = Object.freeze({
      ...scope,
      operationId: parseUlid(storedRecord["operationId"]),
    });
    stage = parseRecordedStage(storedRecord, originalScope, candidate);
    if (stage.candidateReceiptId !== candidateReceiptId) {
      throw new TypeError("Runtime secret delivery stage is invalid");
    }
  }
  let removal: unknown;
  try {
    removal = await dependencies.wfp.removeCandidate({
      organizationId: scope.organizationId,
      operationId: scope.operationId,
      claimId: parseUlid(input["claimId"]),
      candidateReceiptId,
      scope: wfpScope(scope),
      candidate,
    });
    assertCredentialFree(removal);
  } catch (error) {
    throw redactDeliveryError(error);
  }
  const canonicalRemoval = requireRecord(
    canonicalCandidateActionResult("removeCandidate", removal, scope, candidate),
  );
  if (stage === null) {
    return Object.freeze({
      ...canonicalRemoval,
      gateway: null,
      runtimeSecretDeliveryCompensation: null,
    });
  }
  const persistence = requireWfpPersistence(dependencies.persistence);
  const compensation = await persistence.compensateWfp({
    ...runtimeScope(scope),
    compensationReceiptId: stage.stageReceiptId,
    stageReceiptId: stage.stageReceiptId,
    candidateReceiptId: stage.candidateReceiptId,
    failureCode: "CANDIDATE_REMOVED",
    compensatedAt: canonicalNow(dependencies.clock),
  });
  return Object.freeze({
    ...canonicalRemoval,
    gateway: null,
    runtimeSecretDeliveryCompensation: Object.freeze({
      outcome: compensation.outcome,
      compensationReceiptId: parseUlid(compensation.compensationReceiptId),
      compensatedAt: canonicalTimestamp(compensation.compensatedAt),
    }),
  });
}

async function compensateCandidate(
  value: unknown,
  action: "compensateActivation" | "compensateGatewayActivation" | "removeCandidate",
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  // A route change acts under the operation's provider-mutation claim (claimId). Removing the
  // candidate acts under its cleanup claim: claimId alone for a removal, and cleanupClaimId beside
  // the route claim when compensation does both.
  const input = requireExactRecord(
    value,
    action === "removeCandidate"
      ? ["candidate", "claimId", "runtimeSecretDeliveryStage", "scope"]
      : [
          "candidate",
          "claimId",
          ...(action === "compensateActivation" ? ["cleanupClaimId"] : []),
          "expectedGateway",
          "previousGateway?",
          "runtimeSecretDeliveryStage",
          "scope",
        ],
  );
  const scope = parseWfpOperationScope(input["scope"]);
  const candidateRecord = requireRecord(input["candidate"]);
  const candidate = requireCandidateReceipt(
    candidateRecord,
    scope,
    candidateRecord["productDeploymentId"],
  );
  const stage = parseRecordedStage(input["runtimeSecretDeliveryStage"], scope, candidate);
  if (input["expectedGateway"] !== undefined) {
    requireGatewayTargetsCandidate(input["expectedGateway"], scope, candidate);
  }
  if (input["previousGateway"] !== undefined) requireGatewayScope(input["previousGateway"], scope);
  try {
    const providerResult = await dependencies.wfp[action]({
      organizationId: scope.organizationId,
      operationId: scope.operationId,
      claimId: parseUlid(input["claimId"]),
      ...(action === "compensateActivation"
        ? { cleanupClaimId: parseUlid(input["cleanupClaimId"]) }
        : {}),
      ...(action === "removeCandidate" ? { candidateReceiptId: stage.candidateReceiptId } : {}),
      scope: wfpScope(scope),
      candidate,
      ...(input["expectedGateway"] === undefined
        ? {}
        : { expectedGateway: input["expectedGateway"] }),
      ...(input["previousGateway"] === undefined
        ? {}
        : { previousGateway: input["previousGateway"] }),
    });
    assertCredentialFree(providerResult);
    const result = canonicalCandidateActionResult(action, providerResult, scope, candidate);
    if (requireRecord(result)["status"] === "reconciliation_required") {
      return Object.freeze({ ...(result as object), runtimeSecretDeliveryStage: stage });
    }
    const persistence = requireWfpPersistence(dependencies.persistence);
    const persistenceResult = await persistence.compensateWfp({
      ...runtimeScope(scope),
      compensationReceiptId: stage.stageReceiptId,
      stageReceiptId: stage.stageReceiptId,
      candidateReceiptId: stage.candidateReceiptId,
      failureCode: action === "removeCandidate" ? "CANDIDATE_REMOVED" : "ACTIVATION_COMPENSATED",
      compensatedAt: canonicalNow(dependencies.clock),
    });
    return Object.freeze({
      ...(result as object),
      runtimeSecretDeliveryStage: stage,
      runtimeSecretDeliveryCompensation: Object.freeze({
        outcome: persistenceResult.outcome,
        compensationReceiptId: parseUlid(persistenceResult.compensationReceiptId),
        compensatedAt: canonicalTimestamp(persistenceResult.compensatedAt),
      }),
    });
  } catch (error) {
    throw redactDeliveryError(error);
  }
}

function parseRecordedStage(
  value: unknown,
  scope: WfpRuntimeSecretOperationScope,
  candidate: ReturnType<typeof requireCandidateReceipt>,
) {
  const record = requireExactRecord(value, [
    "appliedSecretNames",
    "candidateReceiptId",
    "generation",
    "leaseId",
    "manifestDigest",
    "manifestSecretCount",
    "operationId",
    "outcome",
    "productDeploymentId",
    "providerTag",
    "releaseSequence",
    "stageReceiptId",
    "stagedAt",
    "trigger",
  ]);
  if (record["outcome"] !== "staged" && record["outcome"] !== "existing") {
    throw new TypeError("Runtime secret delivery stage is invalid");
  }
  return Object.freeze({
    ...parsePendingStage(
      Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "candidateReceiptId" && key !== "outcome"),
      ),
      scope,
      candidate,
    ),
    candidateReceiptId: parseUlid(record["candidateReceiptId"]),
    outcome: record["outcome"],
  });
}

async function observeActivation(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, [
    "candidate",
    "runtimePolicy",
    "runtimeSecretDeliveryStage",
    "scope",
  ]);
  const scope = parseWfpOperationScope(input["scope"]);
  const runtimePolicy = canonicalRuntimePolicy(input["runtimePolicy"]);
  const candidateRecord = requireRecord(input["candidate"]);
  const candidate = requireCandidateReceipt(
    candidateRecord,
    scope,
    candidateRecord["productDeploymentId"],
  );
  const stage = parseRecordedStage(input["runtimeSecretDeliveryStage"], scope, candidate);
  let observed: Readonly<Record<string, unknown>>;
  try {
    observed = requireRecord(
      await dependencies.wfp.observeActivation({
        organizationId: scope.organizationId,
        scope: wfpScope(scope),
        candidate,
        runtimePolicy,
      }),
    );
    assertCredentialFree(observed);
  } catch (error) {
    throw redactDeliveryError(error);
  }
  if (observed["status"] === "reconciliation_required") {
    return Object.freeze({
      ...(safeCredentialFreeReconciliation(
        observed,
        candidate,
        scope,
        "activateCandidate",
      ) as object),
      runtimeSecretDeliveryStage: stage,
    });
  }
  if (observed["status"] === "absent") {
    requireExactRecord(observed, ["status"]);
    return Object.freeze({ status: "absent" as const, runtimeSecretDeliveryStage: stage });
  }
  requireExactRecord(observed, ["candidate", "deploymentUrl", "gateway", "health", "status"]);
  if (observed["status"] !== "activated" && observed["status"] !== "unhealthy") {
    throw new TypeError("Runtime secret delivery activation observation is invalid");
  }
  const health = requireExactRecord(observed["health"], ["status", "path", "excerpt", "truncated"]);
  if (
    !Number.isInteger(health["status"]) ||
    Number(health["status"]) < 100 ||
    Number(health["status"]) > 599 ||
    (observed["status"] === "activated" && health["status"] !== 200) ||
    (observed["status"] === "unhealthy" &&
      Number(health["status"]) >= 200 &&
      Number(health["status"]) < 300)
  ) {
    throw new TypeError("Runtime secret delivery activation observation is invalid");
  }
  const observedCandidate = requireCandidateReceipt(
    observed["candidate"],
    scope,
    candidate.productDeploymentId,
  );
  if (
    observedCandidate.providerTag !== candidate.providerTag ||
    observedCandidate["artifactDigest"] !== candidate["artifactDigest"] ||
    observedCandidate["scriptName"] !== candidate["scriptName"] ||
    observedCandidate.bindingSetDigest !== candidate.bindingSetDigest
  )
    throw new TypeError("Runtime secret delivery activation observation is invalid");
  requireGatewayTargetsCandidate(observed["gateway"], scope, candidate);
  return Object.freeze({
    status: observed["status"] as "activated" | "unhealthy",
    candidate: observedCandidate,
    gateway: observed["gateway"],
    deploymentUrl: requirePublicDeploymentUrl(observed["deploymentUrl"], scope),
    health: Object.freeze({
      status: Number(health["status"]),
      path: String(health["path"]),
      excerpt: health["excerpt"] === null ? null : String(health["excerpt"]),
      truncated: health["truncated"] === true,
    }),
    runtimeSecretDeliveryStage: stage,
  });
}

async function reconcileWfpRuntimeSecrets(
  value: unknown,
  dependencies: DeliveryDependencies,
): Promise<unknown> {
  const input = requireExactRecord(value, ["expectedDeployment", "scope"]);
  const scope = parseWfpOperationScope(input["scope"]);
  const expected = requireCandidateReceipt(
    input["expectedDeployment"],
    scope,
    requireRecord(input["expectedDeployment"])["productDeploymentId"],
  );
  const active = await readActiveWfpTarget(dependencies, scope);
  if (
    active === undefined ||
    active.deployment.providerTag !== expected.providerTag ||
    active.deployment.productDeploymentId !== expected.productDeploymentId ||
    active.deployment["artifactDigest"] !== expected["artifactDigest"] ||
    active.deployment.bindingSetDigest !== expected.bindingSetDigest
  ) {
    throw new TypeError("Runtime secret delivery active candidate is invalid");
  }
  return syncRuntimeSecretScope(scope, true, dependencies, active);
}

async function ensureCustomerAuthSecret(value: unknown, dependencies: DeliveryDependencies) {
  if (
    typeof dependencies.cipher.encrypt !== "function" ||
    typeof dependencies.persistence.ensurePlatform !== "function"
  ) {
    throw new TypeError("Customer auth secret installation is unavailable");
  }
  const input = parseGeneratedPlatformSecret(value);
  const bytes = new Uint8Array(32);
  dependencies.entropy.fill(bytes);
  const generated = base64Url(bytes);
  bytes.fill(0);
  const encrypted = await dependencies.cipher.encrypt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: "BETTER_AUTH_SECRET",
    value: generated,
  });
  return dependencies.persistence.ensurePlatform({
    ...input,
    name: "BETTER_AUTH_SECRET",
    ...encrypted,
    writtenAt: canonicalNow(dependencies.clock),
  });
}

async function ensureMailGatewayKey(value: unknown, dependencies: DeliveryDependencies) {
  if (
    typeof dependencies.cipher.encrypt !== "function" ||
    typeof dependencies.persistence.ensureMailGateway !== "function"
  ) {
    throw new TypeError("Mail gateway key installation is unavailable");
  }
  const input = parseGeneratedPlatformSecret(value);
  const bytes = new Uint8Array(32);
  dependencies.entropy.fill(bytes);
  const generated = base64Url(bytes);
  bytes.fill(0);
  const encrypted = await dependencies.cipher.encrypt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: "OHMYHOST_MAIL_KEY",
    value: generated,
  });
  return dependencies.persistence.ensureMailGateway({
    ...input,
    name: "OHMYHOST_MAIL_KEY",
    ...encrypted,
    writtenAt: canonicalNow(dependencies.clock),
  });
}

async function ensureStorageGatewayKey(value: unknown, dependencies: DeliveryDependencies) {
  if (
    typeof dependencies.cipher.encrypt !== "function" ||
    typeof dependencies.persistence.ensureStorageGateway !== "function"
  ) {
    throw new TypeError("Storage gateway key installation is unavailable");
  }
  const input = parseGeneratedPlatformSecret(value);
  const bytes = new Uint8Array(32);
  dependencies.entropy.fill(bytes);
  const generated = base64Url(bytes);
  bytes.fill(0);
  const encrypted = await dependencies.cipher.encrypt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: "OHMYHOST_STORAGE_KEY",
    value: generated,
  });
  return dependencies.persistence.ensureStorageGateway({
    ...input,
    name: "OHMYHOST_STORAGE_KEY",
    ...encrypted,
    writtenAt: canonicalNow(dependencies.clock),
  });
}

async function ensureAiGatewayKey(value: unknown, dependencies: DeliveryDependencies) {
  if (
    typeof dependencies.cipher.encrypt !== "function" ||
    typeof dependencies.persistence.ensureAiGateway !== "function"
  ) {
    throw new TypeError("AI gateway key installation is unavailable");
  }
  const input = parseGeneratedPlatformSecret(value);
  const bytes = new Uint8Array(32);
  dependencies.entropy.fill(bytes);
  // The whole key is sealed, so the stored digest is the SHA-256 the AI gateway computes over the same string.
  const generated = createAiKey(input.projectId, base64Url(bytes));
  bytes.fill(0);
  const encrypted = await dependencies.cipher.encrypt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: AI_KEY_NAME,
    value: generated,
  });
  return dependencies.persistence.ensureAiGateway({
    ...input,
    name: AI_KEY_NAME,
    ...encrypted,
    writtenAt: canonicalNow(dependencies.clock),
  });
}

async function ensureBrowserGatewayKey(value: unknown, dependencies: DeliveryDependencies) {
  if (
    typeof dependencies.cipher.encrypt !== "function" ||
    typeof dependencies.persistence.ensureBrowserGateway !== "function"
  ) {
    throw new TypeError("Browser gateway key installation is unavailable");
  }
  const input = parseGeneratedPlatformSecret(value);
  const bytes = new Uint8Array(32);
  dependencies.entropy.fill(bytes);
  // The whole key is sealed, so the stored digest is the SHA-256 the Browser gateway computes over the same string.
  const generated = createBrowserKey(input.projectId, base64Url(bytes));
  bytes.fill(0);
  const encrypted = await dependencies.cipher.encrypt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: BROWSER_KEY_NAME,
    value: generated,
  });
  return dependencies.persistence.ensureBrowserGateway({
    ...input,
    name: BROWSER_KEY_NAME,
    ...encrypted,
    writtenAt: canonicalNow(dependencies.clock),
  });
}

async function installPlatformSecret(value: unknown, dependencies: DeliveryDependencies) {
  if (
    typeof dependencies.cipher.encrypt !== "function" ||
    typeof dependencies.persistence.installPlatform !== "function"
  ) {
    throw new TypeError("Platform secret installation is unavailable");
  }
  const input = parsePlatformSecret(value);
  const encrypted = await dependencies.cipher.encrypt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: input.name,
    value: input.value,
  });
  return dependencies.persistence.installPlatform({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    operationId: input.operationId,
    claimId: input.claimId,
    name: input.name,
    ...encrypted,
    writtenAt: canonicalNow(dependencies.clock),
  });
}

function parsePlatformSecret(value: unknown) {
  const record = requireRecord(value);
  if (
    Object.keys(record).sort().join(",") !==
      "claimId,environmentId,name,operationId,organizationId,projectId,value" ||
    record["name"] !== "DATABASE_URL" ||
    typeof record["value"] !== "string"
  ) {
    throw new TypeError("Platform secret input is invalid");
  }
  return Object.freeze({
    organizationId: parseUlid(String(record["organizationId"])),
    projectId: parseUlid(String(record["projectId"])),
    environmentId: parseUlid(String(record["environmentId"])),
    operationId: parseUlid(String(record["operationId"])),
    claimId: parseUlid(String(record["claimId"])),
    name: "DATABASE_URL" as const,
    value: record["value"],
  });
}

function parseGeneratedPlatformSecret(value: unknown): RuntimeSecretOperationScope & {
  readonly claimId: Ulid;
} {
  const record = requireRecord(value);
  if (
    Object.keys(record).sort().join(",") !==
    "claimId,environmentId,operationId,organizationId,projectId"
  ) {
    throw new TypeError("Generated platform secret input is invalid");
  }
  return Object.freeze({
    organizationId: parseUlid(record["organizationId"]),
    projectId: parseUlid(record["projectId"]),
    environmentId: parseUlid(record["environmentId"]),
    operationId: parseUlid(record["operationId"]),
    claimId: parseUlid(record["claimId"]),
  });
}

function base64Url(value: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index] ?? 0;
    const second = value[index + 1];
    const third = value[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) output += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) output += alphabet[third & 63];
  }
  if (output.length !== 43) throw new TypeError("Generated platform secret is invalid");
  return output;
}

async function syncPendingOne(dependencies: DeliveryDependencies): Promise<unknown> {
  const now = canonicalNow(dependencies.clock);
  const pending = await dependencies.persistence.readPending({ now, limit: SCHEDULED_BATCH_SIZE });
  if (pending.length === 0) return Object.freeze({ status: "idle" as const });
  let synchronized = 0;
  let deferred = 0;
  let failed = 0;
  for (const pendingScope of pending) {
    // One unreadable or failing scope is counted and skipped past; it cannot abort the rows behind it.
    let scope: WfpRuntimeSecretScope | undefined;
    try {
      scope = parsePersistedWfpScope(pendingScope);
      const active =
        scope.runtimeProvider === "wfp"
          ? await readActiveWfpTarget(dependencies, scope)
          : undefined;
      const result = requireRecord(
        await syncRuntimeSecretScope(scope, false, dependencies, active),
      );
      if (result["status"] === "synchronized") synchronized += 1;
      else deferred += 1;
    } catch {
      failed += 1;
    }
    // The stamp follows the attempt in its own guard: its failure is logged and never changes the attempt's outcome.
    if (scope !== undefined) {
      try {
        await dependencies.persistence.recordPendingAttempt({ ...runtimeScope(scope), now });
      } catch (error) {
        console.error(
          "runtime_secret_attempt_unrecorded",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
  }
  return Object.freeze({
    status: "processed" as const,
    attempted: pending.length,
    synchronized,
    deferred,
    failed,
  });
}

async function syncRuntimeSecretScope(
  scope: WfpRuntimeSecretScope,
  force: boolean,
  dependencies: DeliveryDependencies,
  expectedWfpTarget?: ActiveWfpRuntimeSecretTarget,
): Promise<unknown> {
  const runtimeProvider =
    scope.runtimeProvider ??
    (await dependencies.persistence.readState(runtimeScope(scope)))?.runtimeProvider;
  if (runtimeProvider === undefined || expectedWfpTarget === undefined) {
    return Object.freeze({ status: "pending" as const, reason: "runtime_not_deployed" });
  }
  const deliveryClaim = await acquireClaim(dependencies, scope, "reconcile", force);
  if (deliveryClaim.outcome === "current") return Object.freeze({ status: "idle" as const });
  if (deliveryClaim.outcome === "busy") {
    return Object.freeze({ status: "pending" as const, retryAt: deliveryClaim.retryAt });
  }
  if (
    deliveryClaim.providerTag === undefined ||
    !PROVIDER_TAG_PATTERN.test(deliveryClaim.providerTag)
  ) {
    await fail(dependencies, scope, deliveryClaim);
    return Object.freeze({ status: "pending" as const, reason: "runtime_not_deployed" });
  }
  const expectedWfpDeployment = expectedWfpTarget.deployment;
  try {
    const manifest = await decryptManifest(dependencies.cipher, scope, deliveryClaim.secrets);
    const applied = await dependencies.persistence.readState(runtimeScope(scope));
    let appliedProviderTag = expectedWfpDeployment.providerTag;
    if (!appliedWfpManifestIsExact(applied, manifest, appliedProviderTag)) {
      const result = requireRecord(
        await dependencies.wfp.syncRuntimeSecrets({
          organizationId: scope.organizationId,
          scope: wfpScope(scope),
          expectedDeployment: expectedWfpDeployment,
          runtimeSecretManifest: manifest,
        }),
      );
      if (result["status"] === "reconciliation_required") {
        await fail(dependencies, scope, deliveryClaim);
        return Object.freeze({ status: "pending" as const, reason: "provider_uncertain" });
      }
      if (result["status"] !== "synchronized") {
        throw new TypeError("WFP runtime-secret synchronization result is invalid");
      }
      const receipt = requireRecord(result["receipt"]);
      if (
        receipt["manifestDigest"] !== manifest.digest ||
        !Array.isArray(receipt["secretNames"]) ||
        receipt["secretNames"].join(",") !==
          manifest.secrets.map((secret) => secret.name).join(",") ||
        typeof receipt["providerTag"] !== "string" ||
        !PROVIDER_TAG_PATTERN.test(receipt["providerTag"])
      ) {
        throw new TypeError("WFP runtime-secret synchronization receipt is invalid");
      }
      appliedProviderTag = receipt["providerTag"];
    }
    const completion = await completeWfpOrConfirmApplied(
      dependencies,
      scope,
      deliveryClaim,
      manifest,
      expectedWfpTarget,
      appliedProviderTag,
    );
    return Object.freeze({
      status: "synchronized" as const,
      completion,
      generation: deliveryClaim.generation,
      secretCount: manifest.secrets.length,
      manifestDigest: manifest.digest,
    });
  } catch (error) {
    await fail(dependencies, scope, deliveryClaim);
    throw redactDeliveryError(error);
  }
}

function appliedWfpManifestIsExact(
  state: RuntimeSecretDeliveryState | undefined,
  manifest: RuntimeSecretManifest,
  providerTag: string,
): boolean {
  return (
    state?.runtimeProvider === "wfp" &&
    state.providerTag === providerTag &&
    state.manifestSha256 !== undefined &&
    hex(state.manifestSha256) === manifest.digest.slice("sha256:".length) &&
    state.manifestSecretCount === manifest.secrets.length &&
    state.appliedSecretNames.join(",") === manifest.secrets.map((secret) => secret.name).join(",")
  );
}

async function completeWfpOrConfirmApplied(
  dependencies: DeliveryDependencies,
  scope: WfpRuntimeSecretScope,
  claim: Extract<ClaimRuntimeSecretDeliveryResult, { outcome: "claimed" }>,
  manifest: RuntimeSecretManifest,
  target: ActiveWfpRuntimeSecretTarget,
  providerTag: string,
): Promise<"completed" | "replayed"> {
  try {
    const operationScope = Object.freeze({ ...scope, operationId: target.operationId });
    const stage = createPendingStage(
      dependencies,
      operationScope,
      claim,
      manifest,
      target.deployment,
      providerTag,
    );
    const recorded = await persistStage(
      dependencies,
      operationScope,
      stage,
      target.candidateReceiptId,
    );
    const persistence = requireWfpPersistence(dependencies.persistence);
    const activated = await persistence.activateWfp({
      ...runtimeScope(scope),
      activationReceiptId: recorded.stageReceiptId,
      stageReceiptId: recorded.stageReceiptId,
      operationId: target.operationId,
      productDeploymentId: target.deployment.productDeploymentId,
      candidateReceiptId: target.candidateReceiptId,
      candidateScriptName: String(target.deployment["scriptName"]),
      candidateProviderTag: providerTag,
      candidateArtifactDigest: digestBytes(String(target.deployment["artifactDigest"])),
      gateway: target.gateway,
      activatedAt: canonicalNow(dependencies.clock),
    });
    return recorded.outcome === "existing" || activated.outcome === "existing"
      ? "replayed"
      : "completed";
  } catch (error) {
    const state = await dependencies.persistence.readState(runtimeScope(scope));
    if (
      state?.appliedGeneration === claim.generation &&
      state.appliedReleaseSequence === claim.releaseSequence &&
      state.providerTag === providerTag &&
      state.manifestSecretCount === manifest.secrets.length &&
      state.appliedSecretNames.join(",") ===
        manifest.secrets.map((secret) => secret.name).join(",") &&
      state.manifestSha256 !== undefined &&
      hex(state.manifestSha256) === manifest.digest.slice("sha256:".length)
    ) {
      return "replayed";
    }
    throw error;
  }
}

async function acquireClaim(
  dependencies: DeliveryDependencies,
  scope: RuntimeSecretScope & Partial<Pick<RuntimeSecretOperationScope, "operationId">>,
  trigger: RuntimeSecretDeliveryTrigger,
  force = false,
) {
  const leaseId = parseUlid(dependencies.ids.next());
  const claimedAt = canonicalNow(dependencies.clock);
  return dependencies.persistence.claim({
    ...runtimeScope(scope),
    ...(trigger === "reconcile" || scope.operationId === undefined
      ? {}
      : { operationId: scope.operationId }),
    trigger,
    runtimeProvider: "wfp",
    ...(force ? { force: true } : {}),
    leaseId,
    claimedAt,
    leaseMilliseconds: LEASE_MILLISECONDS,
  });
}

function parsePersistedWfpScope(value: unknown): WfpRuntimeSecretScope {
  const record = requireRecord(value);
  return Object.freeze({
    organizationId: parseUlid(record["organizationId"]),
    projectId: parseUlid(record["projectId"]),
    environmentId: parseUlid(record["environmentId"]),
    environmentName: parseEnvironmentName(record["environmentName"]),
    handle: parseHandle(record["handle"]),
    ...(record["runtimeProvider"] === undefined
      ? {}
      : { runtimeProvider: parseRuntimeProvider(record["runtimeProvider"]) }),
  });
}

async function decryptManifest(
  cipher: RuntimeSecretCipher,
  scope: RuntimeSecretScope,
  encrypted: readonly EncryptedRuntimeSecret[],
): Promise<RuntimeSecretManifest> {
  const secrets = [];
  for (const secret of encrypted) {
    // The stored digest of a user secret is keyed and never leaves Core; the manifest digest that WFP verifies per
    // value is the plaintext SHA-256, so an unchanged secret keeps its manifest digest across this change.
    const value = await cipher.openEnvironmentSecret({ ...runtimeScope(scope), ...secret });
    secrets.push({
      name: secret.name,
      value,
      revision: secret.revision,
      valueSha256:
        `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))}` as const,
    });
  }
  return createRuntimeSecretManifest(secrets);
}

async function release(
  dependencies: DeliveryDependencies,
  scope: RuntimeSecretScope,
  claim: Extract<ClaimRuntimeSecretDeliveryResult, { outcome: "claimed" }>,
): Promise<void> {
  await dependencies.persistence.release({
    ...runtimeScope(scope),
    leaseId: claim.leaseId,
    generation: claim.generation,
    releaseSequence: claim.releaseSequence,
    releasedAt: canonicalNow(dependencies.clock),
  });
}

/** The provider's rejection carries only its status and numeric code; nothing else leaves here. */
function redactedCandidateRejection(result: Readonly<Record<string, unknown>>) {
  const providerStatus = result["providerStatus"];
  const providerCode = result["providerCode"];
  if (
    result["reason"] !== "script_rejected" ||
    !Number.isSafeInteger(providerStatus) ||
    Number(providerStatus) < 400 ||
    Number(providerStatus) > 499 ||
    (providerCode !== null &&
      (!Number.isSafeInteger(providerCode) ||
        Number(providerCode) < 1 ||
        Number(providerCode) > 999_999))
  ) {
    throw new TypeError("WFP candidate rejection result is invalid");
  }
  return Object.freeze({
    status: "rejected" as const,
    reason: "script_rejected" as const,
    providerStatus: Number(providerStatus),
    providerCode: providerCode === null ? null : Number(providerCode),
  });
}

async function fail(
  dependencies: DeliveryDependencies,
  scope: RuntimeSecretScope,
  claim: Extract<ClaimRuntimeSecretDeliveryResult, { outcome: "claimed" }>,
): Promise<void> {
  await dependencies.persistence.fail({
    ...runtimeScope(scope),
    leaseId: claim.leaseId,
    generation: claim.generation,
    releaseSequence: claim.releaseSequence,
    code: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN",
    failedAt: canonicalNow(dependencies.clock),
  });
}

function redactedClaim(claim: ClaimRuntimeSecretDeliveryResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    outcome: claim.outcome,
    generation: claim.generation,
    ...(claim.outcome === "busy" ? { retryAt: claim.retryAt } : {}),
  });
}

function parseWfpOperationScope(value: unknown): WfpRuntimeSecretOperationScope {
  const scope = requireRecord(value);
  if (
    Object.keys(scope).sort().join(",") !==
    "environmentId,environmentName,handle,operationId,organizationId,projectId"
  ) {
    throw new TypeError("Runtime secret delivery scope is invalid");
  }
  return Object.freeze({
    organizationId: parseUlid(scope["organizationId"]),
    projectId: parseUlid(scope["projectId"]),
    environmentId: parseUlid(scope["environmentId"]),
    environmentName: parseEnvironmentName(scope["environmentName"]),
    handle: parseHandle(scope["handle"]),
    operationId: parseUlid(scope["operationId"]),
  });
}

function runtimeScope(value: RuntimeSecretScope): RuntimeSecretScope {
  return Object.freeze({
    organizationId: value.organizationId,
    projectId: value.projectId,
    environmentId: value.environmentId,
  });
}

function wfpScope(value: WfpRuntimeSecretScope) {
  return Object.freeze({
    projectId: value.projectId,
    environmentId: value.environmentId,
    environmentName: value.environmentName,
    handle: value.handle,
  });
}

function parseEnvironmentName(value: unknown): "dev" | "prod" {
  if (value !== "dev" && value !== "prod") {
    throw new TypeError("Runtime secret delivery scope is invalid");
  }
  return value;
}

function parseHandle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 59 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(value)
  ) {
    throw new TypeError("Runtime secret delivery scope is invalid");
  }
  return value;
}

function parseRuntimeProvider(value: unknown): "wfp" {
  if (value !== "wfp") {
    throw new TypeError("Runtime secret delivery scope is invalid");
  }
  return value;
}

function parseUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)) {
    throw new TypeError("Runtime secret delivery scope is invalid");
  }
  return value as Ulid;
}

function canonicalNow(clock: DeliveryDependencies["clock"]): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Runtime secret delivery clock is invalid");
  }
  return value.toISOString();
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Runtime secret delivery timestamp is invalid");
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new TypeError("Runtime secret delivery timestamp is invalid");
  return canonical;
}

function digestBytes(value: string): Uint8Array {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError("Manifest digest is invalid");
  return Uint8Array.from(value.slice(7).match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("Runtime secret digest is invalid");
  }
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateDependencies(value: DeliveryDependencies): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.persistence?.claim !== "function" ||
    typeof value.persistence.fail !== "function" ||
    typeof value.persistence.release !== "function" ||
    typeof value.persistence.readPending !== "function" ||
    typeof value.persistence.readState !== "function" ||
    typeof value.cipher?.openEnvironmentSecret !== "function" ||
    typeof value.wfp?.stageVerifiedArtifact !== "function" ||
    typeof value.wfp.prepareExistingCandidate !== "function" ||
    typeof value.wfp.activateCandidate !== "function" ||
    typeof value.wfp.compensateGatewayActivation !== "function" ||
    typeof value.wfp.compensateActivation !== "function" ||
    typeof value.wfp.removeCandidate !== "function" ||
    typeof value.wfp.observeActivation !== "function" ||
    typeof value.wfp.syncRuntimeSecrets !== "function" ||
    typeof value.ids?.next !== "function" ||
    typeof value.clock?.now !== "function" ||
    typeof value.entropy?.fill !== "function"
  ) {
    throw new TypeError("Runtime secret delivery dependencies are invalid");
  }
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Runtime secret delivery input is invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireWfpPersistence(persistence: RuntimeSecretPersistence) {
  if (
    typeof persistence.stageWfp !== "function" ||
    typeof persistence.activateWfp !== "function" ||
    typeof persistence.compensateWfp !== "function"
  ) {
    throw new TypeError("Runtime secret delivery WFP persistence is unavailable");
  }
  return Object.freeze({
    stageWfp: persistence.stageWfp,
    activateWfp: persistence.activateWfp,
    compensateWfp: persistence.compensateWfp,
  });
}

async function readActiveWfpTarget(
  dependencies: DeliveryDependencies,
  scope: WfpRuntimeSecretScope,
): Promise<ActiveWfpRuntimeSecretTarget | undefined> {
  if (typeof dependencies.persistence.readActiveWfpTarget !== "function") {
    throw new TypeError("Runtime secret delivery WFP persistence is unavailable");
  }
  const raw = await dependencies.persistence.readActiveWfpTarget(runtimeScope(scope));
  if (raw === undefined) return undefined;
  const target = requireExactRecord(raw, [
    "candidateReceiptId",
    "deployment",
    "gateway",
    "operationId",
  ]);
  const deploymentRecord = requireRecord(target["deployment"]);
  const deployment = requireCandidateReceipt(
    deploymentRecord,
    scope,
    deploymentRecord["productDeploymentId"],
  );
  const candidateReceiptId = parseUlid(target["candidateReceiptId"]);
  const operationId = parseUlid(target["operationId"]);
  const gateway = requireGatewayScope(target["gateway"], scope);
  requireGatewayTargetsCandidate(gateway, scope, deployment);
  if (gateway.candidateReceiptId !== candidateReceiptId)
    throw new TypeError("Runtime secret delivery active candidate is invalid");
  return Object.freeze({ deployment, candidateReceiptId, operationId, gateway });
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = requireRecord(value);
  const required = keys.filter((key) => !key.endsWith("?"));
  const allowed = keys.map((key) => (key.endsWith("?") ? key.slice(0, -1) : key));
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.includes(key))
  ) {
    throw new TypeError("Runtime secret delivery input is invalid");
  }
  return record;
}

function requireCandidateReceipt(
  value: unknown,
  scope: WfpRuntimeSecretScope,
  deploymentIdValue: unknown,
): Readonly<Record<string, unknown>> & {
  readonly providerTag: string;
  readonly productDeploymentId: Ulid;
  readonly bindingSetDigest?: string;
} {
  const receipt = requireRecord(value);
  const deploymentId = parseUlid(deploymentIdValue);
  const deployedAt = canonicalDate(receipt["deployedAt"]);
  const hasBindingSetDigest = Object.hasOwn(receipt, "bindingSetDigest");
  const bindingSetDigest = hasBindingSetDigest ? receipt["bindingSetDigest"] : undefined;
  if (
    Object.keys(receipt).sort().join(",") !==
      (hasBindingSetDigest
        ? "artifactDigest,bindingSetDigest,buildReused,deployedAt,environmentId,namespace,productDeploymentId,projectId,provider,providerTag,scriptName"
        : "artifactDigest,buildReused,deployedAt,environmentId,namespace,productDeploymentId,projectId,provider,providerTag,scriptName") ||
    receipt["provider"] !== "cloudflare-wfp" ||
    typeof receipt["namespace"] !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(receipt["namespace"]) ||
    receipt["scriptName"] !==
      `p-${scope.projectId.toLowerCase()}-${scope.environmentName}-${deploymentId.toLowerCase()}` ||
    receipt["projectId"] !== scope.projectId ||
    receipt["environmentId"] !== scope.environmentId ||
    receipt["productDeploymentId"] !== deploymentId ||
    typeof receipt["providerTag"] !== "string" ||
    !PROVIDER_TAG_PATTERN.test(receipt["providerTag"]) ||
    typeof receipt["artifactDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt["artifactDigest"]) ||
    (hasBindingSetDigest &&
      (typeof bindingSetDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(bindingSetDigest))) ||
    typeof receipt["buildReused"] !== "boolean"
  ) {
    throw new TypeError("Runtime secret delivery candidate receipt is invalid");
  }
  return Object.freeze({
    provider: "cloudflare-wfp" as const,
    namespace: receipt["namespace"],
    scriptName: receipt["scriptName"],
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    productDeploymentId: deploymentId,
    providerTag: receipt["providerTag"],
    artifactDigest: receipt["artifactDigest"],
    ...(typeof bindingSetDigest === "string" ? { bindingSetDigest } : {}),
    buildReused: receipt["buildReused"],
    deployedAt,
  }) as Readonly<Record<string, unknown>> & {
    readonly providerTag: string;
    readonly productDeploymentId: Ulid;
    readonly bindingSetDigest?: string;
  };
}

function canonicalDate(value: unknown): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (
    !Number.isFinite(parsed.getTime()) ||
    (typeof value === "string" && parsed.toISOString() !== value)
  ) {
    throw new TypeError("Runtime secret delivery timestamp is invalid");
  }
  return parsed;
}

function requireGatewayScope(value: unknown, scope: WfpRuntimeSecretScope): SharedGatewayReceipt {
  let gateway: SharedGatewayReceipt;
  try {
    gateway = parseSharedGatewayReceipt(value);
  } catch {
    throw new TypeError("Runtime secret delivery gateway receipt is invalid");
  }
  if (
    gateway.organizationId !== scope.organizationId ||
    gateway.projectId !== scope.projectId ||
    gateway.environmentId !== scope.environmentId ||
    gateway.environmentName !== scope.environmentName ||
    gateway.handle !== scope.handle
  )
    throw new TypeError("Runtime secret delivery gateway receipt is invalid");
  return gateway;
}

function canonicalCandidateActionResult(
  action:
    | "activateCandidate"
    | "compensateActivation"
    | "compensateGatewayActivation"
    | "removeCandidate",
  value: unknown,
  scope: WfpRuntimeSecretScope,
  candidate: ReturnType<typeof requireCandidateReceipt>,
): unknown {
  const result = requireRecord(value);
  if (result["status"] === "reconciliation_required") {
    return safeCredentialFreeReconciliation(result, candidate, scope, action);
  }
  if (action === "activateCandidate") {
    if (result["status"] !== "activated" && result["status"] !== "unhealthy") {
      throw new TypeError("Runtime secret delivery activation result is invalid");
    }
    requireExactRecord(
      result,
      result["status"] === "activated"
        ? ["candidate", "deploymentUrl", "gateway", "status"]
        : ["candidate", "deploymentUrl", "gateway", "health", "status"],
    );
    let health:
      | Readonly<{ status: number; path: string; excerpt: string | null; truncated: boolean }>
      | undefined;
    if (result["status"] === "unhealthy") {
      const exactHealth = requireExactRecord(result["health"], [
        "status",
        "path",
        "excerpt",
        "truncated",
      ]);
      if (
        !Number.isInteger(exactHealth["status"]) ||
        Number(exactHealth["status"]) < 100 ||
        Number(exactHealth["status"]) > 599 ||
        (Number(exactHealth["status"]) >= 200 && Number(exactHealth["status"]) < 300)
      ) {
        throw new TypeError("Runtime secret delivery activation result is invalid");
      }
      health = Object.freeze({
        status: Number(exactHealth["status"]),
        path: String(exactHealth["path"]),
        excerpt: exactHealth["excerpt"] === null ? null : String(exactHealth["excerpt"]),
        truncated: exactHealth["truncated"] === true,
      });
    }
    const activatedCandidate = requireCandidateReceipt(
      result["candidate"],
      scope,
      candidate.productDeploymentId,
    );
    if (activatedCandidate.bindingSetDigest !== candidate.bindingSetDigest)
      throw new TypeError("Runtime secret delivery activation result is invalid");
    requireGatewayTargetsCandidate(result["gateway"], scope, activatedCandidate);
    return Object.freeze({
      status: result["status"] as "activated" | "unhealthy",
      candidate: activatedCandidate,
      gateway: result["gateway"],
      deploymentUrl: requirePublicDeploymentUrl(result["deploymentUrl"], scope),
      ...(health === undefined ? {} : { health }),
    });
  }
  if (action === "removeCandidate") {
    requireExactRecord(result, ["outcome", "receipt", "status"]);
    if (
      result["status"] !== "removed" ||
      (result["outcome"] !== "removed" && result["outcome"] !== "not_found")
    ) {
      throw new TypeError("Runtime secret delivery candidate removal is invalid");
    }
    const absence = canonicalCandidateAbsence(result["receipt"], scope, candidate);
    return Object.freeze({
      status: "removed" as const,
      outcome: result["outcome"],
      ...absence,
      candidateAbsence: absence,
    });
  }
  requireExactRecord(result, ["candidate?", "candidateRetained?", "gateway", "status"]);
  if (result["status"] !== "compensated") {
    throw new TypeError("Runtime secret delivery compensation result is invalid");
  }
  const gateway = canonicalGatewayOrAbsence(result["gateway"], scope);
  if (action === "compensateGatewayActivation") {
    if (result["candidateRetained"] !== true || result["candidate"] !== undefined) {
      throw new TypeError("Runtime secret delivery compensation result is invalid");
    }
    return Object.freeze({ status: "compensated" as const, gateway, candidateRetained: true });
  }
  if (result["candidateRetained"] !== undefined) {
    throw new TypeError("Runtime secret delivery compensation result is invalid");
  }
  return Object.freeze({
    status: "compensated" as const,
    gateway,
    candidate: canonicalCandidateAbsence(result["candidate"], scope, candidate),
  });
}

function requireGatewayTargetsCandidate(
  value: unknown,
  scope: WfpRuntimeSecretScope,
  candidate: Readonly<Record<string, unknown>>,
): void {
  requireGatewayScope(value, scope);
  const gateway = requireRecord(value);
  if (
    gateway["active"] !== true ||
    gateway["targetDeploymentId"] !== candidate["productDeploymentId"] ||
    gateway["targetScriptName"] !== candidate["scriptName"] ||
    gateway["targetProviderTag"] !== candidate["providerTag"] ||
    gateway["targetArtifactDigest"] !== candidate["artifactDigest"]
  ) {
    throw new TypeError("Runtime secret delivery gateway target is invalid");
  }
}

function canonicalCandidateAbsence(
  value: unknown,
  scope: WfpRuntimeSecretScope,
  candidate: ReturnType<typeof requireCandidateReceipt>,
) {
  const receipt = requireRecord(value);
  if (
    Object.keys(receipt).sort().join(",") !==
      "environmentId,expectedProviderTag,namespace,observedAt,projectId,scriptName,state" ||
    receipt["state"] !== "metadata_absent" ||
    receipt["namespace"] !== candidate["namespace"] ||
    receipt["scriptName"] !== candidate["scriptName"] ||
    receipt["projectId"] !== scope.projectId ||
    receipt["environmentId"] !== scope.environmentId ||
    receipt["expectedProviderTag"] !== candidate.providerTag ||
    !(receipt["observedAt"] instanceof Date) ||
    !Number.isFinite(receipt["observedAt"].getTime())
  ) {
    throw new TypeError("Runtime secret delivery candidate absence is invalid");
  }
  return Object.freeze({
    state: "metadata_absent" as const,
    namespace: receipt["namespace"],
    scriptName: receipt["scriptName"],
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    expectedProviderTag: candidate.providerTag,
    observedAt: new Date(receipt["observedAt"].getTime()),
  });
}

function canonicalGatewayOrAbsence(value: unknown, scope: WfpRuntimeSecretScope) {
  return requireGatewayScope(value, scope);
}

function safeCredentialFreeReconciliation(
  result: Readonly<Record<string, unknown>>,
  candidate: ReturnType<typeof requireCandidateReceipt>,
  scope: WfpRuntimeSecretScope,
  action:
    | "activateCandidate"
    | "compensateActivation"
    | "compensateGatewayActivation"
    | "removeCandidate",
) {
  requireExactRecord(result, [
    "currentProductDeploymentId",
    "currentProviderTag",
    "gateway?",
    "reconciliationPhase",
    ...(action === "activateCandidate" ? ["reason?"] : []),
    "status",
  ]);
  const phase = result["reconciliationPhase"];
  const allowedPhases =
    action === "activateCandidate"
      ? ["gateway", "health", "candidate"]
      : action === "removeCandidate"
        ? ["candidate"]
        : ["gateway", "candidate"];
  if (typeof phase !== "string" || !allowedPhases.includes(phase)) {
    throw new TypeError("Runtime secret delivery reconciliation result is invalid");
  }
  const reason = result["reason"];
  if ("reason" in result && (phase !== "candidate" || reason !== "candidate_bindings_outdated")) {
    throw new TypeError("Runtime secret delivery reconciliation reason is invalid");
  }
  let gateway: Readonly<Record<string, unknown>> | null | undefined;
  if (result["gateway"] !== undefined) {
    if (result["gateway"] === null) gateway = null;
    else {
      requireGatewayTargetsCandidate(result["gateway"], scope, candidate);
      gateway = requireRecord(result["gateway"]);
    }
  }
  return Object.freeze({
    status: "reconciliation_required" as const,
    reconciliationPhase: phase,
    ...(reason === undefined ? {} : { reason: "candidate_bindings_outdated" as const }),
    currentProviderTag:
      typeof result["currentProviderTag"] === "string" &&
      PROVIDER_TAG_PATTERN.test(result["currentProviderTag"]) &&
      !result["currentProviderTag"].includes("://")
        ? result["currentProviderTag"]
        : null,
    currentProductDeploymentId:
      typeof result["currentProductDeploymentId"] === "string" &&
      /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(result["currentProductDeploymentId"])
        ? result["currentProductDeploymentId"]
        : candidate.productDeploymentId,
    ...(gateway === undefined ? {} : { gateway }),
  });
}

function requirePublicDeploymentUrl(value: unknown, scope: WfpRuntimeSecretScope): string {
  const expected = (["development", "production"] as const).map(
    (platform) => projectEnvironmentAddress({ ...scope, platform }).origin,
  );
  if (typeof value !== "string" || !expected.includes(value)) {
    throw new TypeError("Runtime secret delivery URL is invalid");
  }
  return value;
}

/**
 * A health-check path: a leading slash, then unreserved, sub-delimiter and percent characters with single slashes. The
 * check is linear; the nested quantifier it replaces backtracked exponentially on a long run followed by one bad character.
 */
function isHealthCheckPath(value: string): boolean {
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value) && !value.includes("//");
}

function canonicalRuntimePolicy(value: unknown) {
  const policy = requireExactRecord(value, ["egressAllowedOrigins", "healthCheckPath", "browser?"]);
  if (
    typeof policy["healthCheckPath"] !== "string" ||
    !isHealthCheckPath(policy["healthCheckPath"]) ||
    !Array.isArray(policy["egressAllowedOrigins"]) ||
    policy["egressAllowedOrigins"].some((origin) => !isDnsEgressOrigin(origin))
  ) {
    throw new TypeError("Runtime secret delivery runtime policy is invalid");
  }
  return Object.freeze({
    healthCheckPath: policy["healthCheckPath"],
    egressAllowedOrigins: Object.freeze([...policy["egressAllowedOrigins"]]),
    ...(Object.hasOwn(policy, "browser") ? { browser: parseBrowserPolicy(policy["browser"]) } : {}),
  });
}

function assertCredentialFree(value: unknown, path = "result"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCredentialFree(entry, `${path}[${String(index)}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    // The complete public browser policy validates its CORS credentials switch as a boolean.
    if (path === "result.gateway" && key === "browserPolicy") parseBrowserPolicy(entry);
    const browserCorsSwitch =
      path === "result.gateway.browserPolicy.cors" &&
      key === "credentials" &&
      typeof entry === "boolean";
    if (
      /(?:secret|credential|password|authorization|cookie|token|runtimeSecretManifest)/iu.test(
        key,
      ) &&
      !browserCorsSwitch
    ) {
      throw new TypeError("Runtime secret delivery credential-free result is invalid");
    }
    assertCredentialFree(entry, `${path}.${key}`);
  }
}

function redactedProviderReconciliation(
  result: Readonly<Record<string, unknown>>,
  claim: ClaimRuntimeSecretDeliveryResult,
) {
  requireExactRecord(result, [
    "currentProductDeploymentId",
    "currentProviderTag",
    "reconciliationPhase",
    "reason?",
    "status",
  ]);
  const phase = result["reconciliationPhase"];
  if (phase !== "database" && phase !== "candidate" && phase !== "secrets") {
    throw new TypeError("Runtime secret delivery reconciliation result is invalid");
  }
  const reason = result["reason"];
  if ("reason" in result && (phase !== "candidate" || reason !== "candidate_bindings_outdated")) {
    throw new TypeError("Runtime secret delivery reconciliation reason is invalid");
  }
  return Object.freeze({
    status: "reconciliation_required" as const,
    reconciliationPhase: phase,
    ...(reason === undefined ? {} : { reason: "candidate_bindings_outdated" as const }),
    currentProviderTag:
      typeof result["currentProviderTag"] === "string" &&
      PROVIDER_TAG_PATTERN.test(result["currentProviderTag"]) &&
      !result["currentProviderTag"].includes("://")
        ? result["currentProviderTag"]
        : null,
    currentProductDeploymentId:
      typeof result["currentProductDeploymentId"] === "string" &&
      /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(result["currentProductDeploymentId"])
        ? result["currentProductDeploymentId"]
        : null,
    runtimeSecretDelivery: redactedClaim(claim),
  });
}

function redactDeliveryError(error: unknown): Error {
  const unsafeCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "runtime_secret_delivery_failed";
  const code = [
    "cloudflare_contract_invalid",
    "cloudflare_deployment_conflict",
    "cloudflare_request_failed",
    "cloudflare_result_uncertain",
    "invalid_wfp_management_input",
    "runtime_secret_delivery_failed",
  ].includes(unsafeCode)
    ? unsafeCode
    : "runtime_secret_delivery_failed";
  return Object.assign(new Error("Runtime secret delivery failed"), { code });
}
