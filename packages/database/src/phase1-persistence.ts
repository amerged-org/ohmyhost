import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export declare function recordWorkosInboxEvent(
  client: TransactionClient,
  input: {
    readonly inboxEventId: Ulid;
    readonly externalEventId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly bodyDigest: Uint8Array;
    readonly receivedAt: string;
    readonly signatureTimestamp: string;
    readonly maxAttempts: number;
  },
): Promise<"created" | "existing">;

export declare function recordGithubInboxEvent(
  client: TransactionClient,
  input: {
    readonly inboxEventId: Ulid;
    readonly externalEventId: string;
    readonly eventType: "push" | "installation" | "installation_repositories";
    readonly payload: Readonly<Record<string, unknown>>;
    readonly bodyDigest: Uint8Array;
    readonly receivedAt: string;
    readonly maxAttempts: number;
  },
): Promise<"created" | "existing">;
