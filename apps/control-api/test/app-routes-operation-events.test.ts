import { parseUlid, type Operation } from "@ohmyhost/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createControlApi, type ControlApiDependencies } from "../src/index.js";
import {
  API,
  BEARER,
  NOW,
  OPERATION_ID,
  PRINCIPAL,
  PROJECT_ID,
  recordingReporter,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

const QUEUED_ID = parseUlid("0000000000000000000000000A");
const STARTED_ID = parseUlid("0000000000000000000000000B");
const SUCCEEDED_ID = parseUlid("0000000000000000000000000C");
const EVENTS_URL = `${API}/v1/operations/${OPERATION_ID}/events`;

function event(
  eventId: string,
  type: "OperationQueued" | "OperationStarted" | "OperationSucceeded",
  projectId: string = PROJECT_ID,
) {
  return {
    eventId,
    type,
    operationId: OPERATION_ID,
    projectId,
    occurredAt: NOW,
    ...(type === "OperationQueued" ? {} : { idempotencyKey: `transition-${eventId}` }),
  };
}

function operation(
  state: "queued" | "running" | "succeeded",
  events: ReturnType<typeof event>[],
  projectId: string = PROJECT_ID,
): Operation {
  return {
    operationId: OPERATION_ID,
    projectId,
    state,
    createdAt: NOW,
    updatedAt: NOW,
    events,
  } as unknown as Operation;
}

const QUEUED = operation("queued", [event(QUEUED_ID, "OperationQueued")]);
const RUNNING = operation("running", [
  event(QUEUED_ID, "OperationQueued"),
  event(STARTED_ID, "OperationStarted"),
]);
const SUCCEEDED = operation("succeeded", [
  event(QUEUED_ID, "OperationQueued"),
  event(STARTED_ID, "OperationStarted"),
  event(SUCCEEDED_ID, "OperationSucceeded"),
]);

function eventsApp(
  getOperation: ControlApiDependencies["persistence"]["getOperation"],
  overrides: Partial<ControlApiDependencies> = {},
) {
  const base = routeDependencies();
  return createControlApi(
    routeDependencies({ persistence: { ...base.persistence, getOperation }, ...overrides }),
  );
}

function streamReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (response.body === null) throw new Error("The response has no stream");
  return response.body.getReader();
}

/** Drains a stream in the background so the server side never waits for demand. */
function consume(response: Response) {
  const reader = streamReader(response);
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const finished = (async (): Promise<"closed" | Error> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "closed";
        chunks.push(decoder.decode(value));
      }
    } catch (error) {
      return error as Error;
    }
  })();
  return { chunks, text: () => chunks.join(""), finished };
}

describe("GET /v1/operations/:operation_id/events", () => {
  it("exposes valid mail DNS progress and falls back when the mail projection is malformed", async () => {
    const running = {
      ...RUNNING,
      deploymentObservation: {
        projectId: PROJECT_ID,
        deploymentId: STARTED_ID,
        phase: "publishing" as const,
        mailRequired: true,
        buildCompletedAt: NOW,
      },
    };
    let malformed = false;
    const app = eventsApp(async () => running, {
      projectMailDomains: {
        configure: async () => {
          throw new Error("unused");
        },
        get: async () => ({
          domain: malformed ? "https://bad.example.com" : "mail.example.com",
          status: "verification_pending",
          configuredAt: NOW,
          observedAt: NOW,
          sending: "pending",
          nextCheckAfterSeconds: 60,
          dnsRecords: [
            { type: "TXT", name: "send.mail.example.com", value: "v=spf1", status: "pending" },
          ],
        }),
      },
    });
    const endpoint = `${API}/v1/operations/${OPERATION_ID}`;
    const valid = await app.request(endpoint, { headers: BEARER });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      progress: {
        phase: "waiting_for_mail",
        mail: {
          domain: "mail.example.com",
          next_check_after_seconds: 60,
          dns_records: [{ name: "send.mail.example.com", value: "v=spf1" }],
        },
      },
    });
    malformed = true;
    const invalid = await app.request(endpoint, { headers: BEARER });
    expect(invalid.status).toBe(200);
    const answer = await invalid.json();
    expect(answer).toMatchObject({ progress: { phase: "mail_status_unavailable" } });
    expect(JSON.stringify(answer)).not.toContain("bad.example.com");
  });

  it("streams every event of a finished operation as server-sent events and closes", async () => {
    const response = await eventsApp(async () => SUCCEEDED).request(EVENTS_URL, {
      headers: BEARER,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Request-Id")).toBe("req_fixture");
    const stream = consume(response);
    expect(await stream.finished).toBe("closed");
    expect(stream.text()).toBe(
      [QUEUED_ID, STARTED_ID, SUCCEEDED_ID]
        .map((id, index) => {
          const type = ["OperationQueued", "OperationStarted", "OperationSucceeded"][index];
          return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({
            event_id: id,
            operation_id: OPERATION_ID,
            project_id: PROJECT_ID,
            type,
            occurred_at: NOW,
          })}\n\n`;
        })
        .join(""),
    );
  });

  it("resumes after the event named by Last-Event-ID without replaying earlier ones", async () => {
    const app = eventsApp(async () => SUCCEEDED);

    const resumed = await app.request(EVENTS_URL, {
      headers: { ...BEARER, "Last-Event-ID": STARTED_ID },
    });
    expect(resumed.status).toBe(200);
    const stream = consume(resumed);
    expect(await stream.finished).toBe("closed");
    expect(stream.chunks).toHaveLength(1);
    expect(stream.text()).toContain(`id: ${SUCCEEDED_ID}\nevent: OperationSucceeded`);
    expect(stream.text()).not.toContain(QUEUED_ID);
    expect(stream.text()).not.toContain(STARTED_ID);

    const afterLast = await app.request(EVENTS_URL, {
      headers: { ...BEARER, "Last-Event-ID": SUCCEEDED_ID },
    });
    const drained = consume(afterLast);
    expect(await drained.finished).toBe("closed");
    expect(drained.chunks).toEqual([]);
  });

  it("refuses a Last-Event-ID that is not an event of this operation", async () => {
    const response = await eventsApp(async () => SUCCEEDED).request(EVENTS_URL, {
      headers: { ...BEARER, "Last-Event-ID": parseUlid("0000000000000000000000000F") },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: "Last-Event-ID is invalid." });
  });

  it("answers an unreadable operation before opening a stream", async () => {
    const app = eventsApp(async () => null);
    expect((await app.request(EVENTS_URL, { headers: BEARER })).status).toBe(404);
    expect((await app.request(EVENTS_URL)).status).toBe(401);
    expect(
      (await app.request(`${API}/v1/operations/not-a-ulid/events`, { headers: BEARER })).status,
    ).toBe(400);
    expect(
      (
        await app.request(EVENTS_URL, {
          headers: { ...BEARER, "X-Request-Id": "r".repeat(129) },
        })
      ).status,
    ).toBe(400);
    const denied = eventsApp(async () => RUNNING, { authorization: { check: async () => "deny" } });
    expect((await denied.request(EVENTS_URL, { headers: BEARER })).status).toBe(404);
    const { reports, reporter } = recordingReporter();
    const outage = eventsApp(async () => RUNNING, {
      reporter,
      authorization: {
        check: async () => {
          throw new Error("authorization offline");
        },
      },
    });
    const unavailable = await outage.request(EVENTS_URL, { headers: BEARER });
    expect(unavailable.status).toBe(503);
    expect(reports).toEqual([
      {
        requestId: "req_fixture",
        code: "AUTHENTICATION_OR_AUTHORIZATION_UNAVAILABLE",
        route: "/v1/operations/{operation_id}/events",
      },
    ]);
    const limited = eventsApp(async () => RUNNING, {
      rateLimits: {
        consume: async ({ dimension }) =>
          dimension === "organization"
            ? { allowed: false, retryAfterSeconds: 7 }
            : { allowed: true },
      },
    });
    const response = await limited.request(EVENTS_URL, { headers: BEARER });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
  });
});

describe("a live operation event stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function open(app: ReturnType<typeof createControlApi>, signal?: AbortSignal) {
    const response = await app.request(
      new Request(EVENTS_URL, { headers: BEARER, ...(signal === undefined ? {} : { signal }) }),
    );
    expect(response.status).toBe(200);
    return consume(response);
  }

  it("ends a live stream as soon as the client disconnects and never reads the operation again", async () => {
    const getOperation = vi.fn(async () => RUNNING);
    const abort = new AbortController();
    const stream = await open(eventsApp(getOperation), abort.signal);
    await vi.advanceTimersByTimeAsync(10);
    expect(stream.chunks).toHaveLength(2);

    abort.abort();
    await vi.advanceTimersByTimeAsync(10);

    expect(await stream.finished).toBe("closed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getOperation).toHaveBeenCalledTimes(1);
  });

  it("stops the producer when the consumer cancels the stream", async () => {
    const getOperation = vi.fn(async () => RUNNING);
    const response = await eventsApp(getOperation).request(EVENTS_URL, { headers: BEARER });
    const reader = streamReader(response);
    expect((await reader.read()).done).toBe(false);

    await reader.cancel();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getOperation).toHaveBeenCalledTimes(1);
  });

  it("keeps an idle stream open with a heartbeat comment every fifteen seconds", async () => {
    const abort = new AbortController();
    const stream = await open(
      eventsApp(async () => QUEUED),
      abort.signal,
    );

    await vi.advanceTimersByTimeAsync(14_000);
    expect(stream.text()).not.toContain(": heartbeat");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stream.chunks.filter((chunk) => chunk === ": heartbeat\n\n")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stream.chunks.filter((chunk) => chunk === ": heartbeat\n\n")).toHaveLength(2);

    abort.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await stream.finished).toBe("closed");
  });

  it("delivers events recorded after the stream opened and closes at the terminal state", async () => {
    const reads = [QUEUED, RUNNING, SUCCEEDED];
    const getOperation = vi.fn(async () => reads.shift() ?? SUCCEEDED);
    const check = vi.fn(async () => "allow" as const);
    const stream = await open(
      eventsApp(
        // The first read resolves the operation, the next ones refresh the open stream.
        getOperation as never,
        { authorization: { check } },
      ),
    );

    // The operation is read on every one-second tick; only the access check waits for fifteen seconds.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await stream.finished).toBe("closed");
    expect(stream.chunks.map((chunk) => /^id: (\w+)\n/u.exec(chunk)?.[1] ?? chunk)).toEqual([
      QUEUED_ID,
      STARTED_ID,
      SUCCEEDED_ID,
    ]);
    // Each refresh authorizes the project again before it reads the operation.
    expect(check).toHaveBeenCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: expect.objectContaining({ kind: "project", projectId: PROJECT_ID }),
      action: "operations:read",
    });
  });

  it("revalidates an open stream at most every fifteen seconds, not on every one-second tick", async () => {
    const check = vi.fn(async () => "allow" as const);
    await open(eventsApp(async () => RUNNING, { authorization: { check } }));
    const opened = check.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);

    const revalidations = check.mock.calls.length - opened;
    expect(revalidations).toBeGreaterThanOrEqual(3);
    expect(revalidations).toBeLessThanOrEqual(4);
  });

  it("closes without further events once the caller's authentication is no longer valid", async () => {
    let calls = 0;
    const { reports, reporter } = recordingReporter();
    const stream = await open(
      eventsApp(async () => RUNNING, {
        reporter,
        authentication: {
          authenticate: async () => {
            if (++calls === 1) return PRINCIPAL;
            throw new Error("identity provider offline");
          },
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(15_500);

    expect(await stream.finished).toBe("closed");
    expect(stream.chunks).toHaveLength(2);
    expect(reports).toEqual([
      {
        requestId: "req_fixture",
        code: "STREAM_AUTHENTICATION_UNAVAILABLE",
        route: "/v1/operations/{operation_id}/events",
      },
    ]);
  });

  it("closes when the principal changed or the credential was revoked while streaming", async () => {
    let calls = 0;
    const changed = await open(
      eventsApp(async () => RUNNING, {
        authentication: {
          authenticate: async () =>
            ++calls === 1 ? PRINCIPAL : { ...PRINCIPAL, credentialId: "workos_session:session_2" },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await changed.finished).toBe("closed");

    let revokedCalls = 0;
    const revoked = await open(
      eventsApp(async () => RUNNING, {
        authentication: { authenticate: async () => (++revokedCalls === 1 ? PRINCIPAL : null) },
      }),
    );
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await revoked.finished).toBe("closed");
  });

  it("closes when read access is withdrawn or cannot be checked while streaming", async () => {
    let denyAfter = 0;
    const withdrawn = await open(
      eventsApp(async () => RUNNING, {
        authorization: { check: async () => (++denyAfter === 1 ? "allow" : "deny") },
      }),
    );
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await withdrawn.finished).toBe("closed");

    let outageAfter = 0;
    const { reports, reporter } = recordingReporter();
    const unavailable = await open(
      eventsApp(async () => RUNNING, {
        reporter,
        authorization: {
          check: async () => {
            if (++outageAfter === 1) return "allow";
            throw new Error("authorization offline");
          },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await unavailable.finished).toBe("closed");
    expect(reports.map((entry) => entry.code)).toEqual(["STREAM_AUTHORIZATION_UNAVAILABLE"]);
  });

  it("closes when the operation disappears and errors when persistence answers for another scope", async () => {
    let reads = 0;
    const gone = await open(eventsApp(async () => (++reads === 1 ? RUNNING : null)));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await gone.finished).toBe("closed");

    let foreignReads = 0;
    const { reports, reporter } = recordingReporter();
    const foreign = await open(
      eventsApp(
        async () =>
          ++foreignReads === 1
            ? RUNNING
            : operation("running", RUNNING.events as never, "0000000000000000000000000F"),
        { reporter },
      ),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await foreign.finished;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Operation event stream failed");
    expect(reports).toEqual([
      {
        requestId: "req_fixture",
        code: "OPERATION_STREAM_FAILED",
        route: "/v1/operations/{operation_id}/events",
      },
    ]);
  });
});
