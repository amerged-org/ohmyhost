import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export class SharedMailDomainError extends Error {
  constructor(
    public readonly code:
      | "mail_scope_unavailable"
      | "mail_domain_conflict"
      | "mail_domain_mismatch"
      | "mail_binding_revision_conflict"
      | "mail_sharing_unavailable"
      | "mail_domain_in_use"
      | "mail_identity_revision_conflict"
      | "idempotency_conflict",
  ) {
    super(code);
  }
}
export interface ApplicationDomainIdentityRow {
  organizationId: string;
  projectId: string;
  hostname: string;
  registrableDomain: string;
  revision: number;
  state: "pending" | "verified" | "revoked";
  challengeName: string;
  challengeValue: string;
  declaredAt: string;
  verifiedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}
export interface WorkspaceMailDomainView {
  domain_id: string;
  organization_id: string;
  domain: string;
  registrable_domain: string;
  revision: number;
  status: "active" | "retiring" | "retired";
  sending: "disabled" | "pending" | "ready" | "failed";
  receiving: "disabled" | "pending" | "ready" | "failed";
  configured_at: string;
  observed_at: string | null;
  dns_records: unknown[];
  bindings_count: number;
}
export interface ProjectMailDomainBindingView {
  mail_domain_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  revision: number;
  sending: boolean;
  sender_addresses: string[];
  default_from: string | null;
  default_reply_to: string | null;
  legacy: boolean;
  status: "active" | "detached" | "suspended";
  application_domain_identity: {
    hostname: string;
    registrable_domain: string;
    revision: number;
    status: "pending" | "verified" | "revoked" | "expired";
  } | null;
}
type ProjectScope = { organizationId: Ulid; projectId: Ulid };
type BindingScope = ProjectScope & { environmentId?: Ulid };

export declare function readProjectMailDomainBinding(
  client: TransactionClient,
  input: BindingScope,
): Promise<ProjectMailDomainBindingView | null>;
