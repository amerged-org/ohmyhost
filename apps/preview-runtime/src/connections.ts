/** Connections are fenced by URL generation; neither chunks nor socket messages count as use. */
export class PreviewConnections {
  private readonly closers = new Map<number, Set<() => void>>();

  public closeGeneration(generation: number): void {
    for (const close of [...(this.closers.get(generation) ?? [])]) close();
  }

  public closeAll(): void {
    for (const generation of [...this.closers.keys()]) this.closeGeneration(generation);
  }

  private add(generation: number, close: () => void): void {
    const set = this.closers.get(generation) ?? new Set<() => void>();
    set.add(close);
    this.closers.set(generation, set);
  }

  private remove(generation: number, close: () => void): void {
    const set = this.closers.get(generation);
    set?.delete(close);
    if (set?.size === 0) this.closers.delete(generation);
  }

  public wrap(response: Response, generation: number): Response {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-robots-tag", "noindex, nofollow");
    headers.set("cross-origin-opener-policy", "same-origin");
    headers.set("cross-origin-resource-policy", "same-origin");
    headers.set("origin-agent-cluster", "?1");
    headers.set("referrer-policy", "no-referrer");
    headers.set("strict-transport-security", "max-age=31536000");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    const cookies = headers.getSetCookie();
    headers.delete("set-cookie");
    for (const cookie of cookies.slice(0, 32)) {
      if (
        cookie.length <= 4096 &&
        !cookie
          .split(";")
          .slice(1)
          .some((attribute) => /^\s*domain\s*=/iu.test(attribute))
      )
        headers.append("set-cookie", cookie);
    }
    if (response.status === 101 && response.webSocket)
      return this.socket(response.webSocket, headers, generation);
    if (response.body === null)
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    const reader = response.body.getReader();
    let ended = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const close = (): void => {
      if (ended) return;
      ended = true;
      this.remove(generation, close);
      void reader.cancel().catch(() => undefined);
      try {
        controller.close();
      } catch {
        /* Already canceled. */
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value;
      },
      pull: async (value) => {
        if (ended) return;
        try {
          const part = await reader.read();
          if (ended) return;
          if (part.done) close();
          else value.enqueue(part.value);
        } catch {
          close();
        }
      },
      cancel: close,
    });
    this.add(generation, close);
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private socket(upstream: WebSocket, headers: Headers, generation: number): Response {
    const pair = new WebSocketPair();
    const visitor = pair[0];
    const local = pair[1];
    // Workers deliver binary frames as Blob by default at this compatibility date;
    // select ArrayBuffer before accepting so synchronous relaying preserves bytes and order.
    upstream.binaryType = "arraybuffer";
    local.binaryType = "arraybuffer";
    upstream.accept();
    local.accept();
    let ended = false;
    const close = (): void => {
      if (ended) return;
      ended = true;
      this.remove(generation, close);
      for (const socket of [upstream, local]) {
        try {
          socket.close(1001, "Preview ended");
        } catch {
          /* Already closed. */
        }
      }
    };
    this.add(generation, close);
    for (const [from, to] of [
      [upstream, local],
      [local, upstream],
    ] as const) {
      from.addEventListener("message", (event) => {
        if (ended) return;
        try {
          to.send(event.data);
        } catch {
          close();
        }
      });
      from.addEventListener("close", close);
      from.addEventListener("error", close);
    }
    return new Response(null, { status: 101, webSocket: visitor, headers });
  }
}
