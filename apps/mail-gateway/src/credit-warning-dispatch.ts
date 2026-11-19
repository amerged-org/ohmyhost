export interface CreditWarningRecipientPort {
  resolve(scope: CreditWarningScope): Promise<unknown>;
}
/** The exhaustion episode of one organization: its `exhausted_at` identifies the warning. */
export interface CreditWarningScope {
  organizationId: string;
  exhaustedAt: string;
}
export interface CreditWarningPeriod extends CreditWarningScope {
  leaseUntil: string;
}
/** The Core's view of the warnings: lease the due episodes, then record whether the warning went out. */
export interface CreditWarningPersistence {
  claimPeriods(now: () => string): Promise<CreditWarningPeriod[]>;
  finishPeriod(
    input: () => CreditWarningPeriod & { now: string; delivered: boolean },
  ): Promise<boolean>;
}
/**
 * One warning email per owner of every exhaustion episode the Core leased. The episode counts as warned once at least one
 * owner accepted it (or the organization has nobody to warn); otherwise the Core offers it again after five minutes.
 */
export function createCreditWarningDispatcher(input: {
  persistence: CreditWarningPersistence;
  recipients: CreditWarningRecipientPort;
  now: () => Date;
  sender: {
    send(
      notice: CreditWarningScope & { userId: string; recipient: string },
    ): Promise<{ status: "accepted"; messageId: string }>;
  };
}) {
  return {
    async sync() {
      const periods = await input.persistence.claimPeriods(() => input.now().toISOString());
      let accepted = 0,
        unresolved = 0;
      for (const period of periods) {
        const scope = { organizationId: period.organizationId, exhaustedAt: period.exhaustedAt };
        let delivered = false;
        try {
          const recipients = parseRecipients(await input.recipients.resolve(scope), scope);
          let sent = 0;
          for (const recipient of recipients)
            try {
              const result = await input.sender.send({
                ...scope,
                userId: recipient.userId,
                recipient: recipient.email,
              });
              if (
                result.status !== "accepted" ||
                !/^[A-Za-z0-9._-]{1,256}$/u.test(result.messageId)
              )
                throw new Error("credit_warning_response_invalid");
              sent++;
            } catch {
              // The other owners are still warned; a period nobody accepted is offered again.
            }
          accepted += sent;
          delivered = recipients.length === 0 || sent > 0;
        } catch {
          // Recipients that cannot be resolved leave the period for the next try.
        }
        try {
          await input.persistence.finishPeriod(() => ({
            ...period,
            now: input.now().toISOString(),
            delivered,
          }));
          if (!delivered) unresolved++;
        } catch {
          unresolved++;
          console.error("credit_warning_progress_unavailable", {
            organizationId: scope.organizationId,
          });
        }
      }
      return { periods: periods.length, accepted, unresolved };
    },
  };
}

function parseRecipients(
  raw: unknown,
  scope: CreditWarningScope,
): { userId: string; email: string }[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("credit_warning_recipients_invalid");
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "exhaustedAt,organizationId,recipients,required" ||
    v["organizationId"] !== scope.organizationId ||
    v["exhaustedAt"] !== scope.exhaustedAt ||
    typeof v["required"] !== "boolean" ||
    !Array.isArray(v["recipients"]) ||
    v["recipients"].length > 10 ||
    (v["required"] ? v["recipients"].length === 0 : v["recipients"].length !== 0)
  )
    throw new Error("credit_warning_recipients_invalid");
  const owners = new Set<string>();
  return v["recipients"].map((r: unknown) => {
    if (!r || typeof r !== "object" || Array.isArray(r))
      throw new Error("credit_warning_recipient_invalid");
    const p = r as Record<string, unknown>,
      userId = p["userId"],
      email = p["email"];
    if (
      Object.keys(p).sort().join(",") !== "email,userId" ||
      typeof userId !== "string" ||
      owners.has(userId) ||
      !/^user_[A-Za-z0-9_]{1,128}$/u.test(userId) ||
      typeof email !== "string" ||
      email.length > 254 ||
      email.includes("\0") ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
    )
      throw new Error("credit_warning_recipient_invalid");
    owners.add(userId);
    return { userId, email };
  });
}
