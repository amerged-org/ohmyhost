import { createHash } from "node:crypto";
import type { SharedGatewayReceipt } from "@ohmyhost/platform";
import { projectEnvironmentAddress, projectHandleProblem } from "@ohmyhost/project-handles";
import { parseBrowserPolicy, type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
export type WfpProjectGatewayReceipt = SharedGatewayReceipt;
export type WfpProjectGatewayAbsenceReceipt = SharedGatewayReceipt;
/** Candidates before this scoped-gateway contract remain identity-only cleanup/provenance. */
export const WFP_CANDIDATE_LAYOUT_TAG = "layout:gateway-scopes-v1";

export type WfpProviderErrorCode =
  | "cloudflare_contract_invalid"
  | "cloudflare_deployment_conflict"
  | "cloudflare_request_failed"
  | "cloudflare_result_uncertain"
  | "cloudflare_script_rejected"
  | "invalid_wfp_input";

// Cloudflare answers these statuses when the uploaded script itself is unacceptable (startup
// error, invalid module graph, size limit). Retrying the same bytes cannot succeed, so the caller
// treats the candidate as rejected instead of reconciling. 401/403/429 stay request failures.
const SCRIPT_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

export class CloudflareWfpInputError extends Error {
  public readonly code = "invalid_wfp_input" satisfies WfpProviderErrorCode;

  public constructor() {
    super("Cloudflare WFP provider input is invalid");
    this.name = "CloudflareWfpInputError";
  }
}

export class CloudflareWfpContractError extends Error {
  public readonly code = "cloudflare_contract_invalid" satisfies WfpProviderErrorCode;

  public constructor() {
    super("Cloudflare WFP response is invalid");
    this.name = "CloudflareWfpContractError";
  }
}

export class CloudflareWfpRequestError extends Error {
  public readonly code = "cloudflare_request_failed" satisfies WfpProviderErrorCode;

  public constructor(
    public readonly status?: number,
    public readonly providerCode?: number,
    public readonly providerPointer?: string,
  ) {
    super("Cloudflare WFP request failed");
    this.name = "CloudflareWfpRequestError";
  }
}

export class CloudflareWfpScriptRejectedError extends Error {
  public readonly code = "cloudflare_script_rejected" satisfies WfpProviderErrorCode;

  public constructor(
    public readonly status: number,
    public readonly providerCode?: number,
    public readonly providerPointer?: string,
  ) {
    super("Cloudflare WFP rejected the candidate script");
    this.name = "CloudflareWfpScriptRejectedError";
  }
}

export class CloudflareWfpConflictError extends Error {
  public readonly code = "cloudflare_deployment_conflict" satisfies WfpProviderErrorCode;

  public constructor(
    public readonly expectedProviderTag: string,
    public readonly currentProviderTag: string,
  ) {
    super("Cloudflare WFP deployment changed before removal");
    this.name = "CloudflareWfpConflictError";
  }
}

export class CloudflareWfpUncertainError extends Error {
  public readonly code = "cloudflare_result_uncertain" satisfies WfpProviderErrorCode;

  public constructor(
    public readonly currentProviderTag: string | null,
    public readonly currentProductDeploymentId: string | null = null,
    public readonly currentArtifactDigest: `sha256:${string}` | null = null,
    public readonly reason?: "candidate_bindings_outdated",
  ) {
    super("Cloudflare WFP mutation result is uncertain");
    this.name = "CloudflareWfpUncertainError";
  }
}

export class CloudflareWfpSecretSyncUncertainError extends Error {
  public readonly code = "cloudflare_result_uncertain" satisfies WfpProviderErrorCode;

  public constructor(
    public readonly currentSecrets: readonly RuntimeSecretObservedBinding[] | null,
  ) {
    super("Cloudflare WFP runtime-secret synchronization result is uncertain");
    this.name = "CloudflareWfpSecretSyncUncertainError";
  }
}

export interface WfpScope {
  readonly projectId: string;
  readonly environmentId: string;
  readonly environmentName: "dev" | "prod";
  readonly handle: string;
}

export function projectGatewayPublicOrigin(
  scope: Pick<WfpScope, "projectId" | "handle" | "environmentName">,
  namespace: string,
): string {
  if (
    !["sandbox", "ohmyho-sandbox", "ohmyho-poc-private-fullstack", "ohmyho-production"].includes(
      namespace,
    )
  )
    throw new CloudflareWfpInputError();
  return projectEnvironmentAddress({
    ...scope,
    platform: namespace === "ohmyho-production" ? "production" : "development",
  }).origin;
}

export interface WfpDatabaseBinding {
  readonly service: string;
  readonly props: Readonly<{
    organizationId: string;
    projectId: string;
    environmentId: string;
    physicalEnvironmentId: string;
    registrationVersion: number;
    region: "us" | "eu";
  }>;
}

export interface WfpStorageBinding {
  readonly service: string;
  readonly props: Readonly<{
    organizationId: string;
    projectId: string;
    environmentId: string;
    dataEnvironmentId: string;
  }>;
}

export interface VerifiedWfpArtifact {
  readonly deploymentId: string;
  readonly digest: `sha256:${string}`;
  readonly bodyDigest: `sha256:${string}`;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly platformBindings: Readonly<{
    readonly immutableScriptName: string;
    readonly crons: readonly string[];
    readonly database?: WfpDatabaseBinding;
    readonly storage?: WfpStorageBinding;
    readonly nativeAuth?: WfpNativeAuthBinding;
    readonly nextCache?: WfpNextCacheBinding;
  }>;
}
export interface WfpNextCacheBinding {
  readonly service: string;
  readonly props: Readonly<{
    organizationId: string;
    projectId: string;
    environmentId: string;
    deploymentId: string;
    region: "us" | "eu";
  }>;
}
export interface WfpNativeAuthBinding {
  readonly service: string;
  readonly props: Readonly<{
    organizationId: string;
    projectId: string;
    environmentId: string;
    deploymentId: string;
  }>;
}

export interface WfpPublishInput {
  readonly scope: WfpScope;
  readonly artifact: VerifiedWfpArtifact;
  readonly buildReused?: boolean;
}

export interface WfpDeploymentReceipt {
  readonly provider: "cloudflare-wfp";
  readonly namespace: string;
  readonly scriptName: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly productDeploymentId: string;
  readonly providerTag: string;
  readonly artifactDigest: `sha256:${string}`;
  /** Combined digest computed from validated staging inputs, never from provider metadata. */
  readonly bindingSetDigest?: `sha256:${string}`;
  readonly buildReused: boolean;
  readonly deployedAt: Date;
}

export interface WfpObservation {
  readonly state: "ready" | "unknown" | "metadata_absent";
  readonly scriptName: string;
  readonly providerTag: string | null;
  readonly productDeploymentId: string | null;
  readonly artifactDigest: string | null;
  readonly observedAt: Date;
  readonly reason?: "candidate_bindings_outdated";
}

export interface WfpCandidateObservationInput {
  readonly expectedDatabaseBindingDigest?: `sha256:${string}` | null;
  readonly expectedStorageBindingDigest?: `sha256:${string}` | null;
  readonly expectedNativeAuthBindingDigest?: `sha256:${string}` | null;
  readonly expectedBindingSetDigest?: `sha256:${string}` | null;
  readonly scope: WfpScope;
  readonly deploymentId: string;
  readonly knownDeployment?: WfpDeploymentReceipt;
}

export interface WfpRemoveInput {
  readonly scope: WfpScope;
  readonly expectedDeployment: WfpDeploymentReceipt;
}

export interface RuntimeSecretBinding {
  readonly name: string;
  readonly value: string;
  readonly revision: number;
  readonly valueSha256: `sha256:${string}`;
}

export interface RuntimeSecretManifest {
  readonly digest: `sha256:${string}`;
  readonly secrets: readonly RuntimeSecretBinding[];
}

export interface RuntimeSecretObservedBinding {
  readonly name: string;
  readonly type: "secret_text";
}

export interface WfpSyncRuntimeSecretsInput {
  readonly scope: WfpScope;
  readonly deployment: WfpDeploymentReceipt;
  readonly manifest: RuntimeSecretManifest;
}

export interface WfpRuntimeSecretSyncReceipt {
  readonly provider: "cloudflare-wfp";
  readonly namespace: string;
  readonly scriptName: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly manifestDigest: `sha256:${string}`;
  readonly secretNames: readonly string[];
  readonly providerTag: string;
  readonly observedAt: Date;
}

export interface WfpMetadataAbsenceReceipt {
  readonly state: "metadata_absent";
  readonly namespace: string;
  readonly scriptName: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly expectedProviderTag: string;
  readonly observedAt: Date;
}

export interface WfpRuntimePolicy {
  readonly healthCheckPath: string;
  readonly egressAllowedOrigins: readonly string[];
  readonly browser?: BrowserPolicy;
}

/** Parses the current runtime contract shared by publication, private actions and routing. */
export function parseWfpRuntimePolicy(value: unknown): WfpRuntimePolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "healthCheckPath",
      "egressAllowedOrigins",
      ...(value["browser"] === undefined ? [] : ["browser"]),
    ])
  )
    throw new CloudflareWfpInputError();
  const healthCheckPath = value["healthCheckPath"],
    origins = value["egressAllowedOrigins"];
  if (
    typeof healthCheckPath !== "string" ||
    healthCheckPath.length > 256 ||
    !healthCheckPath.startsWith("/") ||
    healthCheckPath.startsWith("//") ||
    /[\\?#]/u.test(healthCheckPath) ||
    healthCheckPath.split("/").some((part) => part === "." || part === "..") ||
    !Array.isArray(origins) ||
    origins.length > 16
  )
    throw new CloudflareWfpInputError();
  let previous = "";
  for (const origin of origins) {
    if (
      typeof origin !== "string" ||
      origin <= previous ||
      origin.length > 256 ||
      !isDnsEgressOrigin(origin)
    )
      throw new CloudflareWfpInputError();
    previous = origin;
  }
  let browser: BrowserPolicy | undefined;
  try {
    browser = value["browser"] === undefined ? undefined : parseBrowserPolicy(value["browser"]);
  } catch {
    throw new CloudflareWfpInputError();
  }
  return Object.freeze({
    healthCheckPath,
    egressAllowedOrigins: Object.freeze([...origins] as string[]),
    ...(browser === undefined ? {} : { browser }),
  });
}

export interface CloudflareWfpProviderDependencies {
  readonly accountId: string;
  readonly namespace: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
}

interface ScriptMetadata {
  readonly scriptName: string;
  readonly providerTag: string;
  readonly productDeploymentId: string;
  readonly artifactDigest: `sha256:${string}` | null;
  readonly cronBindingsDigest: `sha256:${string}` | null;
  readonly databaseBindingDigest: `sha256:${string}` | null;
  readonly storageBindingDigest: `sha256:${string}` | null;
  readonly nativeAuthBindingDigest: `sha256:${string}` | null;
  readonly bindingSetDigest: `sha256:${string}` | null;
  readonly currentLayout: boolean;
  readonly modifiedAt: Date;
}

interface UploadMetadata {
  readonly scriptName: string;
  readonly scriptTag: string;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RUNTIME_SECRETS = 100;
const MAX_RUNTIME_SECRET_VALUE_BYTES = 5 * 1024;
const RUNTIME_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

export class CloudflareWfpProvider {
  private readonly now: () => Date;
  private readonly timeoutMilliseconds: number;

  public constructor(private readonly dependencies: CloudflareWfpProviderDependencies) {
    validateConfiguration(dependencies);
    this.now = dependencies.now ?? (() => new Date());
    this.timeoutMilliseconds = dependencies.timeoutMilliseconds ?? 15_000;
  }

  public async stageCandidate(input: WfpPublishInput): Promise<WfpDeploymentReceipt> {
    return this.upload(input, input.buildReused === true);
  }

  public async observeCandidate(input: WfpCandidateObservationInput): Promise<WfpObservation> {
    validateScope(input.scope);
    if (!isUlid(input.deploymentId)) throw new CloudflareWfpInputError();
    if (input.knownDeployment !== undefined) {
      validateReceipt(input.knownDeployment, input.scope, this.dependencies.namespace);
      if (input.knownDeployment.productDeploymentId !== input.deploymentId) {
        throw new CloudflareWfpInputError();
      }
    }
    const scriptName = projectCandidateScriptName(
      input.scope.projectId,
      input.scope.environmentName,
      input.deploymentId,
    );
    const metadata = await this.readScript(input.scope, input.deploymentId);
    const known = input.knownDeployment;
    return Object.freeze({
      state:
        metadata === null
          ? ("metadata_absent" as const)
          : known !== undefined &&
              metadata.currentLayout &&
              scriptMatchesReceipt(metadata, known) &&
              (input.expectedBindingSetDigest !== undefined
                ? metadata.bindingSetDigest === input.expectedBindingSetDigest
                : metadata.bindingSetDigest === null &&
                  (input.expectedDatabaseBindingDigest === undefined ||
                    metadata.databaseBindingDigest === input.expectedDatabaseBindingDigest) &&
                  (input.expectedStorageBindingDigest === undefined ||
                    metadata.storageBindingDigest === input.expectedStorageBindingDigest) &&
                  (input.expectedNativeAuthBindingDigest === undefined ||
                    metadata.nativeAuthBindingDigest === input.expectedNativeAuthBindingDigest))
            ? ("ready" as const)
            : ("unknown" as const),
      scriptName,
      providerTag: metadata?.providerTag ?? null,
      productDeploymentId: metadata?.productDeploymentId ?? null,
      artifactDigest: metadata?.artifactDigest ?? null,
      observedAt: checkedNow(this.now),
      ...(metadata !== null &&
      !metadata.currentLayout &&
      known !== undefined &&
      scriptMatchesReceipt(metadata, known)
        ? { reason: "candidate_bindings_outdated" as const }
        : {}),
    });
  }

  public async removeCandidate(input: WfpRemoveInput): Promise<WfpMetadataAbsenceReceipt> {
    validateScope(input.scope);
    validateReceipt(input.expectedDeployment, input.scope, this.dependencies.namespace);
    const scriptName = input.expectedDeployment.scriptName;
    const observedAt = checkedNow(this.now);
    const before = await this.readScript(input.scope, input.expectedDeployment.productDeploymentId);
    if (before === null) {
      await this.confirmScriptMissing(input.scope, input.expectedDeployment.productDeploymentId);
      return metadataAbsenceReceipt(this.dependencies.namespace, input, scriptName, observedAt);
    }
    if (
      before.providerTag !== input.expectedDeployment.providerTag ||
      before.productDeploymentId !== input.expectedDeployment.productDeploymentId ||
      (Object.hasOwn(input.expectedDeployment, "bindingSetDigest") &&
        before.bindingSetDigest !== input.expectedDeployment.bindingSetDigest) ||
      (before.artifactDigest !== null &&
        before.artifactDigest !== input.expectedDeployment.artifactDigest)
    ) {
      throw new CloudflareWfpConflictError(
        input.expectedDeployment.providerTag,
        before.providerTag,
      );
    }
    try {
      const response = await this.request(this.scriptUrl(scriptName), { method: "DELETE" });
      if (response.status === 404) {
        await requireMissingScriptEnvelope(response);
      } else {
        await requireSuccessfulEnvelope(response);
      }
      await this.confirmScriptMissing(input.scope, input.expectedDeployment.productDeploymentId);
      return metadataAbsenceReceipt(this.dependencies.namespace, input, scriptName, observedAt);
    } catch (error) {
      if (!isUncertainMutationError(error)) throw error;
      try {
        await this.confirmScriptMissing(input.scope, input.expectedDeployment.productDeploymentId);
        return metadataAbsenceReceipt(this.dependencies.namespace, input, scriptName, observedAt);
      } catch {
        // Fall through to exact identity reconciliation.
      }
      const current = await this.reconcile(
        input.scope,
        input.expectedDeployment.productDeploymentId,
      );
      throw new CloudflareWfpUncertainError(
        current?.providerTag ?? null,
        current?.productDeploymentId ?? null,
        current?.artifactDigest ?? null,
      );
    }
  }

  public async syncRuntimeSecrets(
    input: WfpSyncRuntimeSecretsInput,
  ): Promise<WfpRuntimeSecretSyncReceipt> {
    const desired = await validateRuntimeSecretSyncInput(input);
    validateReceipt(input.deployment, input.scope, this.dependencies.namespace);
    const scriptName = input.deployment.scriptName;
    const candidateBefore = await this.readScript(
      input.scope,
      input.deployment.productDeploymentId,
    );
    if (!scriptMatchesArtifactReceipt(candidateBefore, input.deployment)) {
      throw new CloudflareWfpConflictError(
        input.deployment.providerTag,
        candidateBefore?.providerTag ?? "absent",
      );
    }
    const current = await this.readRuntimeSecretBindings(scriptName);
    const expected = desired.map(runtimeSecretBinding);
    let observed = current;
    if (desired.length > 0 || current.length > 0) {
      const desiredNames = new Set(desired.map((secret) => secret.name));
      const secrets: Record<string, RuntimeSecretBulkMutation | null> = {};
      for (const secret of desired) {
        secrets[secret.name] = {
          name: secret.name,
          type: "secret_text",
          text: secret.value,
        };
      }
      for (const binding of current) {
        if (!desiredNames.has(binding.name)) secrets[binding.name] = null;
      }

      let response: Response;
      try {
        response = await this.request(`${this.scriptUrl(scriptName)}/secrets-bulk`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secrets }),
        });
      } catch (error) {
        if (!(error instanceof TypeError || isAbortError(error))) throw error;
        throw await this.runtimeSecretUncertain(scriptName);
      }
      if (response.status >= 500) throw await this.runtimeSecretUncertain(scriptName);
      try {
        await requireRuntimeSecretBulkEnvelope(response);
      } catch (error) {
        if (!response.ok) throw error;
        throw await this.runtimeSecretUncertain(scriptName);
      }

      try {
        observed = await this.readRuntimeSecretBindings(scriptName);
      } catch {
        throw new CloudflareWfpSecretSyncUncertainError(null);
      }
      if (!sameRuntimeSecretBindings(observed, expected)) {
        throw new CloudflareWfpSecretSyncUncertainError(observed);
      }
    }
    let metadata: ScriptMetadata | null;
    try {
      metadata = await this.readScript(input.scope, input.deployment.productDeploymentId);
    } catch {
      throw new CloudflareWfpSecretSyncUncertainError(observed);
    }
    if (metadata === null || !scriptMatchesArtifactReceipt(metadata, input.deployment)) {
      throw new CloudflareWfpSecretSyncUncertainError(observed);
    }
    return Object.freeze({
      provider: "cloudflare-wfp" as const,
      namespace: this.dependencies.namespace,
      scriptName,
      projectId: input.scope.projectId,
      environmentId: input.scope.environmentId,
      manifestDigest: input.manifest.digest,
      secretNames: Object.freeze(observed.map((binding) => binding.name)),
      providerTag: metadata.providerTag,
      observedAt: checkedNow(this.now),
    });
  }

  private async upload(
    input: WfpPublishInput,
    buildReused: boolean,
  ): Promise<WfpDeploymentReceipt> {
    const artifactBody = Uint8Array.from(input.artifact.body);
    const {
      cronBindingsDigest,
      databaseBindingDigest,
      storageBindingDigest,
      nativeAuthBindingDigest,
      bindingSetDigest,
      storedBindings,
    } = await validatePublishInput(input, artifactBody, this.dependencies.namespace);
    const scriptName = projectCandidateScriptName(
      input.scope.projectId,
      input.scope.environmentName,
      input.artifact.deploymentId,
    );
    const existing = await this.readScript(input.scope, input.artifact.deploymentId);
    if (existing !== null) {
      if (
        !existing.currentLayout &&
        existing.productDeploymentId === input.artifact.deploymentId &&
        existing.artifactDigest === input.artifact.digest
      )
        throw new CloudflareWfpUncertainError(
          existing.providerTag,
          existing.productDeploymentId,
          existing.artifactDigest,
          "candidate_bindings_outdated",
        );
      if (
        existing.currentLayout &&
        existing.productDeploymentId === input.artifact.deploymentId &&
        existing.artifactDigest === input.artifact.digest &&
        sameBindingDigests(
          existing,
          bindingSetDigest,
          cronBindingsDigest,
          databaseBindingDigest,
          storageBindingDigest,
          nativeAuthBindingDigest,
        )
      ) {
        await this.requireExistingBindings(scriptName, storedBindings, existing);
        return deploymentReceipt(
          existing,
          input.scope,
          this.dependencies.namespace,
          buildReused,
          bindingSetDigest,
        );
      }
      throw new CloudflareWfpConflictError("absent", existing.providerTag);
    }
    let response: Response;
    try {
      let offset = 0;
      const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (offset === artifactBody.byteLength) controller.close();
          else {
            const end = Math.min(offset + 65_536, artifactBody.byteLength);
            controller.enqueue(artifactBody.subarray(offset, end));
            offset = end;
          }
        },
      });
      response = await this.request(this.scriptUrl(scriptName), {
        method: "PUT",
        headers: { "content-type": input.artifact.contentType },
        body,
      });
    } catch (error) {
      if (!(error instanceof TypeError || isAbortError(error))) throw error;
      const current = await this.reconcile(input.scope, input.artifact.deploymentId);
      if (
        current !== null &&
        current.currentLayout &&
        current.productDeploymentId === input.artifact.deploymentId &&
        current.artifactDigest === input.artifact.digest &&
        sameBindingDigests(
          current,
          bindingSetDigest,
          cronBindingsDigest,
          databaseBindingDigest,
          storageBindingDigest,
          nativeAuthBindingDigest,
        )
      ) {
        await this.requireStoredBindings(scriptName, storedBindings);
        return deploymentReceipt(
          current,
          input.scope,
          this.dependencies.namespace,
          buildReused,
          bindingSetDigest,
        );
      }
      throw new CloudflareWfpUncertainError(
        current?.providerTag ?? null,
        current?.productDeploymentId ?? null,
        current?.artifactDigest ?? null,
        current !== null &&
        !current.currentLayout &&
        current.productDeploymentId === input.artifact.deploymentId &&
        current.artifactDigest === input.artifact.digest
          ? "candidate_bindings_outdated"
          : undefined,
      );
    }
    try {
      await readUploadState(response, scriptName);
    } catch (error) {
      if (response.status < 500) {
        if (
          error instanceof CloudflareWfpRequestError &&
          SCRIPT_REJECTION_STATUSES.has(response.status)
        ) {
          throw new CloudflareWfpScriptRejectedError(
            response.status,
            error.providerCode,
            error.providerPointer,
          );
        }
        throw error;
      }
      const current = await this.reconcile(input.scope, input.artifact.deploymentId);
      if (
        current !== null &&
        current.currentLayout &&
        current.productDeploymentId === input.artifact.deploymentId &&
        current.artifactDigest === input.artifact.digest &&
        sameBindingDigests(
          current,
          bindingSetDigest,
          cronBindingsDigest,
          databaseBindingDigest,
          storageBindingDigest,
          nativeAuthBindingDigest,
        )
      ) {
        await this.requireStoredBindings(scriptName, storedBindings);
        return deploymentReceipt(
          current,
          input.scope,
          this.dependencies.namespace,
          buildReused,
          bindingSetDigest,
        );
      }
      throw new CloudflareWfpUncertainError(
        current?.providerTag ?? null,
        current?.productDeploymentId ?? null,
        current?.artifactDigest ?? null,
        current !== null &&
        !current.currentLayout &&
        current.productDeploymentId === input.artifact.deploymentId &&
        current.artifactDigest === input.artifact.digest
          ? "candidate_bindings_outdated"
          : undefined,
      );
    }
    await this.requireStoredBindings(scriptName, storedBindings);
    let current: ScriptMetadata | null;
    try {
      current = await this.readScript(input.scope, input.artifact.deploymentId);
    } catch (error) {
      if (!isUncertainMutationError(error)) throw error;
      throw new CloudflareWfpUncertainError(null);
    }
    if (
      current !== null &&
      !current.currentLayout &&
      current.productDeploymentId === input.artifact.deploymentId &&
      current.artifactDigest === input.artifact.digest
    )
      throw new CloudflareWfpUncertainError(
        current.providerTag,
        current.productDeploymentId,
        current.artifactDigest,
        "candidate_bindings_outdated",
      );
    if (
      current === null ||
      !current.currentLayout ||
      current.productDeploymentId !== input.artifact.deploymentId ||
      current.artifactDigest !== input.artifact.digest ||
      !sameBindingDigests(
        current,
        bindingSetDigest,
        cronBindingsDigest,
        databaseBindingDigest,
        storageBindingDigest,
        nativeAuthBindingDigest,
      )
    ) {
      throw new CloudflareWfpContractError();
    }
    return Object.freeze({
      provider: "cloudflare-wfp" as const,
      namespace: this.dependencies.namespace,
      scriptName,
      projectId: input.scope.projectId,
      environmentId: input.scope.environmentId,
      productDeploymentId: input.artifact.deploymentId,
      providerTag: current.providerTag,
      artifactDigest: input.artifact.digest,
      ...(bindingSetDigest === null ? {} : { bindingSetDigest }),
      buildReused,
      deployedAt: checkedNow(this.now),
    });
  }

  private async reconcile(scope: WfpScope, deploymentId: string): Promise<ScriptMetadata | null> {
    try {
      return await this.readScript(scope, deploymentId);
    } catch {
      throw new CloudflareWfpUncertainError(null);
    }
  }

  private async readScript(scope: WfpScope, deploymentId: string): Promise<ScriptMetadata | null> {
    const scriptName = projectCandidateScriptName(
      scope.projectId,
      scope.environmentName,
      deploymentId,
    );
    const response = await this.request(this.scriptUrl(scriptName), { method: "GET" });
    if (response.status === 404) {
      await requireMissingScriptEnvelope(response);
      return null;
    }
    return readScriptDetails(response, scriptName, scope, this.dependencies.namespace);
  }

  private async confirmScriptMissing(scope: WfpScope, deploymentId: string): Promise<void> {
    const scriptName = projectCandidateScriptName(
      scope.projectId,
      scope.environmentName,
      deploymentId,
    );
    const response = await this.request(this.scriptUrl(scriptName), { method: "GET" });
    if (response.status === 404) {
      await requireMissingScriptEnvelope(response);
      return;
    }
    await requireMissingDispatchScriptEnvelope(response, this.dependencies.namespace);
  }

  private async readRuntimeSecretBindings(
    scriptName: string,
  ): Promise<readonly RuntimeSecretObservedBinding[]> {
    const response = await this.request(`${this.scriptUrl(scriptName)}/secrets`, {
      method: "GET",
    });
    return readRuntimeSecretBindings(response);
  }

  /** A user Worker is kept only when Cloudflare reports exactly the bindings it was sent. */
  private async requireStoredBindings(
    scriptName: string,
    expected: readonly StoredBinding[],
  ): Promise<void> {
    let observed: readonly StoredBinding[] | null;
    try {
      observed = await this.readStoredBindings(scriptName);
    } catch {
      observed = null;
    }
    if (observed !== null && sameStoredBindings(observed, expected)) return;
    await this.rejectScript(scriptName);
  }

  /**
   * An existing candidate may carry runtime secret_text bindings synced after its upload, so only
   * its platform bindings must match. A failed read keeps the script: it is never deleted unseen.
   */
  private async requireExistingBindings(
    scriptName: string,
    expected: readonly StoredBinding[],
    existing: ScriptMetadata,
  ): Promise<void> {
    let observed: readonly StoredBinding[];
    try {
      observed = await this.readStoredBindings(scriptName);
    } catch {
      throw new CloudflareWfpUncertainError(
        existing.providerTag,
        existing.productDeploymentId,
        existing.artifactDigest,
      );
    }
    const platform = (bindings: readonly StoredBinding[]) =>
      bindings.filter((binding) => binding.type !== "secret_text");
    if (
      sameStoredBindings(platform(observed), platform(expected)) &&
      observed.every(
        (binding) =>
          binding.type !== "secret_text" || RUNTIME_SECRET_NAME_PATTERN.test(binding.name),
      )
    )
      return;
    await this.rejectScript(scriptName);
  }

  /** Deletes a candidate whose stored bindings differ from the closed set, then fails the deployment. */
  private async rejectScript(scriptName: string): Promise<never> {
    try {
      const response = await this.request(this.scriptUrl(scriptName), { method: "DELETE" });
      if (response.status === 404) await requireMissingScriptEnvelope(response);
      else await requireSuccessfulEnvelope(response);
    } catch {
      throw new CloudflareWfpUncertainError(null);
    }
    throw new CloudflareWfpContractError();
  }

  private async readStoredBindings(scriptName: string): Promise<readonly StoredBinding[]> {
    const response = await this.request(`${this.scriptUrl(scriptName)}/bindings`, {
      method: "GET",
    });
    return readStoredBindingList(response);
  }

  private async runtimeSecretUncertain(
    scriptName: string,
  ): Promise<CloudflareWfpSecretSyncUncertainError> {
    try {
      return new CloudflareWfpSecretSyncUncertainError(
        await this.readRuntimeSecretBindings(scriptName),
      );
    } catch {
      return new CloudflareWfpSecretSyncUncertainError(null);
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${this.dependencies.apiToken}`);
      return await this.dependencies.fetch(url, { ...init, headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private scriptUrl(scriptName: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.dependencies.accountId}/workers/dispatch/namespaces/${encodeURIComponent(this.dependencies.namespace)}/scripts/${scriptName}`;
  }
}

interface RuntimeSecretBulkMutation extends RuntimeSecretObservedBinding {
  readonly text: string;
}

export function projectCandidateScriptName(
  projectId: string,
  environmentName: "dev" | "prod",
  deploymentId: string,
): string {
  if (!isUlid(projectId) || !isProjectEnvironmentName(environmentName) || !isUlid(deploymentId)) {
    throw new CloudflareWfpInputError();
  }
  const scriptName = `p-${projectId.toLowerCase()}-${environmentName}-${deploymentId.toLowerCase()}`;
  if (scriptName.length > 60) throw new CloudflareWfpInputError();
  return scriptName;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export async function computeRuntimeSecretManifestDigest(
  secrets: readonly Pick<RuntimeSecretBinding, "name" | "revision" | "valueSha256">[],
): Promise<`sha256:${string}`> {
  if (!Array.isArray(secrets)) throw new CloudflareWfpInputError();
  const entries = secrets.map((secret) => ({
    name: secret.name,
    revision: secret.revision,
    valueSha256: secret.valueSha256,
  }));
  validateRuntimeSecretManifestEntries(entries);
  return sha256(
    new TextEncoder().encode(
      `ohmyhost-runtime-secret-manifest-v1\n${entries
        .map((secret) => `${secret.name}\t${String(secret.revision)}\t${secret.valueSha256}\n`)
        .join("")}`,
    ),
  );
}

export async function createRuntimeSecretManifest(
  secrets: readonly RuntimeSecretBinding[],
): Promise<RuntimeSecretManifest> {
  if (!Array.isArray(secrets) || secrets.length > MAX_RUNTIME_SECRETS) {
    throw new CloudflareWfpInputError();
  }
  const snapshot = secrets
    .map((secret) => Object.freeze({ ...secret }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  await validateRuntimeSecretValues(snapshot);
  validateRuntimeSecretManifestEntries(snapshot);
  return Object.freeze({
    digest: await computeRuntimeSecretManifestDigest(snapshot),
    secrets: Object.freeze(snapshot),
  });
}

function metadataAbsenceReceipt(
  namespace: string,
  input: WfpRemoveInput,
  scriptName: string,
  observedAt: Date,
): WfpMetadataAbsenceReceipt {
  return Object.freeze({
    state: "metadata_absent" as const,
    namespace,
    scriptName,
    projectId: input.scope.projectId,
    environmentId: input.scope.environmentId,
    expectedProviderTag: input.expectedDeployment.providerTag,
    observedAt,
  });
}

function validateConfiguration(dependencies: CloudflareWfpProviderDependencies): void {
  if (
    !/^[a-f0-9]{32}$/u.test(dependencies.accountId) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(dependencies.namespace) ||
    dependencies.apiToken.trim().length === 0 ||
    (dependencies.timeoutMilliseconds !== undefined &&
      (!Number.isSafeInteger(dependencies.timeoutMilliseconds) ||
        dependencies.timeoutMilliseconds < 1))
  ) {
    throw new CloudflareWfpInputError();
  }
}

async function validatePublishInput(
  input: WfpPublishInput,
  artifactBody: Uint8Array,
  namespace: string,
): Promise<{
  cronBindingsDigest: `sha256:${string}` | null;
  databaseBindingDigest: `sha256:${string}` | null;
  storageBindingDigest: `sha256:${string}` | null;
  nativeAuthBindingDigest: `sha256:${string}` | null;
  nextCacheBindingDigest: `sha256:${string}` | null;
  bindingSetDigest: `sha256:${string}` | null;
  storedBindings: readonly StoredBinding[];
}> {
  validateScope(input.scope);
  if (
    !isUlid(input.artifact.deploymentId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.artifact.digest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.artifact.bodyDigest) ||
    !/^multipart\/form-data;\s*boundary=[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(
      input.artifact.contentType,
    ) ||
    artifactBody.byteLength === 0
  ) {
    throw new CloudflareWfpInputError();
  }
  const bodyDigest = await sha256(artifactBody);
  if (bodyDigest !== input.artifact.bodyDigest) throw new CloudflareWfpInputError();
  const immutableScriptName = projectCandidateScriptName(
    input.scope.projectId,
    input.scope.environmentName,
    input.artifact.deploymentId,
  );
  const platformBindings = input.artifact.platformBindings;
  if (
    !isRecord(platformBindings) ||
    !hasExactKeys(platformBindings, [
      "immutableScriptName",
      "crons",
      ...(platformBindings["database"] === undefined ? [] : ["database"]),
      ...(platformBindings["storage"] === undefined ? [] : ["storage"]),
      ...(platformBindings["nativeAuth"] === undefined ? [] : ["nativeAuth"]),
      ...(platformBindings["nextCache"] === undefined ? [] : ["nextCache"]),
    ]) ||
    platformBindings["immutableScriptName"] !== immutableScriptName ||
    !Array.isArray(platformBindings["crons"])
  ) {
    throw new CloudflareWfpInputError();
  }
  const crons = platformBindings["crons"];
  if (
    crons.length > 8 ||
    crons.some(
      (cron, index) =>
        typeof cron !== "string" ||
        !CRON_PATTERN.test(cron) ||
        (index > 0 && cron <= String(crons[index - 1])),
    )
  ) {
    throw new CloudflareWfpInputError();
  }
  const cronsJson = JSON.stringify(crons);
  const cronBindingsDigest =
    crons.length === 0 ? null : await sha256(new TextEncoder().encode(cronsJson));
  const databaseBindingDigest = await computeDatabaseBindingDigest(
    platformBindings.database,
    input.scope,
  );
  const storageBindingDigest = await computeStorageBindingDigest(
    platformBindings.storage,
    input.scope,
    platformBindings.database,
  );
  const nativeAuthBindingDigest = await computeNativeAuthBindingDigest(
    platformBindings.nativeAuth,
    input.scope,
    input.artifact.deploymentId,
    namespace,
  );
  const nextCacheBindingDigest = await computeNextCacheBindingDigest(
    platformBindings.nextCache,
    input.scope,
    input.artifact.deploymentId,
    namespace,
  );
  const bindingSetDigest = await computeBindingSetDigest(
    cronBindingsDigest,
    databaseBindingDigest,
    storageBindingDigest,
    nativeAuthBindingDigest,
    nextCacheBindingDigest,
  );
  if (
    platformBindings.storage !== undefined &&
    platformBindings.storage.service !==
      `ohmyho-storage-gateway-${namespace.replace(/^ohmyho-/u, "")}`
  )
    throw new CloudflareWfpInputError();
  const storedBindings = validateWorkerPlatformBindings(
    artifactBody,
    input.artifact.contentType,
    namespace,
    immutableScriptName,
    cronsJson,
    cronBindingsDigest,
    platformBindings.database,
    databaseBindingDigest,
    platformBindings.storage,
    storageBindingDigest,
    platformBindings.nativeAuth,
    nativeAuthBindingDigest,
    platformBindings.nextCache,
    bindingSetDigest,
  );
  return {
    cronBindingsDigest,
    databaseBindingDigest,
    storageBindingDigest,
    nativeAuthBindingDigest,
    nextCacheBindingDigest,
    bindingSetDigest,
    storedBindings,
  };
}

/** A single compact attestation keeps cache-enabled scripts within Cloudflare's eight-tag limit. */
export async function computeBindingSetDigest(
  crons: `sha256:${string}` | null,
  database: `sha256:${string}` | null,
  storage: `sha256:${string}` | null,
  nativeAuth: `sha256:${string}` | null,
  nextCache: `sha256:${string}` | null,
): Promise<`sha256:${string}` | null> {
  return nextCache === null
    ? null
    : sha256(
        new TextEncoder().encode(JSON.stringify([crons, database, storage, nativeAuth, nextCache])),
      );
}
function sameBindingDigests(
  metadata: ScriptMetadata,
  combined: `sha256:${string}` | null,
  crons: `sha256:${string}` | null,
  database: `sha256:${string}` | null,
  storage: `sha256:${string}` | null,
  nativeAuth: `sha256:${string}` | null,
): boolean {
  return (
    metadata.bindingSetDigest === combined &&
    (combined !== null ||
      (metadata.cronBindingsDigest === crons &&
        metadata.databaseBindingDigest === database &&
        metadata.storageBindingDigest === storage &&
        metadata.nativeAuthBindingDigest === nativeAuth))
  );
}

export async function computeNextCacheBindingDigest(
  binding: WfpNextCacheBinding | undefined,
  scope: WfpScope,
  deploymentId: string,
  namespace: string,
): Promise<`sha256:${string}` | null> {
  if (binding === undefined) return null;
  if (
    !isRecord(binding) ||
    !hasExactKeys(binding, ["service", "props"]) ||
    !isRecord(binding.props) ||
    !hasExactKeys(binding.props, [
      "organizationId",
      "projectId",
      "environmentId",
      "deploymentId",
      "region",
    ]) ||
    !isUlid(binding.props.organizationId) ||
    binding.props.projectId !== scope.projectId ||
    binding.props.environmentId !== scope.environmentId ||
    binding.props.deploymentId !== deploymentId ||
    !isUlid(deploymentId) ||
    (binding.props.region !== "us" && binding.props.region !== "eu") ||
    !["ohmyho-sandbox", "ohmyho-poc-private-fullstack", "ohmyho-production"].includes(namespace) ||
    binding.service !== `ohmyho-next-cache-${namespace.replace(/^ohmyho-/u, "")}`
  )
    throw new CloudflareWfpInputError();
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        service: binding.service,
        props: {
          organizationId: binding.props.organizationId,
          projectId: binding.props.projectId,
          environmentId: binding.props.environmentId,
          deploymentId: binding.props.deploymentId,
          region: binding.props.region,
        },
      }),
    ),
  );
}

export async function computeNativeAuthBindingDigest(
  binding: WfpNativeAuthBinding | undefined,
  scope: WfpScope,
  deploymentId: string,
  namespace: string,
): Promise<`sha256:${string}` | null> {
  if (binding === undefined) return null;
  if (
    !isRecord(binding) ||
    !hasExactKeys(binding, ["service", "props"]) ||
    !isRecord(binding.props) ||
    !hasExactKeys(binding.props, [
      "organizationId",
      "projectId",
      "environmentId",
      "deploymentId",
    ]) ||
    !isUlid(binding.props.organizationId) ||
    binding.props.projectId !== scope.projectId ||
    binding.props.environmentId !== scope.environmentId ||
    binding.props.deploymentId !== deploymentId ||
    !isUlid(deploymentId)
  )
    throw new CloudflareWfpInputError();
  const environment =
    namespace === "ohmyho-production"
      ? "production"
      : namespace === "ohmyho-sandbox" || namespace === "ohmyho-poc-private-fullstack"
        ? "development"
        : null;
  if (
    environment === null ||
    !new RegExp(`^ohmyho-native-auth-${environment}-(us|eu)$`, "u").test(binding.service)
  )
    throw new CloudflareWfpInputError();
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        service: binding.service,
        props: {
          organizationId: binding.props.organizationId,
          projectId: binding.props.projectId,
          environmentId: binding.props.environmentId,
          deploymentId: binding.props.deploymentId,
        },
      }),
    ),
  );
}

/** Immutable storage identity comes only from the trusted assignment selected by Control. */
export async function computeStorageBindingDigest(
  storage: WfpStorageBinding | undefined,
  scope: WfpScope,
  database?: WfpDatabaseBinding,
): Promise<`sha256:${string}` | null> {
  if (storage === undefined) return null;
  if (
    !isRecord(storage) ||
    !hasExactKeys(storage, ["service", "props"]) ||
    !isRecord(storage.props)
  )
    throw new CloudflareWfpInputError();
  const props = storage.props;
  if (
    !hasExactKeys(props, ["organizationId", "projectId", "environmentId", "dataEnvironmentId"]) ||
    !isUlid(props.organizationId) ||
    props.projectId !== scope.projectId ||
    props.environmentId !== scope.environmentId ||
    !isUlid(props.dataEnvironmentId) ||
    typeof storage.service !== "string" ||
    !/^ohmyho-storage-gateway-(?:sandbox|poc-private-fullstack|production)$/u.test(storage.service)
  )
    throw new CloudflareWfpInputError();
  if (
    database !== undefined &&
    (props.organizationId !== database.props.organizationId ||
      props.dataEnvironmentId !== database.props.physicalEnvironmentId)
  )
    throw new CloudflareWfpInputError();
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        service: storage.service,
        props: {
          organizationId: props.organizationId,
          projectId: props.projectId,
          environmentId: props.environmentId,
          dataEnvironmentId: props.dataEnvironmentId,
        },
      }),
    ),
  );
}

/** Canonical trusted identity of the private database binding, committed into the artifact tag. */
export async function computeDatabaseBindingDigest(
  database: WfpDatabaseBinding | undefined,
  scope: WfpScope,
): Promise<`sha256:${string}` | null> {
  if (database === undefined) return null;
  if (
    !isRecord(database) ||
    !hasExactKeys(database, ["service", "props"]) ||
    !isRecord(database.props)
  )
    throw new CloudflareWfpInputError();
  const props = database.props;
  if (
    !hasExactKeys(props, [
      "organizationId",
      "projectId",
      "environmentId",
      "physicalEnvironmentId",
      "registrationVersion",
      "region",
    ]) ||
    !isUlid(props.organizationId) ||
    props.projectId !== scope.projectId ||
    props.environmentId !== scope.environmentId ||
    !isUlid(props.physicalEnvironmentId) ||
    !Number.isSafeInteger(props.registrationVersion) ||
    props.registrationVersion < 1 ||
    (props.region !== "us" && props.region !== "eu") ||
    typeof database.service !== "string" ||
    !new RegExp(
      `^ohmyho-project-database-(?:sandbox|development|production)-${props.region}$`,
      "u",
    ).test(database.service)
  )
    throw new CloudflareWfpInputError();
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        service: database.service,
        props: {
          organizationId: props.organizationId,
          projectId: props.projectId,
          environmentId: props.environmentId,
          physicalEnvironmentId: props.physicalEnvironmentId,
          registrationVersion: props.registrationVersion,
          region: props.region,
        },
      }),
    ),
  );
}

/** Five-field UTC cron with a single minute or a step of at least five minutes. */
const CRON_PATTERN =
  /^(?:\*\/(?:[5-9]|[1-5][0-9])|[0-9]|[1-5][0-9]) (?:\*|[0-9]|1[0-9]|2[0-3]) (?:\*|[1-9]|[12][0-9]|3[01]) (?:\*|[1-9]|1[0-2]) (?:\*|[0-6])$/u;

/** Platform plain_text names: the only plain_text bindings a customer Worker may carry. */
const PLATFORM_PLAIN_TEXT_NAMES: ReadonlySet<string> = new Set([
  "BETTER_AUTH_URL",
  "OHMYHOST_AI_BASE_URL",
  "OHMYHOST_BROWSER_BASE_URL",
  "OHMYHOST_CRONS",
  "OHMYHOST_ENVIRONMENT_ID",
  "OHMYHOST_IMMUTABLE_SCRIPT_NAME",
  "OHMYHOST_MAIL_GATEWAY_URL",
  "OHMYHOST_PROJECT_ID",
  "OHMYHOST_STORAGE_GATEWAY_URL",
]);

/** A binding identity as Cloudflare reports it. Values of plain_text and secret_text never enter it. */
interface StoredBinding {
  readonly type: string;
  readonly name: string;
  readonly service?: string;
  readonly entrypoint?: string;
}

function validateWorkerPlatformBindings(
  body: Uint8Array,
  contentType: string,
  namespace: string,
  immutableScriptName: string,
  cronsJson: string,
  cronBindingsDigest: `sha256:${string}` | null,
  database: WfpDatabaseBinding | undefined,
  databaseBindingDigest: `sha256:${string}` | null,
  storage: WfpStorageBinding | undefined,
  storageBindingDigest: `sha256:${string}` | null,
  nativeAuth: WfpNativeAuthBinding | undefined,
  nativeAuthBindingDigest: `sha256:${string}` | null,
  nextCache: WfpNextCacheBinding | undefined,
  bindingSetDigest: `sha256:${string}` | null,
): readonly StoredBinding[] {
  const metadata = readMetadataPart(body, contentType);
  if (
    !isRecord(metadata) ||
    !Array.isArray(metadata["bindings"]) ||
    !Array.isArray(metadata["tags"])
  ) {
    throw new CloudflareWfpInputError();
  }
  const layouts = metadata["tags"].filter(
    (tag) => typeof tag === "string" && tag.startsWith("layout:"),
  );
  if (layouts.length !== 1 || layouts[0] !== WFP_CANDIDATE_LAYOUT_TAG)
    throw new CloudflareWfpInputError();
  if (nextCache !== undefined && metadata["tags"].length > 8) throw new CloudflareWfpInputError();
  const combinedTags = metadata["tags"].filter(
    (tag) => typeof tag === "string" && tag.startsWith("bindings:"),
  );
  if (
    bindingSetDigest === null
      ? combinedTags.length !== 0
      : combinedTags.length !== 1 || combinedTags[0] !== `bindings:${bindingSetDigest}`
  )
    throw new CloudflareWfpInputError();
  const bindingValues = new Map<string, unknown>();
  for (const binding of metadata["bindings"]) {
    if (!isRecord(binding) || typeof binding["name"] !== "string")
      throw new CloudflareWfpInputError();
    if (bindingValues.has(binding["name"])) throw new CloudflareWfpInputError();
    bindingValues.set(binding["name"], binding);
  }
  const databaseBinding = bindingValues.get("OHMYHOST_DATABASE");
  const databaseTags = metadata["tags"].filter(
    (tag) => typeof tag === "string" && tag.startsWith("database:"),
  );
  if (database === undefined) {
    if (databaseBinding !== undefined || databaseTags.length !== 0)
      throw new CloudflareWfpInputError();
  } else if (
    !isRecord(databaseBinding) ||
    !hasExactKeys(databaseBinding, ["type", "name", "service", "entrypoint", "props"]) ||
    databaseBinding["type"] !== "service" ||
    databaseBinding["service"] !== database.service ||
    databaseBinding["entrypoint"] !== "ProjectDatabaseService" ||
    !isRecord(databaseBinding["props"]) ||
    !hasExactKeys(databaseBinding["props"], Object.keys(database.props)) ||
    Object.entries(database.props).some(
      ([key, value]) => (databaseBinding["props"] as Record<string, unknown>)[key] !== value,
    ) ||
    (bindingSetDigest === null
      ? databaseTags.length !== 1 || databaseTags[0] !== `database:${databaseBindingDigest}`
      : databaseTags.length !== 0)
  )
    throw new CloudflareWfpInputError();
  const storageBinding = bindingValues.get("OHMYHOST_STORAGE_GATEWAY");
  const nativeBinding = bindingValues.get("OHMYHOST_AUTH");
  const nativeTags = metadata["tags"].filter(
    (tag) => typeof tag === "string" && tag.startsWith("native-auth:"),
  );
  if (nativeAuth === undefined) {
    if (nativeBinding !== undefined || nativeTags.length !== 0) throw new CloudflareWfpInputError();
  } else if (
    !isRecord(nativeBinding) ||
    !hasExactKeys(nativeBinding, ["type", "name", "service", "entrypoint", "props"]) ||
    nativeBinding["type"] !== "service" ||
    nativeBinding["service"] !== nativeAuth.service ||
    nativeBinding["entrypoint"] !== "NativeSessionService" ||
    !isRecord(nativeBinding["props"]) ||
    !hasExactKeys(nativeBinding["props"], Object.keys(nativeAuth.props)) ||
    Object.entries(nativeAuth.props).some(
      ([key, value]) => (nativeBinding["props"] as Record<string, unknown>)[key] !== value,
    ) ||
    (bindingSetDigest === null
      ? nativeTags.length !== 1 || nativeTags[0] !== `native-auth:${nativeAuthBindingDigest}`
      : nativeTags.length !== 0)
  )
    throw new CloudflareWfpInputError();
  const cacheBinding = bindingValues.get("OHMYHOST_NEXT_CACHE");
  if (nextCache === undefined) {
    if (cacheBinding !== undefined) throw new CloudflareWfpInputError();
  } else if (
    !isRecord(cacheBinding) ||
    !hasExactKeys(cacheBinding, ["type", "name", "service", "entrypoint", "props"]) ||
    cacheBinding["type"] !== "service" ||
    cacheBinding["service"] !== nextCache.service ||
    cacheBinding["entrypoint"] !== "NextCacheRuntime" ||
    !isRecord(cacheBinding["props"]) ||
    !hasExactKeys(cacheBinding["props"], Object.keys(nextCache.props)) ||
    Object.entries(nextCache.props).some(
      ([key, value]) => (cacheBinding["props"] as Record<string, unknown>)[key] !== value,
    ) ||
    bindingSetDigest === null
  )
    throw new CloudflareWfpInputError();
  const storageTags = metadata["tags"].filter(
    (tag) => typeof tag === "string" && tag.startsWith("storage:"),
  );
  if (storage === undefined) {
    if (storageBinding !== undefined || storageTags.length !== 0)
      throw new CloudflareWfpInputError();
  } else if (
    !isRecord(storageBinding) ||
    !hasExactKeys(storageBinding, ["type", "name", "service", "props"]) ||
    storageBinding["type"] !== "service" ||
    storageBinding["service"] !== storage.service ||
    !isRecord(storageBinding["props"]) ||
    !hasExactKeys(storageBinding["props"], Object.keys(storage.props)) ||
    Object.entries(storage.props).some(
      ([key, value]) => (storageBinding["props"] as Record<string, unknown>)[key] !== value,
    ) ||
    (bindingSetDigest === null
      ? storageTags.length !== 1 || storageTags[0] !== `storage:${storageBindingDigest}`
      : storageTags.length !== 0)
  )
    throw new CloudflareWfpInputError();
  const cronBinding = bindingValues.get("OHMYHOST_CRONS");
  const immutable = bindingValues.get("OHMYHOST_IMMUTABLE_SCRIPT_NAME");
  if (cronBindingsDigest === null) {
    if (cronBinding !== undefined || immutable !== undefined) throw new CloudflareWfpInputError();
  } else if (
    !isRecord(cronBinding) ||
    !hasExactKeys(cronBinding, ["name", "text", "type"]) ||
    cronBinding["type"] !== "plain_text" ||
    cronBinding["text"] !== cronsJson ||
    !isRecord(immutable) ||
    !hasExactKeys(immutable, ["name", "text", "type"]) ||
    immutable["type"] !== "plain_text" ||
    immutable["text"] !== immutableScriptName
  ) {
    throw new CloudflareWfpInputError();
  }
  const cronTags = metadata["tags"].filter(
    (tag): tag is string => typeof tag === "string" && tag.startsWith("crons:"),
  );
  if (
    bindingSetDigest !== null || cronBindingsDigest === null
      ? cronTags.length !== 0
      : cronTags.length !== 1 || cronTags[0] !== `crons:${cronBindingsDigest}`
  ) {
    throw new CloudflareWfpInputError();
  }
  return Object.freeze(
    metadata["bindings"].map((binding) => expectedStoredBinding(binding, namespace)),
  );
}

/** Deny by default: only the closed platform set of binding types and names may be uploaded. */
function expectedStoredBinding(binding: unknown, namespace: string): StoredBinding {
  if (
    !isRecord(binding) ||
    typeof binding["name"] !== "string" ||
    typeof binding["type"] !== "string"
  )
    throw new CloudflareWfpInputError();
  const name = binding["name"];
  const type = binding["type"];
  if (type === "assets" || type === "images") {
    if (
      !hasExactKeys(binding, ["name", "type"]) ||
      name !== (type === "assets" ? "ASSETS" : "IMAGES")
    )
      throw new CloudflareWfpInputError();
    return Object.freeze({ type, name });
  }
  if (type === "plain_text" || type === "secret_text") {
    if (
      !hasExactKeys(binding, ["name", "text", "type"]) ||
      typeof binding["text"] !== "string" ||
      (type === "plain_text"
        ? !PLATFORM_PLAIN_TEXT_NAMES.has(name)
        : !RUNTIME_SECRET_NAME_PATTERN.test(name))
    )
      throw new CloudflareWfpInputError();
    return Object.freeze({ type, name });
  }
  if (type === "service" && name === "OHMYHOST_DATABASE") {
    // The database identity was already checked against the trusted binding in the caller.
    if (typeof binding["service"] !== "string") throw new CloudflareWfpInputError();
    return Object.freeze({
      type,
      name,
      service: binding["service"],
      entrypoint: "ProjectDatabaseService",
    });
  }
  if (type === "service" && name === "OHMYHOST_NEXT_CACHE") {
    if (typeof binding["service"] !== "string") throw new CloudflareWfpInputError();
    return Object.freeze({
      type,
      name,
      service: binding["service"],
      entrypoint: "NextCacheRuntime",
    });
  }
  if (type === "service" && name === "OHMYHOST_AUTH") {
    if (typeof binding["service"] !== "string") throw new CloudflareWfpInputError();
    return Object.freeze({
      type,
      name,
      service: binding["service"],
      entrypoint: "NativeSessionService",
    });
  }
  if (type === "service" && name === "OHMYHOST_STORAGE_GATEWAY") {
    if (typeof binding["service"] !== "string") throw new CloudflareWfpInputError();
    return Object.freeze({ type, name, service: binding["service"] });
  }
  if (
    type === "service" &&
    name === "OHMYHOST_MAIL_GATEWAY" &&
    hasExactKeys(binding, ["name", "service", "type"]) &&
    binding["service"] === `ohmyho-mail-gateway-${namespace.replace(/^ohmyho-/u, "")}`
  ) {
    return Object.freeze({ type, name, service: binding["service"] });
  }
  throw new CloudflareWfpInputError();
}

/** The part header block exactly as encodeWorkerMultipart writes it; any other block is refused. */
const PART_HEADERS_PATTERN =
  /^Content-Disposition: form-data; name="([^"\r\n]+)"(?:; filename="\1")?\r\nContent-Type: [^\r\n]+$/u;

/**
 * Reads the whole multipart body. The first part must be the only `metadata` part, and no byte
 * sequence inside a module may open another part: the platform bindings come from that part alone.
 */
function readMetadataPart(body: Uint8Array, contentType: string): unknown {
  const boundary = contentType.slice(contentType.indexOf("boundary=") + "boundary=".length);
  const delimiter = `--${boundary}`;
  // Latin-1 maps every byte to one character, so offsets and delimiter matches are byte-exact.
  const text = Buffer.from(body).toString("latin1");
  if (!text.startsWith(`${delimiter}\r\n`)) throw new CloudflareWfpInputError();
  let metadata = "";
  let parts = 0;
  let cursor = delimiter.length + 2;
  for (;;) {
    const headersEnd = text.indexOf("\r\n\r\n", cursor);
    if (headersEnd < 0) throw new CloudflareWfpInputError();
    const name = PART_HEADERS_PATTERN.exec(text.slice(cursor, headersEnd))?.[1];
    const contentStart = headersEnd + 4;
    const next = text.indexOf(`\r\n${delimiter}`, contentStart);
    if (name === undefined || next < 0) throw new CloudflareWfpInputError();
    if (parts === 0 ? name !== "metadata" : name === "metadata")
      throw new CloudflareWfpInputError();
    if (parts === 0) metadata = text.slice(contentStart, next);
    parts += 1;
    const end = next + 2 + delimiter.length;
    if (text.startsWith("--\r\n", end)) {
      if (end + 4 !== text.length) throw new CloudflareWfpInputError();
      break;
    }
    if (!text.startsWith("\r\n", end)) throw new CloudflareWfpInputError();
    cursor = end + 2;
  }
  // Each delimiter occurrence is a part opening or the closing delimiter; any other one is refused.
  if (text.split(delimiter).length - 1 !== parts + 1) throw new CloudflareWfpInputError();
  try {
    return JSON.parse(Buffer.from(metadata, "latin1").toString("utf8"));
  } catch {
    throw new CloudflareWfpInputError();
  }
}

function scriptMatchesReceipt(
  script: ScriptMetadata | null,
  receipt: WfpDeploymentReceipt,
): boolean {
  return (
    script !== null &&
    script.providerTag === receipt.providerTag &&
    script.productDeploymentId === receipt.productDeploymentId &&
    script.artifactDigest === receipt.artifactDigest
  );
}

function scriptMatchesArtifactReceipt(
  script: ScriptMetadata | null,
  receipt: WfpDeploymentReceipt,
): boolean {
  return (
    script !== null &&
    script.productDeploymentId === receipt.productDeploymentId &&
    script.artifactDigest === receipt.artifactDigest &&
    script.bindingSetDigest ===
      (Object.hasOwn(receipt, "bindingSetDigest") ? receipt.bindingSetDigest : null)
  );
}

function deploymentReceipt(
  target: ScriptMetadata,
  scope: WfpScope,
  namespace: string,
  buildReused: boolean,
  bindingSetDigest: `sha256:${string}` | null,
): WfpDeploymentReceipt {
  if (target.artifactDigest === null) throw new CloudflareWfpContractError();
  return Object.freeze({
    provider: "cloudflare-wfp" as const,
    namespace,
    scriptName: target.scriptName,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    productDeploymentId: target.productDeploymentId,
    providerTag: target.providerTag,
    artifactDigest: target.artifactDigest,
    ...(bindingSetDigest === null ? {} : { bindingSetDigest }),
    buildReused,
    deployedAt: new Date(target.modifiedAt.getTime()),
  });
}

async function validateRuntimeSecretSyncInput(
  input: WfpSyncRuntimeSecretsInput,
): Promise<readonly RuntimeSecretBinding[]> {
  validateScope(input.scope);
  if (
    !isRecord(input.manifest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.manifest.digest) ||
    !Array.isArray(input.manifest.secrets)
  ) {
    throw new CloudflareWfpInputError();
  }
  const secrets = input.manifest.secrets.map((secret) => Object.freeze({ ...secret }));
  validateRuntimeSecretManifestEntries(secrets);
  await validateRuntimeSecretValues(secrets);
  const manifestDigest = await computeRuntimeSecretManifestDigest(secrets);
  if (manifestDigest !== input.manifest.digest) throw new CloudflareWfpInputError();
  return Object.freeze(secrets);
}

async function validateRuntimeSecretValues(
  secrets: readonly RuntimeSecretBinding[],
): Promise<void> {
  const encoder = new TextEncoder();
  for (const secret of secrets) {
    if (typeof secret.value !== "string") throw new CloudflareWfpInputError();
    const value = encoder.encode(secret.value);
    if (
      value.byteLength === 0 ||
      value.byteLength > MAX_RUNTIME_SECRET_VALUE_BYTES ||
      (await sha256(value)) !== secret.valueSha256
    ) {
      throw new CloudflareWfpInputError();
    }
  }
}

function validateRuntimeSecretManifestEntries(
  secrets: readonly Pick<RuntimeSecretBinding, "name" | "revision" | "valueSha256">[],
): void {
  if (secrets.length > MAX_RUNTIME_SECRETS) throw new CloudflareWfpInputError();
  let previousName: string | null = null;
  for (const secret of secrets) {
    if (
      !RUNTIME_SECRET_NAME_PATTERN.test(secret.name) ||
      !Number.isSafeInteger(secret.revision) ||
      secret.revision < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(secret.valueSha256) ||
      (previousName !== null && secret.name <= previousName)
    ) {
      throw new CloudflareWfpInputError();
    }
    previousName = secret.name;
  }
}

function validateScope(scope: WfpScope): void {
  if (
    !isUlid(scope.projectId) ||
    !isUlid(scope.environmentId) ||
    !isProjectEnvironmentName(scope.environmentName) ||
    !isProjectHandle(scope.handle)
  ) {
    throw new CloudflareWfpInputError();
  }
}

function validateReceipt(receipt: WfpDeploymentReceipt, scope: WfpScope, namespace: string): void {
  if (
    receipt.provider !== "cloudflare-wfp" ||
    receipt.namespace !== namespace ||
    receipt.projectId !== scope.projectId ||
    receipt.environmentId !== scope.environmentId ||
    !isUlid(receipt.productDeploymentId) ||
    receipt.scriptName !==
      projectCandidateScriptName(
        scope.projectId,
        scope.environmentName,
        receipt.productDeploymentId,
      ) ||
    !isProviderTag(receipt.providerTag) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.artifactDigest) ||
    (Object.hasOwn(receipt, "bindingSetDigest") && !isSha256(receipt.bindingSetDigest))
  ) {
    throw new CloudflareWfpInputError();
  }
}

async function readUploadState(
  response: Response,
  expectedScript: string,
): Promise<UploadMetadata> {
  const result = await requireSuccessfulEnvelope(response);
  if (!isRecord(result)) throw new CloudflareWfpContractError();
  const id = result["id"];
  const scriptTag = result["tag"];
  if (id !== expectedScript || typeof scriptTag !== "string" || !isScriptTag(scriptTag)) {
    throw new CloudflareWfpContractError();
  }
  return Object.freeze({ scriptName: id, scriptTag });
}

async function readScriptDetails(
  response: Response,
  expectedScript: string,
  expectedScope: WfpScope,
  expectedNamespace: string,
): Promise<ScriptMetadata | null> {
  const result = await requireSuccessfulEnvelope(response);
  if (!isRecord(result)) throw new CloudflareWfpContractError();
  if (result["script"] === null) {
    if (
      !hasExactKeys(result, ["created_on", "dispatch_namespace", "modified_on", "script"]) ||
      result["dispatch_namespace"] !== expectedNamespace ||
      !Number.isFinite(Date.parse(String(result["created_on"]))) ||
      !Number.isFinite(Date.parse(String(result["modified_on"])))
    ) {
      throw new CloudflareWfpContractError();
    }
    return null;
  }
  const script = result["script"];
  const modifiedOn = result["modified_on"];
  if (!isRecord(script) || typeof modifiedOn !== "string") {
    throw new CloudflareWfpContractError();
  }
  const id = script["id"];
  const scriptTag = script["tag"];
  const deploymentId = script["deployment_id"];
  const tags = script["tags"];
  if (
    id !== expectedScript ||
    typeof scriptTag !== "string" ||
    !isScriptTag(scriptTag) ||
    typeof deploymentId !== "string" ||
    !isProviderTag(deploymentId) ||
    !Array.isArray(tags)
  ) {
    throw new CloudflareWfpContractError();
  }
  const identity = readArtifactIdentity(tags, expectedScope);
  const parsedModifiedOn = new Date(modifiedOn);
  if (!Number.isFinite(parsedModifiedOn.getTime())) throw new CloudflareWfpContractError();
  return Object.freeze({
    scriptName: id,
    providerTag: scriptTag,
    ...identity,
    modifiedAt: parsedModifiedOn,
  });
}

async function requireSuccessfulEnvelope(response: Response): Promise<unknown> {
  const envelope = await readEnvelope(response);
  if (
    typeof envelope["success"] !== "boolean" ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"])
  ) {
    throw new CloudflareWfpContractError();
  }
  if (!response.ok || envelope["success"] !== true) {
    const providerError = (envelope["errors"] as unknown[]).find(
      (error) =>
        isRecord(error) &&
        Number.isSafeInteger(error["code"]) &&
        Number(error["code"]) >= 1 &&
        Number(error["code"]) <= 999_999,
    );
    throw new CloudflareWfpRequestError(
      response.status,
      isRecord(providerError) ? Number(providerError["code"]) : undefined,
      providerErrorPointer(providerError),
    );
  }
  if ((envelope["errors"] as unknown[]).length !== 0) {
    throw new CloudflareWfpContractError();
  }
  return envelope["result"];
}

function providerErrorPointer(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error["source"])) return undefined;
  const pointer = error["source"]["pointer"];
  return typeof pointer === "string" &&
    pointer.length <= 128 &&
    /^\/[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+){0,7}$/u.test(pointer)
    ? pointer
    : undefined;
}

async function readRuntimeSecretBindings(
  response: Response,
): Promise<readonly RuntimeSecretObservedBinding[]> {
  const result = await requireSuccessfulSecretEnvelope(response);
  if (!Array.isArray(result)) throw new CloudflareWfpContractError();
  const bindings = result
    .map(readRuntimeSecretBinding)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (bindings.length > MAX_RUNTIME_SECRETS) throw new CloudflareWfpContractError();
  for (let index = 1; index < bindings.length; index += 1) {
    if (bindings[index - 1]?.name === bindings[index]?.name) {
      throw new CloudflareWfpContractError();
    }
  }
  return Object.freeze(bindings);
}

async function readStoredBindingList(response: Response): Promise<readonly StoredBinding[]> {
  const result = await requireSuccessfulEnvelope(response);
  if (!Array.isArray(result)) throw new CloudflareWfpContractError();
  return Object.freeze(result.map(readStoredBinding));
}

function readStoredBinding(value: unknown): StoredBinding {
  if (!isRecord(value) || typeof value["type"] !== "string" || typeof value["name"] !== "string")
    throw new CloudflareWfpContractError();
  return Object.freeze({
    type: value["type"],
    name: value["name"],
    ...(typeof value["service"] === "string" ? { service: value["service"] } : {}),
    ...(typeof value["entrypoint"] === "string" ? { entrypoint: value["entrypoint"] } : {}),
  });
}

function sameStoredBindings(
  observed: readonly StoredBinding[],
  expected: readonly StoredBinding[],
): boolean {
  const byName = (left: StoredBinding, right: StoredBinding): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  const actual = [...observed].sort(byName);
  const wanted = [...expected].sort(byName);
  return (
    actual.length === wanted.length &&
    wanted.every((binding, index) => {
      const stored = actual[index];
      return (
        stored !== undefined &&
        stored.type === binding.type &&
        stored.name === binding.name &&
        stored.service === binding.service &&
        stored.entrypoint === binding.entrypoint
      );
    })
  );
}

async function requireRuntimeSecretBulkEnvelope(response: Response): Promise<void> {
  const result = await requireSuccessfulSecretEnvelope(response);
  if (result === null) return;
  if (Array.isArray(result)) {
    if (result.length > MAX_RUNTIME_SECRETS) throw new CloudflareWfpContractError();
    for (const value of result) readRedactedBulkBinding(value);
    return;
  }
  if (!isRecord(result) || Object.keys(result).length > MAX_RUNTIME_SECRETS) {
    throw new CloudflareWfpContractError();
  }
  for (const [name, value] of Object.entries(result)) {
    if (readRedactedBulkBinding(value) !== name) throw new CloudflareWfpContractError();
  }
}

function readRedactedBulkBinding(value: unknown): string {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["name", "type"]) ||
    (value["type"] !== "secret_text" && value["type"] !== "plain_text") ||
    typeof value["name"] !== "string" ||
    !RUNTIME_SECRET_NAME_PATTERN.test(value["name"])
  ) {
    throw new CloudflareWfpContractError();
  }
  return value["name"];
}

async function requireSuccessfulSecretEnvelope(response: Response): Promise<unknown> {
  const envelope = await readEnvelope(response);
  if (containsPlaintextField(envelope["result"])) throw new CloudflareWfpContractError();
  if (
    typeof envelope["success"] !== "boolean" ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"])
  ) {
    throw new CloudflareWfpContractError();
  }
  if (!response.ok || envelope["success"] !== true) {
    throw new CloudflareWfpRequestError(response.status);
  }
  return envelope["result"];
}

function readRuntimeSecretBinding(value: unknown): RuntimeSecretObservedBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["name", "type"]) ||
    value["type"] !== "secret_text" ||
    typeof value["name"] !== "string" ||
    !RUNTIME_SECRET_NAME_PATTERN.test(value["name"])
  ) {
    throw new CloudflareWfpContractError();
  }
  return Object.freeze({ name: value["name"], type: "secret_text" as const });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function containsPlaintextField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPlaintextField);
  if (!isRecord(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "text") ||
    Object.values(value).some(containsPlaintextField)
  );
}

function runtimeSecretBinding(
  secret: Pick<RuntimeSecretBinding, "name">,
): RuntimeSecretObservedBinding {
  return Object.freeze({ name: secret.name, type: "secret_text" as const });
}

function sameRuntimeSecretBindings(
  left: readonly RuntimeSecretObservedBinding[],
  right: readonly RuntimeSecretObservedBinding[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (binding, index) =>
        binding.name === right[index]?.name && binding.type === right[index]?.type,
    )
  );
}

async function requireMissingScriptEnvelope(response: Response): Promise<void> {
  const envelope = await readEnvelope(response);
  const errors = envelope["errors"];
  if (
    envelope["success"] !== false ||
    envelope["result"] !== null ||
    !Array.isArray(errors) ||
    !errors.some((error) => isRecord(error) && error["code"] === 10007)
  ) {
    throw new CloudflareWfpRequestError(response.status);
  }
}

async function requireMissingDispatchScriptEnvelope(
  response: Response,
  expectedNamespace: string,
): Promise<void> {
  const envelope = await readEnvelope(response);
  const result = envelope["result"];
  if (
    response.status !== 200 ||
    envelope["success"] !== true ||
    !Array.isArray(envelope["errors"]) ||
    envelope["errors"].length !== 0 ||
    !Array.isArray(envelope["messages"]) ||
    !isRecord(result) ||
    !hasExactKeys(result, ["created_on", "dispatch_namespace", "modified_on", "script"]) ||
    result["dispatch_namespace"] !== expectedNamespace ||
    result["script"] !== null ||
    !Number.isFinite(Date.parse(String(result["created_on"]))) ||
    !Number.isFinite(Date.parse(String(result["modified_on"])))
  ) {
    throw new CloudflareWfpContractError();
  }
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new CloudflareWfpContractError();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CloudflareWfpContractError();
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new CloudflareWfpContractError();
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new CloudflareWfpContractError();
  }
  if (!isRecord(envelope)) throw new CloudflareWfpContractError();
  return envelope;
}

function checkedNow(now: () => Date): Date {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) throw new CloudflareWfpInputError();
  return value;
}

function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
}

function isProjectEnvironmentName(value: unknown): value is "dev" | "prod" {
  return value === "dev" || value === "prod";
}

/** Accepts exactly the customer-chosen handles the control plane accepts (shared rule). */
function isProjectHandle(value: unknown): value is string {
  return typeof value === "string" && projectHandleProblem(value) === null;
}

function isProviderTag(value: string): boolean {
  return /^[a-f0-9]{32}$/u.test(value);
}

function isScriptTag(value: string): boolean {
  return /^[a-f0-9]{32}$/u.test(value);
}

function readArtifactIdentity(tags: readonly unknown[], scope: WfpScope) {
  if (tags.length < 3 || tags.length > 11 || tags.some((tag) => typeof tag !== "string")) {
    throw new CloudflareWfpContractError();
  }
  const values = new Set(tags as readonly string[]);
  const deployments = [...values].filter((tag) => tag.startsWith("deployment:"));
  const artifacts = [...values].filter((tag) => tag.startsWith("artifact:"));
  const runtimeTags = [...values].filter((tag) => tag.startsWith("runtime:"));
  const cronTags = [...values].filter((tag) => tag.startsWith("crons:"));
  const databaseTags = [...values].filter((tag) => tag.startsWith("database:"));
  const storageTags = [...values].filter((tag) => tag.startsWith("storage:"));
  const nativeAuthTags = [...values].filter((tag) => tag.startsWith("native-auth:"));
  const bindingSetTags = [...values].filter((tag) => tag.startsWith("bindings:"));
  const layoutTags = [...values].filter((tag) => tag.startsWith("layout:"));
  if (
    values.size !== tags.length ||
    !values.has(`project:${scope.projectId}`) ||
    !values.has(`environment:${scope.environmentId}`) ||
    deployments.length !== 1 ||
    artifacts.length > 1 ||
    (runtimeTags.length !== 0 && (runtimeTags.length !== 1 || runtimeTags[0] !== "runtime:edge")) ||
    cronTags.length > 1 ||
    databaseTags.length > 1 ||
    storageTags.length > 1 ||
    nativeAuthTags.length > 1 ||
    bindingSetTags.length > 1 ||
    (bindingSetTags.length === 1 &&
      cronTags.length + databaseTags.length + storageTags.length + nativeAuthTags.length !== 0) ||
    layoutTags.length > 1
  ) {
    throw new CloudflareWfpContractError();
  }
  const deploymentId = deployments[0]?.slice("deployment:".length);
  if (deploymentId === undefined || !isUlid(deploymentId)) {
    throw new CloudflareWfpContractError();
  }
  const artifactDigest = artifacts[0]?.slice("artifact:".length) ?? null;
  if (artifactDigest !== null && !isSha256(artifactDigest)) {
    throw new CloudflareWfpContractError();
  }
  const cronBindingsDigest = cronTags[0]?.slice("crons:".length) ?? null;
  if (cronBindingsDigest !== null && !isSha256(cronBindingsDigest)) {
    throw new CloudflareWfpContractError();
  }
  const databaseBindingDigest = databaseTags[0]?.slice("database:".length) ?? null;
  if (databaseBindingDigest !== null && !isSha256(databaseBindingDigest))
    throw new CloudflareWfpContractError();
  const storageBindingDigest = storageTags[0]?.slice("storage:".length) ?? null;
  if (storageBindingDigest !== null && !isSha256(storageBindingDigest))
    throw new CloudflareWfpContractError();
  const nativeAuthBindingDigest = nativeAuthTags[0]?.slice("native-auth:".length) ?? null;
  if (nativeAuthBindingDigest !== null && !isSha256(nativeAuthBindingDigest))
    throw new CloudflareWfpContractError();
  const bindingSetDigest = bindingSetTags[0]?.slice("bindings:".length) ?? null;
  if (bindingSetDigest !== null && !isSha256(bindingSetDigest))
    throw new CloudflareWfpContractError();
  return Object.freeze({
    productDeploymentId: deploymentId,
    artifactDigest,
    cronBindingsDigest,
    databaseBindingDigest,
    storageBindingDigest,
    nativeAuthBindingDigest,
    bindingSetDigest,
    currentLayout: layoutTags[0] === WFP_CANDIDATE_LAYOUT_TAG,
  });
}

async function sha256(body: Uint8Array): Promise<`sha256:${string}`> {
  // The upload already owns its custody snapshot. Reuse its exact range for WebCrypto.
  const owned =
    body.buffer instanceof ArrayBuffer ? (body as Uint8Array<ArrayBuffer>) : Uint8Array.from(body);
  const hash = createHash("sha256");
  for (let offset = 0; offset < owned.byteLength; offset += 65_536) {
    hash.update(owned.subarray(offset, Math.min(offset + 65_536, owned.byteLength)));
  }
  return `sha256:${hash.digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isUncertainMutationError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    isAbortError(error) ||
    (error instanceof CloudflareWfpRequestError &&
      error.status !== undefined &&
      error.status >= 500)
  );
}
