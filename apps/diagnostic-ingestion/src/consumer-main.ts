import { createConsumer, type DiagnosticPersistence } from "./runtime.js";

interface DiagnosticConsumerRuntime extends DiagnosticPersistence {
  purgeDiagnostics(input: { cutoff: string; limit: number }): Promise<number>;
}
interface ConsumerBindings {
  readonly RUNTIME_CONFIGURATION_STATE: string;
  readonly DIAGNOSTIC_CONSUMER_RUNTIME?: unknown;
}

/** Reject a direct Control binding by inventory before reading anything, then require the complete private capability. */
function consumerRuntime(env: ConsumerBindings) {
  if (env.RUNTIME_CONFIGURATION_STATE !== "configured")
    throw new Error("Diagnostic consumer disabled");
  const names = Object.getOwnPropertyNames(env);
  if (names.some((name) => /^CONTROL_(?:CORE|GLOBAL|DIRECTORY|SHARD_.*)$/u.test(name)))
    throw new TypeError("Diagnostic consumer has mixed Control authority");
  const runtime = env.DIAGNOSTIC_CONSUMER_RUNTIME;
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    typeof (runtime as DiagnosticConsumerRuntime).recordDiagnostic !== "function" ||
    typeof (runtime as DiagnosticConsumerRuntime).purgeDiagnostics !== "function"
  )
    throw new TypeError("Diagnostic consumer private runtime missing");
  return runtime as DiagnosticConsumerRuntime;
}

export default {
  /**
   * Every message is a signed diagnostic envelope. Anything else, such as a notification of the usage bucket's
   * retired R2 event rule, fails the envelope check and is acknowledged without a write instead of being retried.
   */
  async queue(
    batch: { messages: readonly { body: unknown; ack(): void; retry(): void }[] },
    env: ConsumerBindings & {
      readonly DIAGNOSTIC_PRODUCER_ID: string;
      readonly DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64: string;
    },
  ) {
    await createConsumer(
      consumerRuntime(env),
      env.DIAGNOSTIC_PRODUCER_ID,
      env.DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64,
    )(batch);
  },
  async scheduled(_controller: unknown, env: ConsumerBindings) {
    const persistence = consumerRuntime(env);
    let removed = 0;
    for (let batch = 0; batch < 10; batch++) {
      const count = await persistence.purgeDiagnostics({
        cutoff: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        limit: 1000,
      });
      removed += count;
      if (count < 1000) break;
    }
    return { removed };
  },
};
