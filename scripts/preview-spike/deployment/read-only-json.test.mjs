/* global AbortSignal, AbortController, Response */
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readOnlyJson } from "./read-only-json.mjs";
import { assertControlTarget } from "./control-target.mjs";
import { cloudflareAdapter, fixtureTreeSha256 } from "../benchmark/cloudflare.mjs";

const url = "https://fixed.example.invalid/read";
const response = (status, value = {}) => new Response(JSON.stringify(value), { status });

test("safe GET transients retry with bounded diagnostics, while unsafe/auth/malformed inputs never retry", async () => {
  let calls = 0,
    clock = 0;
  const events = [];
  const value = await readOnlyJson(url, {
    label: "cf-account",
    fetcher: async (_, request) => {
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "error");
      calls++;
      clock += 10;
      return calls === 1 ? response(503) : response(200, { good: true });
    },
    now: () => clock,
    deadlineAt: 1000,
    pause: async (ms) => {
      clock += ms;
    },
    observe: (event) => events.push(event),
  });
  assert.deepEqual(value, { good: true });
  assert.equal(calls, 2);
  assert.equal(events[0].reason, "http-transient");
  assert.equal(events[0].status, 503);
  assert.equal(events.at(-1).outcome, "ok");
  assert.doesNotMatch(JSON.stringify(events), /https:|fixed\.example|Bearer|sensitive|body/);
  for (const status of [401, 403, 404]) {
    calls = 0;
    await assert.rejects(
      readOnlyJson(url, {
        label: "cf-zone",
        fetcher: async () => {
          calls++;
          return response(status);
        },
      }),
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-zone",
      fetcher: async () => {
        calls++;
        return new Response("not-json-sensitive", { status: 200 });
      },
    }),
  );
  assert.equal(calls, 1);
  const malformedEvents = [];
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-zone",
      observe: (event) => malformedEvents.push(event),
      fetcher: async () => {
        calls++;
        return { status: "sensitive-provider-value" };
      },
    }),
    (error) => error.reason === "malformed-response",
  );
  assert.equal(calls, 1);
  assert.equal(malformedEvents[0].status, null);
  assert.doesNotMatch(JSON.stringify(malformedEvents), /sensitive-provider-value/);
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-zone",
      method: "POST",
      fetcher: async () => {
        calls++;
        return response(503);
      },
    }),
  );
  assert.equal(calls, 0);
  for (const options of [{ maxAttempts: 4 }, { maxAttempts: 5 }, { attemptTimeoutMs: 15001 }]) {
    calls = 0;
    await assert.rejects(
      readOnlyJson(url, {
        label: "cf-zone",
        ...options,
        fetcher: async () => {
          calls++;
          return response(200);
        },
      }),
      (error) => error.reason === "unsafe-input",
    );
    assert.equal(calls, 0, "the three-attempt and fifteen-second caps cannot be increased");
  }
  const afterRead = new AbortController();
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-routes",
      signal: afterRead.signal,
      observe: (event) => {
        if (event.outcome === "ok") afterRead.abort();
      },
      fetcher: async () => {
        calls++;
        return response(200);
      },
    }),
  );
  assert.equal(calls, 1, "cancellation during read audit cannot return a positive result");
  calls = 0;
  await readOnlyJson(url, {
    label: "cf-zone",
    deadlineAt: 1000,
    now: () => 0,
    pause: async () => {},
    fetcher: async () => {
      calls++;
      if (calls === 1)
        throw Object.assign(new TypeError("fetch failed sensitive"), {
          cause: { code: "ECONNRESET" },
        });
      return response(200);
    },
  });
  assert.equal(calls, 2);
});

test("attempt timeouts and rate limits obey one caller deadline and aborted callers do not dispatch", async () => {
  let calls = 0;
  const events = [];
  await readOnlyJson(url, {
    label: "cf-routes",
    attemptTimeoutMs: 5,
    backoffMs: 1,
    deadlineAt: performance.now() + 1000,
    observe: (entry) => events.push(entry),
    fetcher: async () => {
      calls++;
      return calls === 1 ? new Promise(() => {}) : response(200);
    },
  });
  assert.equal(calls, 2);
  assert.equal(events[0].reason, "attempt-timeout");
  let clock = 0;
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-routes",
      now: () => clock,
      deadlineAt: 25,
      backoffMs: 10,
      pause: async (ms) => {
        clock += ms;
      },
      fetcher: async () => {
        calls++;
        clock += 10;
        return response(429);
      },
    }),
  );
  assert.equal(calls, 2);
  assert.ok(clock >= 25);
  const controller = new AbortController();
  controller.abort();
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-routes",
      signal: controller.signal,
      fetcher: async () => {
        calls++;
        return response(200);
      },
    }),
  );
  assert.equal(calls, 0);
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-routes",
      attemptTimeoutMs: 100,
      deadlineAt: performance.now() + 5,
      fetcher: async () => {
        calls++;
        return new Promise(() => {});
      },
    }),
  );
  assert.equal(calls, 1, "a caller deadline cannot be restarted after a slow read");
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-routes",
      maxAttempts: 2,
      pause: async () => {},
      fetcher: async () => {
        calls++;
        return response(503);
      },
    }),
  );
  assert.equal(calls, 2, "retry count remains bounded even when failures are immediate");
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-routes",
      pause: async () => {},
      fetcher: async () => {
        calls++;
        return response(503);
      },
    }),
  );
  assert.equal(calls, 3, "the default retry cap is three attempts");
  for (const retryAfter of ["1", new Date(Date.now() + 60_000).toUTCString()]) {
    calls = 0;
    clock = 0;
    await assert.rejects(
      readOnlyJson(url, {
        label: "cf-routes",
        deadlineAt: 25,
        backoffMs: 0,
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
        },
        fetcher: async () => {
          calls++;
          return new Response(null, { status: 429, headers: { "retry-after": retryAfter } });
        },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(clock, 25, "numeric or HTTP-date Retry-After cannot exceed the original budget");
  }
  for (const status of [200, 503]) {
    for (const stop of ["caller-aborted", "deadline"]) {
      const caller = new AbortController();
      let observed = false;
      calls = 0;
      await assert.rejects(
        readOnlyJson(url, {
          label: "cf-routes",
          now: () => 0,
          deadlineAt: stop === "deadline" ? 25 : 1000,
          signal: caller.signal,
          observe: () => {
            observed = true;
            if (stop === "caller-aborted") caller.abort();
            return new Promise(() => {});
          },
          fetcher: async () => {
            calls++;
            return response(status);
          },
        }),
        (error) => error.message === "read_only_get_unverified" && error.reason === stop,
      );
      assert.equal(observed, true);
      assert.equal(calls, 1, "a pending diagnostic cannot cause another GET after stopping");
    }
  }
  calls = 0;
  await assert.rejects(
    readOnlyJson(url, {
      label: "cf-routes",
      observe: async () => {
        throw new Error("sensitive-audit-error");
      },
      fetcher: async () => {
        calls++;
        return response(503);
      },
    }),
    (error) =>
      error.message === "read_only_get_unverified" && error.reason === "observation-unverified",
  );
  assert.equal(calls, 1, "observer failures never retry the request or log recursively");
});

test("real target identity drift blocks before control, and a control POST is dispatched once despite transient response", async () => {
  const account = "00000000000000000000000000000001",
    zone = "0000000000000000000000000000000b";
  const version = "11111111-1111-4111-8111-111111111111";
  const seen = [];
  await assert.rejects(
    assertControlTarget({
      accountId: account,
      zoneId: zone,
      routeId: "a".repeat(32),
      workerVersionId: version,
      token: "synthetic-token",
      now: () => -1000000,
      deadlineAt: -999000,
      observe: (item) => seen.push(item),
      fetcher: async (address) => {
        if (address.endsWith(`/accounts/${account}`))
          return response(200, { success: true, result: { id: account } });
        if (address.endsWith(`/zones/${zone}`))
          return response(200, {
            success: true,
            result: { id: zone, name: "omh.st", account: { id: account } },
          });
        if (address.endsWith("/workers/routes"))
          return response(200, {
            success: true,
            result: [
              { id: "a".repeat(32), pattern: "*.preview.dev.omh.st/*", script: "wrong-worker" },
            ],
          });
        return response(200, {
          success: true,
          result: {
            deployments: [
              { id: "b".repeat(32), versions: [{ percentage: 100, version_id: version }] },
            ],
          },
        });
      },
    }),
    /control_target_unverified/,
  );
  assert.ok(
    seen.some((event) => event.event === "control-target-check" && event.reason === "identity"),
  );
  for (const stop of ["caller-aborted", "deadline"]) {
    const caller = new AbortController();
    let diagnosticCalls = 0;
    await assert.rejects(
      assertControlTarget({
        now: () => 0,
        deadlineAt: stop === "deadline" ? 25 : 1000,
        signal: caller.signal,
        observe: () => {
          diagnosticCalls++;
          if (stop === "caller-aborted") caller.abort();
          return new Promise(() => {});
        },
      }),
      /control_target_unverified/,
    );
    assert.equal(diagnosticCalls, 1, "a failed target's diagnostic also stays bounded");
  }
  const records = [];
  let posts = 0,
    leases = 0;
  const adapter = cloudflareAdapter({
    browser: {},
    token: "synthetic-control-token-0000000000000",
    verifyProvenance: async (_, { now, deadlineAt }) => {
      assert.equal(now(), 0);
      assert.equal(deadlineAt, 1000);
      return true;
    },
    verifyControlTarget: async ({ signal, now, deadlineAt }) => {
      assert.ok(signal);
      assert.equal(now(), 0);
      assert.equal(deadlineAt, 1000);
      return true;
    },
    observeRead: (item) => seen.push(item),
    resourceJournal: { append: async (event) => records.push(event) },
    config: {
      fixture: "next-edge",
      instance: "standard-3",
      inactivityMs: 600000,
      deadlineMs: 1000,
      provenance: {
        fixtureTreeSha256: await fixtureTreeSha256("next-edge"),
        packageCache: "seeded",
      },
    },
    fetchImpl: async (_, request) => {
      if (request.method === "GET") {
        leases++;
        return leases === 1 ? response(503) : response(200, null);
      }
      posts++;
      return response(503);
    },
    now: () => 0,
  });
  const signal = AbortSignal.timeout(1000);
  await adapter.verifyScope({ signal });
  await assert.rejects(adapter.setup({ signal }), /control_outcome_unknown/);
  assert.equal(leases, 2);
  assert.equal(posts, 1);
  assert.equal(records.at(-1).outcome, "unknown");
  assert.ok(seen.some((event) => event.label === "control-lease" && event.outcome === "retry"));
});
