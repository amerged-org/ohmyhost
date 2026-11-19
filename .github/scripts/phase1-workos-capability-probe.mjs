/* global Headers, Request, Response, URL, AbortSignal, TextDecoder */

const json = (status, code) =>
  new Response(JSON.stringify({ ok: false, error: { code } }), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });

/** Read-only D1 functional convergence, not a settings/permission claim; contacts remain inside this probe. */
async function controlProfileProbe(request, bindings) {
  try {
    const input = await boundedJson(request, 2048);
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "artifactSha256,deployment,sessionId,userId,versionId" ||
      !/^user_[A-Za-z0-9_]{1,123}$/u.test(input.userId ?? "") ||
      !/^session_[A-Za-z0-9_]{1,120}$/u.test(input.sessionId ?? "") ||
      !/^[a-f0-9]{64}$/u.test(input.artifactSha256 ?? "") ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(input.versionId ?? "") ||
      !["development", "production"].includes(input.deployment)
    )
      return json(400, "invalid_request");
    if (bindings?.WORKOS_MANAGEMENT === undefined) return json(503, "unavailable");
    const response = await bindings.WORKOS_MANAGEMENT.fetch(
      new Request("https://workos-management.internal/user-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: input.userId, sessionId: input.sessionId }),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    const artifact = response.headers.get("x-ohmyhost-management-artifact-sha256");
    const version = response.headers.get("x-ohmyhost-cloudflare-version-id");
    const tag = response.headers.get("x-ohmyhost-cloudflare-version-tag");
    const deployment = response.headers.get("x-ohmyhost-workos-deployment");
    if (
      response.status !== 200 ||
      artifact !== input.artifactSha256 ||
      version !== input.versionId ||
      tag !== artifact ||
      deployment !== input.deployment
    ) {
      await response.body?.cancel();
      return json(503, "convergence_unverified");
    }
    const profile = await boundedJson(response, 32768);
    if (
      profile === null ||
      typeof profile !== "object" ||
      Array.isArray(profile) ||
      Object.keys(profile).sort().join(",") !==
        "email,email_verified,name,user_id,workos_organization_ids" ||
      profile.user_id !== input.userId ||
      typeof profile.name !== "string" ||
      profile.name.length > 256 ||
      typeof profile.email !== "string" ||
      profile.email.length > 254 ||
      typeof profile.email_verified !== "boolean" ||
      !Array.isArray(profile.workos_organization_ids) ||
      profile.workos_organization_ids.length > 100 ||
      profile.workos_organization_ids.some(
        (value) => typeof value !== "string" || !/^org_[A-Za-z0-9_]{1,124}$/u.test(value),
      )
    )
      return json(503, "convergence_unverified");
    // No email, name, user identity or organization list is returned or logged.
    return new Response(
      JSON.stringify({
        schemaVersion: 3,
        kind: "workos-control-profile/v3",
        state: "verified",
        artifactSha256: artifact,
        cloudflareWorkerVersionId: version,
        versionTag: tag,
        deployment,
        observedAt: new Date().toISOString(),
      }),
      { status: 200, headers: { "cache-control": "no-store", "content-type": "application/json" } },
    );
  } catch {
    return json(503, "unavailable");
  }
}
async function boundedJson(message, limit) {
  if (message.body === null) throw new Error("missing body");
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const worker = {
  async fetch(request, bindings) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/control-probe" && url.search === "")
      return controlProfileProbe(request, bindings);
    if (
      request.method !== "POST" ||
      url.pathname !== "/probe" ||
      url.search !== "" ||
      request.body !== null
    ) {
      return json(404, "not_found");
    }
    if (bindings?.WORKOS_MANAGEMENT === undefined) {
      return json(503, "unavailable");
    }
    try {
      const response = await bindings.WORKOS_MANAGEMENT.fetch(
        new Request("https://workos-management.internal/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method: "capabilities.probe_read_only",
            requestId: "capability-producer",
            payload: {},
          }),
        }),
      );
      const headers = new Headers({
        "cache-control": "no-store",
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
      });
      const artifactSha256 = response.headers.get("x-ohmyhost-management-artifact-sha256");
      if (/^[a-f0-9]{64}$/u.test(artifactSha256 ?? "")) {
        headers.set("x-ohmyhost-management-artifact-sha256", artifactSha256);
      }
      const versionId = response.headers.get("x-ohmyhost-cloudflare-version-id");
      if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(versionId ?? "")) {
        headers.set("x-ohmyhost-cloudflare-version-id", versionId);
      }
      const versionTag = response.headers.get("x-ohmyhost-cloudflare-version-tag");
      if (/^[a-f0-9]{64}$/u.test(versionTag ?? "")) {
        headers.set("x-ohmyhost-cloudflare-version-tag", versionTag);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return json(503, "unavailable");
    }
  },
};

export default worker;
