import { createHash } from "node:crypto";

import type {
  R2BucketBinding,
  R2MultipartUploadBinding,
  R2ObjectBody,
  R2ObjectHead,
  R2PutOptions,
  R2UploadedPart,
} from "../src/r2-object-store.js";

const encoder = new TextEncoder();

function streamOf(bytes: Uint8Array, chunkBytes = 3): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
}

async function bytesOf(body: ReadableStream<Uint8Array> | string): Promise<Uint8Array> {
  if (typeof body === "string") return encoder.encode(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly head: R2ObjectHead;
  readonly contentType: string | undefined;
}

type BucketMethod = keyof R2BucketBinding | "uploadPart" | "complete" | "abort";

/** A deterministic in-memory R2 bucket: one current version per key, multipart uploads, `onlyIf`. */
export class MemoryR2Bucket implements R2BucketBinding {
  public readonly objects = new Map<string, StoredObject>();
  public readonly uploads = new Map<
    string,
    {
      key: string;
      options: Omit<R2PutOptions, "onlyIf"> | undefined;
      parts: Map<number, Uint8Array>;
    }
  >();
  public readonly calls: BucketMethod[] = [];
  private readonly failures = new Map<BucketMethod, unknown[]>();
  private versions = 0;
  private uploadIds = 0;

  /** The next call of `method` rejects with `error`. */
  public failNext(method: BucketMethod, error: unknown): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }

  public seed(key: string, bytes: Uint8Array, options?: Omit<R2PutOptions, "onlyIf">) {
    return this.write(key, bytes, options);
  }

  public text(key: string): string | undefined {
    const object = this.objects.get(key);
    return object === undefined ? undefined : new TextDecoder().decode(object.bytes);
  }

  public contentType(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }

  public async head(key: string): Promise<R2ObjectHead | null> {
    this.enter("head");
    return this.objects.get(key)?.head ?? null;
  }

  public async get(key: string): Promise<R2ObjectBody | null> {
    this.enter("get");
    const object = this.objects.get(key);
    return object === undefined ? null : { ...object.head, body: streamOf(object.bytes) };
  }

  public async put(
    key: string,
    value: string | Uint8Array,
    options?: R2PutOptions,
  ): Promise<R2ObjectHead | null> {
    this.enter("put");
    if (options?.onlyIf?.get("if-none-match") === "*" && this.objects.has(key)) return null;
    return this.write(key, typeof value === "string" ? encoder.encode(value) : value, options);
  }

  public async delete(key: string): Promise<void> {
    this.enter("delete");
    this.objects.delete(key);
  }

  public async createMultipartUpload(
    key: string,
    options?: Omit<R2PutOptions, "onlyIf">,
  ): Promise<R2MultipartUploadBinding> {
    this.enter("createMultipartUpload");
    this.uploadIds += 1;
    const uploadId = `upload-${this.uploadIds}`;
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  public resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadBinding {
    const open = () => {
      const upload = this.uploads.get(uploadId);
      if (upload === undefined || upload.key !== key) {
        throw new Error("The specified multipart upload does not exist. (10024)");
      }
      return upload;
    };
    return {
      uploadId,
      uploadPart: async (partNumber: number, body: Uint8Array): Promise<R2UploadedPart> => {
        this.enter("uploadPart");
        open().parts.set(partNumber, body.slice());
        return { partNumber, etag: `part-${partNumber}-${body.byteLength}` };
      },
      complete: async (parts: readonly R2UploadedPart[]): Promise<R2ObjectHead> => {
        this.enter("complete");
        const upload = open();
        const bodies = parts.map((part) => {
          const body = upload.parts.get(part.partNumber);
          if (body === undefined || part.etag !== `part-${part.partNumber}-${body.byteLength}`) {
            throw new Error("One or more of the specified parts could not be found.");
          }
          return body;
        });
        const bytes = new Uint8Array(bodies.reduce((total, body) => total + body.byteLength, 0));
        let offset = 0;
        for (const body of bodies) {
          bytes.set(body, offset);
          offset += body.byteLength;
        }
        this.uploads.delete(uploadId);
        return this.write(key, bytes, upload.options);
      },
      abort: async (): Promise<void> => {
        this.enter("abort");
        open();
        this.uploads.delete(uploadId);
      },
    };
  }

  private enter(method: BucketMethod): void {
    this.calls.push(method);
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) throw failure;
  }

  private write(
    key: string,
    bytes: Uint8Array,
    options: Omit<R2PutOptions, "onlyIf"> | undefined,
  ): R2ObjectHead {
    this.versions += 1;
    const head: R2ObjectHead = {
      version: `version-${this.versions}`,
      etag: createHash("md5").update(bytes).digest("hex"),
      size: bytes.byteLength,
      ...(options?.customMetadata === undefined
        ? {}
        : { customMetadata: { ...options.customMetadata } }),
    };
    this.objects.set(key, {
      bytes: bytes.slice(),
      head,
      contentType: options?.httpMetadata?.contentType,
    });
    return head;
  }
}

const AGENT_ENVIRONMENT_NAMES = [
  "APPLICATION_ROOT",
  "AUTH_REQUIREMENT_JSON",
  "BUILD_COMMAND",
  "BUILD_ID",
  "BUILD_INPUT_FINGERPRINT",
  "BUILD_OUTPUT_DIRECTORY",
  "BUILD_PLAN_SHA256",
  "COMPATIBILITY_DATE",
  "COMPATIBILITY_FLAGS",
  "DATABASE_REQUIREMENT_JSON",
  "DEPLOYMENT_ID",
  "ENVIRONMENT_ID",
  "EXPECTED_SOURCE_SHA256",
  "FRAMEWORK_ADAPTER",
  "FRAMEWORK_RUNTIME",
  "FUNCTIONS_REQUIREMENT_JSON",
  "INSTALL_COMMAND",
  "MAIL_REQUIREMENT_JSON",
  "OPERATION_ID",
  "PROJECT_ID",
  "RUNTIME_POLICY_JSON",
  "SERVER_CONFIG_PATH",
  "SERVER_ENTRYPOINT",
  "SERVER_OUTPUT_DIRECTORY",
  "SOURCE_COMMIT_SHA",
  "STORAGE_REQUIREMENT_JSON",
];
const AGENT_REQUIRED_NAMES = [
  "EXPECTED_SOURCE_SHA256",
  "BUILD_PLAN_SHA256",
  "APPLICATION_ROOT",
  "INSTALL_COMMAND",
  "FRAMEWORK_ADAPTER",
  "FRAMEWORK_RUNTIME",
  "SOURCE_COMMIT_SHA",
  "OPERATION_ID",
  "BUILD_ID",
  "PROJECT_ID",
  "ENVIRONMENT_ID",
  "DEPLOYMENT_ID",
];

/**
 * The HTTP protocol of `sandbox/agent.mjs` without a build: token, 401, 204/409 for the source,
 * 202/409/400 for the start, the status document, 409 for a bundle that does not exist, 404 for a
 * log that does not exist. A test ends the build with `succeed` or `fail`.
 */
export class SandboxAgentDouble {
  public source: Uint8Array | null = null;
  public environment: Record<string, string> | null = null;
  public readonly requests: string[] = [];
  /** Answers the next request for `route` with this status instead of handling it. */
  public readonly refusals = new Map<string, number[]>();
  public statusBody: string | null = null;
  private state: "idle" | "running" | "succeeded" | "failed" = "idle";
  private startedAt: string | null = null;
  private completedAt: string | null = null;
  private failure: Record<string, unknown> | null = null;
  private bundle: Uint8Array | null = null;
  private log: Uint8Array | null = null;
  private acceptedStart: string | null = null;

  public constructor(public readonly token: string) {
    if (token.length < 32) throw new Error("BUILD_AGENT_TOKEN has at least 32 characters");
  }

  public succeed(bundle: Uint8Array, log: string | null, completedAt: string): void {
    this.state = "succeeded";
    this.bundle = bundle;
    this.log = log === null ? null : encoder.encode(log);
    this.completedAt = completedAt;
  }

  public fail(failure: Record<string, unknown> | null, log: string | null, completedAt: string) {
    this.state = "failed";
    this.failure = failure;
    this.log = log === null ? null : encoder.encode(log);
    this.completedAt = completedAt;
  }

  public async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const route = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    this.requests.push(route);
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${this.token}`) {
      return new Response(null, { status: 401 });
    }
    const refused = this.refusals.get(route)?.shift();
    if (refused !== undefined) return new Response(null, { status: refused });
    if (route === "PUT /source") {
      if (this.state !== "idle") return Response.json({ error: "closed" }, { status: 409 });
      const bytes = await bytesOf(init.body as ReadableStream<Uint8Array>);
      if (bytes.byteLength === 0) return Response.json({ error: "empty" }, { status: 400 });
      this.source = bytes;
      return new Response(null, { status: 204 });
    }
    if (route === "POST /start") {
      const parsed = JSON.parse(String(init.body)) as { environment: Record<string, string> };
      const entries = Object.entries(parsed.environment);
      if (
        Object.keys(parsed).join() !== "environment" ||
        entries.some(([name]) => !AGENT_ENVIRONMENT_NAMES.includes(name)) ||
        AGENT_REQUIRED_NAMES.some((name) => !parsed.environment[name])
      ) {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
      const requested = JSON.stringify(entries.sort());
      if (this.acceptedStart !== null) {
        return new Response(null, { status: this.acceptedStart === requested ? 202 : 409 });
      }
      if (this.source === null) return Response.json({ error: "no source" }, { status: 409 });
      this.acceptedStart = requested;
      this.environment = parsed.environment;
      this.state = "running";
      this.startedAt = new Date().toISOString();
      return new Response(null, { status: 202 });
    }
    if (route === "GET /status") {
      return this.statusBody === null
        ? Response.json({
            state: this.state,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            failure: this.failure,
          })
        : new Response(this.statusBody);
    }
    if (route === "GET /bundle") {
      return this.state === "succeeded" && this.bundle !== null
        ? new Response(streamOf(this.bundle, 1024))
        : Response.json({ error: "no bundle" }, { status: 409 });
    }
    if (route === "GET /log") {
      return this.log === null
        ? Response.json({ error: "no log" }, { status: 404 })
        : new Response(streamOf(this.log, 1024));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}

/**
 * What the Cloudflare platform gives a `BuildSandbox` object: durable storage, the sandbox and the
 * schedule. It outlives the object, so a second object over the same platform is an eviction.
 */
export class SandboxPlatformDouble {
  public readonly stored = new Map<string, unknown>();
  public readonly scheduled: { seconds: number; callback: string }[] = [];
  public readonly startOptions: unknown[] = [];
  public agent: SandboxAgentDouble | null = null;
  public running = false;
  public destroyed = 0;
  public renewed = 0;
  public startFailures = 0;
  public destroyFailures = 0;
  /** Requests to the sandbox fail at the network level while this is set. */
  public unreachable = false;

  public readonly storage = {
    get: async <T>(key: string): Promise<T | undefined> =>
      structuredClone(this.stored.get(key)) as T | undefined,
    put: async <T>(key: string, value: T): Promise<void> => {
      this.stored.set(key, structuredClone(value));
    },
  };

  public readonly container = {
    getTcpPort: (port: number) => ({
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        if (port !== 8080 || !this.running || this.agent === null || this.unreachable) {
          throw new Error("Network connection lost.");
        }
        return this.agent.fetch(url, init);
      },
    }),
  };

  public get context() {
    const container = { running: false, getTcpPort: this.container.getTcpPort };
    Object.defineProperty(container, "running", { get: () => this.running });
    return { storage: this.storage, container, platform: this as SandboxPlatformDouble };
  }

  public async startAndWaitForPorts(options: {
    startOptions?: { envVars?: Record<string, string> };
  }): Promise<void> {
    this.startOptions.push(options);
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new Error("there is no container instance that can be provided to this durable object");
    }
    if (this.running) return;
    this.agent = new SandboxAgentDouble(options.startOptions?.envVars?.["BUILD_AGENT_TOKEN"] ?? "");
    this.running = true;
  }

  public async destroy(): Promise<void> {
    if (this.destroyFailures > 0) {
      this.destroyFailures -= 1;
      throw new Error("destroy failed");
    }
    this.destroyed += 1;
    this.running = false;
  }

  /** The sandbox dies underneath the object. */
  public crash(): void {
    this.running = false;
  }

  public async schedule(seconds: number, callback: string): Promise<void> {
    this.scheduled.push({ seconds, callback });
  }

  public deleteSchedules(callback: string): void {
    for (let index = this.scheduled.length - 1; index >= 0; index -= 1) {
      if (this.scheduled[index]?.callback === callback) this.scheduled.splice(index, 1);
    }
  }

  /** Fires the due schedule the way the platform alarm would: once, then it is gone. */
  public async fire(target: { poll(): Promise<void> }): Promise<void> {
    const due = this.scheduled.shift();
    if (due === undefined) throw new Error("nothing is scheduled");
    if (due.callback !== "poll") throw new Error(`unexpected callback ${due.callback}`);
    await target.poll();
  }
}

/** The shape `vi.mock("@cloudflare/containers")` gives the base class in these tests. */
export class ContainerBaseDouble {
  public readonly ctx: SandboxPlatformDouble["context"];
  public readonly env: unknown;

  public constructor(ctx: SandboxPlatformDouble["context"], env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }

  public startAndWaitForPorts(options: never): Promise<void> {
    return this.ctx.platform.startAndWaitForPorts(options);
  }

  public destroy(): Promise<void> {
    return this.ctx.platform.destroy();
  }

  public schedule(seconds: number, callback: string): Promise<void> {
    return this.ctx.platform.schedule(seconds, callback);
  }

  public deleteSchedules(callback: string): void {
    this.ctx.platform.deleteSchedules(callback);
  }

  public renewActivityTimeout(): void {
    this.ctx.platform.renewed += 1;
  }
}
