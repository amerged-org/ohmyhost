import type {
  AiAdmitInput,
  AiAdmitResult,
  AiGatewayRuntime,
  AiKeyScope,
  AiJurisdiction,
  AiReleaseInput,
  AiSettleInput,
} from "@ohmyhost/platform";

export const PROJECT_ID = "01H00000000000000000000700";
export const ENVIRONMENT_ID = "01H00000000000000000000701";
export const ORGANIZATION_ID = "01H00000000000000000000702";
export const KEY = `omh_ai_${PROJECT_ID}_${"A".repeat(43)}`;
export const HAIKU = "anthropic/claude-haiku-5-5";
export const ORQ_BASE_URL = "https://my.orq.ai/v3/router";
export const ORQ_KEY = "orq-test-key";
export const TELEMETRY_URL = "https://my.orq.ai/v3/telemetry/query";

export function scopeOf(jurisdiction: AiJurisdiction): AiKeyScope {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    jurisdiction,
  };
}

/** A typed Core fake: records every call, fails on demand, and never touches a database. */
export class FakeCore implements AiGatewayRuntime {
  public scope: AiKeyScope | null = scopeOf("any");
  public admission: AiAdmitResult = { admitted: true, reservedMicros: 100 };
  public authorizeFails = false;
  public admitFails = false;
  public settleFailures = 0;
  public releaseFails = false;
  public sweepFails = false;
  public sweepReleased = 0;
  public readonly authorizeCalls: { projectId: string; keySha256: string }[] = [];
  public readonly admits: AiAdmitInput[] = [];
  public readonly settleCalls: AiSettleInput[] = [];
  public readonly releases: AiReleaseInput[] = [];
  public readonly sweeps: { olderThanMs: number; limit: number }[] = [];

  public async authorizeKey(input: { projectId: string; keySha256: string }) {
    this.authorizeCalls.push(input);
    if (this.authorizeFails) throw new Error("core unreachable");
    return this.scope;
  }

  public async admit(input: AiAdmitInput): Promise<AiAdmitResult> {
    this.admits.push(input);
    if (this.admitFails) throw new Error("core unreachable");
    return this.admission;
  }

  public async settle(input: AiSettleInput) {
    this.settleCalls.push(input);
    if (this.settleFailures > 0) {
      this.settleFailures -= 1;
      throw new Error("core unreachable");
    }
    return { settled: true as const, chargedMicros: 1 };
  }

  public async release(input: AiReleaseInput) {
    this.releases.push(input);
    if (this.releaseFails) throw new Error("core unreachable");
    return { released: true };
  }

  public async sweep(input: { olderThanMs: number; limit: number }) {
    this.sweeps.push(input);
    if (this.sweepFails) throw new Error("core unreachable");
    return { released: this.sweepReleased };
  }
}

/** A typed rate limiter fake. */
export class FakeLimiter {
  public success = true;
  public fails = false;
  public readonly keys: string[] = [];

  public async limit(input: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(input.key);
    if (this.fails) throw new Error("limiter unreachable");
    return { success: this.success };
  }
}

/** A fake orq endpoint: every call is recorded, the reply is chosen by the test. */
export class FakeOrq {
  public readonly calls: { url: string; init: RequestInit }[] = [];
  private reply: (init: RequestInit, url: string) => Promise<Response> | Response = () =>
    Response.json({ id: "x" });

  public respond(reply: (init: RequestInit, url: string) => Promise<Response> | Response): void {
    this.reply = reply;
  }

  public readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.calls.push({ url, init });
    return this.reply(init, url);
  };
}

/** The orq answer of a successful call: its body, its content type and its trace id. */
export function answer(
  body: BodyInit,
  traceId: string | null = "trace-1",
  contentType = "application/json",
) {
  const headers: Record<string, string> = { "content-type": contentType };
  if (traceId !== null) headers["x-orq-trace-id"] = traceId;
  return new Response(body, { status: 200, headers });
}

/** An orq telemetry answer that reports one cost in USD for the trace. */
export function telemetryReply(usd: number): Response {
  return Response.json({ data: [{ metrics: { "cost.total:sum": usd } }] });
}

/** An upstream SSE body that yields one chunk per pull and counts how often a reader cancels it. */
export function sseBody(chunks: readonly string[]): {
  readonly body: ReadableStream<Uint8Array>;
  readonly cancels: { count: number };
} {
  const encoder = new TextEncoder();
  const cancels = { count: 0 };
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next];
      next += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancels.count += 1;
    },
  });
  return { body, cancels };
}

/** A ctx whose waitUntil promises the test can await. */
export function fakeContext() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    },
    async drain(): Promise<void> {
      await Promise.all(pending);
    },
  };
}

/** The body of a call as the fake orq received it, parsed. */
export function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

export function headersOf(init: RequestInit | undefined): Record<string, string> {
  return { ...(init?.headers as Record<string, string>) };
}

/*
 * A fake WebSocket. The gateway's end of a pair is `1` and the customer's is `0`: a test delivers a message or a close
 * to the gateway's end as the customer would, and reads what the gateway sent or closed.
 */
export class FakeSocket {
  public readyState = 0;
  public binaryType = "blob";
  public closeFails = false;
  public acceptFails = false;
  public accepted = false;
  public readonly sent: unknown[] = [];
  public readonly closes: { code: number; reason: string }[] = [];
  private readonly listeners: { type: string; listener: (event: unknown) => void }[] = [];

  public accept(): void {
    if (this.acceptFails) throw new Error("accept failed");
    this.accepted = true;
    this.readyState = 1;
  }

  public send(message: unknown): void {
    if (this.readyState !== 1) throw new Error("the socket is not open");
    this.sent.push(message instanceof Blob ? String(message) : message);
  }

  /** workerd refuses codes below 1000 or above 4999 and 1004, 1005, 1006, 1015 (measured), and a reason over 123 UTF-8 bytes. */
  public close(code: number, reason: string): void {
    if (
      this.closeFails ||
      code < 1000 ||
      code > 4999 ||
      [1004, 1005, 1006, 1015].includes(code) ||
      new TextEncoder().encode(reason).byteLength > 123
    )
      throw new Error("invalid close");
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.push({ type, listener });
  }

  /** A message arrives from the far end of this socket. */
  public deliver(data: unknown): void {
    this.emit("message", {
      data: data instanceof ArrayBuffer && this.binaryType === "blob" ? new Blob([data]) : data,
    });
  }

  /** The far end closes: the socket is closed and its close event fires. */
  public peerClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  /** The socket fails: its error event fires. */
  public fail(): void {
    this.emit("error", {});
  }

  private emit(type: string, event: unknown): void {
    for (const entry of this.listeners) if (entry.type === type) entry.listener(event);
  }
}

/** A fake WebSocketPair that records every pair it creates. */
export class FakeWebSocketPair {
  public static readonly created: FakeWebSocketPair[] = [];
  public readonly 0: FakeSocket = new FakeSocket();
  public readonly 1: FakeSocket = new FakeSocket();

  public constructor() {
    FakeWebSocketPair.created.push(this);
  }
}

/**
 * Node cannot build the 101 Response the Workers runtime returns for an upgrade. This subclass builds it as a 200,
 * reports the 101 it was given, and keeps the socket it carries.
 */
export class UpgradeResponse extends Response {
  public override readonly webSocket: WebSocket | null;

  public constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    Object.defineProperty(this, "status", { value: init?.status ?? 200 });
    this.webSocket = init?.webSocket ?? null;
  }
}

/** The orq answer to a realtime upgrade: the upstream socket it carries and its trace id. */
export function upgradeAnswer(socket: FakeSocket, traceId: string | null = "trace-rt"): Response {
  const headers: Record<string, string> = {};
  if (traceId !== null) headers["x-orq-trace-id"] = traceId;
  return Object.assign(new Response(null, { status: 200, headers }), {
    webSocket: socket as unknown as WebSocket,
  });
}
