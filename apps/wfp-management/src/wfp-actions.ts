import {
  readGatewayReceipt,
  type SharedGatewayReceipt as WfpProjectGatewayReceipt,
} from "./gateway-registry.js";
import {
  parseVerifiedBuildLifecycleEvidence,
  type VerifiedArtifactBundle,
} from "@ohmyhost/build-broker";
import { normalizeCrons } from "@ohmyhost/contracts";
import { isRecordedBetterAuthVersion } from "@ohmyhost/platform";
import {
  CloudflareWfpProvider,
  type RuntimeSecretManifest,
  type WfpDeploymentReceipt,
  type WfpScope,
} from "@ohmyhost/provider-cloudflare";

import type { ProjectDatabaseRegistrationReceipt } from "@ohmyhost/project-database-runtime/registry";
import { parseWfpRuntimePolicy } from "@ohmyhost/provider-cloudflare";
import type { WfpManagementConfiguration } from "./bindings.js";
import {
  createWfpManagement,
  requireBindingRefreshSourceDeployment,
  validateDatabaseOriginHost,
  validateDatabaseRegistrationBinding,
} from "./management.js";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface WfpActionDependencies {
  readonly configuration: WfpManagementConfiguration;
  readonly readArtifact: (
    provenance: VerifiedArtifactBundle["provenance"],
  ) => Promise<VerifiedArtifactBundle>;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

type CandidateArtifactInput = Readonly<{
  organizationId: string;
  scope: WfpScope;
  deploymentId: string;
  artifactProvenance: VerifiedArtifactBundle["provenance"];
  artifactReuse?: "promotion" | "binding-refresh";
  knownDeployments: readonly WfpDeploymentReceipt[];
  previousGateway?: WfpProjectGatewayReceipt;
  runtimeSecretManifest: RuntimeSecretManifest;
  databaseRegistration?: ProjectDatabaseRegistrationReceipt;
  databaseOriginHost?: string;
  storageBucketName?: string;
  storageDataEnvironmentId?: string;
}>;

type StageCandidateEvent = Readonly<{
  action: "stage-candidate";
  input: CandidateArtifactInput;
}>;

type ActivateCandidateEvent = Readonly<{
  action: "activate-candidate";
  input: Readonly<{
    operationId: string;
    claimId: string;
    candidateReceiptId: string;
    organizationId: string;
    scope: WfpScope;
    candidate: WfpDeploymentReceipt;
    previousGateway?: WfpProjectGatewayReceipt;
    runtimePolicy: Readonly<{
      healthCheckPath: string;
      egressAllowedOrigins: readonly string[];
    }>;
  }>;
}>;

type ObserveActivationEvent = Readonly<{
  action: "observe-activation";
  input: Omit<
    ActivateCandidateEvent["input"],
    "previousGateway" | "operationId" | "claimId" | "candidateReceiptId"
  > & {
    readonly expectedGateway?: WfpProjectGatewayReceipt;
  };
}>;

type CompensateGatewayActivationEvent = Readonly<{
  action: "compensate-gateway-activation";
  input: Readonly<{
    organizationId: string;
    operationId: string;
    claimId: string;
    scope: WfpScope;
    candidate: WfpDeploymentReceipt;
    expectedGateway: WfpProjectGatewayReceipt;
    previousGateway?: WfpProjectGatewayReceipt;
  }>;
}>;

type CompensateActivationEvent = Readonly<{
  action: "compensate-activation";
  input: CompensateGatewayActivationEvent["input"] & Readonly<{ cleanupClaimId: string }>;
}>;

type PrepareExistingCandidateEvent = Readonly<{
  action: "prepare-existing-candidate";
  input: Readonly<{
    artifactSourceDeploymentId: string;
    organizationId: string;
    scope: WfpScope;
    candidate: WfpDeploymentReceipt;
    artifactProvenance: VerifiedArtifactBundle["provenance"];
    runtimeSecretManifest: RuntimeSecretManifest;
    databaseRegistration?: ProjectDatabaseRegistrationReceipt;
    storageBucketName?: string;
    storageDataEnvironmentId?: string;
  }>;
}>;

type RemoveCandidateEvent = Readonly<{
  action: "remove-candidate";
  input: Readonly<{
    organizationId: string;
    operationId: string;
    claimId: string;
    candidateReceiptId: string;
    scope: WfpScope;
    candidate: WfpDeploymentReceipt;
  }>;
}>;

type ObserveCandidateEvent = Readonly<{
  action: "observe-candidate";
  input: Pick<RemoveCandidateEvent["input"], "scope" | "candidate">;
}>;

type SyncSecretsEvent = Readonly<{
  action: "sync-secrets";
  input: Readonly<{
    scope: WfpScope;
    expectedDeployment: WfpDeploymentReceipt;
    runtimeSecretManifest: RuntimeSecretManifest;
  }>;
}>;

type FinalizeRemovalEvent = Readonly<{
  action: "finalize-removal";
  input: Readonly<{
    organizationId: string;
    operationId: string;
    claimId: string;
    scope: WfpScope;
    deploymentId: string;
    expectedGateway: WfpProjectGatewayReceipt;
  }>;
}>;

export type WfpAction =
  | StageCandidateEvent
  | ActivateCandidateEvent
  | ObserveActivationEvent
  | CompensateActivationEvent
  | CompensateGatewayActivationEvent
  | PrepareExistingCandidateEvent
  | RemoveCandidateEvent
  | ObserveCandidateEvent
  | SyncSecretsEvent
  | FinalizeRemovalEvent;

interface UnknownRecord {
  readonly [key: string]: unknown;
  readonly action?: unknown;
  readonly input?: unknown;
  readonly scope?: unknown;
  readonly deploymentId?: unknown;
  readonly artifactProvenance?: unknown;
  readonly knownDeployments?: unknown;
  readonly previousDeployment?: unknown;
  readonly previousGateway?: unknown;
  readonly candidate?: unknown;
  readonly runtimePolicy?: unknown;
  readonly sourceScope?: unknown;
  readonly sourceDeployment?: unknown;
  readonly previousTargetDeployment?: unknown;
  readonly previousTargetGateway?: unknown;
  readonly expectedDeployment?: unknown;
  readonly expectedGateway?: unknown;
  readonly runtimeSecretManifest?: unknown;
  readonly digest?: unknown;
  readonly secrets?: unknown;
  readonly name?: unknown;
  readonly value?: unknown;
  readonly revision?: unknown;
  readonly valueSha256?: unknown;
  readonly projectId?: unknown;
  readonly environmentId?: unknown;
  readonly environmentName?: unknown;
  readonly handle?: unknown;
  readonly operationId?: unknown;
  readonly buildId?: unknown;
  readonly sourceCommit?: unknown;
  readonly sourceDigest?: unknown;
  readonly buildPlanDigest?: unknown;
  readonly artifactDigest?: unknown;
  readonly bindingSetDigest?: unknown;
  readonly output?: unknown;
  readonly bucket?: unknown;
  readonly key?: unknown;
  readonly versionId?: unknown;
  readonly eTag?: unknown;
  readonly byteLength?: unknown;
  readonly sha256?: unknown;
  readonly provider?: unknown;
  readonly namespace?: unknown;
  readonly scriptName?: unknown;
  readonly providerTag?: unknown;
  readonly buildReused?: unknown;
  readonly deployedAt?: unknown;
}

/** Runs one validated action against Workers for Platforms inside this private Worker. */
export function createWfpActionRunner(dependencies: WfpActionDependencies) {
  const configuration = dependencies.configuration;
  return async (event: WfpAction): Promise<unknown> => {
    const provider = new CloudflareWfpProvider({
      accountId: configuration.accountId,
      namespace: configuration.namespace,
      apiToken: configuration.apiToken,
      fetch: dependencies.fetch,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      timeoutMilliseconds: 15_000,
    });
    const management = createWfpManagement({
      bindings: {
        WFP_ACCOUNT_ID: configuration.accountId,
        WFP_DISPATCH_NAMESPACE: configuration.namespace,
        WFP_API_TOKEN: configuration.apiToken,
        WFP_WORKERS_DEV_SUBDOMAIN: configuration.workersDevSubdomain,
        DATABASE_SERVICE_US: configuration.databaseServiceUs,
        DATABASE_SERVICE_EU: configuration.databaseServiceEu,
        ...(configuration.nativeAuthServiceUs === undefined
          ? {}
          : { NATIVE_AUTH_SERVICE_US: configuration.nativeAuthServiceUs }),
        ...(configuration.nativeAuthServiceEu === undefined
          ? {}
          : { NATIVE_AUTH_SERVICE_EU: configuration.nativeAuthServiceEu }),
        WFP_MAIL_GATEWAY_SERVICE: configuration.mailGatewayService,
        WFP_MAIL_GATEWAY_ORIGIN: configuration.mailGatewayOrigin,
        WFP_STORAGE_GATEWAY_ORIGIN: configuration.storageGatewayOrigin,
        WFP_AI_GATEWAY_ORIGIN: configuration.aiGatewayOrigin,
      },
      provider,
      gatewayRegistry: configuration.gatewayRegistry,
      nextCacheAuthority: configuration.runtimeSecretAuthority,
      ...(configuration.nativeAuthAuthority === undefined
        ? {}
        : { nativeAuthAuthority: configuration.nativeAuthAuthority }),
      fetch: dependencies.fetch,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    });
    switch (event.action) {
      case "stage-candidate": {
        const artifact = await dependencies.readArtifact(event.input.artifactProvenance);
        return management.stageVerifiedArtifact({
          organizationId: event.input.organizationId,
          scope: event.input.scope,
          deploymentId: event.input.deploymentId,
          artifact,
          ...(event.input.artifactReuse === undefined
            ? {}
            : { artifactReuse: event.input.artifactReuse }),
          knownDeployments: event.input.knownDeployments,
          ...(event.input.previousGateway === undefined
            ? {}
            : { previousGateway: event.input.previousGateway }),
          runtimeSecretManifest: event.input.runtimeSecretManifest,
          ...(event.input.databaseRegistration === undefined
            ? {}
            : { databaseRegistration: event.input.databaseRegistration }),
          ...(event.input.databaseOriginHost === undefined
            ? {}
            : { databaseOriginHost: event.input.databaseOriginHost }),
          ...(event.input.storageBucketName === undefined
            ? {}
            : { storageBucketName: event.input.storageBucketName }),
          ...(event.input.storageDataEnvironmentId === undefined
            ? {}
            : { storageDataEnvironmentId: event.input.storageDataEnvironmentId }),
        });
      }
      case "activate-candidate":
        return management.activateCandidate(event.input);
      case "observe-activation":
        return management.observeActivation(event.input);
      case "compensate-activation":
        return management.compensateActivation(event.input);
      case "compensate-gateway-activation":
        return management.compensateGatewayActivation(event.input);
      case "prepare-existing-candidate": {
        const artifact = await dependencies.readArtifact(event.input.artifactProvenance);
        return management.prepareExistingCandidate({
          artifactSourceDeploymentId: event.input.artifactSourceDeploymentId,
          organizationId: event.input.organizationId,
          scope: event.input.scope,
          candidate: event.input.candidate,
          artifact,
          runtimeSecretManifest: event.input.runtimeSecretManifest,
          ...(event.input.databaseRegistration === undefined
            ? {}
            : { databaseRegistration: event.input.databaseRegistration }),
          ...(event.input.storageBucketName === undefined
            ? {}
            : { storageBucketName: event.input.storageBucketName }),
          ...(event.input.storageDataEnvironmentId === undefined
            ? {}
            : { storageDataEnvironmentId: event.input.storageDataEnvironmentId }),
        });
      }
      case "remove-candidate":
        return management.removeCandidate(event.input);
      case "observe-candidate":
        return management.observeCandidate(event.input);
      case "sync-secrets":
        return management.syncRuntimeSecrets(event.input);
      case "finalize-removal":
        return management.finalizeRemoval(event.input);
    }
  };
}

export function parseWfpAction(value: unknown): WfpAction {
  if (!isRecord(value) || !hasExactKeys(value, ["action", "input"]) || !isRecord(value.input)) {
    throw invalidInput();
  }
  switch (value.action) {
    case "stage-candidate":
      return Object.freeze({ action: "stage-candidate", input: parsePublishInput(value.input) });
    case "activate-candidate":
      return Object.freeze({
        action: "activate-candidate",
        input: parseActivateCandidateInput(value.input),
      });
    case "observe-activation":
      return Object.freeze({
        action: "observe-activation",
        input: parseObserveActivationInput(value.input),
      });
    case "compensate-activation":
      return Object.freeze({
        action: "compensate-activation",
        input: parseCompensateActivationInput(value.input, true),
      });
    case "compensate-gateway-activation":
      return Object.freeze({
        action: "compensate-gateway-activation",
        input: parseCompensateActivationInput(value.input, false),
      });
    case "prepare-existing-candidate":
      return Object.freeze({
        action: "prepare-existing-candidate",
        input: parsePrepareExistingCandidateInput(value.input),
      });
    case "remove-candidate":
      return Object.freeze({
        action: "remove-candidate",
        input: parseRemoveCandidateInput(value.input),
      });
    case "observe-candidate":
      return Object.freeze({
        action: "observe-candidate",
        input: parseObserveCandidateInput(value.input),
      });
    case "sync-secrets":
      return Object.freeze({ action: "sync-secrets", input: parseSyncSecretsInput(value.input) });
    case "finalize-removal":
      return Object.freeze({
        action: "finalize-removal",
        input: parseFinalizeRemovalInput(value.input),
      });
    default:
      throw invalidInput();
  }
}

function parseActivateCandidateInput(value: UnknownRecord): ActivateCandidateEvent["input"] {
  const expectedKeys = [
    "organizationId",
    "operationId",
    "claimId",
    "candidateReceiptId",
    "scope",
    "candidate",
    ...(value.previousGateway === undefined ? [] : ["previousGateway"]),
    "runtimePolicy",
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !["organizationId", "operationId", "claimId", "candidateReceiptId"].every((key) =>
      ULID_PATTERN.test(String(value[key])),
    )
  )
    throw invalidInput();
  const scope = parseScope(value.scope);
  const candidate = parseReceipt(value.candidate);
  requireReceiptScope(candidate, scope);
  const previousGateway =
    value.previousGateway === undefined ? undefined : parseGatewayReceipt(value.previousGateway);
  // A rename activates the chosen address over the route that still carries the old one.
  if (previousGateway !== undefined)
    requireGatewayScope(previousGateway, { ...scope, handle: previousGateway.handle });
  return Object.freeze({
    organizationId: String(value["organizationId"]),
    operationId: String(value["operationId"]),
    claimId: String(value["claimId"]),
    candidateReceiptId: String(value["candidateReceiptId"]),
    scope,
    candidate,
    ...(previousGateway === undefined ? {} : { previousGateway }),
    runtimePolicy: parseRuntimePolicy(value.runtimePolicy),
  });
}

function parseObserveActivationInput(value: UnknownRecord): ObserveActivationEvent["input"] {
  const { expectedGateway: rawGateway, ...activation } = value;
  if (
    !hasExactKeys(activation, ["organizationId", "scope", "candidate", "runtimePolicy"]) ||
    !ULID_PATTERN.test(String(activation["organizationId"]))
  )
    throw invalidInput();
  const parsed = {
    organizationId: String(activation["organizationId"]),
    scope: parseScope(activation.scope),
    candidate: parseReceipt(activation.candidate),
    runtimePolicy: parseRuntimePolicy(activation.runtimePolicy),
  };
  requireReceiptScope(parsed.candidate, parsed.scope);
  const expectedGateway = rawGateway === undefined ? undefined : parseGatewayReceipt(rawGateway);
  if (expectedGateway !== undefined) {
    requireGatewayScope(expectedGateway, parsed.scope);
    if (
      expectedGateway.organizationId !== parsed.organizationId ||
      expectedGateway.targetDeploymentId !== parsed.candidate.productDeploymentId ||
      expectedGateway.targetScriptName !== parsed.candidate.scriptName ||
      expectedGateway.targetArtifactDigest !== parsed.candidate.artifactDigest ||
      expectedGateway.targetProviderTag !== parsed.candidate.providerTag
    )
      throw invalidInput();
  }
  return Object.freeze({
    organizationId: parsed.organizationId,
    scope: parsed.scope,
    candidate: parsed.candidate,
    runtimePolicy: parsed.runtimePolicy,
    ...(expectedGateway === undefined ? {} : { expectedGateway }),
  });
}

function parseCompensateActivationInput(
  value: UnknownRecord,
  removesCandidate: true,
): CompensateActivationEvent["input"];
function parseCompensateActivationInput(
  value: UnknownRecord,
  removesCandidate: false,
): CompensateGatewayActivationEvent["input"];
function parseCompensateActivationInput(
  value: UnknownRecord,
  removesCandidate: boolean,
): CompensateGatewayActivationEvent["input"] | CompensateActivationEvent["input"] {
  const claims = removesCandidate ? ["claimId", "cleanupClaimId"] : ["claimId"];
  const expectedKeys = [
    "organizationId",
    "operationId",
    ...claims,
    "scope",
    "candidate",
    "expectedGateway",
    ...(value.previousGateway === undefined ? [] : ["previousGateway"]),
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !["organizationId", "operationId", ...claims].every((key) =>
      ULID_PATTERN.test(String(value[key])),
    )
  )
    throw invalidInput();
  const scope = parseScope(value.scope);
  const candidate = parseReceipt(value.candidate);
  const expectedGateway = parseGatewayReceipt(value.expectedGateway);
  requireReceiptScope(candidate, scope);
  requireGatewayScope(expectedGateway, scope);
  if (expectedGateway.targetDeploymentId !== candidate.productDeploymentId) throw invalidInput();
  const previousGateway =
    value.previousGateway === undefined ? undefined : parseGatewayReceipt(value.previousGateway);
  if (previousGateway !== undefined) requireGatewayScope(previousGateway, scope);
  return Object.freeze({
    organizationId: String(value["organizationId"]),
    operationId: String(value["operationId"]),
    claimId: String(value["claimId"]),
    ...(removesCandidate ? { cleanupClaimId: String(value["cleanupClaimId"]) } : {}),
    scope,
    candidate,
    expectedGateway,
    ...(previousGateway === undefined ? {} : { previousGateway }),
  });
}

function parseObserveCandidateInput(value: UnknownRecord): ObserveCandidateEvent["input"] {
  if (!hasExactKeys(value, ["scope", "candidate"])) throw invalidInput();
  const scope = parseScope(value.scope),
    candidate = parseReceipt(value.candidate);
  requireReceiptScope(candidate, scope);
  return { scope, candidate };
}

function parseRemoveCandidateInput(value: UnknownRecord): RemoveCandidateEvent["input"] {
  if (
    !hasExactKeys(value, [
      "organizationId",
      "operationId",
      "claimId",
      "candidateReceiptId",
      "scope",
      "candidate",
    ]) ||
    !["organizationId", "operationId", "claimId", "candidateReceiptId"].every((key) =>
      ULID_PATTERN.test(String(value[key])),
    )
  )
    throw invalidInput();
  return {
    ...parseObserveCandidateInput({ scope: value.scope, candidate: value.candidate }),
    organizationId: String(value["organizationId"]),
    operationId: String(value["operationId"]),
    claimId: String(value["claimId"]),
    candidateReceiptId: String(value["candidateReceiptId"]),
  };
}

function parsePrepareExistingCandidateInput(
  value: UnknownRecord,
): PrepareExistingCandidateEvent["input"] {
  const expectedKeys = [
    "artifactSourceDeploymentId",
    "organizationId",
    "scope",
    "candidate",
    "artifactProvenance",
    "runtimeSecretManifest",
    ...(value["databaseRegistration"] === undefined ? [] : ["databaseRegistration"]),
    ...(value["storageBucketName"] === undefined ? [] : ["storageBucketName"]),
    ...(value["storageDataEnvironmentId"] === undefined ? [] : ["storageDataEnvironmentId"]),
  ];
  if (!hasExactKeys(value, expectedKeys)) throw invalidInput();
  const scope = parseScope(value.scope);
  const candidate = parseReceipt(value.candidate);
  requireReceiptScope(candidate, scope);
  const artifactProvenance = parseProvenance(value.artifactProvenance);
  if (
    !ULID_PATTERN.test(String(value["artifactSourceDeploymentId"])) ||
    artifactProvenance.deploymentId !== value["artifactSourceDeploymentId"]
  )
    throw invalidInput();
  if (artifactProvenance.scope.projectId !== scope.projectId) throw invalidInput();
  const databaseRegistration = parseDatabaseRegistration(value, artifactProvenance, scope);
  const storageBucketName = parsePromotionStorageBucketName(value, artifactProvenance, scope);
  const storageDataEnvironmentId = parseStorageDataEnvironmentId(
    value,
    artifactProvenance,
    databaseRegistration,
  );
  return Object.freeze({
    artifactSourceDeploymentId: String(value["artifactSourceDeploymentId"]),
    organizationId: String(value["organizationId"]),
    scope,
    candidate,
    artifactProvenance,
    runtimeSecretManifest: parseRuntimeSecretManifest(value.runtimeSecretManifest),
    ...(databaseRegistration === null ? {} : { databaseRegistration }),
    ...(storageBucketName === null ? {} : { storageBucketName }),
    ...(storageDataEnvironmentId === null ? {} : { storageDataEnvironmentId }),
  });
}
function requireReceiptScope(receipt: WfpDeploymentReceipt, scope: WfpScope): void {
  if (receipt.projectId !== scope.projectId || receipt.environmentId !== scope.environmentId) {
    throw invalidInput();
  }
  const expected = `p-${scope.projectId.toLowerCase()}-${scope.environmentName}-${receipt.productDeploymentId.toLowerCase()}`;
  if (receipt.scriptName !== expected) throw invalidInput();
}

function requireGatewayScope(receipt: WfpProjectGatewayReceipt, scope: WfpScope): void {
  if (
    receipt.projectId !== scope.projectId ||
    receipt.environmentId !== scope.environmentId ||
    receipt.environmentName !== scope.environmentName ||
    receipt.handle !== scope.handle
  ) {
    throw invalidInput();
  }
}

function parsePublishInput(value: UnknownRecord): CandidateArtifactInput {
  const expectedKeys = [
    "organizationId",
    "scope",
    "deploymentId",
    "artifactProvenance",
    ...(value["artifactReuse"] === undefined ? [] : ["artifactReuse"]),
    "knownDeployments",
    ...(value["previousGateway"] === undefined ? [] : ["previousGateway"]),
    "runtimeSecretManifest",
    ...(value["databaseRegistration"] === undefined ? [] : ["databaseRegistration"]),
    ...(value["databaseOriginHost"] === undefined ? [] : ["databaseOriginHost"]),
    ...(value["storageBucketName"] === undefined ? [] : ["storageBucketName"]),
    ...(value["storageDataEnvironmentId"] === undefined ? [] : ["storageDataEnvironmentId"]),
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !ULID_PATTERN.test(String(value.deploymentId)) ||
    !Array.isArray(value.knownDeployments)
  ) {
    throw invalidInput();
  }
  const scope = parseScope(value.scope);
  const artifactProvenance = parseProvenance(value.artifactProvenance);
  const artifactReuse = value["artifactReuse"];
  if (
    artifactReuse !== undefined &&
    artifactReuse !== "promotion" &&
    artifactReuse !== "binding-refresh"
  )
    throw invalidInput();
  if (
    artifactProvenance.scope.projectId !== scope.projectId ||
    (artifactReuse === "promotion" &&
      (scope.environmentName !== "prod" ||
        artifactProvenance.scope.environmentId === scope.environmentId ||
        artifactProvenance.deploymentId === String(value.deploymentId))) ||
    (artifactReuse === "binding-refresh" &&
      artifactProvenance.scope.environmentId !== scope.environmentId &&
      scope.environmentName !== "prod") ||
    (artifactReuse === undefined &&
      (artifactProvenance.scope.environmentId !== scope.environmentId ||
        artifactProvenance.deploymentId !== String(value.deploymentId)))
  ) {
    throw invalidInput();
  }
  const knownDeployments = Object.freeze(value.knownDeployments.map(parseReceipt));
  for (const deployment of knownDeployments) requireReceiptScope(deployment, scope);
  const previousGateway =
    value.previousGateway === undefined ? undefined : parseGatewayReceipt(value.previousGateway);
  if (previousGateway !== undefined) requireGatewayScope(previousGateway, scope);
  if (artifactReuse === "binding-refresh") {
    try {
      requireBindingRefreshSourceDeployment({
        organizationId: String(value["organizationId"]),
        scope,
        deploymentId: String(value.deploymentId),
        artifactProvenance,
        knownDeployments,
        ...(previousGateway === undefined ? {} : { previousGateway }),
      });
    } catch {
      throw invalidInput();
    }
  }
  const databaseRegistration = parseDatabaseRegistration(value, artifactProvenance, scope);
  let databaseOriginHost: string | null;
  try {
    databaseOriginHost = validateDatabaseOriginHost(
      artifactProvenance.database,
      value["databaseOriginHost"],
      databaseRegistration,
    );
  } catch {
    throw invalidInput();
  }
  const storageBucketName =
    artifactReuse !== undefined
      ? parsePromotionStorageBucketName(value, artifactProvenance, scope)
      : parseStorageBucketName(value, artifactProvenance);
  const storageDataEnvironmentId = parseStorageDataEnvironmentId(
    value,
    artifactProvenance,
    databaseRegistration,
  );
  return Object.freeze({
    organizationId: String(value["organizationId"]),
    scope,
    deploymentId: String(value.deploymentId),
    artifactProvenance,
    ...(artifactReuse === undefined ? {} : { artifactReuse }),
    knownDeployments,
    ...(previousGateway === undefined ? {} : { previousGateway }),
    runtimeSecretManifest: parseRuntimeSecretManifest(value.runtimeSecretManifest),
    ...(databaseRegistration === null ? {} : { databaseRegistration }),
    ...(databaseOriginHost === null ? {} : { databaseOriginHost }),
    ...(storageBucketName === null ? {} : { storageBucketName }),
    ...(storageDataEnvironmentId === null ? {} : { storageDataEnvironmentId }),
  });
}
function parseStorageDataEnvironmentId(
  input: UnknownRecord,
  provenance: VerifiedArtifactBundle["provenance"],
  database: ProjectDatabaseRegistrationReceipt | null,
): string | null {
  const value = input["storageDataEnvironmentId"];
  if (!provenance.storage.enabled) {
    if (value !== undefined) throw invalidInput();
    return null;
  }
  if (
    typeof value !== "string" ||
    !ULID_PATTERN.test(value) ||
    (database !== null && database.physicalEnvironmentId !== value)
  )
    throw invalidInput();
  return value;
}

function parseDatabaseRegistration(
  input: UnknownRecord,
  provenance: VerifiedArtifactBundle["provenance"],
  scope: WfpScope,
): ProjectDatabaseRegistrationReceipt | null {
  try {
    return validateDatabaseRegistrationBinding(
      provenance.database,
      input["databaseRegistration"],
      String(input["organizationId"]),
      scope,
    );
  } catch {
    throw invalidInput();
  }
}

function parseStorageBucketName(
  input: UnknownRecord,
  provenance: VerifiedArtifactBundle["provenance"],
): string | null {
  const storageEnabled =
    "storage" in provenance &&
    isRecord(provenance.storage) &&
    provenance.storage["enabled"] === true;
  if (!storageEnabled) {
    if (input["storageBucketName"] !== undefined) throw invalidInput();
    return null;
  }
  const expected = `ohmyho-${provenance.scope.projectId.toLowerCase()}-${provenance.scope.environmentId.toLowerCase()}`;
  if (input["storageBucketName"] !== expected) throw invalidInput();
  return expected;
}

function parsePromotionStorageBucketName(
  input: UnknownRecord,
  provenance: VerifiedArtifactBundle["provenance"],
  targetScope: WfpScope,
): string | null {
  const storageEnabled =
    "storage" in provenance &&
    isRecord(provenance.storage) &&
    provenance.storage["enabled"] === true;
  if (!storageEnabled) {
    if (input["storageBucketName"] !== undefined) throw invalidInput();
    return null;
  }
  const expected = `ohmyho-${targetScope.projectId.toLowerCase()}-${targetScope.environmentId.toLowerCase()}`;
  if (input["storageBucketName"] !== expected) throw invalidInput();
  return expected;
}

function parseSyncSecretsInput(value: UnknownRecord): SyncSecretsEvent["input"] {
  if (!hasExactKeys(value, ["scope", "expectedDeployment", "runtimeSecretManifest"])) {
    throw invalidInput();
  }
  return Object.freeze({
    scope: parseScope(value.scope),
    expectedDeployment: parseReceipt(value.expectedDeployment),
    runtimeSecretManifest: parseRuntimeSecretManifest(value.runtimeSecretManifest),
  });
}

function parseFinalizeRemovalInput(value: UnknownRecord): FinalizeRemovalEvent["input"] {
  if (
    !hasExactKeys(value, [
      "organizationId",
      "operationId",
      "claimId",
      "scope",
      "deploymentId",
      "expectedGateway",
    ]) ||
    !["organizationId", "operationId", "claimId", "deploymentId"].every((key) =>
      ULID_PATTERN.test(String(value[key])),
    )
  )
    throw invalidInput();
  const scope = parseScope(value.scope);
  const expectedGateway = parseGatewayReceipt(value.expectedGateway);
  requireGatewayScope(expectedGateway, scope);
  return Object.freeze({
    organizationId: String(value["organizationId"]),
    operationId: String(value["operationId"]),
    claimId: String(value["claimId"]),
    scope,
    deploymentId: String(value.deploymentId),
    expectedGateway,
  });
}

function parseScope(value: unknown): WfpScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["projectId", "environmentId", "environmentName", "handle"]) ||
    !ULID_PATTERN.test(String(value.projectId)) ||
    !ULID_PATTERN.test(String(value.environmentId)) ||
    (value.environmentName !== "dev" && value.environmentName !== "prod")
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    projectId: String(value.projectId),
    environmentId: String(value.environmentId),
    environmentName: value.environmentName,
    handle: parseHandle(value.handle),
  });
}

function parseHandle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 59 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function parseOperationScope(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["projectId", "environmentId", "operationId"]) ||
    !ULID_PATTERN.test(String(value.projectId)) ||
    !ULID_PATTERN.test(String(value.environmentId)) ||
    !ULID_PATTERN.test(String(value.operationId))
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    projectId: String(value.projectId),
    environmentId: String(value.environmentId),
    operationId: String(value.operationId),
  });
}

function parseProvenance(value: unknown): VerifiedArtifactBundle["provenance"] {
  const keys = [
    "scope",
    "deploymentId",
    "buildId",
    "sourceCommit",
    "sourceDigest",
    "buildPlanDigest",
    "artifactDigest",
    "output",
    "applicationRoot",
    "frameworkPlanSchemaVersion",
    "runtimePolicy",
    "database",
    "auth",
    "storage",
    "lifecycleEvidence",
    ...(isRecord(value) && Object.hasOwn(value, "functions") ? ["functions"] : []),
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !isRecord(value.output) ||
    !hasExactKeys(value.output, ["bucket", "key", "versionId", "eTag", "byteLength", "sha256"]) ||
    !ULID_PATTERN.test(String(value.deploymentId)) ||
    typeof value.buildId !== "string" ||
    value.buildId.length === 0 ||
    value.buildId.length > 512 ||
    !/^[a-f0-9]{40}$/u.test(String(value.sourceCommit)) ||
    !DIGEST_PATTERN.test(String(value.sourceDigest)) ||
    !DIGEST_PATTERN.test(String(value.buildPlanDigest)) ||
    !DIGEST_PATTERN.test(String(value.artifactDigest)) ||
    typeof value.output.bucket !== "string" ||
    typeof value.output.key !== "string" ||
    typeof value.output.versionId !== "string" ||
    !/^"[^"\r\n]{1,256}"$/u.test(String(value.output.eTag)) ||
    !Number.isSafeInteger(value.output.byteLength) ||
    Number(value.output.byteLength) <= 0 ||
    !/^[a-f0-9]{64}$/u.test(String(value.output.sha256))
  ) {
    throw invalidInput();
  }
  const common = {
    scope: parseOperationScope(value.scope),
    deploymentId: String(value.deploymentId),
    buildId: value.buildId,
    sourceCommit: String(value.sourceCommit),
    sourceDigest: String(value.sourceDigest) as `sha256:${string}`,
    buildPlanDigest: String(value.buildPlanDigest) as `sha256:${string}`,
    artifactDigest: String(value.artifactDigest) as `sha256:${string}`,
    output: Object.freeze({
      bucket: value.output.bucket,
      key: value.output.key,
      versionId: value.output.versionId,
      eTag: String(value.output.eTag),
      byteLength: Number(value.output.byteLength),
      sha256: String(value.output.sha256),
    }),
  };
  const applicationRoot = parseApplicationRoot(value["applicationRoot"]);
  if (value["frameworkPlanSchemaVersion"] !== "ohmyhost.framework-plan/v5") throw invalidInput();
  const runtimePolicy = parseRuntimePolicy(value["runtimePolicy"]);
  const database = parseDatabaseRequirement(value["database"]);
  const auth = parseCustomerAuthRequirement(value["auth"]);
  if (auth.provider === "better-auth" && database.enabled !== true) throw invalidInput();
  const storage = parseStorageRequirement(value["storage"]);
  let lifecycleEvidence;
  try {
    lifecycleEvidence = parseVerifiedBuildLifecycleEvidence(value["lifecycleEvidence"]);
  } catch {
    throw invalidInput();
  }
  if (
    lifecycleEvidence.frameworkBuild.frameworkPlanSha256 !==
      String(value["buildPlanDigest"]).slice("sha256:".length) ||
    lifecycleEvidence.buildSandbox.sourceArchiveSha256 !==
      String(value["sourceDigest"]).slice("sha256:".length) ||
    lifecycleEvidence.buildSandbox.buildId !== value.buildId
  ) {
    throw invalidInput();
  }
  const functions = Object.hasOwn(value, "functions")
    ? parseFunctionsRequirement(value["functions"])
    : undefined;
  return Object.freeze({
    ...common,
    applicationRoot,
    frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v5" as const,
    runtimePolicy,
    database,
    auth,
    storage,
    lifecycleEvidence,
    ...(functions === undefined ? {} : { functions }),
  });
}

function parseFunctionsRequirement(value: unknown): Readonly<{ crons: readonly string[] }> {
  if (!isRecord(value) || !hasExactKeys(value, ["crons"]) || !Array.isArray(value["crons"])) {
    throw invalidInput();
  }
  let crons: readonly string[];
  try {
    crons = normalizeCrons(value["crons"]);
  } catch {
    throw invalidInput();
  }
  if (JSON.stringify(crons) !== JSON.stringify(value["crons"])) throw invalidInput();
  return Object.freeze({ crons });
}

function parseApplicationRoot(
  value: unknown,
): VerifiedArtifactBundle["provenance"]["applicationRoot"] {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > 64 ||
    !/^(?:\.|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u.test(value) ||
    (value !== "." && value.split("/").length > 8) ||
    value.split("/").some((segment) => new TextEncoder().encode(segment).byteLength > 63)
  ) {
    throw invalidInput();
  }
  return value as VerifiedArtifactBundle["provenance"]["applicationRoot"];
}

function parseRuntimePolicy(value: unknown) {
  try {
    return parseWfpRuntimePolicy(value);
  } catch {
    throw invalidInput();
  }
}

function parseDatabaseRequirement(value: unknown) {
  if (!isRecord(value)) throw invalidInput();
  if (hasExactKeys(value, ["enabled"]) && value["enabled"] === false) {
    return Object.freeze({ enabled: false as const });
  }
  if (
    !hasExactKeys(value, ["enabled", "migrations"]) ||
    value["enabled"] !== true ||
    typeof value["migrations"] !== "string" ||
    value["migrations"].length < 1 ||
    value["migrations"].length > 512 ||
    value["migrations"].startsWith("/") ||
    value["migrations"].includes("\\") ||
    value["migrations"].split("/").some((part) => part === "..")
  ) {
    throw invalidInput();
  }
  return Object.freeze({ enabled: true as const, migrations: value["migrations"] });
}

function parseCustomerAuthRequirement(value: unknown) {
  if (!isRecord(value)) throw invalidInput();
  if (hasExactKeys(value, ["provider"]) && value["provider"] === "none") {
    return Object.freeze({ provider: "none" as const });
  }
  if (
    hasExactKeys(value, ["provider", "routePath", "bindingName"]) &&
    value["provider"] === "omh-native" &&
    value["routePath"] === "/api/auth/v1" &&
    value["bindingName"] === "OHMYHOST_AUTH"
  ) {
    return Object.freeze({
      provider: "omh-native" as const,
      routePath: "/api/auth/v1" as const,
      bindingName: "OHMYHOST_AUTH" as const,
    });
  }
  if (
    !hasExactKeys(value, [
      "authSecretName",
      "databaseBindingName",
      "databaseSchema",
      "deployment",
      "provider",
      "routePath",
      "version",
    ]) ||
    value["provider"] !== "better-auth" ||
    !isRecordedBetterAuthVersion(value["version"]) ||
    (value["deployment"] !== "embedded" && value["deployment"] !== "companion") ||
    value["routePath"] !== "/api/auth" ||
    value["databaseSchema"] !== "auth" ||
    value["databaseBindingName"] !== "OHMYHOST_DATABASE" ||
    value["authSecretName"] !== "BETTER_AUTH_SECRET"
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    provider: "better-auth" as const,
    version: value["version"],
    deployment: value["deployment"],
    routePath: "/api/auth" as const,
    databaseSchema: "auth" as const,
    databaseBindingName: "OHMYHOST_DATABASE" as const,
    authSecretName: "BETTER_AUTH_SECRET" as const,
  });
}

function parseStorageRequirement(value: unknown) {
  if (!isRecord(value)) throw invalidInput();
  if (hasExactKeys(value, ["enabled"]) && value["enabled"] === false) {
    return Object.freeze({ enabled: false as const });
  }
  if (
    !hasExactKeys(value, ["enabled", "jurisdiction", "provider", "public"]) ||
    value["enabled"] !== true ||
    value["provider"] !== "r2" ||
    (value["jurisdiction"] !== "eu" && value["jurisdiction"] !== "us") ||
    value["public"] !== false
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    enabled: true as const,
    provider: "r2" as const,
    jurisdiction: value["jurisdiction"],
    public: false as const,
  });
}

function parseRuntimeSecretManifest(value: unknown): RuntimeSecretManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["digest", "secrets"]) ||
    !DIGEST_PATTERN.test(String(value.digest)) ||
    !Array.isArray(value.secrets) ||
    value.secrets.length > 128
  ) {
    throw invalidInput();
  }
  let previousName: string | null = null;
  const secrets = value.secrets.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["name", "value", "revision", "valueSha256"]) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(String(entry.name)) ||
      typeof entry.value !== "string" ||
      new TextEncoder().encode(entry.value).byteLength < 1 ||
      new TextEncoder().encode(entry.value).byteLength > 5_120 ||
      !Number.isSafeInteger(entry.revision) ||
      Number(entry.revision) < 1 ||
      !DIGEST_PATTERN.test(String(entry.valueSha256)) ||
      (previousName !== null && String(entry.name) <= previousName)
    ) {
      throw invalidInput();
    }
    previousName = String(entry.name);
    return Object.freeze({
      name: String(entry.name),
      value: entry.value,
      revision: Number(entry.revision),
      valueSha256: String(entry.valueSha256) as `sha256:${string}`,
    });
  });
  return Object.freeze({
    digest: String(value.digest) as `sha256:${string}`,
    secrets: Object.freeze(secrets),
  });
}

function parseReceipt(value: unknown): WfpDeploymentReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "provider",
      "namespace",
      "scriptName",
      "projectId",
      "environmentId",
      "productDeploymentId",
      "providerTag",
      "artifactDigest",
      ...(Object.hasOwn(value, "bindingSetDigest") ? ["bindingSetDigest"] : []),
      "buildReused",
      "deployedAt",
    ]) ||
    value.provider !== "cloudflare-wfp" ||
    typeof value.namespace !== "string" ||
    typeof value.scriptName !== "string" ||
    !ULID_PATTERN.test(String(value.projectId)) ||
    !ULID_PATTERN.test(String(value.environmentId)) ||
    !ULID_PATTERN.test(String(value["productDeploymentId"])) ||
    typeof value.providerTag !== "string" ||
    !DIGEST_PATTERN.test(String(value.artifactDigest)) ||
    (Object.hasOwn(value, "bindingSetDigest") &&
      (typeof value["bindingSetDigest"] !== "string" ||
        !DIGEST_PATTERN.test(value["bindingSetDigest"]))) ||
    typeof value.buildReused !== "boolean" ||
    typeof value.deployedAt !== "string"
  ) {
    throw invalidInput();
  }
  const deployedAt = new Date(value.deployedAt);
  if (!Number.isFinite(deployedAt.getTime()) || deployedAt.toISOString() !== value.deployedAt) {
    throw invalidInput();
  }
  return Object.freeze({
    provider: "cloudflare-wfp",
    namespace: value.namespace,
    scriptName: value.scriptName,
    projectId: String(value.projectId),
    environmentId: String(value.environmentId),
    productDeploymentId: String(value["productDeploymentId"]),
    providerTag: value.providerTag,
    artifactDigest: String(value.artifactDigest) as `sha256:${string}`,
    ...(Object.hasOwn(value, "bindingSetDigest")
      ? { bindingSetDigest: value["bindingSetDigest"] as `sha256:${string}` }
      : {}),
    buildReused: value.buildReused,
    deployedAt,
  });
}

function parseGatewayReceipt(value: unknown): WfpProjectGatewayReceipt {
  try {
    return readGatewayReceipt(value);
  } catch {
    throw invalidInput();
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function invalidInput(): Error {
  return new Error("invalid_wfp_action_input");
}
