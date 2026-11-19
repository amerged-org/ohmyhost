import { WorkerEntrypoint } from "cloudflare:workers";
import { handleDatabaseRequest } from "./bridge.mjs";

// Export from the test Worker's top-level module before registering the intercept.
export class QaDatabaseOutbound extends WorkerEntrypoint {
  fetch(request) {
    return handleDatabaseRequest(request, this.env, this.ctx.props);
  }
}
