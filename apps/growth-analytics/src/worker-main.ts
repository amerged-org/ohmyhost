import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createGrowthRuntime,
  type GrowthEnvironment,
  type GrowthContext,
  type GrowthBatch,
} from "./runtime.js";

/** Named bindings are the only ingestion surface; HTTP is exclusively the verified operator application. */
export class GrowthCollectRuntime extends WorkerEntrypoint<GrowthEnvironment> {
  collect(event: unknown) {
    return createGrowthRuntime(this.env, this.ctx).collect(event);
  }
  collectUsage(record: unknown) {
    return createGrowthRuntime(this.env, this.ctx).collectUsage(record);
  }
  observeHealth(observation: unknown) {
    return createGrowthRuntime(this.env, this.ctx).observeHealth(observation);
  }
  collectSourceHealth(snapshot: unknown) {
    return createGrowthRuntime(this.env, this.ctx).collectSourceHealth(snapshot);
  }
}
export class GrowthReconcileRuntime extends WorkerEntrypoint<GrowthEnvironment> {
  reconcile(source: Parameters<ReturnType<typeof createGrowthRuntime>["reconcile"]>[0]) {
    return createGrowthRuntime(this.env, this.ctx).reconcile(source);
  }
}
export default {
  fetch(request: Request, env: GrowthEnvironment, ctx: GrowthContext) {
    return createGrowthRuntime(env, ctx).fetch(request);
  },
  queue(batch: GrowthBatch, env: GrowthEnvironment, ctx: GrowthContext) {
    return createGrowthRuntime(env, ctx).consume(batch);
  },
  scheduled(_event: unknown, env: GrowthEnvironment, ctx: GrowthContext) {
    ctx.waitUntil(createGrowthRuntime(env, ctx).scheduled());
  },
};
