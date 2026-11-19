import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";
import type { MailScope } from "./resend-mail.js";
export interface ResendMailDomainRow {
  domain_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  domain: string;
  provider_domain_id: string | null;
  provider_claimed_at: Date | null;
  provider_preflight_at: Date | null;
  verify_requested_at: Date | null;
  sending_key_id: string | null;
  sending_key_claimed_at: Date | null;
  sending_key_ciphertext: Buffer | null;
  sending_key_nonce: Buffer | null;
  sending_key_sha256: Buffer | null;
  sending_key_version: number | null;
  sending: boolean;
  receiving: boolean;
  receiving_suspended: boolean;
  sending_status: "disabled" | "pending" | "ready" | "failed";
  receiving_status: "disabled" | "pending" | "ready" | "failed";
  records: unknown[];
  dns_receipts: Record<string, unknown>;
  webhook_url: string | null;
  webhook_secret_generation: number;
  webhook_verified_at: Date | null;
  configured_at: Date;
  observed_at: Date | null;
  deleted_at: Date | null;
}
export class ResendMailScopeError extends Error {
  public readonly code = "mail_scope_unavailable";
}
export declare function configureResendMailDomain(
  client: TransactionClient,
  input: MailScope & {
    domainId: Ulid;
    domain: string;
    sending: boolean;
    receiving: boolean;
    webhookUrl: string | null;
    now: string;
  },
): Promise<ResendMailDomainRow>;
export declare function saveResendDomainObservation(
  client: TransactionClient,
  input: {
    domainId: string;
    providerId: string;
    sendingStatus: string;
    receivingStatus: string;
    records: readonly unknown[];
    now: string;
  },
): Promise<void>;
export declare function saveResendSendingKey(
  client: TransactionClient,
  input: {
    domainId: Ulid;
    providerDomainId: string;
    keyId: string;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    valueSha256: Uint8Array;
    keyVersion: number;
  },
): Promise<void>;
export declare function readResendSendingKey(
  client: TransactionClient,
  input: MailScope & {
    now?: string;
  },
): Promise<{
  domainId: Ulid;
  keyOrganizationId: Ulid;
  keyProjectId: Ulid;
  keyEnvironmentId: Ulid;
  ciphertext: Uint8Array<ArrayBufferLike>;
  nonce: Uint8Array<ArrayBufferLike>;
  valueSha256: Uint8Array<ArrayBufferLike>;
  keyVersion: number;
}>;
/** Environment secret hashes are the authority; duplicated Dev/Prod secrets fail closed. */
export declare function authorizeResendMailKey(
  client: TransactionClient,
  input: {
    projectId: Ulid;
    keySha256: Uint8Array;
    receiving?: boolean;
  },
): Promise<{
  domain: string;
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
} | null>;
export declare function authorizeResendMailSend(
  client: TransactionClient,
  input: MailScope & {
    requestId: Ulid;
    idempotencyKey: string;
    now: string;
  },
): Promise<boolean>;
