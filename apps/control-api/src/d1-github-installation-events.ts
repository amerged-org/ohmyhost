import { z } from "zod";
import type { Clock, UlidFactory } from "@ohmyhost/platform";

import {
  isD1InboxClaimRuntime,
  isD1InboxRuntime,
  type D1InboxClaimRuntime,
  type D1InboxRuntime,
} from "./d1-github-auto-deploy.js";

/** The Core's installation command: plain input, no SQL and no provider authority. */
export interface D1GithubInstallationRuntime {
  revokeGithubInstallationAccess(input: unknown): Promise<unknown>;
}

export const INSTALLATION_EVENT_TYPES = ["installation", "installation_repositories"] as const;

export function isD1GithubInstallationRuntime(
  value: unknown,
): value is D1GithubInstallationRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "revokeGithubInstallationAccess") === "function"
  );
}

const claimed = z.object({
  inboxEventId: z.string(),
  claimId: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
const withdrawal = z.object({
  schemaVersion: z.literal("github.installation.v1"),
  action: z.enum(["deleted", "suspended", "repositories_removed"]),
  installationId: z.number().int().positive(),
  removedRepositoryIds: z.array(z.number().int().positive()).max(1000),
});

export type InstallationEventOutcome =
  | { readonly status: "idle" }
  | { readonly status: "applied"; readonly eventType: (typeof INSTALLATION_EVENT_TYPES)[number] }
  | { readonly status: "failed"; readonly eventType: (typeof INSTALLATION_EVENT_TYPES)[number] };

/**
 * One installation event per tick, claimed from the shared inbox. A withdrawal is applied by the Core's idempotent
 * command and then acknowledged; a failure is recorded on the event for a later retry, never acknowledged.
 */
export function createD1GithubInstallationEventConsumer(input: {
  readonly bindings: {
    readonly GITHUB_RUNTIME?: unknown;
    readonly CONTROL_RUNTIME?: unknown;
    readonly CONTROL_MAINTENANCE_RUNTIME?: unknown;
  };
  readonly clock: Clock;
  readonly ids: UlidFactory;
}) {
  const github = input.bindings.GITHUB_RUNTIME,
    inbox = input.bindings.CONTROL_RUNTIME,
    drain = input.bindings.CONTROL_MAINTENANCE_RUNTIME;
  if (
    !isD1GithubInstallationRuntime(github) ||
    !isD1InboxRuntime(inbox) ||
    !isD1InboxClaimRuntime(drain)
  )
    throw new Error("GitHub installation events are unavailable");
  const { clock, ids } = input;
  const later = (seconds: number) => new Date(clock.now().getTime() + seconds * 1000).toISOString();
  return Object.freeze({
    async pollOne(): Promise<InstallationEventOutcome> {
      for (const eventType of INSTALLATION_EVENT_TYPES) {
        const raw = await (drain as D1InboxClaimRuntime).claimInboxEvent({
          shardId: 0,
          provider: "github",
          eventType,
          claimId: ids.next(),
          claimedAt: clock.now().toISOString(),
          leaseExpiresAt: later(30),
        });
        if (raw === null) continue;
        const row = claimed.parse(raw);
        // Installation events are global facts: their rows carry no organization.
        const scope = {
          organizationId: null,
          provider: "github" as const,
          inboxEventId: row.inboxEventId,
          claimId: row.claimId,
        };
        try {
          const event = withdrawal.parse(row.payload);
          await (github as D1GithubInstallationRuntime).revokeGithubInstallationAccess({
            installationId: event.installationId,
            action: event.action,
            removedRepositoryIds: event.removedRepositoryIds,
            now: clock.now().toISOString(),
          });
          await (inbox as D1InboxRuntime).acknowledgeInboxEvent({
            ...scope,
            acknowledgedAt: clock.now().toISOString(),
          });
          return { status: "applied", eventType };
        } catch {
          await (inbox as D1InboxRuntime).failInboxEvent({
            ...scope,
            failedAt: clock.now().toISOString(),
            errorCode: "GITHUB_INSTALLATION_REVOCATION_FAILED",
            nextAvailableAt: later(30),
          });
          return { status: "failed", eventType };
        }
      }
      return { status: "idle" };
    },
  });
}
