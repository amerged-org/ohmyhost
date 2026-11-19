import { DirectoryBackup } from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  browserContentSecurityPolicy,
  secureBrowserCors,
} from "@ohmyhost/wfp-dispatch/browser-security";
import type {
  PreviewRuntimeFence,
  PreviewRuntimeRecord,
  PreviewUsageReporterRuntime,
  ProjectPreviewRuntime,
} from "@ohmyhost/contracts/previews";
import type { FrameworkPlan } from "@ohmyhost/platform";
import { BoundedDirectoryBackup, PreviewBackups } from "./backup.js";
import {
  PreviewBackupGrantLedger,
  type BackupPartObservation,
  type BackupTransferMessage,
  type BackupTransferPermit,
} from "./backup-transfer.js";
import {
  createPreviewCapabilityHandler,
  type PreviewCapabilityBindings,
  type PreviewCapabilitySelection,
} from "./capability-bridge.js";
import { PreviewConnections } from "./connections.js";
import {
  createSourceWriter,
  installDependencies,
  prepareApplicationCaches,
  prepareFramework,
  prepareWorkspace,
  startFramework,
} from "./container.js";
import { PreviewDatabaseHandles } from "./database-handles.js";
import {
  hashPreviewToken,
  isPreviewMutationAllowed,
  previewId,
  previewTokenFromRequest,
  unavailable,
} from "./protocol.js";
import { PreviewSessionController, type PreviewSessionDriver } from "./session.js";
import { statusPage } from "./status-page.js";
import { sameSourceVersion } from "./source-sync.js";
import { observePreviewUsage, resolvePreviewApplication } from "./usage-provider.js";
import type {
  PreviewContainer,
  PreviewSourcePort,
  PreviewSourceResult,
  PreviewStorage,
} from "./runtime-types.js";
export { PreviewBackupGateway } from "./backup-gateway.js";

async function boundedBackupCleanup(operation: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("preview_backup_multipart_outcome_unknown")), 30_000);
  });
  try {
    await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface SessionStub {
  fetch(request: Request): Promise<Response>;
  wake(fence: PreviewRuntimeFence, publicOrigin: string): Promise<void>;
  sourceChanged(sequence: number): Promise<void>;
  fence(fence: PreviewRuntimeFence, reason: "rotate" | "destroy"): Promise<void>;
  cleanupScope(fence: PreviewRuntimeFence): Promise<string | null>;
  expireBackup(fence: PreviewRuntimeFence): Promise<void>;
  refreshNative(): Promise<void>;
  database(input: {
    fence: PreviewRuntimeFence;
    region: "eu" | "us";
    operation: "open" | "openRls" | "connection-query" | "connection-commit" | "connection-close";
    input: unknown;
  }): Promise<unknown>;
}
interface SessionNamespace {
  getByName(name: string): SessionStub;
  idFromName(name: string): { toString(): string };
}
interface NativePreview {
  validatePreviewSession(input: {
    fence: PreviewRuntimeFence;
    cookie: string;
    publicOrigin: string;
  }): Promise<unknown>;
  fetchPreview(
    request: Request,
    input: { fence: PreviewRuntimeFence; publicOrigin: string; clientAddress: string },
  ): Promise<Response>;
  drainPreview(input: { fence: PreviewRuntimeFence }): Promise<void>;
}
interface RuntimeSecrets {
  readCustomerVariables(input: {
    fence: PreviewRuntimeFence;
    names?: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
  fetchPreview(request: Request, fence: PreviewRuntimeFence): Promise<Response>;
}
interface RuntimeEnvironment {
  readonly PREVIEW_AUTHORITY: ProjectPreviewRuntime;
  readonly PREVIEW_SOURCE: PreviewSourcePort;
  readonly PREVIEW_CONTAINERS: SessionNamespace;
  readonly PREVIEW_USAGE_REPORTER: PreviewUsageReporterRuntime;
  readonly PREVIEW_RUNTIME_SECRETS?: RuntimeSecrets;
  readonly PREVIEW_NATIVE_PREPARATION?: {
    prepare(input: { operationId: string }): Promise<unknown>;
  };
  readonly DATABASE_PREVIEW_US?: NonNullable<ReturnType<PreviewCapabilityBindings["database"]>>;
  readonly DATABASE_PREVIEW_EU?: NonNullable<ReturnType<PreviewCapabilityBindings["database"]>>;
  readonly NATIVE_PREVIEW_US?: NativePreview;
  readonly NATIVE_PREVIEW_EU?: NativePreview;
  readonly PREVIEW_HOST_SUFFIX: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_PREVIEW_USAGE_TOKEN?: string;
  readonly PREVIEW_CONTAINER_APPLICATION_ID?: string;
  readonly PREVIEW_CONTAINER_APPLICATION_NAME?: string;
}
interface ExportedService {
  fetch(request: Request): Promise<Response>;
}
interface SandboxContext {
  readonly container: PreviewContainer;
  readonly storage: PreviewStorage;
  readonly id: { readonly name?: string; toString(): string };
  readonly exports: {
    PreviewBackupGateway: ConstructorParameters<typeof DirectoryBackup>[1];
    PreviewEgress(input: { props: EgressProps }): ExportedService;
  };
  waitUntil(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface EgressProps {
  readonly fence: PreviewRuntimeFence;
  readonly selection: PreviewCapabilitySelection;
  readonly publicOrigin: string;
  readonly phase: "install" | "runtime";
  readonly allowedOrigins: readonly string[];
}
// Same-origin scripts can imitate this request; it is activity, not proof of a human identity.
const PASSIVE_QUERY = "__ohmyhost_preview_passive=1";
const CLEAN_PASSIVE_SCRIPT = `<script>(()=>{const u=new URL(location.href),q=${JSON.stringify(PASSIVE_QUERY)},suffix='&'+q;if(u.search==='?'+q)u.search='';else if(u.search.endsWith(suffix))u.search=u.search.slice(0,-suffix.length);history.replaceState(history.state,'',u.pathname+u.search+u.hash)})()</script>`;
function activityScript(runtimeRevision: number): string {
  return `<script>(()=>{const revision=${JSON.stringify(runtimeRevision)},marker=${JSON.stringify(PASSIVE_QUERY)};let last=0;function active(e){if(!e.isTrusted||Date.now()-last<5000)return;last=Date.now();fetch('/__ohmyhost/preview/activity',{method:'POST',keepalive:true}).catch(()=>{})}for(const event of ['pointerdown','keydown'])document.addEventListener(event,active,{capture:true,passive:true});async function check(){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);try{const r=await fetch('/__ohmyhost/preview/status',{cache:'no-store',signal:controller.signal});if(r.ok){const s=await r.json();if((s.state==='ready'&&Number.isSafeInteger(s.runtimeRevision)&&s.runtimeRevision!==revision)||s.state==='sleeping'||s.state==='cold'){const u=new URL(location.href);u.search+=(u.search?'&':'?')+marker;location.replace(u.href);return}}}catch{}finally{clearTimeout(timer)}setTimeout(check,10000)}setTimeout(check,10000)})()</script>`;
}
function fenceOf(record: PreviewRuntimeRecord): PreviewRuntimeFence {
  return {
    previewId: record.previewId,
    runtimeGeneration: record.runtimeGeneration,
    tokenGeneration: record.tokenGeneration,
  };
}
function selected(source: PreviewSourceResult): PreviewCapabilitySelection {
  const plan = source.inspection.frameworkPlan;
  return {
    source: source.to,
    database: plan.database.enabled,
    auth: plan.auth.provider === "omh-native",
    mail: plan.mail.enabled,
    storage: plan.storage.enabled,
    ai: plan.ai?.enabled === true,
  };
}
function usageConfigured(env: RuntimeEnvironment): env is RuntimeEnvironment & {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_PREVIEW_USAGE_TOKEN: string;
  PREVIEW_CONTAINER_APPLICATION_NAME: string;
} {
  return (
    typeof env.CLOUDFLARE_ACCOUNT_ID === "string" &&
    /^[a-f0-9]{32}$/u.test(env.CLOUDFLARE_ACCOUNT_ID) &&
    typeof env.CLOUDFLARE_PREVIEW_USAGE_TOKEN === "string" &&
    env.CLOUDFLARE_PREVIEW_USAGE_TOKEN.length > 0 &&
    typeof env.PREVIEW_CONTAINER_APPLICATION_NAME === "string" &&
    env.PREVIEW_CONTAINER_APPLICATION_NAME.length > 0 &&
    !!env.PREVIEW_USAGE_REPORTER
  );
}
async function applicationId(env: RuntimeEnvironment): Promise<string> {
  if (!usageConfigured(env)) throw new Error("preview_usage_provider_unavailable");
  return resolvePreviewApplication({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_PREVIEW_USAGE_TOKEN,
    applicationName: env.PREVIEW_CONTAINER_APPLICATION_NAME,
    ...(env.PREVIEW_CONTAINER_APPLICATION_ID
      ? { expectedApplicationId: env.PREVIEW_CONTAINER_APPLICATION_ID }
      : {}),
    fetch: (request) => fetch(request),
  });
}
function validClientAddress(value: string): boolean {
  if (value.includes(":")) {
    if (!/^[0-9a-fA-F:.]+$/u.test(value)) return false;
    try {
      return new URL(`http://[${value}]/`).hostname.startsWith("[");
    } catch {
      return false;
    }
  }
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255)
  );
}
async function resolveCapability(
  env: RuntimeEnvironment,
  request: Request,
): Promise<PreviewRuntimeRecord | null> {
  const token = previewTokenFromRequest(request, env.PREVIEW_HOST_SUFFIX);
  if (!token) return null;
  return env.PREVIEW_AUTHORITY.resolveTokenHash({ tokenHash: await hashPreviewToken(token) });
}
async function resolveRequest(
  env: RuntimeEnvironment,
  request: Request,
): Promise<PreviewRuntimeRecord | null> {
  const record = await resolveCapability(env, request);
  return record ? env.PREVIEW_AUTHORITY.authorizeRuntime(fenceOf(record)) : null;
}
async function originMatches(
  env: RuntimeEnvironment,
  origin: string,
  fence: PreviewRuntimeFence,
): Promise<boolean> {
  let request: Request;
  try {
    request = new Request(origin);
    if (new URL(origin).origin !== origin) return false;
  } catch {
    return false;
  }
  const record = await resolveRequest(env, request);
  return (
    !!record &&
    record.previewId === fence.previewId &&
    record.runtimeGeneration === fence.runtimeGeneration &&
    record.tokenGeneration === fence.tokenGeneration
  );
}

/** Outbound policy and provider identity are selected outside the complete guest VM. */
export class PreviewEgress extends WorkerEntrypoint<RuntimeEnvironment> {
  public async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props as EgressProps;
    let url = new URL(request.url);
    const gateway =
      url.protocol === "https:"
        ? (
            {
              "preview-mail.invalid": "mail",
              "preview-storage.invalid": "storage",
              "preview-ai.invalid": "ai",
            } as Record<string, string>
          )[url.hostname]
        : undefined;
    if (gateway && url.pathname.startsWith("/v1/")) {
      const target = new URL(`http://preview.capabilities/${gateway}${url.pathname}${url.search}`);
      request = new Request(target, request);
      url = target;
    }
    if (url.origin === "http://preview.capabilities") {
      if (props.phase !== "runtime") return unavailable(403);
      const handler = createPreviewCapabilityHandler({
        authority: this.env.PREVIEW_AUTHORITY,
        database: (region) =>
          region === "eu" ? this.env.DATABASE_PREVIEW_EU : this.env.DATABASE_PREVIEW_US,
        heldDatabase: (input) =>
          this.env.PREVIEW_CONTAINERS.getByName(input.fence.previewId).database(input),
        nativeAuth: (region) =>
          region === "eu" ? this.env.NATIVE_PREVIEW_EU : this.env.NATIVE_PREVIEW_US,
        ...(this.env.PREVIEW_RUNTIME_SECRETS ? { platform: this.env.PREVIEW_RUNTIME_SECRETS } : {}),
      });
      const response = await handler(request, props.fence, props.selection, props.publicOrigin);
      if (
        url.pathname === "/native-auth/session" &&
        response.status === 503 &&
        props.selection.auth
      )
        this.ctx.waitUntil(
          this.env.PREVIEW_CONTAINERS.getByName(props.fence.previewId)
            .refreshNative()
            .catch(() => undefined),
        );
      return response;
    }
    const current = await this.env.PREVIEW_AUTHORITY.authorizeRuntime(props.fence).catch(
      () => null,
    );
    if (
      !current ||
      (props.phase === "runtime" &&
        (!sameSourceVersion(current.targetSource, props.selection.source) ||
          !sameSourceVersion(current.appliedSource, props.selection.source)))
    )
      return unavailable(403);
    const packageOrigin = ["https://registry.npmjs.org", "https://registry.yarnpkg.com"].includes(
      url.origin,
    );
    if (
      url.username ||
      url.password ||
      url.protocol !== "https:" ||
      (props.phase === "install" ? !packageOrigin : !props.allowedOrigins.includes(url.origin))
    )
      return unavailable(403);
    const headers = new Headers(request.headers);
    if (props.phase === "install")
      for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}

/** The actor owns one stable project/environment container and its persisted journals. */
export class PreviewSandbox extends DurableObject<RuntimeEnvironment> {
  private readonly context: SandboxContext;
  private readonly controller: PreviewSessionController;
  private readonly connections = new PreviewConnections();
  private readonly databaseHandles = new PreviewDatabaseHandles();
  private readonly backups: BoundedDirectoryBackup;
  private readonly backupGrants: PreviewBackupGrantLedger;
  private sourceQueue: Promise<unknown> = Promise.resolve();
  private readonly source: PreviewSourcePort;
  private networkReady = false;
  private currentFence: PreviewRuntimeFence | null = null;
  private applicationRoot = ".";
  public constructor(context: SandboxContext, env: RuntimeEnvironment) {
    super(context, env);
    this.context = context;
    if (context.container.running)
      void context.blockConcurrencyWhile(() =>
        context.container.setInactivityTimeout(10 * 60_000 + 30_000),
      );
    this.source = {
      previewDiff: (input) => {
        const result = this.sourceQueue.then(() => env.PREVIEW_SOURCE.previewDiff(input));
        this.sourceQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    };
    const prefix = `preview-backups/${previewId(context.id.name)}/`;
    const sdkGateway = context.exports.PreviewBackupGateway;
    this.backupGrants = new PreviewBackupGrantLedger(context.storage);
    const gateway =
      (operationId: string | null): ConstructorParameters<typeof DirectoryBackup>[1] =>
      ({ props }) => {
        if (props.mode === "deny") return sdkGateway({ props });
        if (props.mode !== "control") {
          if (operationId === null) throw new Error("preview_backup_grant_invalid");
          return sdkGateway({
            props: { ...props, ...this.backups.gatewayGrant(operationId, props.key) },
          });
        }
        const key = props.key;
        if (!key.startsWith(prefix) || !/^[0-9a-f-]{36}\.tar\.zst$/u.test(key.slice(prefix.length)))
          throw new Error("preview_backup_key_invalid");
        const target = sdkGateway({ props });
        if (operationId !== null) this.backups.claimControlKey(operationId, key);
        // The pinned SDK uses control grants through its RPC methods; data grants keep SDK fetch.
        return {
          createUpload: async (name?: string) => {
            if (operationId === null) throw new Error("preview_backup_grant_invalid");
            await this.backups.assertActive(operationId);
            this.backups.assertLocalActive(operationId);
            // SDK-generated ID is captured durably before R2 multipart creation is dispatched.
            await journal.captureObjectKey(key);
            await this.backups.captureObjectKey(key, operationId);
            await this.backups.assertActive(operationId);
            const funding = await this.backupScope();
            await this.backups.assertScope(operationId, funding);
            this.backups.assertLocalActive(operationId);
            if (Date.now() >= funding.fundedUntil)
              throw new Error("preview_backup_funding_required");
            const uploadId = await target.createUpload(name);
            try {
              // Even a late create reply must preserve its original multipart identity.
              await journal.captureUploadId(key, uploadId);
              await this.backups.captureUploadId(key, uploadId, operationId);
            } catch (error) {
              try {
                await this.backups.assertActive(operationId);
                this.backups.assertLocalActive(operationId);
                await target.abortUpload(uploadId).catch(() => undefined);
              } catch {
                // Cancellation leaves the exact journaled upload for reconciliation.
              }
              throw error;
            }
            return uploadId;
          },
          completeUpload: async (
            uploadId: string,
            parts: readonly { partNumber: number; etag: string }[],
          ) => {
            if (operationId === null) throw new Error("preview_backup_grant_invalid");
            await this.backups.assertActive(operationId);
            await this.backups.validateCompletion(uploadId, parts, operationId);
            await this.backups.assertActive(operationId);
            const funding = await this.backupScope();
            await this.backups.assertScope(operationId, funding);
            let dispatched = false;
            try {
              await this.backups.markCompletionDispatched(uploadId, operationId);
              this.backups.assertLocalActive(operationId);
              if (Date.now() >= funding.fundedUntil)
                throw new Error("preview_backup_funding_required");
              dispatched = true;
              const size = await target.completeUpload(uploadId, parts);
              await this.backupGrants.recordCompletionOutcome(operationId, uploadId, size);
              await this.backups.confirmCompletion(uploadId, size, operationId);
              return size;
            } catch (error) {
              if (!dispatched)
                await this.backupGrants.recordCompletionNotDispatched(operationId, key, uploadId);
              throw error;
            }
          },
          abortUpload: async (uploadId: string) => {
            if (operationId === null) throw new Error("preview_backup_grant_invalid");
            await this.backups.assertActive(operationId);
            await this.backupGrants.assertSettled(key, uploadId);
            await this.backups.assertActive(operationId);
            this.backups.assertLocalActive(operationId);
            await target.abortUpload(uploadId);
          },
          deleteObject: async () => {
            if (operationId !== null) {
              await this.backups.assertActive(operationId);
              this.backups.assertLocalActive(operationId);
            }
            return target.deleteObject();
          },
        } as unknown as ReturnType<ConstructorParameters<typeof DirectoryBackup>[1]>;
      };
    this.backups = new BoundedDirectoryBackup(
      (operationId) =>
        new DirectoryBackup(
          context.container as unknown as ConstructorParameters<typeof DirectoryBackup>[0],
          gateway(operationId),
          { binding: "BACKUP_BUCKET", prefix },
        ),
      this.backupGrants,
      { previewId: previewId(context.id.name), prefix, scope: () => this.backupScope() },
    );
    const journal = new PreviewBackups(context.storage, this.backups);
    const driver: PreviewSessionDriver = {
      running: () => context.container.running,
      ensureUsageAuthority: () => applicationId(env),
      start: async (fence, intervalId, source, origin, signal) => {
        if (!usageConfigured(env)) throw new Error("preview_usage_provider_unavailable");
        signal?.throwIfAborted();
        this.currentFence = fence;
        context.container.start({
          image: context.container.images["preview"],
          instance: "standard-3",
          enableInternet: false,
          labels: {
            preview: fence.previewId,
            runtime: String(fence.runtimeGeneration),
            run: intervalId,
          },
        });
        await this.configureNetwork(
          fence,
          selected(source),
          origin,
          source.inspection.frameworkPlan,
          "install",
          signal,
        );
        signal?.throwIfAborted();
        await context.container.setInactivityTimeout(10 * 60_000 + 30_000);
      },
      prepareWorkspace: (signal) => prepareWorkspace(context.container, signal),
      prepareCaches: (root, signal) => prepareApplicationCaches(context.container, root, signal),
      writer: (signal) => createSourceWriter(context.container, signal),
      install: (source, signal) => installDependencies(context.container, source, signal),
      ensurePrepared: async (fence, source) => {
        await this.acceptNativeInspection(fence, source);
        if (source.inspection.frameworkPlan.auth.provider !== "omh-native") return;
        const prepared = await env.PREVIEW_AUTHORITY.readNativePreparation({
          previewId: fence.previewId,
          sourceSequence: source.to.sequence,
        });
        if (!prepared || prepared.state !== "succeeded")
          throw new Error("preview_native_preparing");
      },
      prepare: async (source, origin, signal) => {
        const fence = this.currentFence;
        if (!fence) throw new Error("preview_scope_unavailable");
        if (!env.PREVIEW_RUNTIME_SECRETS) throw new Error("preview_secrets_unavailable");
        const current = await env.PREVIEW_AUTHORITY.authorizeRuntime(fence);
        if (!current) throw new Error("preview_scope_unavailable");
        signal?.throwIfAborted();
        const variables: Record<string, string> = {
          ...(await env.PREVIEW_RUNTIME_SECRETS.readCustomerVariables({
            fence,
          })),
        };
        // These are public transport markers; the trusted gateway replaces them with real keys.
        const marker = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        const plan = source.inspection.frameworkPlan;
        this.applicationRoot = plan.applicationRoot;
        if (plan.mail.enabled) {
          variables["OHMYHOST_MAIL_GATEWAY_URL"] = "https://preview-mail.invalid";
          variables["OHMYHOST_MAIL_KEY"] = marker;
          variables["OHMYHOST_PROJECT_ID"] = current.projectId;
        }
        if (plan.storage.enabled) {
          variables["OHMYHOST_STORAGE_GATEWAY_URL"] = "https://preview-storage.invalid";
          variables["OHMYHOST_STORAGE_KEY"] = marker;
          variables["OHMYHOST_PROJECT_ID"] = current.projectId;
        }
        if (plan.ai?.enabled) {
          variables["OHMYHOST_AI_BASE_URL"] = "https://preview-ai.invalid/v1";
          variables["OHMYHOST_AI_KEY"] = marker;
        }
        signal?.throwIfAborted();
        await prepareFramework(
          context.container,
          fence.previewId,
          origin,
          source,
          variables,
          signal,
        );
      },
      serve: (origin, signal) =>
        startFramework(context.container, origin, this.applicationRoot, signal),
      updateSource: (fence, source, origin, signal) =>
        this.configureNetwork(
          fence,
          selected(source),
          origin,
          source.inspection.frameworkPlan,
          "runtime",
          signal,
        ),
      destroy: async () => {
        this.currentFence = null;
        if (context.container.running) await context.container.destroy();
        if (context.container.running) throw new Error("preview_stop_unknown");
        this.networkReady = false;
      },
      closeConnections: async () => {
        this.connections.closeAll();
        await this.databaseHandles.closeAll();
      },
      drainNative: async (fence, region) => {
        const service = region === "eu" ? env.NATIVE_PREVIEW_EU : env.NATIVE_PREVIEW_US;
        if (!service) throw new Error("preview_auth_unavailable");
        await service.drainPreview({ fence });
      },
    };
    this.controller = new PreviewSessionController({
      core: env.PREVIEW_AUTHORITY,
      source: this.source,
      storage: context.storage,
      backups: journal,
      cancelBackup: () => this.backups.cancelActive(),
      reconcileBackup: async () => {
        if (context.container.running) throw new Error("preview_stop_unknown");
        // A restarted actor has no live operation token; preserve IDs while revoking its grant.
        await this.backupGrants.revokeOrphan();
        await journal.reconcileUnknown(async (key, uploadId) => {
          if (
            !key.startsWith(prefix) ||
            !/^[0-9a-f-]{36}\.tar\.zst$/u.test(key.slice(prefix.length))
          )
            throw new Error("preview_backup_key_invalid");
          await this.backupGrants.assertSettled(key, uploadId);
          const control = sdkGateway({
            props: { protocolVersion: 1, mode: "control", binding: "BACKUP_BUCKET", key },
          });
          try {
            await boundedBackupCleanup(() => control.abortUpload(uploadId));
          } catch (error) {
            const code =
              error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
            const status =
              error && typeof error === "object" ? Reflect.get(error, "status") : undefined;
            if (code !== "NoSuchUpload" && status !== 404)
              throw new Error("preview_backup_multipart_outcome_unknown");
          }
          await boundedBackupCleanup(() => control.deleteObject());
        });
      },
      driver,
      waitUntil: (promise) => context.waitUntil(promise),
    });
  }

  private async backupFunded(scope: {
    fence: PreviewRuntimeFence;
    intervalId: string;
  }): Promise<boolean> {
    const run = await this.context.storage.get<{
      fence: PreviewRuntimeFence;
      intervalId: string;
      startedAt: number | null;
      holdAt: number;
    } | null>("product-run-v1");
    const current = this.currentFence;
    return !!(
      run &&
      current &&
      run.startedAt !== null &&
      Date.now() < run.holdAt + 45_000 &&
      run.intervalId === scope.intervalId &&
      run.fence.previewId === scope.fence.previewId &&
      run.fence.runtimeGeneration === scope.fence.runtimeGeneration &&
      run.fence.tokenGeneration === scope.fence.tokenGeneration &&
      current.previewId === scope.fence.previewId &&
      current.runtimeGeneration === scope.fence.runtimeGeneration &&
      current.tokenGeneration === scope.fence.tokenGeneration
    );
  }

  private async backupScope(): Promise<{
    fence: PreviewRuntimeFence;
    intervalId: string;
    fundedUntil: number;
  }> {
    const run = await this.context.storage.get<{
      fence: PreviewRuntimeFence;
      intervalId: string;
      holdAt: number;
    } | null>("product-run-v1");
    if (!run || !(await this.backupFunded(run))) throw new Error("preview_backup_funding_required");
    const record = await this.env.PREVIEW_AUTHORITY.authorizeRuntime(run.fence);
    if (!record || record.retirement !== "none" || !(await this.backupFunded(run)))
      throw new Error("preview_scope_unavailable");
    return { fence: run.fence, intervalId: run.intervalId, fundedUntil: run.holdAt + 45_000 };
  }

  /** Private service RPC: the durable grant, not the caller, determines backup authority. */
  public reserveBackupTransfer(message: BackupTransferMessage): Promise<BackupTransferPermit> {
    return this.backupGrants.transfer(message, (scope) => this.backupFunded(scope));
  }

  /** Private gateway RPC: only an actual provider outcome can settle a dispatched part. */
  public observeBackupPart(observation: BackupPartObservation): Promise<void> {
    return this.backupGrants.recordPartOutcome(observation);
  }

  private async configureNetwork(
    fence: PreviewRuntimeFence,
    selection: PreviewCapabilitySelection,
    publicOrigin: string,
    plan: FrameworkPlan,
    phase: "install" | "runtime",
    signal?: AbortSignal,
  ): Promise<void> {
    const allowedOrigins = [...plan.runtimePolicy.egressAllowedOrigins];
    if (phase === "runtime" && plan.storage.enabled) {
      const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
      if (
        typeof accountId !== "string" ||
        !/^[a-f0-9]{32}$/u.test(accountId) ||
        !["eu", "us"].includes(plan.storage.jurisdiction)
      )
        throw new Error("preview_storage_unavailable");
      // The normal WFP policy adds this exact managed origin for the SDK's signed-object hop.
      const r2Origin = `https://${accountId}.${plan.storage.jurisdiction}.r2.cloudflarestorage.com`;
      if (!allowedOrigins.includes(r2Origin)) allowedOrigins.push(r2Origin);
      allowedOrigins.sort();
    }
    signal?.throwIfAborted();
    await this.backups.intercept();
    signal?.throwIfAborted();
    const props = {
      fence,
      selection,
      publicOrigin,
      phase,
      allowedOrigins,
    };
    const service = this.context.exports.PreviewEgress({ props });
    await this.context.container.interceptOutboundHttp("preview.capabilities", service);
    signal?.throwIfAborted();
    await this.context.container.interceptAllOutboundHttp(service);
    signal?.throwIfAborted();
    await this.context.container.interceptOutboundHttps("*", service);
    signal?.throwIfAborted();
    this.networkReady = phase === "runtime";
    this.currentFence = fence;
  }

  public async wake(fence: PreviewRuntimeFence, publicOrigin: string): Promise<void> {
    previewId(fence.previewId);
    if (!(await originMatches(this.env, publicOrigin, fence)))
      throw new Error("preview_scope_unavailable");
    await this.controller.wake(fence, publicOrigin);
  }
  private async prepareNative(force = false): Promise<void> {
    const sequence = await this.context.storage.get<number>("product-native-target-v1");
    if (!sequence) return;
    const id = previewId(this.context.id.name);
    const scope = await this.env.PREVIEW_AUTHORITY.getCleanupState({ previewId: id });
    if (!scope || scope.retirement !== "none") return;
    const done = await this.context.storage.get<{
      sequence: number;
      authGeneration: number;
      runtimeGeneration: number;
      tokenGeneration: number;
    }>("product-native-inspected-v2");
    if (
      !force &&
      done &&
      sequence <= done.sequence &&
      scope.authGeneration === done.authGeneration &&
      scope.runtimeGeneration === done.runtimeGeneration &&
      scope.tokenGeneration === done.tokenGeneration
    )
      return;
    const fence = {
      previewId: id,
      runtimeGeneration: scope.runtimeGeneration,
      tokenGeneration: scope.tokenGeneration,
    };
    const current = await this.env.PREVIEW_AUTHORITY.authorizeRuntime(fence);
    if (!current?.targetSource || current.targetSource.sequence < sequence) return;
    const source = await this.source.previewDiff({
      ...fence,
      from: null,
      to: current.targetSource,
    });
    await this.acceptNativeInspection(fence, source);
  }
  private async acceptNativeInspection(
    fence: PreviewRuntimeFence,
    source: PreviewSourceResult,
  ): Promise<void> {
    const current = await this.env.PREVIEW_AUTHORITY.authorizeRuntime(fence);
    if (!current || current.retirement !== "none") throw new Error("preview_scope_unavailable");
    if (!sameSourceVersion(current.targetSource, source.to)) return;
    if (source.inspection.frameworkPlan.auth.provider === "omh-native") {
      const job = await this.env.PREVIEW_AUTHORITY.queueNativePreparation({
        fence,
        source: source.to,
        buildPlanSha256: source.inspection.buildPlanSha256,
        authProvider: "omh-native",
      });
      if (job.state !== "succeeded") {
        if (!this.env.PREVIEW_NATIVE_PREPARATION)
          throw new Error("preview_native_preparation_unavailable");
        this.context.waitUntil(
          this.env.PREVIEW_NATIVE_PREPARATION.prepare({ operationId: job.operationId }),
        );
      }
    }
    await this.context.storage.put("product-native-inspected-v2", {
      sequence: source.to.sequence,
      authGeneration: current.authGeneration,
      runtimeGeneration: current.runtimeGeneration,
      tokenGeneration: current.tokenGeneration,
    });
  }
  private async armNative(): Promise<void> {
    const target = (await this.context.storage.get<number>("product-native-target-v1")) ?? 0;
    if (!target) return;
    const done = await this.context.storage.get<{
      sequence: number;
      authGeneration: number;
      runtimeGeneration: number;
      tokenGeneration: number;
    }>("product-native-inspected-v2");
    const scope = await this.env.PREVIEW_AUTHORITY.getCleanupState({
      previewId: previewId(this.context.id.name),
    });
    if (
      !scope ||
      scope.retirement !== "none" ||
      (done &&
        target <= done.sequence &&
        scope.authGeneration === done.authGeneration &&
        scope.runtimeGeneration === done.runtimeGeneration &&
        scope.tokenGeneration === done.tokenGeneration)
    )
      return;
    const deadline = Date.now() + 30_000;
    const existing = await this.context.storage.getAlarm();
    if (existing === null || existing > deadline) await this.context.storage.setAlarm(deadline);
  }
  public async sourceChanged(sequence: number): Promise<void> {
    const { synchronization } = await this.controller.sourceChanged(sequence);
    const previous = (await this.context.storage.get<number>("product-native-target-v1")) ?? 0;
    if (sequence > previous) await this.context.storage.put("product-native-target-v1", sequence);
    await this.armNative();
    this.context.waitUntil(
      synchronization
        .catch(() => undefined)
        .then(() => this.prepareNative())
        .catch(() => this.armNative()),
    );
  }
  public async refreshNative(): Promise<void> {
    const previous = (await this.context.storage.get<number>("product-native-refresh-at-v1")) ?? 0;
    if (Date.now() < previous + 30_000) return;
    await this.context.storage.put("product-native-refresh-at-v1", Date.now());
    await this.prepareNative(true);
  }
  public async fence(fence: PreviewRuntimeFence, reason: "rotate" | "destroy"): Promise<void> {
    await this.controller.fence(fence, reason);
  }
  public async cleanupScope(fence: PreviewRuntimeFence): Promise<string | null> {
    return this.controller.cleanupScope(fence);
  }
  public async expireBackup(fence: PreviewRuntimeFence): Promise<void> {
    await this.controller.expireBackup(fence);
  }
  public async database(input: {
    fence: PreviewRuntimeFence;
    region: "eu" | "us";
    operation: "open" | "openRls" | "connection-query" | "connection-commit" | "connection-close";
    input: unknown;
  }): Promise<unknown> {
    const record = await this.env.PREVIEW_AUTHORITY.authorizeRuntime(input.fence);
    if (!record || record.region !== input.region || record.previewId !== this.context.id.name)
      throw new Error("preview_database_unavailable");
    const service =
      record.region === "eu" ? this.env.DATABASE_PREVIEW_EU : this.env.DATABASE_PREVIEW_US;
    if (!service) throw new Error("preview_database_unavailable");
    return this.databaseHandles.invoke(service, input.fence, input.operation, input.input);
  }
  public async alarm(): Promise<void> {
    const { synchronization } = await this.controller.alarm();
    await synchronization.catch(() => undefined);
    await this.prepareNative().catch(() => undefined);
    await this.armNative();
  }

  public async fetch(request: Request): Promise<Response> {
    const capability = await resolveCapability(this.env, request);
    if (!capability || capability.previewId !== this.context.id.name) return unavailable(404);
    let record = await this.env.PREVIEW_AUTHORITY.authorizeRuntime(fenceOf(capability));
    if (!record) {
      // Starting a usage run can advance the generation between lookup and authorization.
      const refreshed = await resolveCapability(this.env, request);
      if (
        refreshed &&
        refreshed.previewId === capability.previewId &&
        refreshed.tokenGeneration === capability.tokenGeneration &&
        refreshed.runtimeGeneration > capability.runtimeGeneration
      )
        record = await this.env.PREVIEW_AUTHORITY.authorizeRuntime(fenceOf(refreshed));
    }
    const url = new URL(request.url),
      origin = url.origin;
    const passiveSuffix = `&${PASSIVE_QUERY}`;
    const passive =
      request.method === "GET" &&
      (url.search === `?${PASSIVE_QUERY}` || url.search.endsWith(passiveSuffix));
    if (passive)
      url.search =
        url.search === `?${PASSIVE_QUERY}` ? "" : url.search.slice(0, -passiveSuffix.length);
    if (!record) {
      if (url.pathname === "/__ohmyhost/preview/status" && request.method === "GET")
        return Response.json(
          { state: "cold", phase: "failed", failure: "admission" },
          { headers: { "cache-control": "no-store" } },
        );
      return request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate"
        ? statusPage("admission")
        : unavailable();
    }
    const fence = fenceOf(record);
    const state = await this.controller.status();
    if (url.pathname === "/__ohmyhost/preview/status" && request.method === "GET") {
      await this.controller.rememberOrigin(origin, false);
      const ready =
        state.state === "ready" &&
        this.context.container.running &&
        state.fence &&
        state.applied &&
        state.plan &&
        state.fence.runtimeGeneration === fence.runtimeGeneration &&
        state.fence.tokenGeneration === fence.tokenGeneration;
      return Response.json(
        {
          state: ready
            ? "ready"
            : state.restartPending
              ? "starting"
              : state.state === "ready"
                ? "sleeping"
                : state.state,
          phase: state.phase,
          failure: state.failure,
          failedAt: state.failedAt,
          runtimeRevision: ready ? state.fence?.runtimeGeneration : null,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    await this.controller.rememberOrigin(origin, !passive);
    if (url.pathname === "/__ohmyhost/preview/wake" && request.method === "POST") {
      if (
        request.headers.get("origin") !== origin ||
        request.headers.get("sec-fetch-site") !== "same-origin"
      )
        return unavailable(403);
      this.context.waitUntil(this.controller.wake(fence, origin));
      return Response.json({ state: "starting" }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/__ohmyhost/preview/activity" && request.method === "POST") {
      if (
        request.headers.get("origin") !== origin ||
        request.headers.get("sec-fetch-site") !== "same-origin"
      )
        return unavailable(403);
      if (state.state !== "ready" || !this.context.container.running)
        return new Response(null, { status: 409, headers: { "cache-control": "no-store" } });
      await this.controller.touch();
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.startsWith("/__ohmyhost/preview/")) return unavailable(404);
    if (
      state.state !== "ready" ||
      !this.context.container.running ||
      !state.fence ||
      !state.applied ||
      !state.plan ||
      state.fence.runtimeGeneration !== fence.runtimeGeneration ||
      state.fence.tokenGeneration !== fence.tokenGeneration
    ) {
      const navigate =
        request.method === "GET" &&
        request.headers.get("sec-fetch-mode") === "navigate" &&
        (request.headers.get("sec-fetch-user") === "?1" ||
          request.headers.get("sec-fetch-site") === "none");
      if (navigate && !passive && state.state !== "starting")
        this.context.waitUntil(this.controller.wake(fence, origin));
      return statusPage(
        (navigate && !passive) || state.state === "starting" || state.restartPending
          ? "starting"
          : "sleeping",
      );
    }
    const runtimeRevision = state.fence.runtimeGeneration;
    if (!this.networkReady) {
      const selection: PreviewCapabilitySelection = {
        source: state.applied,
        database: state.plan.database.enabled,
        auth: state.plan.auth.provider === "omh-native",
        mail: state.plan.mail.enabled,
        storage: state.plan.storage.enabled,
        ai: state.plan.ai?.enabled === true,
      };
      await this.configureNetwork(fence, selection, origin, state.plan, "runtime");
    }
    if (url.pathname.startsWith("/api/auth/v1/") && state.plan.auth.provider === "omh-native") {
      if (
        !sameSourceVersion(record.targetSource, state.applied) ||
        !sameSourceVersion(record.appliedSource, state.applied)
      )
        return unavailable(403);
      const clientAddress = request.headers.get("x-ohmyhost-preview-client-address");
      const auth = record.region === "eu" ? this.env.NATIVE_PREVIEW_EU : this.env.NATIVE_PREVIEW_US;
      if (!auth || !clientAddress || !validClientAddress(clientAddress)) return unavailable(403);
      const response = await auth.fetchPreview(request, {
        fence,
        publicOrigin: origin,
        clientAddress,
      });
      if (response.status === 503)
        this.context.waitUntil(this.refreshNative().catch(() => undefined));
      return this.connections.wrap(response, fence.tokenGeneration);
    }
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (
      (mutation &&
        !isPreviewMutationAllowed(
          request,
          state.plan.runtimePolicy.browser,
          state.applied,
          record.targetSource,
          record.appliedSource,
        )) ||
      (request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        request.headers.get("origin") !== origin)
    )
      return unavailable(403);
    const active =
      !passive &&
      request.method === "GET" &&
      request.headers.get("sec-fetch-mode") === "navigate" &&
      request.headers.get("sec-fetch-user") === "?1";
    if (active) this.context.waitUntil(this.controller.touch());
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()])
      if (name.startsWith("x-ohmyhost-") || name.startsWith("cf-")) headers.delete(name);
    for (const name of ["origin", "referer"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(`x-ohmyhost-preview-original-${name}`, btoa(value));
    }
    const port =
      state.plan.adapter === "vite-static" &&
      state.plan.runtime === "edge" &&
      url.pathname.startsWith("/api/")
        ? 3003
        : 3001;
    // The browser origin remains HTTPS, but the private in-container dev server speaks HTTP.
    const internal = new URL(url);
    internal.protocol = "http:";
    let upstream = await this.context.container
      .getTcpPort(port)
      .fetch(new Request(internal, new Request(request, { headers })));
    if (
      request.method === "GET" &&
      upstream.status === 200 &&
      upstream.headers.get("content-type")?.toLowerCase().startsWith("text/html")
    )
      upstream = new HTMLRewriter()
        .on("head", {
          element(element) {
            if (passive)
              (
                element as unknown as { prepend(content: string, options: { html: boolean }): void }
              ).prepend(CLEAN_PASSIVE_SCRIPT, { html: true });
          },
        })
        .on("body", {
          element(element) {
            element.append(activityScript(runtimeRevision), { html: true });
          },
        })
        .transform(upstream);
    const response = this.connections.wrap(upstream, fence.tokenGeneration);
    secureBrowserCors(
      response.headers,
      request.headers.get("origin"),
      state.plan.runtimePolicy.browser,
    );
    if (upstream.status !== 101) {
      const websocketOrigin = origin.replace(/^https:/u, "wss:");
      const base = `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${websocketOrigin}; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'`;
      response.headers.set(
        "content-security-policy",
        browserContentSecurityPolicy(base, state.plan.runtimePolicy.browser),
      );
    }
    return response;
  }
}

export class PreviewExecution extends WorkerEntrypoint<RuntimeEnvironment> {
  public async wake(input: PreviewRuntimeFence & { publicOrigin: string }): Promise<void> {
    const { publicOrigin, ...fence } = input;
    if (!(await originMatches(this.env, publicOrigin, fence)))
      throw new Error("preview_scope_unavailable");
    const actor = this.env.PREVIEW_CONTAINERS.getByName(previewId(fence.previewId));
    const record = await resolveRequest(this.env, new Request(publicOrigin));
    if (record?.targetSource) this.ctx.waitUntil(actor.sourceChanged(record.targetSource.sequence));
    this.ctx.waitUntil(actor.wake(fence, publicOrigin));
  }
  public async sourceChanged(input: { previewId: string; sequence: number }): Promise<void> {
    await this.env.PREVIEW_CONTAINERS.getByName(previewId(input.previewId)).sourceChanged(
      input.sequence,
    );
  }
  public async fence(input: PreviewRuntimeFence & { reason: "rotate" | "destroy" }): Promise<void> {
    const { reason, ...fence } = input;
    if (reason !== "rotate" && reason !== "destroy") throw new Error("preview_fence_invalid");
    await this.env.PREVIEW_CONTAINERS.getByName(previewId(fence.previewId)).fence(fence, reason);
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnvironment): Promise<Response> {
    try {
      const record = await resolveCapability(env, request);
      if (!record) return unavailable(404);
      return await env.PREVIEW_CONTAINERS.getByName(previewId(record.previewId)).fetch(request);
    } catch {
      return unavailable();
    }
  },
  async scheduled(_controller: unknown, env: RuntimeEnvironment): Promise<void> {
    const pending = await env.PREVIEW_AUTHORITY.listPendingSources({ limit: 100 });
    for (const item of pending) {
      try {
        await env.PREVIEW_CONTAINERS.getByName(previewId(item.previewId)).sourceChanged(
          item.sequence,
        );
        await env.PREVIEW_AUTHORITY.acknowledgeSource(item);
      } catch {
        /* Durable Core outbox remains for the next pass. */
      }
    }
    const nativePreparation = env.PREVIEW_NATIVE_PREPARATION;
    if (nativePreparation) {
      const nativeCursor = await env.PREVIEW_AUTHORITY.getNativePreparationCursor();
      const jobs = await env.PREVIEW_AUTHORITY.listPendingNativePreparations({
        limit: 100,
        ...(nativeCursor ? { after: nativeCursor } : {}),
      });
      for (let offset = 0; offset < jobs.length; offset += 10) {
        await Promise.allSettled(
          jobs
            .slice(offset, offset + 10)
            .map((job) => nativePreparation.prepare({ operationId: job.operationId })),
        );
      }
      await env.PREVIEW_AUTHORITY.setNativePreparationCursor({
        expected: nativeCursor,
        next: jobs.length === 100 ? (jobs.at(-1) as { operationId: string }).operationId : null,
      });
    }
    let after: string | undefined;
    for (;;) {
      const candidates = await env.PREVIEW_AUTHORITY.listCleanupCandidates({
        limit: 100,
        ...(after ? { after } : {}),
      });
      for (const candidate of candidates) {
        try {
          const fence = {
            previewId: candidate.previewId,
            runtimeGeneration: candidate.runtimeGeneration,
            tokenGeneration: candidate.tokenGeneration,
          };
          const actor = env.PREVIEW_CONTAINERS.getByName(previewId(candidate.previewId));
          if (candidate.reason === "resume")
            await env.PREVIEW_AUTHORITY.resumeSuspended({
              previewId: candidate.previewId,
              expectedRowVersion: candidate.rowVersion,
            });
          else if (candidate.reason === "backup_cleanup") await actor.expireBackup(fence);
          else if (candidate.reason === "rotation" || candidate.reason === "destroy") {
            await actor.fence(fence, candidate.reason === "rotation" ? "rotate" : "destroy");
            if (candidate.reason === "rotation") await env.PREVIEW_AUTHORITY.confirmRotation(fence);
            else await env.PREVIEW_AUTHORITY.confirmDestroy(fence);
          } else if (candidate.reason === "expired") {
            const claimed = await env.PREVIEW_AUTHORITY.claimExpiredBackup({
              ...fence,
              expectedRowVersion: candidate.rowVersion,
            });
            if (claimed.backup === null) await actor.expireBackup(fence);
          } else {
            const claimed = await env.PREVIEW_AUTHORITY.claimScopeCleanup({
              previewId: candidate.previewId,
              expectedRowVersion: candidate.rowVersion,
            });
            const cleanupFence = {
              previewId: claimed.previewId,
              runtimeGeneration: claimed.runtimeGeneration,
              tokenGeneration: claimed.tokenGeneration,
            };
            const deletedBackupHandle = await actor.cleanupScope(cleanupFence);
            if (claimed.hasBackup && deletedBackupHandle === null)
              throw new Error("preview_backup_reconciliation_required");
            await env.PREVIEW_AUTHORITY.finishScopeCleanup({
              ...cleanupFence,
              deletedBackupHandle,
            });
          }
        } catch {
          /* Core keeps the candidate until exact cleanup succeeds. */
        }
      }
      if (candidates.length < 100) break;
      after = (candidates[candidates.length - 1] as { previewId: string }).previewId;
    }
    if (!usageConfigured(env)) return;
    // Core claims due reads under one durable query budget and schedules their next retry first.
    const runs = await env.PREVIEW_USAGE_REPORTER.listUsageForReconciliation({
      limit: 20,
    });
    for (let offset = 0; offset < runs.length; offset += 10) {
      await Promise.allSettled(
        runs.slice(offset, offset + 10).map(async (run) => {
          const fact = await observePreviewUsage(
            {
              accountId: env.CLOUDFLARE_ACCOUNT_ID,
              token: env.CLOUDFLARE_PREVIEW_USAGE_TOKEN,
              applicationId: run.applicationId,
              fetch: (request) => fetch(request),
            },
            { ...run, instanceId: env.PREVIEW_CONTAINERS.idFromName(run.previewId).toString() },
          );
          if (fact.status === "observed")
            await env.PREVIEW_USAGE_REPORTER.observeUsage({
              previewId: run.previewId,
              runtimeGeneration: run.runtimeGeneration,
              intervalId: run.intervalId,
              cpuMilliseconds: fact.cpuMilliseconds,
              observedAt: fact.observedAt,
              providerFactId: fact.providerFactId,
            });
        }),
      ); // Missing rows, failed reads and interrupted passes retain Core's durable backoff.
    }
  },
};
