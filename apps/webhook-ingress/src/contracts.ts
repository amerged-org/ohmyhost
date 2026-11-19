import type { recordGithubInboxEvent, recordWorkosInboxEvent } from "@ohmyhost/database";

export type WorkosWebhookInboxRecord = Parameters<typeof recordWorkosInboxEvent>[1];

export type WorkosWebhookAuthStateProjection =
  | {
      readonly kind: "session-revocation";
      readonly sessionId: string;
      readonly workosUserId: string;
      readonly workosOrganizationId?: string;
      readonly sourceEventId: string;
      readonly effectiveAt: string;
    }
  | {
      readonly kind: "user-revocation";
      readonly workosUserId: string;
      readonly sourceEventId: string;
      readonly effectiveAt: string;
    }
  | {
      readonly kind: "organization-revocation";
      readonly workosOrganizationId: string;
      readonly sourceEventId: string;
      readonly effectiveAt: string;
    }
  | {
      readonly kind: "membership-barrier";
      readonly workosOrganizationId: string;
      readonly workosUserId: string;
      readonly sourceEventId: string;
      readonly eventCreatedAt: string;
    };

export interface WorkosWebhookInboxRecorder {
  record(
    input: WorkosWebhookInboxRecord,
    authStateProjection?: WorkosWebhookAuthStateProjection,
  ): Promise<"created" | "existing">;
}

export interface WorkosWebhookSecretReference {
  readonly kind: "secret-reference";
  readonly provider: "workos";
  readonly purpose: "webhook-verification";
  readonly reference: string;
}

export interface WorkosWebhookSecretResolver {
  resolve(reference: WorkosWebhookSecretReference): Promise<string>;
  /** Worker-private, exact-purpose keys already filtered by the verification clock. */
  resolveAdditional?(reference: WorkosWebhookSecretReference, now: Date): readonly string[];
}

export interface WorkosWebhookEventIdSource {
  next(): WorkosWebhookInboxRecord["inboxEventId"];
}

export interface Clock {
  now(): Date;
}

export interface WorkosWebhookIngressDependencies {
  readonly secretReference: WorkosWebhookSecretReference;
  readonly secretResolver: WorkosWebhookSecretResolver;
  readonly inbox: WorkosWebhookInboxRecorder;
  readonly eventIds: WorkosWebhookEventIdSource;
  readonly clock: Clock;
  readonly maximumBodyBytes: number;
  readonly signatureToleranceMs: number;
  readonly maximumAttempts: number;
}

export type GithubWebhookInboxRecord = Parameters<typeof recordGithubInboxEvent>[1];

export interface GithubWebhookInboxRecorder {
  record(input: GithubWebhookInboxRecord, signal: AbortSignal): Promise<"created" | "existing">;
}

export interface GithubWebhookSecretReference {
  readonly kind: "secret-reference";
  readonly provider: "github";
  readonly purpose: "webhook-verification";
  readonly reference: string;
}

export interface GithubWebhookSecretResolver {
  resolve(reference: GithubWebhookSecretReference, signal: AbortSignal): Promise<Uint8Array>;
  /** Worker-private, exact-purpose keys already filtered by the verification clock. */
  resolveAdditional?(
    reference: GithubWebhookSecretReference,
    now: Date,
    signal: AbortSignal,
  ): readonly Uint8Array[];
}

export interface GithubWebhookEventIdSource {
  next(): GithubWebhookInboxRecord["inboxEventId"];
}

export interface GithubWebhookIngressDependencies {
  readonly secretReference: GithubWebhookSecretReference;
  readonly secretResolver: GithubWebhookSecretResolver;
  readonly inbox: GithubWebhookInboxRecorder;
  readonly eventIds: GithubWebhookEventIdSource;
  readonly clock: Clock;
  readonly maximumBodyBytes: number;
  readonly maximumAttempts: number;
  readonly externalOperationTimeoutMs: number;
}
