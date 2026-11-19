import { MAIL_ACCESS_WINDOW_MS, type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";
export interface MailScope {
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
}
export declare function readReceivedMail(
  client: TransactionClient,
  input: MailScope & {
    messageId: Ulid;
    now: string;
  },
): Promise<{
  domain: string;
  state: string;
  message_id: string;
  provider_message_id: string;
  domain_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  received_at: Date;
  expires_at: Date;
  attempts: number;
  first_attempt_at: Date | null;
  lease_until: Date | null;
  webhook_url: string;
  webhook_secret_generation: number;
} | null>;
/** The transaction commits this claim before any customer HTTP request is started. */
export declare function claimReceivedMailAttempt(
  client: TransactionClient,
  input: MailScope & {
    messageId: Ulid;
    now: string;
    manual?: boolean;
    commandKey?: string;
  },
): Promise<{
  attempts: number;
  first_attempt_at: Date;
  message_id: string;
  provider_message_id: string;
  domain_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  received_at: Date;
  expires_at: Date;
  state: string;
  lease_until: Date | null;
  domain: string;
  webhook_url: string;
  webhook_secret_generation: number;
} | null>;
export declare function completeReceivedMailAttempt(
  client: TransactionClient,
  input: {
    messageId: Ulid;
    attempt: number;
    now: string;
    status: number | null;
  },
): Promise<void>;
export declare function listReceivedMail(
  client: TransactionClient,
  input: MailScope & {
    now: string;
    after?: Ulid;
  },
): Promise<
  {
    message_id: string;
    received_at: string;
    state: string;
    attempts: number;
  }[]
>;
export declare function listDueReceivedMail(
  client: TransactionClient,
  now: string,
): Promise<
  {
    messageId: Ulid;
    organizationId: Ulid;
    projectId: Ulid;
    environmentId: Ulid;
  }[]
>;
export declare function expireReceivedMail(client: TransactionClient, now: string): Promise<void>;
export { MAIL_ACCESS_WINDOW_MS };
