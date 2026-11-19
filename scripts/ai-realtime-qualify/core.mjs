import { WorkerEntrypoint } from "cloudflare:workers";

/*
 * The fake Core of the realtime qualification: the five AI_RUNTIME methods the gateway calls, and the two ratelimit
 * bindings as always-success fakes. Every call is recorded, as one JSON line, through the RECORDER binding (a Node
 * function that appends to a file), so the evidence never depends on the Worker's memory. Nothing else is simulated.
 */

function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );
}

async function record(env, method, input) {
  await env.RECORDER.fetch("http://recorder.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, input: jsonSafe(input) }),
  });
}

export class AiGatewayRuntime extends WorkerEntrypoint {
  async authorizeKey(input) {
    await record(this.env, "authorizeKey", input);
    const accepted =
      input.projectId === this.env.TEST_PROJECT_ID && input.keySha256 === this.env.TEST_KEY_SHA256;
    if (!accepted) return null;
    return {
      organizationId: this.env.TEST_ORGANIZATION_ID,
      projectId: input.projectId,
      environmentId: this.env.TEST_ENVIRONMENT_ID,
      jurisdiction: "any",
    };
  }

  async admit(input) {
    await record(this.env, "admit", input);
    return { admitted: true, reservedMicros: 500_000 };
  }

  async settle(input) {
    await record(this.env, "settle", input);
    return { settled: true, chargedMicros: 0 };
  }

  async release(input) {
    await record(this.env, "release", input);
    return { released: true };
  }

  async sweep(input) {
    await record(this.env, "sweep", input);
    return { released: 0 };
  }
}

/** Always-success stand-in for the PROJECT_LIMITER and AUTH_LIMITER ratelimit bindings (`limit({ key })`). */
export class RateLimiter extends WorkerEntrypoint {
  async limit() {
    return { success: true };
  }
}
