/* global AbortController, setTimeout, Request, clearTimeout */
export class ReadinessFailure extends Error {
  constructor() {
    super("server_not_ready");
  }
}

export async function waitForReady(
  fetchPort,
  url,
  { timeoutMs = 180_000, perRequestMs = timeoutMs, pollMs = 250 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(perRequestMs, remaining)),
    );
    const request = new Request(url, { signal: controller.signal });
    let onAbort;
    try {
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error("readiness_aborted"));
        request.signal.addEventListener("abort", onAbort, { once: true });
      });
      const response = await Promise.race([fetchPort(request), aborted]);
      if (response.body) void response.body.cancel().catch(() => {});
      if (response.status === 200) return;
    } catch {
      // Do not overlap a later probe with one that ignored cancellation.
      if (request.signal.aborted) throw new ReadinessFailure();
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal.removeEventListener("abort", onAbort);
    }
    const delay = Math.min(pollMs, deadline - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new ReadinessFailure();
}
