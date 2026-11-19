/* global fetch, Response */
import { WorkerEntrypoint } from "cloudflare:workers";
import { decodeValue } from "./capabilities/wire.mjs";

export { Database } from "./capabilities/guest-binding.mjs";

// This local workerd entrypoint carries no platform scope or credentials. The outbound
// intercept fixes those in the trusted Worker, independently of anything a guest sends.
export class Auth extends WorkerEntrypoint {
  async validateSession(input) {
    if (!input || typeof input.cookie !== "string" || input.cookie.length > 16_384)
      throw new Error("preview_auth_input_invalid");
    const response = await fetch("http://preview.capabilities/native-auth/session", {
      method: "POST",
      headers: { cookie: input.cookie },
    });
    if (!response.ok) throw new Error("preview_auth_unavailable");
    return decodeValue(await response.text());
  }
}

export default {
  fetch(request, env) {
    if (env.PREVIEW_APPLICATION) return env.PREVIEW_APPLICATION.fetch(request);
    return new Response("ready");
  },
};
