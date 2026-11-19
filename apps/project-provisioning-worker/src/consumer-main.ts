import { runQueueConsumer } from "./worker-runtime.js";
import type { CloudflareQueueBatch } from "./runtime-types.js";

export default {
  queue: (batch: CloudflareQueueBatch<unknown>, bindings: unknown) =>
    runQueueConsumer(batch, bindings),
};
