import { WorkerEntrypoint } from "cloudflare:workers";
import type { CorePublisherBindings } from "./core-bindings.js";
import { runScheduledPublisher } from "./worker-runtime.js";

export default {
  scheduled: (_event: unknown, bindings: unknown) => runScheduledPublisher(bindings),
};

export class OperationPublisherService extends WorkerEntrypoint<CorePublisherBindings> {
  public async wake(): Promise<void> {
    await runScheduledPublisher(this.env, 1);
  }
}
