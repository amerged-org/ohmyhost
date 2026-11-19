/* global Response */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  armMailPermit,
  cleanupMailPermit,
  guestMailConfiguration,
  handleMailOutbound,
  peekMailPermit,
  readMailPermitStatus,
} from "./adapter.mjs";
import { createPermitOps } from "./permit.mjs";

// This namespace is bound only to the private QA-mail Worker, never to a container.
export class QaMailPermit extends DurableObject {
  ops() {
    return createPermitOps(this.ctx.storage, this.ctx.id.name);
  }
  arm(input) {
    return this.ops().arm(input);
  }
  peek(input) {
    return this.ops().peek(input);
  }
  consume(input) {
    return this.ops().consume(input);
  }
  complete(input, outcome) {
    return this.ops().complete(input, outcome);
  }
  status() {
    return this.ops().status();
  }
  cleanup(input) {
    return this.ops().cleanup(input);
  }
}

// Only the spike Worker receives this private service binding. No public fetch route exists.
export class QaMailPrivate extends WorkerEntrypoint {
  arm(request, sessionId) {
    return armMailPermit(request, this.env, sessionId);
  }
  peek(input) {
    return peekMailPermit(input, this.env);
  }
  status(input) {
    return readMailPermitStatus(input, this.env);
  }
  cleanup(input) {
    return cleanupMailPermit(input, this.env);
  }
  configuration() {
    return guestMailConfiguration(this.env);
  }
  send(request, props) {
    return handleMailOutbound(request, this.env, props);
  }
}

// Export this class from the spike Worker; the per-container intercept supplies immutable props.
export class QaMailIntercept extends WorkerEntrypoint {
  fetch(request) {
    return this.env.QA_MAIL_PRIVATE.send(request, this.ctx.props);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
