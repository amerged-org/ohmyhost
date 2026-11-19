import { createGrowthIdentityReader } from "./growth-identity.js";
import { createWorkosUserKeyLifecycle } from "./user-key-lifecycle.js";
import { createD1WorkosIdentityPort } from "./d1-identity-port.js";
import { createD1OnboardingPersistence } from "./d1-onboarding-port.js";
import { createD1CreditWarningPersistence } from "./d1-credit-warning-port.js";
import { createD1WorkosPollerPort } from "./d1-poller-port.js";
import { createD1WorkosManagementDatabase } from "./d1-management-database.js";
import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCreditWarningRecipients } from "./credit-warning-recipients.js";
import { createSignupFeedbackRecipient } from "./signup-feedback-recipient.js";
import { createD1SignupFeedbackClaimReader } from "./d1-signup-feedback-port.js";

import type { WorkosPollResult } from "./poller.js";
import { createWorkosOrganizationOnboarding } from "./organization-onboarding.js";
import { createWorkosSessionRevocation } from "./session-revocation.js";
import type { WorkosSessionAnswerCache } from "./session-status.js";
import type { WorkosManagementWorkerBindings } from "./worker-runtime.js";
import {
  createWorkosManagementWorkerRuntime,
  parseWorkosManagementWorkerBindings,
} from "./worker-runtime.js";

export interface WorkosManagementScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

/**
 * One scheduled run claims events one after another (each keeps its own claim and lease) until the queue is idle,
 * this many events are done, the time budget is spent, or events keep failing. The cron runs every minute, so the
 * time budget keeps one run from overlapping the next, and the failure stop keeps a provider outage from spending
 * an attempt of every queued event.
 */
export const SCHEDULED_POLL_MAX_EVENTS = 50;
export const SCHEDULED_POLL_BUDGET_MS = 25_000;
export const SCHEDULED_POLL_MAX_CONSECUTIVE_FAILURES = 3;

export type WorkosManagementScheduledOutcome =
  | {
      readonly ok: true;
      readonly recovery: WorkosPollResult | null;
      /** The first claim of the run, or `idle` when nothing was due. */
      readonly poll: WorkosPollResult;
      /** How many events the run claimed. */
      readonly polled: number;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: "unavailable" };
    };

type WorkerRuntimeFactory = (
  input: Parameters<typeof createWorkosManagementWorkerRuntime>[0],
) => Pick<ReturnType<typeof createWorkosManagementWorkerRuntime>, "handler"> & {
  readonly graph: {
    readonly poller: {
      pollOne(): Promise<WorkosPollResult>;
      recoverOneExpiredFinalClaim(): Promise<WorkosPollResult | null>;
    };
  };
};

const unavailable = (): Response =>
  new Response(JSON.stringify({ ok: false, error: { code: "unavailable" } }), {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });

/** Composes one request over the private WorkosRuntime capability, the only Control authority of this Worker. */
function composeRequestRuntime(
  bindings: WorkosManagementWorkerBindings,
  input: { readonly fetcher: (request: Request) => Promise<Response> },
  runtimeFactory: WorkerRuntimeFactory,
  sessionAnswers: WorkosSessionAnswerCache,
) {
  const clock = new SystemClock();
  const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const organizationIds = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const identity = createD1WorkosIdentityPort({ runtime: bindings.CONTROL_RUNTIME });
  return runtimeFactory({
    bindings,
    sessionAnswers,
    userKeyLifecycle: createWorkosUserKeyLifecycle({
      identity,
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      fetcher: input.fetcher,
      clock,
      ids,
    }),
    sessionRevocation: createWorkosSessionRevocation({
      identity,
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      fetcher: input.fetcher,
      clock,
      ids,
    }),
    organizationOnboarding: createWorkosOrganizationOnboarding({
      persistence: createD1OnboardingPersistence(bindings.CONTROL_RUNTIME),
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      fetcher: input.fetcher,
      clock,
      ids: organizationIds,
    }),
    database: createD1WorkosManagementDatabase(
      identity,
      createD1WorkosPollerPort({
        runtime: bindings.CONTROL_RUNTIME,
        auditIds: createUlidFactory({ clock, entropy: new SystemEntropy() }),
      }),
    ),
    fetcher: input.fetcher,
    clock,
    ids,
    organizationIds,
  });
}

export function createWorkosManagementWorkerEntrypoint(input: {
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly runtimeFactory?: WorkerRuntimeFactory;
}) {
  const runtimeFactory = input.runtimeFactory ?? createWorkosManagementWorkerRuntime;
  // One answer cache per Worker isolate: the request runtime is rebuilt for every request.
  const sessionAnswers: WorkosSessionAnswerCache = new Map();
  return {
    async fetch(
      request: Request,
      rawBindings: Partial<WorkosManagementWorkerBindings>,
    ): Promise<Response> {
      let bindings: WorkosManagementWorkerBindings;
      try {
        bindings = parseWorkosManagementWorkerBindings(rawBindings);
      } catch {
        return unavailable();
      }
      try {
        const runtime = composeRequestRuntime(bindings, input, runtimeFactory, sessionAnswers);
        const response = await runtime.handler.fetch(request);
        const headers = new Headers(response.headers);
        headers.set("x-ohmyhost-management-artifact-sha256", bindings.MANAGEMENT_ARTIFACT_SHA256);
        headers.set("x-ohmyhost-cloudflare-version-id", bindings.CF_VERSION_METADATA.id);
        headers.set("x-ohmyhost-cloudflare-version-tag", bindings.CF_VERSION_METADATA.tag);
        headers.set("x-ohmyhost-workos-deployment", bindings.WORKOS_DEPLOYMENT);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        return unavailable();
      }
    },
    async scheduled(
      _controller: WorkosManagementScheduledController,
      bindings: Partial<WorkosManagementWorkerBindings>,
    ): Promise<WorkosManagementScheduledOutcome> {
      try {
        const parsedBindings = parseWorkosManagementWorkerBindings(bindings);
        const clock = new SystemClock();
        const identity = createD1WorkosIdentityPort({ runtime: parsedBindings.CONTROL_RUNTIME });
        const runtime = runtimeFactory({
          bindings: parsedBindings,
          sessionAnswers,
          database: createD1WorkosManagementDatabase(
            identity,
            createD1WorkosPollerPort({
              runtime: parsedBindings.CONTROL_RUNTIME,
              auditIds: createUlidFactory({ clock, entropy: new SystemEntropy() }),
            }),
          ),
          fetcher: input.fetcher,
          clock,
          ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
          organizationIds: createUlidFactory({ clock, entropy: new SystemEntropy() }),
        });
        const recovery = await runtime.graph.poller.recoverOneExpiredFinalClaim();
        const startedAt = clock.now().getTime();
        const poll = await runtime.graph.poller.pollOne();
        let latest = poll;
        let polled = 0;
        let failures = 0;
        while (latest.outcome !== "idle") {
          polled += 1;
          failures = latest.outcome === "acknowledged" ? 0 : failures + 1;
          if (
            polled >= SCHEDULED_POLL_MAX_EVENTS ||
            failures >= SCHEDULED_POLL_MAX_CONSECUTIVE_FAILURES ||
            clock.now().getTime() - startedAt >= SCHEDULED_POLL_BUDGET_MS
          )
            break;
          latest = await runtime.graph.poller.pollOne();
        }
        return { ok: true, recovery, poll, polled };
      } catch {
        return { ok: false, error: { code: "unavailable" } };
      }
    },
  };
}

const workerFetch = (request: Request): Promise<Response> => globalThis.fetch(request);
const worker = createWorkosManagementWorkerEntrypoint({ fetcher: workerFetch });

/** Bound only by the platform Mail Gateway; no membership or provider-write RPC is exposed. */
export class CreditWarningRecipientsService extends WorkerEntrypoint<WorkosManagementWorkerBindings> {
  async resolve(raw: unknown) {
    const bindings = parseWorkosManagementWorkerBindings(this.env);
    return createCreditWarningRecipients({
      persistence: createD1CreditWarningPersistence(bindings.CONTROL_RUNTIME),
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      fetcher: workerFetch,
      clock: new SystemClock(),
    }).resolve(raw);
  }
}

/** Bound only by Mail Gateway; exact live feedback claims limit identity access. */
export class SignupFeedbackRecipientsService extends WorkerEntrypoint<WorkosManagementWorkerBindings> {
  async resolve(raw: unknown) {
    const bindings = parseWorkosManagementWorkerBindings(this.env);
    return createSignupFeedbackRecipient({
      claims: createD1SignupFeedbackClaimReader(bindings.CONTROL_RUNTIME),
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      fetcher: workerFetch,
    }).resolve(raw);
  }
}

/** Fixed, private analytics capability; no general WorkOS query is exposed. */
export class GrowthIdentityService extends WorkerEntrypoint<WorkosManagementWorkerBindings> {
  async getGrowthIdentity(input: { user_id: string }) {
    const bindings = parseWorkosManagementWorkerBindings(this.env);
    return createGrowthIdentityReader({
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      environment: bindings.WORKOS_DEPLOYMENT,
      fetcher: workerFetch,
    }).getGrowthIdentity(input);
  }
  async readGrowthUserSnapshotPage(page: { cursor: string | null; limit: number }) {
    const bindings = parseWorkosManagementWorkerBindings(this.env);
    return createGrowthIdentityReader({
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      environment: bindings.WORKOS_DEPLOYMENT,
      fetcher: workerFetch,
    }).readGrowthUserSnapshotPage(page);
  }
  async readGrowthIdentityPage(page: { cursor: string | null; limit: number }) {
    const bindings = parseWorkosManagementWorkerBindings(this.env);
    return createGrowthIdentityReader({
      credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
      environment: bindings.WORKOS_DEPLOYMENT,
      fetcher: workerFetch,
    }).readGrowthIdentityPage(page);
  }
}

export default worker;
