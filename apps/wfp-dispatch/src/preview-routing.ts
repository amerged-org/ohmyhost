import { isIP } from "node:net";

export interface PreviewIngressEnvironment {
  readonly PREVIEW_HOST_SUFFIX?: string;
  /** A private service binding; only the runtime resolves capability authority. */
  readonly PREVIEW_RUNTIME?: { fetch(request: Request): Promise<Response> };
}

/** Return null for other hosts; reserved preview hosts never fall through to project routing. */
export async function routePreviewRequest(
  request: Request,
  environment: PreviewIngressEnvironment,
): Promise<Response | null> {
  const suffix = environment.PREVIEW_HOST_SUFFIX;
  if (suffix !== "preview.dev.omh.st" && suffix !== "preview.omh.st") return null;
  const url = new URL(request.url);
  if (url.hostname !== suffix && !url.hostname.endsWith(`.${suffix}`)) return null;
  const label = url.hostname.slice(0, -(suffix.length + 1));
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !/^[a-z2-7]{51}[aq]$/u.test(label)
  )
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    request.headers.get("origin") !== url.origin
  )
    return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  if (environment.PREVIEW_RUNTIME === undefined)
    return new Response("Service unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith("x-ohmyhost-") ||
      name.startsWith("cf-") ||
      name.startsWith("x-forwarded-") ||
      name === "forwarded" ||
      name === "host"
    )
      headers.delete(name);
  }
  // Only the gateway may add this header; the private runtime consumes it before the guest.
  const clientAddress = request.headers.get("cf-connecting-ip");
  if (clientAddress !== null && isIP(clientAddress) !== 0)
    headers.set("x-ohmyhost-preview-client-address", clientAddress);
  try {
    return await environment.PREVIEW_RUNTIME.fetch(new Request(request, { headers }));
  } catch {
    return new Response("Service unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
