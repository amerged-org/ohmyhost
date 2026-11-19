import { requireSchedulerBindings } from "./bindings.js";
import { createScheduledDispatch } from "./dispatch.js";
import { createCoreSchedulerPersistence } from "./persistence.js";
import { runSchedulerTick } from "./tick.js";

export default Object.freeze({
  fetch: async (): Promise<Response> =>
    new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } }),
  scheduled: async (
    event: Readonly<{ scheduledTime: number }>,
    rawBindings: unknown,
  ): Promise<void> => {
    const bindings = requireSchedulerBindings(rawBindings);
    const result = await runSchedulerTick({
      persistence: createCoreSchedulerPersistence(bindings.CONTROL_FUNCTIONS_RUNTIME),
      dispatch: createScheduledDispatch(bindings.CUSTOMER_DISPATCH),
      at: new Date(event.scheduledTime),
    });
    console.info(JSON.stringify({ event: "functions_scheduler_tick", ...result }));
  },
});
