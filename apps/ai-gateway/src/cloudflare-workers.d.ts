declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    public constructor(context: unknown, env: Env);
  }
}

/* The Workers runtime globals the realtime route uses: a socket pair, an accepted socket and a 101 response. */
interface WebSocket {
  accept(): void;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}

interface Response {
  readonly webSocket?: WebSocket | null;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}
