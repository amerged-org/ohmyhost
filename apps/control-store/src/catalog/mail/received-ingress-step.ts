import { classifyCustomerMailDomain } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { shiftStored } from "../../timestamps.js";
import { ulid, publicTimestamp } from "../common.js";
import { mailTime } from "./auth.js";

export interface ReceivedIngressInput {
  messageId: string;
  providerMessageId: string;
  recipientDomains: readonly string[];
  receivedAt: string;
  observedAt: string;
}
export interface ReceivingDomainFacts {
  domain_id: string;
  domain: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
}
export interface ExistingReceivedFacts {
  message_id: string;
  domain_id: string;
}

const RECEIVERS = `SELECT d.domain_id,d.domain,d.organization_id,d.project_id,d.environment_id FROM resend_mail_domains d
 JOIN projects p ON p.organization_id=d.organization_id AND p.project_id=d.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 WHERE d.domain IN(SELECT value FROM json_each(?1)) AND d.receiving=1 AND d.receiving_suspended=0
 AND d.receiving_status IN('pending','ready') AND d.sending_status='ready' AND d.provider_domain_id IS NOT NULL AND d.deleted_at IS NULL
 AND d.webhook_url IS NOT NULL AND d.webhook_verified_at IS NOT NULL ORDER BY d.domain_id`;

/** The original received producer validates before its domain read, even for a foreign recipient. */
export function receivedIngressReads(
  db: D1Database,
  input: ReceivedIngressInput,
): D1PreparedStatement[] {
  ulid.parse(input.messageId);
  for (const value of [input.receivedAt, input.observedAt]) {
    const parsed = mailTime.safeParse(publicTimestamp(value));
    if (!parsed.success || parsed.data !== value) throw new TypeError("Invalid mail timestamp");
  }
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(input.providerMessageId) ||
    !input.recipientDomains.length ||
    input.recipientDomains.length > 100 ||
    input.receivedAt > input.observedAt
  )
    throw new TypeError("Invalid received mail identity");
  return [
    db.prepare(RECEIVERS).bind(JSON.stringify(input.recipientDomains)),
    db
      .prepare(
        "SELECT message_id,domain_id FROM mail_received_messages WHERE provider_message_id=?",
      )
      .bind(input.providerMessageId),
  ];
}

/** Original ambiguity/duplicate behavior as statements within the signed Resend receipt batch; no second command. */
export function receivedIngressStep(
  db: D1Database,
  input: ReceivedIngressInput,
  domains: readonly ReceivingDomainFacts[],
  existing: ExistingReceivedFacts | undefined,
): { concerned: boolean; preconditions: D1PreparedStatement[]; statements: D1PreparedStatement[] } {
  const domain = domains[0];
  if (
    domains.length !== 1 ||
    !domain ||
    (existing !== undefined && existing.domain_id !== domain.domain_id)
  )
    return { concerned: false, preconditions: [], statements: [] };
  try {
    classifyCustomerMailDomain(domain.domain);
  } catch {
    return { concerned: false, preconditions: [], statements: [] };
  }
  const expected = JSON.stringify(
      domains.map(({ domain_id, organization_id, project_id, environment_id }) => ({
        domain_id,
        organization_id,
        project_id,
        environment_id,
      })),
    ),
    preconditions = [
      guard(
        db,
        "precondition_changed",
        `(SELECT json_group_array(json_object('domain_id',domain_id,'organization_id',organization_id,'project_id',project_id,'environment_id',environment_id)) FROM(${RECEIVERS}))<>?2`,
        [JSON.stringify(input.recipientDomains), expected],
      ),
    ];
  if (existing !== undefined)
    return {
      concerned: true,
      preconditions: [
        ...preconditions,
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS(SELECT 1 FROM mail_received_messages WHERE provider_message_id=?1 AND message_id=?2 AND domain_id=?3)",
          [input.providerMessageId, existing.message_id, domain.domain_id],
        ),
      ],
      statements: [],
    };
  const expires = shiftStored(input.receivedAt, 72 * 3600000);
  return {
    concerned: true,
    preconditions: [
      ...preconditions,
      guard(
        db,
        "precondition_changed",
        "EXISTS(SELECT 1 FROM mail_received_messages WHERE provider_message_id=?)",
        [input.providerMessageId],
      ),
    ],
    statements: [
      db
        .prepare(
          "INSERT INTO mail_received_messages(message_id,provider_message_id,domain_id,organization_id,project_id,environment_id,received_at,expires_at,next_attempt_at,state)VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          input.messageId,
          input.providerMessageId,
          domain.domain_id,
          domain.organization_id,
          domain.project_id,
          domain.environment_id,
          input.receivedAt,
          expires,
          input.observedAt,
          expires <= input.observedAt ? "expired" : "pending",
        ),
    ],
  };
}
