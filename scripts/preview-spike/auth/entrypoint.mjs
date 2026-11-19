/* global Response */
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleQaAuthSession } from "./bridge.mjs";

/** The trusted sandbox DO, not the guest, selects this immutable service scope. */
export class QaNativeAuthSessionOutbound extends WorkerEntrypoint {
  fetch(request) {
    return handleQaAuthSession(request, this.env, this.ctx.props?.scope);
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
