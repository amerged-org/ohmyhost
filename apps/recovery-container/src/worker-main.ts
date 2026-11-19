import { Container } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createRecoveryInputCipher,
  parseRecoveryCommand,
  parseRecoveryJobInput,
} from "@ohmyhost/platform";
import {
  RECOVERY_CONTROL_HANDLER,
  RECOVERY_CONTROL_HOST,
} from "@ohmyhost/project-recovery-worker/control-wire";
import {
  createRecoveryControlHandler,
  mintControlToken,
  sha256Hex,
  type OutboundContext,
  type RecoveryControlDependencies,
  type RecoveryControlGrant,
  type RecoveryStorePort,
  type NativeRestoreDependencies,
} from "./control-mediator.js";

export { ContainerProxy } from "@cloudflare/containers";

const PORT = 8080;
const MAX_RESULT_BYTES = 16 * 1024;
const CONTAINER_REQUEST_MS = 13 * 60_000;
/** The job token outlives the longest container request by one minute and never longer. */
const CONTROL_TOKEN_MS = CONTAINER_REQUEST_MS + 60_000;
/**
 * A ready download is answered from memory for this long. The control API rejects a signed URL whose
 * X-Amz-Date is older than 60 seconds, so 20 seconds leaves room for every answer it can still accept.
 */
const DOWNLOAD_REUSE_MS = 20_000;

export interface RecoveryContainerBindings {
  readonly RESOURCE_NAMESPACE: "poc-private-fullstack" | "production";
  /** Worker secret with the environment-scoped recovery fields (no Control database URL, no provider admin key). */
  readonly RECOVERY_CONFIGURATION: string;
  readonly RECOVERY_SANDBOX: {
    getByName(
      name: string,
    ): Pick<
      RecoverySandbox,
      "invoke" | "admitNativeRestore" | "resumeNativeRestore" | "observeNativeRestore"
    >;
  };
  /**
   * Typed private dependency of the mediated Control port: a service binding to the control-store RecoveryPort
   * entrypoint. It is operator integration (no binding name or id exists yet); when it is absent the mediated port
   * answers `control_unavailable` and nothing runs. There is no database URL or pool fallback.
   */
  readonly RECOVERY_CONTROL_STORE?: RecoveryStorePort;
  readonly NATIVE_RESTORE_JOB_STORE?: NativeRestoreDependencies["store"] & {
    authorizeAdmission(input: unknown): Promise<unknown>;
    accept(input: unknown): Promise<unknown>;
    claim(input: unknown): Promise<unknown>;
    observe(input: unknown): Promise<unknown>;
  };
  readonly NATIVE_RESTORE_ADMIN_US?: Pick<
    ReturnType<NativeRestoreDependencies["admin"]>,
    "sanitizeRestore"
  >;
  readonly NATIVE_RESTORE_ADMIN_EU?: Pick<
    ReturnType<NativeRestoreDependencies["admin"]>,
    "sanitizeRestore"
  >;
  readonly NATIVE_RESTORE_POLICY_US?: Pick<
    ReturnType<NativeRestoreDependencies["admin"]>,
    "applyRealmPolicy"
  >;
  readonly NATIVE_RESTORE_POLICY_EU?: Pick<
    ReturnType<NativeRestoreDependencies["admin"]>,
    "applyRealmPolicy"
  >;
  readonly NATIVE_RESTORE_PREPARATION_US?: ReturnType<NativeRestoreDependencies["preparation"]>;
  readonly NATIVE_RESTORE_PREPARATION_EU?: ReturnType<NativeRestoreDependencies["preparation"]>;
}

/** The binding-to-dependencies step of the mediated port; an incomplete environment fails closed. */
export function controlDependencies(
  env: RecoveryContainerBindings,
): RecoveryControlDependencies | undefined {
  const store = env.RECOVERY_CONTROL_STORE;
  if (store === undefined) return undefined;
  const restoreStore = env.NATIVE_RESTORE_JOB_STORE;
  return {
    store,
    ...(restoreStore === undefined
      ? {}
      : {
          restore: {
            store: restoreStore,
            admin: (region: "us-dev" | "eu-dev") => {
              const binding =
                region === "us-dev" ? env.NATIVE_RESTORE_ADMIN_US : env.NATIVE_RESTORE_ADMIN_EU;
              const policy =
                region === "us-dev" ? env.NATIVE_RESTORE_POLICY_US : env.NATIVE_RESTORE_POLICY_EU;
              if (!binding || !policy) throw new Error("native_restore_unavailable");
              return {
                sanitizeRestore: (input) => binding.sanitizeRestore(input),
                applyRealmPolicy: (input) => policy.applyRealmPolicy(input),
              };
            },
            preparation: (region: "us-dev" | "eu-dev") => {
              const binding =
                region === "us-dev"
                  ? env.NATIVE_RESTORE_PREPARATION_US
                  : env.NATIVE_RESTORE_PREPARATION_EU;
              if (!binding) throw new Error("native_restore_unavailable");
              return binding;
            },
          },
        }),
  };
}

const controlHandler = createRecoveryControlHandler<RecoveryContainerBindings>({
  dependencies: controlDependencies,
});

const restoreSandboxName = (scope: {
  organizationId: string;
  projectId: string;
  restoreId: string;
}) => `native-restore/${scope.organizationId}/${scope.projectId}/${scope.restoreId}`;

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};

/** The closed recovery RPC that Control and the Deployment Workflow call. */
export class RecoveryContainerService extends WorkerEntrypoint<RecoveryContainerBindings> {
  public inspectNativeRestore() {
    const namespace = this.env.RESOURCE_NAMESPACE;
    if (
      !["production", "poc-private-fullstack"].includes(namespace) ||
      typeof this.env.RECOVERY_CONFIGURATION !== "string" ||
      !this.env.RECOVERY_CONFIGURATION ||
      this.env.RECOVERY_CONFIGURATION.length > 8192 ||
      !this.env.RECOVERY_SANDBOX ||
      !this.env.RECOVERY_CONTROL_STORE ||
      !this.env.NATIVE_RESTORE_JOB_STORE ||
      !this.env.NATIVE_RESTORE_ADMIN_US ||
      !this.env.NATIVE_RESTORE_ADMIN_EU ||
      !this.env.NATIVE_RESTORE_POLICY_US ||
      !this.env.NATIVE_RESTORE_POLICY_EU ||
      !this.env.NATIVE_RESTORE_PREPARATION_US ||
      !this.env.NATIVE_RESTORE_PREPARATION_EU
    )
      throw new Error("native_restore_unavailable");
    try {
      const config: unknown = JSON.parse(this.env.RECOVERY_CONFIGURATION);
      if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error();
      const fields = config as Record<string, unknown>;
      // The PGCF key's expiry is optional: configurations deployed before it omit the field.
      const keys = Object.keys(fields).sort().join(",");
      if (
        keys !== "inputKeyBase64,pgcf,pgcfKeyExpiresAt,r2AccessKeyId,r2AccountId,r2ApiToken" &&
        keys !== "inputKeyBase64,pgcf,r2AccessKeyId,r2AccountId,r2ApiToken"
      )
        throw new Error();
      const key = fields["inputKeyBase64"],
        token = fields["r2ApiToken"],
        pgcf = fields["pgcf"];
      if (
        typeof key !== "string" ||
        (fields["pgcfKeyExpiresAt"] !== undefined &&
          (typeof fields["pgcfKeyExpiresAt"] !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(
              fields["pgcfKeyExpiresAt"],
            ) ||
            !Number.isFinite(Date.parse(fields["pgcfKeyExpiresAt"])))) ||
        atob(key).length !== 32 ||
        btoa(atob(key)) !== key ||
        fields["r2AccountId"] !== "00000000000000000000000000000001" ||
        typeof fields["r2AccessKeyId"] !== "string" ||
        !/^[a-f0-9]{32}$/u.test(fields["r2AccessKeyId"]) ||
        typeof token !== "string" ||
        token.length < 20 ||
        token.length > 4096 ||
        /\s/u.test(token) ||
        typeof pgcf !== "object" ||
        pgcf === null ||
        Array.isArray(pgcf) ||
        Object.keys(pgcf).sort().join(",") !== "apiKey,baseUrl,projectId"
      )
        throw new Error();
      const provider = pgcf as Record<string, unknown>;
      if (
        typeof provider["baseUrl"] !== "string" ||
        typeof provider["projectId"] !== "string" ||
        !/^prj_[a-z0-9]{20}$/u.test(provider["projectId"]) ||
        typeof provider["apiKey"] !== "string" ||
        !/^[\x21-\x7e]{16,512}$/u.test(provider["apiKey"])
      )
        throw new Error();
      const url = new URL(provider["baseUrl"]);
      if (
        url.protocol !== "https:" ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.port ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(url.hostname)
      )
        throw new Error();
    } catch {
      throw new Error("native_restore_unavailable");
    }
    return { status: "ready" as const, namespace };
  }
  public async invokeRecovery(raw: unknown) {
    const command = parseRecoveryCommand(raw);
    if (command.action === "restore" || command.action === "reconcile-restore-pin")
      throw new Error("native_restore_private_admission_required");
    let archiveOperationId: string = command.operationId;
    let archiveOrganizationId: string = command.organizationId;
    if (command.action === "purge") {
      if (!this.env.RECOVERY_CONTROL_STORE?.readCleanupTarget)
        throw new Error("recovery_cleanup_scope_unavailable");
      const target = await this.env.RECOVERY_CONTROL_STORE.readCleanupTarget({
        organizationId: command.organizationId,
        projectId: command.projectId,
        operationId: command.operationId,
        exportId: command.exportId,
      });
      const key =
        typeof target === "object" && target !== null ? Reflect.get(target, "key") : undefined;
      const match =
        typeof key === "string"
          ? /^(?:snapshots|native-exports)\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/([0-7][0-9A-HJKMNP-TV-Z]{25})\.zip$/u.exec(
              key,
            )
          : null;
      if (!match || !match[1] || match[2] !== command.projectId || !match[3])
        throw new Error("recovery_cleanup_scope_unavailable");
      archiveOrganizationId = match[1];
      archiveOperationId = match[3];
    }
    return this.env.RECOVERY_SANDBOX.getByName(
      `export/${archiveOrganizationId}/${command.projectId}/${archiveOperationId}`,
    ).invoke(command);
  }

  public reconcileNativeRestorePin(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new TypeError("native_restore_invalid");
    const command = parseRecoveryCommand({ ...raw, action: "reconcile-restore-pin" });
    if (command.action !== "reconcile-restore-pin") throw new Error("native_restore_unavailable");
    return this.env.RECOVERY_SANDBOX.getByName(restoreSandboxName(command)).invoke(command);
  }

  public resumeNativeRestore(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new TypeError("native_restore_invalid");
    const command = parseRecoveryCommand({ ...raw, action: "restore" });
    if (command.action !== "restore") throw new Error("native_restore_unavailable");
    return this.env.RECOVERY_SANDBOX.getByName(restoreSandboxName(command)).resumeNativeRestore(
      command,
    );
  }

  public observeNativeRestore(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new TypeError("native_restore_invalid");
    const restoreId = Reflect.get(raw, "restoreId");
    const organizationId = Reflect.get(raw, "organizationId"),
      projectId = Reflect.get(raw, "projectId"),
      ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
    if (
      typeof restoreId !== "string" ||
      !ulid.test(restoreId) ||
      typeof organizationId !== "string" ||
      !ulid.test(organizationId) ||
      typeof projectId !== "string" ||
      !ulid.test(projectId)
    )
      throw new TypeError("native_restore_invalid");
    return this.env.RECOVERY_SANDBOX.getByName(
      restoreSandboxName({ organizationId, projectId, restoreId }),
    ).observeNativeRestore(raw);
  }

  /** Private trusted caller supplies the password once; only its encrypted envelope and keyed digest enter Core. */
  public async invokeNativeRestore(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new TypeError("native_restore_invalid");
    const value = raw as Record<string, unknown>,
      expected = [
        "archiveSha256",
        "claimId",
        "exportOperationId",
        "organizationId",
        "passphrase",
        "principalId",
        "projectId",
        "restoreId",
        ...(value["delegation"] === undefined ? [] : ["delegation"]),
        ...(value["expectedPreviousClaimId"] === undefined ? [] : ["expectedPreviousClaimId"]),
      ].sort();
    if (
      Object.keys(value).sort().join(",") !== expected.join(",") ||
      typeof value["passphrase"] !== "string" ||
      typeof value["principalId"] !== "string" ||
      typeof value["exportOperationId"] !== "string" ||
      typeof value["archiveSha256"] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value["archiveSha256"])
    )
      throw new TypeError("native_restore_invalid");
    const command = parseRecoveryCommand({
      action: "restore",
      organizationId: value["organizationId"],
      projectId: value["projectId"],
      restoreId: value["restoreId"],
      claimId: value["claimId"],
    });
    if (command.action !== "restore" || !this.env.NATIVE_RESTORE_JOB_STORE)
      throw new Error("native_restore_unavailable");
    const configuration = JSON.parse(this.env.RECOVERY_CONFIGURATION) as Record<string, unknown>,
      encoded = configuration["inputKeyBase64"];
    if (typeof encoded !== "string") throw new Error("native_restore_unavailable");
    let key: Uint8Array;
    try {
      key = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    } catch {
      throw new Error("native_restore_unavailable");
    }
    if (key.length !== 32 || btoa(String.fromCharCode(...key)) !== encoded)
      throw new Error("native_restore_unavailable");
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ version: 1, passphrase: value["passphrase"] }),
    );
    try {
      parseRecoveryJobInput(plaintext);
      const scope = {
        organizationId: command.organizationId,
        projectId: command.projectId,
        restoreId: command.restoreId,
      };
      const hmac = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digestBytes = new TextEncoder().encode(
        JSON.stringify(["native-restore-input/v1", scope, Array.from(plaintext)]),
      );
      const inputDigest = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, digestBytes));
      digestBytes.fill(0);
      const sealedInput = await createRecoveryInputCipher({ key, keyVersion: 1, crypto }).seal(
        { ...scope, operationId: scope.restoreId },
        plaintext,
      );
      return this.env.RECOVERY_SANDBOX.getByName(restoreSandboxName(scope)).admitNativeRestore({
        command,
        admission: {
          ...scope,
          principalId: value["principalId"],
          exportOperationId: value["exportOperationId"],
          archiveSha256: value["archiveSha256"],
          ...(value["delegation"] === undefined ? {} : { delegation: value["delegation"] }),
          ...(value["expectedPreviousClaimId"] === undefined
            ? {}
            : {
                rearm: {
                  expectedPreviousClaimId: value["expectedPreviousClaimId"],
                  claimId: command.claimId,
                },
              }),
          inputDigest,
          sealedInput,
        },
      });
    } finally {
      plaintext.fill(0);
      key.fill(0);
    }
  }
}

/** One operation owns one trusted Container; replay keeps the same Control claim and R2 key. */
export class RecoverySandbox extends Container<RecoveryContainerBindings> {
  public override defaultPort = PORT;
  public override requiredPorts = [PORT];
  public override enableInternet = true;
  public override sleepAfter = "15m";
  // The virtual Control host is answered here, in the Worker, never by the network; everything else (customer PGCF
  // over WSS, R2) keeps the Internet allowance above. The handlers MUST be registered through the inherited static
  // setter of `Container`: it fills the registry the runtime proxy and `setOutboundByHost` read. A static class FIELD
  // (`static outboundHandlers = ...`) defines an own property that shadows the setter, leaves that registry empty and
  // makes `setOutboundByHost` throw, so the registration is an assignment in a static initialization block.
  static {
    this.outboundHandlers = {
      [RECOVERY_CONTROL_HANDLER]: (
        request: Request,
        env: RecoveryContainerBindings,
        context: OutboundContext,
      ) => controlHandler(request, env, context),
    };
  }
  // Calls for one operation (a run and a download, or two downloads) share this object and its
  // Container, so each one starts, uses and destroys it only after the previous call settled.
  #invocations: Promise<unknown> = Promise.resolve();
  // The last successful download of this operation, answered again within DOWNLOAD_REUSE_MS. Any other command clears it.
  #download:
    | {
        organizationId: string;
        projectId: string;
        operationId: string;
        untilMs: number;
        result: unknown;
      }
    | undefined;

  /** The clock of the download reuse window; tests replace it. */
  protected clockMs(): number {
    return Date.now();
  }

  public invoke(raw: unknown): Promise<unknown> {
    const invocation = this.#invocations.then(async () => {
      const command = parseRecoveryCommand(raw);
      if (command.action === "download") {
        const remembered = this.#download;
        if (
          remembered &&
          remembered.organizationId === command.organizationId &&
          remembered.projectId === command.projectId &&
          remembered.operationId === command.operationId &&
          this.clockMs() < remembered.untilMs
        )
          return remembered.result;
        // The window starts before the Container boots, so every remembered signature is younger than the window.
        const startedMs = this.clockMs();
        const result = await this.#invokeAlone(command);
        this.#download = {
          organizationId: command.organizationId,
          projectId: command.projectId,
          operationId: command.operationId,
          untilMs: startedMs + DOWNLOAD_REUSE_MS,
          result,
        };
        return result;
      }
      this.#download = undefined;
      if (command.action === "reconcile-restore-pin") {
        if (!this.env.NATIVE_RESTORE_JOB_STORE) throw new Error("native_restore_unavailable");
        await this.env.NATIVE_RESTORE_JOB_STORE.readPinReconciliation({
          organizationId: command.organizationId,
          projectId: command.projectId,
          restoreId: command.restoreId,
          principalId: command.principalId,
          ...(command.delegation === undefined ? {} : { delegation: command.delegation }),
        });
      }
      return this.#invokeAlone(command);
    });
    this.#invocations = invocation.catch(() => undefined);
    return invocation;
  }

  /** Expired-input rearm happens only after this per-restore object stops any previous container. */
  public admitNativeRestore(raw: unknown): Promise<unknown> {
    const invocation = this.#invocations.then(async () => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "admission,command"
      )
        throw new TypeError("native_restore_invalid");
      const value = raw as { command: unknown; admission: unknown },
        command = parseRecoveryCommand(value.command);
      if (command.action !== "restore" || !this.env.NATIVE_RESTORE_JOB_STORE)
        throw new Error("native_restore_unavailable");
      if (
        typeof value.admission !== "object" ||
        value.admission === null ||
        Reflect.get(value.admission, "organizationId") !== command.organizationId ||
        Reflect.get(value.admission, "projectId") !== command.projectId ||
        Reflect.get(value.admission, "restoreId") !== command.restoreId
      )
        throw new Error("native_restore_unavailable");
      const rearm = Reflect.get(value.admission, "rearm");
      if (
        rearm !== undefined &&
        (typeof rearm !== "object" ||
          rearm === null ||
          Reflect.get(rearm, "claimId") !== command.claimId)
      )
        throw new Error("native_restore_unavailable");
      const authorization = await this.env.NATIVE_RESTORE_JOB_STORE.authorizeAdmission({
        ...value.admission,
        proposedClaimId: command.claimId,
      });
      if (
        typeof authorization !== "object" ||
        authorization === null ||
        Reflect.get(authorization, "authorized") !== true
      )
        throw new Error("native_restore_unavailable");
      if (this.ctx.container.running) await this.destroy();
      const accepted = await this.env.NATIVE_RESTORE_JOB_STORE.accept(value.admission);
      if (
        typeof accepted !== "object" ||
        accepted === null ||
        typeof Reflect.get(accepted, "status") !== "string"
      )
        throw new Error("native_restore_unavailable");
      const claimed = await this.env.NATIVE_RESTORE_JOB_STORE.claim({
        organizationId: command.organizationId,
        projectId: command.projectId,
        restoreId: command.restoreId,
        claimId: command.claimId,
      });
      if (
        typeof claimed !== "object" ||
        claimed === null ||
        !["claimed", "complete"].includes(String(Reflect.get(claimed, "status")))
      )
        throw new Error("native_restore_unavailable");
      return this.#invokeAlone(command);
    });
    this.#invocations = invocation.catch(() => undefined);
    return invocation;
  }

  public resumeNativeRestore(raw: unknown): Promise<unknown> {
    const invocation = this.#invocations.then(async () => {
      const command = parseRecoveryCommand(raw);
      if (command.action !== "restore" || !this.env.NATIVE_RESTORE_JOB_STORE)
        throw new Error("native_restore_unavailable");
      const scope = {
        organizationId: command.organizationId,
        projectId: command.projectId,
        restoreId: command.restoreId,
        claimId: command.claimId,
      };
      const before = await this.env.NATIVE_RESTORE_JOB_STORE.readClaim(scope);
      if (
        typeof before !== "object" ||
        before === null ||
        !(
          Reflect.get(before, "completed") === true ||
          (Reflect.get(before, "completed") === false &&
            Reflect.get(before, "inputState") === "consumed")
        )
      )
        throw new Error("native_restore_unavailable");
      if (this.ctx.container.running) await this.destroy();
      const claim = await this.env.NATIVE_RESTORE_JOB_STORE.readClaim(scope);
      if (
        typeof claim !== "object" ||
        claim === null ||
        !(
          Reflect.get(claim, "completed") === true ||
          (Reflect.get(claim, "completed") === false &&
            Reflect.get(claim, "inputState") === "consumed")
        )
      )
        throw new Error("native_restore_unavailable");
      if (Reflect.get(claim, "completed") === true)
        await this.env.NATIVE_RESTORE_JOB_STORE.claim(scope);
      return this.#invokeAlone(command);
    });
    this.#invocations = invocation.catch(() => undefined);
    return invocation;
  }

  public observeNativeRestore(raw: unknown): Promise<unknown> {
    const invocation = this.#invocations.then(async () => {
      if (!this.env.NATIVE_RESTORE_JOB_STORE) throw new Error("native_restore_unavailable");
      await this.env.NATIVE_RESTORE_JOB_STORE.observe(raw);
      if (this.ctx.container.running) await this.destroy();
      return this.env.NATIVE_RESTORE_JOB_STORE.observe(raw);
    });
    this.#invocations = invocation.catch(() => undefined);
    return invocation;
  }

  async #invokeAlone(raw: unknown): Promise<unknown> {
    const command = parseRecoveryCommand(raw);
    const configuration = this.env.RECOVERY_CONFIGURATION;
    if (
      !["poc-private-fullstack", "production"].includes(this.env.RESOURCE_NAMESPACE) ||
      typeof configuration !== "string" ||
      configuration.length < 2 ||
      configuration.length > 8192
    )
      throw new Error("recovery_configuration_invalid");
    // A surviving container may belong to an earlier executor. Without current Core proof this caller
    // has no authority to stop it; fail closed until the platform expires that container.
    if (this.ctx.container.running) throw new Error("recovery_container_busy");
    let grantInstalled = false;
    try {
      const token = randomToken();
      const controlToken = mintControlToken();
      const tokenSha256 = await sha256Hex(controlToken);
      await this.startAndWaitForPorts({
        ports: [PORT],
        startOptions: {
          envVars: {
            RECOVERY_CONFIGURATION: configuration,
            RESOURCE_NAMESPACE: this.env.RESOURCE_NAMESPACE,
            RECOVERY_AGENT_TOKEN: token,
            RECOVERY_CONTROL_TOKEN: controlToken,
          },
          enableInternet: true,
        },
      });
      // The token lives from the moment the request can start, not from the container start latency.
      const grant: RecoveryControlGrant = {
        containerId: this.ctx.id.toString(),
        action: command.action,
        organizationId: command.organizationId,
        projectId: command.projectId,
        operationId:
          command.action === "restore" || command.action === "reconcile-restore-pin"
            ? command.restoreId
            : command.operationId,
        ...(command.action === "run" || command.action === "restore"
          ? { claimId: command.claimId }
          : {}),
        ...(command.action === "purge" ? { exportId: command.exportId } : {}),
        ...(command.action === "purge-restore-pin" ? { restoreId: command.restoreId } : {}),
        ...(command.action === "reconcile-restore-pin"
          ? {
              principalId: command.principalId,
              ...(command.delegation === undefined ? {} : { delegation: command.delegation }),
            }
          : {}),
        tokenSha256,
        expiresAtMs: Date.now() + CONTROL_TOKEN_MS,
      };
      // Only the digest of the job token is stored with the interception; the token itself stays in the Container.
      grantInstalled = true;
      await this.setOutboundByHost(RECOVERY_CONTROL_HOST, RECOVERY_CONTROL_HANDLER, grant);
      let response: Response;
      try {
        response = await this.ctx.container.getTcpPort(PORT).fetch("http://recovery-agent/invoke", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(CONTAINER_REQUEST_MS),
        });
      } catch {
        throw new Error("recovery_container_unavailable");
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("recovery_container_unavailable");
      }
      return parseResult(command, await boundedResult(response));
    } finally {
      // Authority first: the job grant is withdrawn (and its persisted copy rewritten by the library) BEFORE the
      // Container is destroyed, so a failing destroy can never leave a usable grant behind. Each step is attempted
      // regardless of the other; the token itself only ever existed inside the destroyed Container.
      if (grantInstalled) {
        try {
          await this.removeOutboundByHost(RECOVERY_CONTROL_HOST);
        } catch {
          console.warn("recovery_control_grant_pending");
        }
      }
      try {
        await this.destroy();
      } catch {
        console.warn("recovery_container_destroy_pending");
      }
    }
  }

  public override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function boundedResult(response: Response): Promise<unknown> {
  const stated = Number(response.headers.get("content-length") ?? "0");
  if (stated > MAX_RESULT_BYTES || response.body === null)
    throw new Error("recovery_container_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_RESULT_BYTES) throw new Error("recovery_container_response_invalid");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("recovery_container_response_invalid");
  }
}

function parseResult(
  command: ReturnType<typeof parseRecoveryCommand>,
  raw: unknown,
): Readonly<Record<string, unknown>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("recovery_container_response_invalid");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (command.action === "restore") {
    if (
      keys !== "restoreId,status" ||
      value["status"] !== "complete" ||
      value["restoreId"] !== command.restoreId
    )
      throw new Error("recovery_container_response_invalid");
    return value;
  }
  if (command.action === "run") {
    if (
      keys !== "status" ||
      !["absent", "queued", "running", "succeeded", "failed", "cancelled"].includes(
        String(value["status"]),
      )
    )
      throw new Error("recovery_container_response_invalid");
    return value;
  }
  if (command.action === "purge") {
    if (
      keys !== "exportId,status" ||
      value["status"] !== "absent" ||
      value["exportId"] !== command.exportId
    )
      throw new Error("recovery_container_response_invalid");
    return value;
  }
  if (command.action === "purge-restore-pin") {
    if (
      keys !== "restoreId,status" ||
      value["status"] !== "absent" ||
      value["restoreId"] !== command.restoreId
    )
      throw new Error("recovery_container_response_invalid");
    return value;
  }
  if (command.action === "reconcile-restore-pin") {
    if (
      keys !== "restoreId,status" ||
      !["verified", "tombstoned"].includes(String(value["status"])) ||
      value["restoreId"] !== command.restoreId
    )
      throw new Error("recovery_container_response_invalid");
    return value;
  }
  if (keys === "status" && value["status"] === "unavailable") return value;
  if (
    keys !==
      "archiveExpiresAt,bytes,capturedAt,downloadExpiresAt,operationId,sha256,sqlFiles,status,url" ||
    value["status"] !== "ready" ||
    value["operationId"] !== command.operationId ||
    typeof value["url"] !== "string" ||
    typeof value["sha256"] !== "string" ||
    typeof value["bytes"] !== "number" ||
    !Array.isArray(value["sqlFiles"])
  )
    throw new Error("recovery_container_response_invalid");
  return value;
}
