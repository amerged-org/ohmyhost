import { WorkerEntrypoint } from "cloudflare:workers";
import { ProjectR2BucketConflictError } from "@ohmyhost/database";
import {
  createCloudflareR2BucketProvider,
  createR2UsageProvider,
} from "@ohmyhost/provider-cloudflare";

import { requireR2ManagementBindings, type R2ManagementBindings } from "./bindings.js";
import { createR2Management, parseDeletionReceipt, type R2Persistence } from "./runtime.js";
import { collectR2DailyUsage, type R2DailyUsage } from "./usage.js";

type Runtime = ReturnType<typeof createR2Management>;

async function withRuntime<T>(
  rawBindings: unknown,
  action: (runtime: Runtime) => Promise<T>,
): Promise<T> {
  const bindings = requireR2ManagementBindings(rawBindings);
  return action(
    createR2Management({
      persistence: createCoreR2Persistence(requireR2Core(bindings.R2_MANAGEMENT_RUNTIME)),
      provider: createCloudflareR2BucketProvider({
        accountId: bindings.CLOUDFLARE_ACCOUNT_ID,
        apiToken: bindings.CLOUDFLARE_R2_API_TOKEN,
        fetch: globalThis.fetch,
      }),
    }),
  );
}

interface R2Core {
  claimBucket(input: unknown): Promise<unknown>;
  authorizeBucket(input: unknown): Promise<unknown>;
  putBucket(input: unknown): Promise<unknown>;
  readBucket(input: unknown): Promise<unknown>;
  proveBucketAbsence(input: unknown): Promise<unknown>;
  supersedeBucketReservation(input: unknown): Promise<unknown>;
  confirmedStorage(input: unknown): Promise<unknown>;
}
function requireR2Core(value: unknown): R2Core {
  if (
    typeof value !== "object" ||
    value === null ||
    [
      "claimBucket",
      "authorizeBucket",
      "putBucket",
      "readBucket",
      "proveBucketAbsence",
      "supersedeBucketReservation",
      "confirmedStorage",
    ].some((name) => typeof Reflect.get(value, name) !== "function")
  )
    throw new TypeError("R2 management private Core runtime is unavailable");
  return value as R2Core;
}
const scopeOf = (i: Parameters<R2Persistence["claim"]>[0]) => ({
  organizationId: i.organizationId,
  projectId: i.projectId,
  environmentId: i.environmentId,
  operationId: i.operationId,
  claimId: i.claimId,
});
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid R2 Core response");
  return value as Record<string, unknown>;
}
export function createCoreR2Persistence(core: R2Core): R2Persistence {
  return {
    async claim(input) {
      let result: Record<string, unknown>;
      try {
        result = row(await core.claimBucket(input));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Project R2 bucket conflicts with durable state"
        )
          throw new ProjectR2BucketConflictError();
        throw error;
      }
      if (result["status"] === "completed")
        return { status: "completed", receipt: parseDeletionReceipt(result["receipt"]) };
      if (
        result["status"] === "claimed" &&
        (result["mode"] === "create" || result["mode"] === "observe")
      )
        return { status: "claimed", mode: result["mode"] };
      throw new Error("Invalid R2 Core claim response");
    },
    async authorize(input) {
      const value = await core.authorizeBucket(
        scopeOf(input as Parameters<R2Persistence["claim"]>[0]),
      );
      if (typeof value !== "boolean") throw new Error("Invalid R2 Core authorization response");
      return value;
    },
    async put(input) {
      const value = await core.putBucket({ ...input, observedAt: input.observedAt.toISOString() });
      if (value !== "created" && value !== "existing")
        throw new Error("Invalid R2 Core receipt response");
      return value;
    },
    async read(input) {
      const value = await core.readBucket({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
      });
      return value === null ? null : parseDeletionReceipt(value);
    },
    async proveBucketAbsence(input) {
      const value = await core.proveBucketAbsence({
        ...scopeOf(input),
        bucketName: input.bucketName,
        observedAt: input.observedAt.toISOString(),
      });
      if (value !== "proven") throw new Error("Invalid R2 Core absence response");
      return value;
    },
    async supersedeBucketReservation(input) {
      const value = await core.supersedeBucketReservation({
        ...scopeOf(input),
        bucketName: input.bucketName,
        observedAt: input.observedAt.toISOString(),
      });
      if (value !== "superseded" && value !== "operation_open")
        throw new Error("Invalid R2 Core supersede response");
      return value;
    },
  };
}
export class R2ManagementService extends WorkerEntrypoint<R2ManagementBindings> {
  /** Final daily usage of the named buckets for one finished UTC day; any failure throws. */
  public async collectUsage(input: unknown): Promise<R2DailyUsage> {
    const bindings = requireR2ManagementBindings(this.env);
    return collectR2DailyUsage({
      core: requireR2Core(bindings.R2_MANAGEMENT_RUNTIME),
      provider: createR2UsageProvider({
        accountId: bindings.CLOUDFLARE_ACCOUNT_ID,
        apiToken: bindings.CLOUDFLARE_R2_ANALYTICS_TOKEN,
        fetch: globalThis.fetch,
      }),
      request: input,
      now: new Date(),
    });
  }

  public async ensureBucket(input: unknown) {
    return withRuntime(this.env, (runtime) => runtime.ensureBucket(input));
  }

  public async readRuntimeBinding(input: unknown) {
    return withRuntime(this.env, (runtime) => runtime.readRuntimeBinding(input));
  }

  public async purgeAndDeleteBucket(input: unknown) {
    return withRuntime(this.env, (runtime) => runtime.purgeAndDeleteBucket(input));
  }
}

export default class R2ManagementWorker extends WorkerEntrypoint<R2ManagementBindings> {
  public async fetch() {
    return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  }
}
