import { Container } from "@cloudflare/containers";
import type {
  BuildStartCommand,
  BuildState,
  BuildStatus,
  BuildUsage,
} from "@ohmyhost/build-broker";

import {
  buildObjectsBuckets,
  type BuildObjectsBindings,
  type BuildObjectsBucket,
  type BuildRegion,
} from "./build-placement.js";
import { readBounded } from "./r2-object-store.js";

/** Must equal `containers[].instance_type` of the Wrangler configurations; it is what gets billed. */
export const BUILD_SANDBOX_INSTANCE_TYPE = "standard-3";
export const BUILD_SANDBOX_PORT = 8080;
export const POLL_INTERVAL_SECONDS = 5;
/** A build that has not reached `running` this long after the sandbox was requested is given up. */
export const LAUNCH_TIMEOUT_MILLISECONDS = 5 * 60_000;
/** The longest a customer build may run inside the sandbox. */
export const EXECUTION_TIMEOUT_MILLISECONDS = 8 * 60_000;

const RECORD_KEY = "build";
const POLL_CALLBACK = "poll";
const CONTROL_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const TRANSFER_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const MAXIMUM_STATUS_BYTES = 256 * 1024;
const MAXIMUM_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAXIMUM_LOG_BYTES = 5 * 1024 * 1024;
const OPERATION_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export type BuildSandboxBindings = BuildObjectsBindings;

/** Results cross the Durable Object boundary as values: an RPC exception keeps no `code`. */
export type StartBuildResult =
  | Readonly<{ ok: true; buildId: string; projectName: string }>
  | Readonly<{ ok: false; code: "InvalidCommand" | "BuildConflict" }>;

export type StopBuildResult =
  | Readonly<{ ok: true; buildId: string; status: "STOPPED" }>
  | Readonly<{ ok: false; code: "BuildNotFound" | "BuildNotRunning" }>;

type BuildFaultReason =
  | "source_object_changed"
  | "source_rejected"
  | "start_rejected"
  | "agent_unauthorized"
  | "status_unreadable"
  | "sandbox_restarted"
  | "sandbox_stopped"
  | "bundle_missing"
  | "log_invalid";

interface BuildRecord {
  readonly command: BuildStartCommand;
  /** The bearer token of this operation's sandbox agent; the customer process never sees it. */
  readonly token: string;
  /** When the sandbox was requested. */
  readonly startTime: string;
  /** When the agent accepted the start; null while the sandbox is still being launched. */
  readonly runningSince: string | null;
  readonly status: BuildStatus;
  readonly usage: BuildUsage | null;
  readonly sandboxDestroyed: boolean;
}

interface AgentStatus {
  readonly state: "idle" | "running" | "succeeded" | "failed";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failure: Readonly<Record<string, unknown>> | null;
}

/**
 * One object per build operation (`idFromName(operationId)`). It owns the operation's build
 * sandbox and moves every byte itself: the source archive from R2 into the sandbox, the bundle,
 * the failure excerpt and the log back into R2. The sandbox holds no platform credential. Every
 * step reads the record from storage, so an evicted object resumes where it stopped, and every
 * terminal status destroys the sandbox.
 */
export class BuildSandbox extends Container<BuildSandboxBindings> {
  public override defaultPort = BUILD_SANDBOX_PORT;
  public override requiredPorts = [BUILD_SANDBOX_PORT];
  public override enableInternet = true;
  /** Only a backstop for a sandbox whose polling ended; a polled build renews it every tick. */
  public override sleepAfter = "15m";
  /** The region of this class's container application; its build objects bucket is the only one it touches. */
  protected readonly region: BuildRegion = "us";

  public async startBuild(command: BuildStartCommand): Promise<StartBuildResult> {
    if (!isBuildStartCommand(command, this.objects().bucketName)) {
      return Object.freeze({ ok: false, code: "InvalidCommand" });
    }
    const existing = await this.load();
    if (existing !== undefined && commandIdentity(existing.command) !== commandIdentity(command)) {
      return Object.freeze({ ok: false, code: "BuildConflict" });
    }
    if (existing === undefined) {
      await this.ctx.storage.put<BuildRecord>(RECORD_KEY, {
        command,
        token: randomToken(),
        startTime: new Date().toISOString(),
        runningSince: null,
        status: "IN_PROGRESS",
        usage: null,
        sandboxDestroyed: false,
      });
    }
    // A replayed start re-arms the poll, so a lost first arming cannot strand the build.
    if (existing === undefined || existing.status === "IN_PROGRESS") await this.arm(0);
    return Object.freeze({
      ok: true,
      buildId: command.buildId,
      projectName: command.buildProject,
    });
  }

  public async readBuild(): Promise<BuildState | null> {
    const record = await this.load();
    if (record === undefined) return null;
    const environment = new Map(record.command.environment.map(({ name, value }) => [name, value]));
    return Object.freeze({
      buildId: record.command.buildId,
      projectName: record.command.buildProject,
      status: record.status,
      startTime: new Date(record.startTime),
      operationId: environment.get("OPERATION_ID"),
      inputFingerprint: environment.get("BUILD_INPUT_FINGERPRINT"),
      usage: record.usage,
    });
  }

  public async stopBuild(): Promise<StopBuildResult> {
    const record = await this.load();
    if (record === undefined) return Object.freeze({ ok: false, code: "BuildNotFound" });
    if (record.status !== "IN_PROGRESS") {
      return Object.freeze({ ok: false, code: "BuildNotRunning" });
    }
    const final = await this.finish("STOPPED", record.runningSince, new Date().toISOString());
    if (!(await this.destroySandbox(final))) await this.arm(POLL_INTERVAL_SECONDS);
    if (final.status !== "STOPPED") return Object.freeze({ ok: false, code: "BuildNotRunning" });
    return Object.freeze({ ok: true, buildId: final.command.buildId, status: "STOPPED" });
  }

  /** The scheduled tick. It re-arms itself until the build is terminal and the sandbox is gone. */
  public async poll(): Promise<void> {
    let again = true;
    try {
      again = await this.advance();
    } finally {
      if (again) await this.arm(POLL_INTERVAL_SECONDS);
    }
  }

  /** A sandbox nobody polls any more must not keep running: SIGTERM is not enough, destroy it. */
  public override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }

  private async advance(): Promise<boolean> {
    const record = await this.load();
    if (record === undefined) return false;
    if (record.status !== "IN_PROGRESS") return !(await this.destroySandbox(record));
    this.renewActivityTimeout();
    const now = Date.now();
    if (record.runningSince === null) {
      if (now - Date.parse(record.startTime) > LAUNCH_TIMEOUT_MILLISECONDS) {
        return this.conclude("TIMED_OUT", null, new Date(now).toISOString());
      }
      return this.launch(record);
    }
    if (!this.ctx.container.running) {
      // The sandbox is gone although its build never reported an end: a crash, never a success.
      console.warn("build_sandbox_fault", {
        buildId: record.command.buildId,
        reason: "sandbox_stopped",
      });
      return this.conclude("FAULT", record.runningSince, new Date(now).toISOString());
    }
    if (now - Date.parse(record.runningSince) > EXECUTION_TIMEOUT_MILLISECONDS) {
      return this.conclude("TIMED_OUT", record.runningSince, new Date(now).toISOString());
    }
    return this.observe(record);
  }

  /** Starts the sandbox, hands it the exact source object and starts the build. Repeatable. */
  private async launch(record: BuildRecord): Promise<boolean> {
    try {
      await this.startAndWaitForPorts({
        ports: [BUILD_SANDBOX_PORT],
        startOptions: { envVars: { BUILD_AGENT_TOKEN: record.token }, enableInternet: true },
      });
    } catch {
      console.warn("build_sandbox_not_ready", { buildId: record.command.buildId });
      return true;
    }
    const { source } = record.command;
    const object = await this.objects().bucket.get(source.key);
    if (
      object === null ||
      object.version !== source.versionId ||
      object.size !== source.byteLength
    ) {
      await object?.body.cancel();
      return this.fault(record, "source_object_changed");
    }
    const received = await this.agent(record, "PUT", "/source", object.body);
    await received?.body?.cancel();
    if (received?.status === 400 || received?.status === 413)
      return this.fault(record, "source_rejected");
    // 409 means the agent already started this build; the identical start below confirms it.
    if (received?.status !== 204 && received?.status !== 409) return true;
    const started = await this.agent(
      record,
      "POST",
      "/start",
      JSON.stringify({
        environment: Object.fromEntries(
          record.command.environment.map(({ name, value }) => [name, value]),
        ),
      }),
    );
    await started?.body?.cancel();
    if (started?.status === 400) return this.fault(record, "start_rejected");
    if (started?.status !== 202) return true;
    await this.ctx.storage.put<BuildRecord>(RECORD_KEY, {
      ...record,
      runningSince: new Date().toISOString(),
    });
    return true;
  }

  /** Reads the agent's status and, once the build ended, moves its outputs into R2. */
  private async observe(record: BuildRecord): Promise<boolean> {
    const response = await this.agent(record, "GET", "/status");
    if (response?.status === 401) {
      await response.body?.cancel();
      return this.fault(record, "agent_unauthorized");
    }
    if (response?.ok !== true || response.body === null) {
      await response?.body?.cancel();
      return true;
    }
    let status: AgentStatus | null;
    try {
      const { body } = await readBounded(response.body, MAXIMUM_STATUS_BYTES, true);
      status = parseAgentStatus(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      status = null;
    }
    // An idle agent has lost the build it was given: the sandbox restarted underneath it.
    if (status === null || status.state === "idle")
      return this.fault(record, status === null ? "status_unreadable" : "sandbox_restarted");
    if (status.state === "running") return true;

    // The billed end is this object's clock at observation; the sandbox's own instants are never billed.
    const observedAt = new Date().toISOString();
    const { outputs } = record.command;
    if (status.state === "succeeded") {
      const bundle = await this.download(record, "/bundle", MAXIMUM_BUNDLE_BYTES);
      if (bundle === "unavailable") return true;
      if (bundle === "invalid" || bundle === "absent") return this.fault(record, "bundle_missing");
      await this.store(outputs.bundleKey, bundle, "application/gzip");
    } else if (status.failure !== null) {
      await this.store(outputs.failureKey, JSON.stringify(status.failure), "application/json");
    }
    const log = await this.download(record, "/log", MAXIMUM_LOG_BYTES);
    if (log === "unavailable") return true;
    if (log === "invalid") return this.fault(record, "log_invalid");
    if (log !== "absent") await this.store(outputs.logKey, log, "text/plain; charset=utf-8");
    return this.conclude(
      status.state === "succeeded" ? "SUCCEEDED" : "FAILED",
      record.runningSince,
      observedAt,
    );
  }

  /** A fault is the operator's only evidence: name the step that refused, never just the outcome. */
  private fault(record: BuildRecord, reason: BuildFaultReason): Promise<boolean> {
    console.warn("build_sandbox_fault", { buildId: record.command.buildId, reason });
    return this.conclude("FAULT", record.runningSince, new Date().toISOString());
  }

  /** Records the terminal status and destroys the sandbox; true while the destroy is outstanding. */
  private async conclude(
    status: Exclude<BuildStatus, "IN_PROGRESS">,
    provisioningStartedAt: string | null,
    completedAt: string,
  ): Promise<boolean> {
    return !(await this.destroySandbox(
      await this.finish(status, provisioningStartedAt, completedAt),
    ));
  }

  /** The first terminal status wins; a later one never overwrites it. */
  private async finish(
    status: Exclude<BuildStatus, "IN_PROGRESS">,
    provisioningStartedAt: string | null,
    completedAt: string,
  ): Promise<BuildRecord> {
    const current = await this.load();
    if (current === undefined) throw new Error("build_sandbox_record_missing");
    if (current.status !== "IN_PROGRESS") return current;
    const terminal: BuildRecord = {
      ...current,
      status,
      usage: measuredUsage(current.startTime, status, provisioningStartedAt, completedAt),
    };
    await this.ctx.storage.put<BuildRecord>(RECORD_KEY, terminal);
    return terminal;
  }

  private async destroySandbox(record: BuildRecord): Promise<boolean> {
    if (record.sandboxDestroyed) return true;
    try {
      await this.destroy();
    } catch {
      console.error("build_sandbox_destroy_failed", { buildId: record.command.buildId });
      return false;
    }
    await this.ctx.storage.put<BuildRecord>(RECORD_KEY, { ...record, sandboxDestroyed: true });
    return true;
  }

  /** One authenticated request to the sandbox agent; null when the sandbox did not answer. */
  private async agent(
    record: BuildRecord,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: ReadableStream<Uint8Array> | string,
  ): Promise<Response | null> {
    try {
      return await this.ctx.container
        .getTcpPort(BUILD_SANDBOX_PORT)
        .fetch(`http://build-sandbox${path}`, {
          method,
          headers: {
            authorization: `Bearer ${record.token}`,
            ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
          },
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(
            typeof body === "object" || path === "/bundle"
              ? TRANSFER_REQUEST_TIMEOUT_MILLISECONDS
              : CONTROL_REQUEST_TIMEOUT_MILLISECONDS,
          ),
        });
    } catch {
      return null;
    }
  }

  private async download(
    record: BuildRecord,
    path: "/bundle" | "/log",
    maximumBytes: number,
  ): Promise<Uint8Array | "absent" | "invalid" | "unavailable"> {
    const response = await this.agent(record, "GET", path);
    if (response?.status === 404) {
      await response.body?.cancel();
      return "absent";
    }
    if (response?.ok !== true || response.body === null) {
      await response?.body?.cancel();
      return "unavailable";
    }
    try {
      const { body } = await readBounded(response.body, maximumBytes, true);
      // An empty log is a silent build's output, not a missing one; only an empty bundle is invalid.
      if (body.byteLength === 0) return path === "/log" ? "absent" : "invalid";
      return body;
    } catch {
      return "invalid";
    }
  }

  /** Outputs are immutable: a key that already holds this operation's object is left as it is. */
  private async store(key: string, value: Uint8Array | string, contentType: string): Promise<void> {
    await this.objects().bucket.put(key, value, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType },
    });
  }

  private objects(): BuildObjectsBucket {
    const bucket = buildObjectsBuckets(this.env).find(({ region }) => region === this.region);
    if (bucket === undefined) throw new Error("build_runner_configuration_invalid");
    return bucket;
  }

  private load(): Promise<BuildRecord | undefined> {
    return this.ctx.storage.get<BuildRecord>(RECORD_KEY);
  }

  private async arm(seconds: number): Promise<void> {
    this.deleteSchedules(POLL_CALLBACK);
    await this.schedule(seconds, POLL_CALLBACK);
  }
}

/** Measured times of one build, kept in order; every instant is this object's own clock. */
function measuredUsage(
  startTime: string,
  status: Exclude<BuildStatus, "IN_PROGRESS">,
  provisioningStartedAt: string | null,
  completedAt: string,
): BuildUsage {
  const requested = Date.parse(startTime);
  const provisioned = provisioningStartedAt === null ? null : Date.parse(provisioningStartedAt);
  const started = Math.min(requested, provisioned ?? requested);
  const completed = Math.max(Date.parse(completedAt), provisioned ?? started, started);
  return Object.freeze({
    runner: "cloudflare-build-sandbox",
    instanceType: BUILD_SANDBOX_INSTANCE_TYPE,
    status,
    startedAt: new Date(started).toISOString(),
    provisioningStartedAt: provisioned === null ? null : new Date(provisioned).toISOString(),
    completedAt: new Date(completed).toISOString(),
  });
}

function parseAgentStatus(value: unknown): AgentStatus | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "completedAt,failure,startedAt,state" ||
    (value["failure"] !== null && !isRecord(value["failure"]))
  ) {
    return null;
  }
  const { state, startedAt, completedAt, failure } = value;
  if (state === "idle" || state === "running") {
    return { state, startedAt: null, completedAt: null, failure: null };
  }
  if (
    (state !== "succeeded" && state !== "failed") ||
    !isInstant(startedAt) ||
    !isInstant(completedAt) ||
    Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    return null;
  }
  return { state, startedAt, completedAt, failure: failure as AgentStatus["failure"] };
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The same object for the EU container application; it reads and writes the EU build objects bucket. */
export class BuildSandboxEu extends BuildSandbox {
  protected override readonly region: BuildRegion = "eu";
}

function isBuildStartCommand(command: BuildStartCommand, bucket: string): boolean {
  if (
    !isRecord(command) ||
    !Array.isArray(command.environment) ||
    !isRecord(command.source) ||
    !isRecord(command.outputs)
  ) {
    return false;
  }
  const environment = command.environment as readonly unknown[];
  if (
    !environment.every(
      (entry) =>
        isRecord(entry) && typeof entry["name"] === "string" && typeof entry["value"] === "string",
    )
  ) {
    return false;
  }
  const operationId = command.environment.find(({ name }) => name === "OPERATION_ID")?.value;
  const cacheLimits = command.environment.filter(({ name }) => name === "SSG_CACHE_MAX_BYTES");
  const revalidatePath = command.environment.filter(({ name }) => name === "NEXT_REVALIDATE_PATH");
  if (
    revalidatePath.length > 1 ||
    (revalidatePath[0] !== undefined &&
      (command.environment.find(({ name }) => name === "FRAMEWORK_ADAPTER")?.value !== "nextjs" ||
        revalidatePath[0].value !== "1")) ||
    cacheLimits.length > 1 ||
    (cacheLimits[0] !== undefined &&
      (command.environment.find(({ name }) => name === "FRAMEWORK_ADAPTER")?.value !== "nextjs" ||
        !/^[1-9][0-9]{6,7}$/u.test(cacheLimits[0].value) ||
        Number(cacheLimits[0].value) < 1048576 ||
        Number(cacheLimits[0].value) > 67108864 ||
        Number(cacheLimits[0].value) % 1048576 !== 0))
  )
    return false;
  return (
    typeof command.buildProject === "string" &&
    typeof command.idempotencyToken === "string" &&
    operationId !== undefined &&
    OPERATION_ID_PATTERN.test(operationId) &&
    command.buildId === `${command.buildProject}:${operationId}` &&
    command.source.bucket === bucket &&
    [command.source.key, command.source.versionId, command.source.sha256].every(
      (value) => typeof value === "string" && value.length > 0,
    ) &&
    Number.isSafeInteger(command.source.byteLength) &&
    command.source.byteLength > 0 &&
    [command.outputs.bundleKey, command.outputs.failureKey, command.outputs.logKey].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  );
}

function commandIdentity(command: BuildStartCommand): string {
  return JSON.stringify([
    command.buildProject,
    command.buildId,
    command.idempotencyToken,
    command.environment.map(({ name, value }) => [name, value]),
    [
      command.source.bucket,
      command.source.key,
      command.source.versionId,
      command.source.sha256,
      command.source.byteLength,
    ],
    [command.outputs.bundleKey, command.outputs.failureKey, command.outputs.logKey],
  ]);
}

/** 32 random bytes as 64 hexadecimal characters; the agent requires at least 32 characters. */
function randomToken(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
