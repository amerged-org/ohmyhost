/* global fetch, URL, Response */
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import {
  createPreviewDatabaseBinding,
  decodePreviewValue,
} from "../../../packages/customer-runtime/src/preview-transport.ts";

const ENDPOINT = "http://preview.capabilities";

function database() {
  return createPreviewDatabaseBinding({
    endpoint: ENDPOINT,
    fetch: (request) => {
      return fetch(request);
    },
  });
}

class Connection extends RpcTarget {
  constructor(connection, environment) {
    super();
    this.connection = connection;
    this.environment = environment;
    this.closed = false;
  }
  async query(input) {
    if (this.closed) throw new Error("preview_connection_closed");
    return await this.connection.query(input);
  }
  async commit() {
    if (this.closed || typeof this.connection.commit !== "function")
      throw new Error("preview_connection_closed");
    return await this.connection.commit();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.connection.close();
  }
  [Symbol.dispose]() {
    void this.close().catch(() => undefined);
  }
}

/** These methods preserve the deployed OHMYHOST_DATABASE binding and RpcTarget lifetimes. */
async function ready() {
  const response = await fetch(`${ENDPOINT}/ready`, { redirect: "manual" });
  await response.body?.cancel();
  return response.status === 200;
}

export class Database extends WorkerEntrypoint {
  async ready() {
    return await ready();
  }
  async query(input) {
    return await database().query(input);
  }
  async transaction(input) {
    return await database().transaction(input);
  }
  async open() {
    return new Connection(await database().open(), this.env);
  }
  async openRls(input) {
    return new Connection(await database().openRls(input), this.env);
  }
}

export class Auth extends WorkerEntrypoint {
  async ready() {
    return await ready();
  }
  async validateSession(input) {
    if (!input || typeof input.cookie !== "string" || input.cookie.length > 16_384)
      throw new Error("preview_auth_input_invalid");
    const response = await fetch(`${ENDPOINT}/native-auth/session`, {
      method: "POST",
      headers: { cookie: input.cookie },
    });
    if (!response.ok) throw new Error("preview_auth_unavailable");
    return decodePreviewValue(await response.text());
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/__ohmyhost_preview_capabilities_ready")
      return new Response(null, { status: (await ready()) ? 200 : 503 });
    if (env.PREVIEW_APPLICATION) return env.PREVIEW_APPLICATION.fetch(request);
    if (new URL(request.url).pathname !== "/ready")
      return new Response("Not found", { status: 404 });
    // The private platform checks the selected real database/auth/capability authority.
    return await fetch(`${ENDPOINT}/ready`, { redirect: "manual" });
  },
};
