declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: { readonly props: unknown; waitUntil(promise: Promise<unknown>): void };
    public constructor(context: unknown, env: Env);
  }
  export abstract class DurableObject<Env = unknown> {
    protected readonly env: Env;
    public constructor(context: unknown, env: Env);
  }
}
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
declare class HTMLRewriter {
  on(
    selector: string,
    handlers: {
      element(element: { append(content: string, options: { html: boolean }): void }): void;
    },
  ): HTMLRewriter;
  transform(response: Response): Response;
}
