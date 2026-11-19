import { signEnvelope, verifyMarker } from "./runtime.js";
export default {
  async tail(
    events: readonly unknown[],
    env: {
      RUNTIME_CONFIGURATION_STATE: string;
      DIAGNOSTIC_PRODUCER_ID: string;
      DIAGNOSTIC_QUEUE: { send(value: string): Promise<void> };
      DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64: string;
    },
  ) {
    if (env.RUNTIME_CONFIGURATION_STATE !== "configured") return;
    for (const event of events.slice(0, 100)) {
      if (typeof event !== "object" || event === null) continue;
      const channelEvents = Reflect.get(event, "diagnosticsChannelEvents");
      if (!Array.isArray(channelEvents)) continue;
      for (const channelEvent of channelEvents.slice(0, 100)) {
        if (
          typeof channelEvent !== "object" ||
          channelEvent === null ||
          Reflect.get(channelEvent, "channel") !== "ohmyhost.diagnostic.v1"
        )
          continue;
        const marker = await verifyMarker(
          Reflect.get(channelEvent, "message"),
          env.DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64,
        );
        if (marker === null) continue;
        await env.DIAGNOSTIC_QUEUE.send(
          JSON.stringify(
            await signEnvelope(
              marker,
              env.DIAGNOSTIC_PRODUCER_ID,
              env.DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64,
            ),
          ),
        );
      }
    }
  },
};
