import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { activateTestCore, migrate, type TestControl } from "../support/control-d1.js";
import type { D1Database } from "../../src/d1-types.js";
import type { ProductWorkflowWireContext } from "../../src/catalog/provisioning/context.js";

/** A real private Worker RPC boundary around ONLY the owned reader; no parent mutation wiring is claimed. */
export async function createContextRpcControl(): Promise<
  TestControl & { read(scope: unknown): Promise<ProductWorkflowWireContext | null> }
> {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import { WorkerEntrypoint } from "cloudflare:workers";
 import { readProductWorkflowContext } from "./apps/control-store/src/catalog/provisioning/context.ts";
 import { SharedCoreRouter } from "./apps/control-store/src/router.ts";
 export class ContextReaderRuntime extends WorkerEntrypoint {
  readProductWorkflowContext(scope) {return readProductWorkflowContext({directory:this.env.CONTROL_CORE,router:new SharedCoreRouter(this.env.CONTROL_CORE)},scope);}
 }
 export default {fetch(){throw new Error("No HTTP context surface");}};`,
      resolveDir: root,
      sourcefile: "context-reader-rpc.mjs",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["source"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    metafile: true,
  });
  if (
    Object.keys(bundle.metafile.inputs).some((path) =>
      /packages\/database\/|node_modules\/.*(?:pg|postgres)/u.test(path),
    )
  )
    throw new Error("PostgreSQL runtime entered Core reader bundle");
  const entry = bundle.outputFiles[0];
  if (entry === undefined) throw new Error("Missing context reader Worker bundle");
  const miniflare = new Miniflare({
    workers: [
      {
        name: "core",
        modules: true,
        script: entry.text,
        d1Databases: { CONTROL_CORE: "core" },
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
      },
      {
        name: "caller",
        modules: true,
        script: `import {WorkerEntrypoint} from "cloudflare:workers"; export default class extends WorkerEntrypoint {read(scope){return this.env.CONTEXT.readProductWorkflowContext(scope);} fetch(){throw new Error("No HTTP reader transport");}}`,
        serviceBindings: { CONTEXT: { name: "core", entrypoint: "ContextReaderRuntime" } },
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
      },
    ],
  });
  try {
    const core = (await miniflare.getD1Database("CONTROL_CORE", "core")) as unknown as D1Database;
    await migrate(core, "core");
    await activateTestCore(core);
    const caller = (await miniflare.getWorker("caller")) as unknown as {
      read(scope: unknown): Promise<ProductWorkflowWireContext | null>;
    };
    return {
      core,
      bindings: { CONTROL_CORE: core },
      directory: core,
      shards: { CONTROL_SHARD_0000: core, CONTROL_SHARD_0001: core },
      dispose: () => miniflare.dispose(),
      read: async (scope) => await caller.read(scope),
    };
  } catch (error) {
    await miniflare.dispose();
    throw error;
  }
}
