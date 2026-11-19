import { describe, expect, it } from "vitest";

import {
  createWorkosSessionStatusChecker,
  type WorkosSessionAnswerCache,
} from "../src/session-status.js";
import type {
  CandidateClock,
  WorkloadIdentitySecretResolver,
  WorkosManagementDatabase,
  WorkosSessionTransport,
} from "../src/ports.js";
import { FixtureDatabase, FixtureResolver, FixtureTransport } from "./fixtures.js";

const request = {
  sessionId: "session_01",
  userId: "user_01",
  organizationId: "org_01",
  tokenExpiresAt: 1_787_137_200,
} as const;

const checker = (input?: {
  readonly database?: WorkosManagementDatabase;
  readonly resolver?: WorkloadIdentitySecretResolver;
  readonly transport?: WorkosSessionTransport;
  readonly clock?: CandidateClock;
  readonly answerCache?: WorkosSessionAnswerCache;
}) =>
  createWorkosSessionStatusChecker({
    database: input?.database ?? new FixtureDatabase(),
    resolver: input?.resolver ?? new FixtureResolver(),
    transport: input?.transport ?? new FixtureTransport(),
    clock: input?.clock ?? { now: () => new Date("2026-08-19T10:00:00.000Z") },
    answerCache: input?.answerCache ?? new Map(),
  });

describe("private WorkOS session-status checker", () => {
  it("requires fresh local eligibility before checking the exact provider session", async () => {
    const database = new FixtureDatabase();
    const transport = new FixtureTransport();
    transport.sessionActive = true;
    const statusChecker = checker({ database, transport });

    await expect(statusChecker.check(request)).resolves.toEqual({
      active: true,
    });
    expect(database.sessionEligibilityChecks).toEqual([
      {
        sessionId: "session_01",
        workosUserId: "user_01",
        workosOrganizationId: "org_01",
        observedAt: "2026-08-19T10:00:00.000Z",
      },
    ]);
    expect(transport.sessionRequests).toEqual([request]);

    // The second check is served from the provider answer cache; local eligibility is still read.
    await expect(statusChecker.check(request)).resolves.toEqual({
      active: true,
    });
    expect(transport.sessionRequests).toHaveLength(1);
    expect(database.sessionEligibilityChecks).toHaveLength(2);
  });

  it("serves a provider-true answer for twenty seconds per exact session, after live eligibility", async () => {
    const time = { now: Date.parse("2026-08-19T10:00:00.000Z") };
    const database = new FixtureDatabase();
    const transport = new FixtureTransport();
    transport.sessionActive = true;
    const answerCache: WorkosSessionAnswerCache = new Map();
    const statusChecker = checker({
      database,
      transport,
      clock: { now: () => new Date(time.now) },
      answerCache,
    });

    const answers = await Promise.all(
      Array.from({ length: 100 }, () => statusChecker.check(request)),
    );
    expect(answers.every((answer) => answer.active)).toBe(true);
    expect(transport.sessionRequests).toHaveLength(1);
    expect(database.sessionEligibilityChecks).toHaveLength(100);

    time.now += 19_000;
    await statusChecker.check(request);
    expect(transport.sessionRequests).toHaveLength(1);
    time.now += 1_000;
    await statusChecker.check(request);
    expect(transport.sessionRequests).toHaveLength(2);

    await statusChecker.check({ ...request, tokenExpiresAt: request.tokenExpiresAt + 1 });
    expect(transport.sessionRequests).toHaveLength(3);

    database.sessionEligible = false;
    await expect(statusChecker.check(request)).resolves.toEqual({ active: false });
    expect(transport.sessionRequests).toHaveLength(3);

    // The answer cache is bounded: distinct sessions beyond 10,000 evict the oldest entries.
    database.sessionEligible = true;
    for (let index = 0; index < 10_001; index += 1) {
      await statusChecker.check({ ...request, sessionId: `session_bulk_${index}` });
    }
    expect(answerCache.size).toBeLessThanOrEqual(10_000);
  });

  it("never caches a provider false or an error, and never serves a stale true after its TTL", async () => {
    const time = { now: Date.parse("2026-08-19T10:00:00.000Z") };
    const transport = new FixtureTransport();
    const statusChecker = checker({
      transport,
      clock: { now: () => new Date(time.now) },
      answerCache: new Map(),
    });

    await expect(statusChecker.check(request)).resolves.toEqual({ active: false });
    await expect(statusChecker.check(request)).resolves.toEqual({ active: false });
    expect(transport.sessionRequests).toHaveLength(2);

    transport.sessionError = new Error("provider detail");
    await expect(statusChecker.check(request)).rejects.toThrow("provider detail");

    transport.sessionError = undefined;
    transport.sessionActive = true;
    await expect(statusChecker.check(request)).resolves.toEqual({ active: true });
    expect(transport.sessionRequests).toHaveLength(4);

    time.now += 20_000;
    transport.sessionError = new Error("provider detail");
    await expect(statusChecker.check(request)).rejects.toThrow("provider detail");
    expect(transport.sessionRequests).toHaveLength(5);
  });

  it("returns inactive without provider access when the session is locally denied", async () => {
    const denied = new FixtureDatabase();
    denied.sessionEligible = false;
    const deniedTransport = new FixtureTransport();
    await expect(
      checker({ database: denied, transport: deniedTransport }).check(request),
    ).resolves.toEqual({ active: false });
    expect(deniedTransport.sessionRequests).toEqual([]);
  });

  it("still asks the provider once the access token that opened the session has expired", async () => {
    // An access token lives minutes; the session behind it lives hours. Treating the expired
    // token as an expired session ended customer flows that were still perfectly valid, so the
    // provider answers the only question that matters: is this session still active?
    const transport = new FixtureTransport();
    transport.sessionActive = true;
    await expect(
      checker({ transport }).check({ ...request, tokenExpiresAt: 1_787_133_599 }),
    ).resolves.toEqual({ active: true });
    expect(transport.sessionRequests).toHaveLength(1);
  });

  it("propagates parser, database, resolver, and provider uncertainty to the private boundary", async () => {
    await expect(checker().check({ ...request, extra: true })).rejects.toThrow();

    const database = new FixtureDatabase();
    database.sessionEligibilityError = new Error("database detail");
    await expect(checker({ database }).check(request)).rejects.toThrow("database detail");

    const resolver: WorkloadIdentitySecretResolver = {
      withWorkosManagementCredential: async () => {
        throw new Error("resolver detail");
      },
    };
    await expect(checker({ resolver }).check(request)).rejects.toThrow("resolver detail");

    const transport = new FixtureTransport();
    transport.sessionError = new Error("provider detail");
    await expect(checker({ transport }).check(request)).rejects.toThrow("provider detail");
  });
});
