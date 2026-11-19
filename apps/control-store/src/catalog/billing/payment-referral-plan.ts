import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { classifyFailure, guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { grantCredit, MICROS_PER_CREDIT, reverseGrant } from "../credit/index.js";
import { isDuplicate } from "../credit/spend.js";

/** What the referrer of a paying organization gets for its first payment: 1000 credits that never expire. */
export const REFERRAL_REWARD_MICROS = 1_000 * MICROS_PER_CREDIT;
/** The most referral rewards one referrer organization ever receives, so farmed payers cannot pay it without limit. */
export const REFERRAL_REWARDS_PER_ORGANIZATION = 10;

interface Target {
  readonly organization_id: string;
}

/**
 * Takes back the referrer's reward when the payment that earned it is refunded or disputed: the whole one-time credit
 * of the reward, and the 30 days of granted Paid access it added, never before now. Only the payment that earned the reward
 * claws it back; a refund of any other payment takes nothing. The reward is looked up by
 * its grant key, so a reward that was never granted (a direct signup, an unknown referrer) takes nothing back.
 *
 * The Paid days come off first, guarded by the reward not being reversed yet, so two overlapping reversals that both read
 * the reward before either one wrote subtract them once: the reversal of the credit then follows in the same batch.
 */
export async function clawBackReferralReward(
  db: D1Database,
  input: { readonly payerId: string; readonly paymentKey: string; readonly now: string },
): Promise<D1PreparedStatement[]> {
  const key = `referral_reward:${input.payerId}`;
  const grant = await db
    .prepare("SELECT organization_id, reversed_micros, granted_at FROM credit_grant WHERE key = ?1")
    .bind(key)
    .first<{ organization_id: string; reversed_micros: number; granted_at: string }>();
  if (grant === null || grant.reversed_micros > 0) return [];
  // The payment that earned the reward is the payer's paid grant made at the reward's instant, or the latest one before
  // it: a first payment that came before the referrer was active earned nothing and is not the one to claw back.
  const earner = await db
    .prepare(
      "SELECT key FROM credit_grant WHERE organization_id = ?1 AND paid_minor IS NOT NULL AND granted_at <= ?2 ORDER BY granted_at DESC, key DESC LIMIT 1",
    )
    .bind(input.payerId, grant.granted_at)
    .first<{ key: string }>();
  if (earner === null || earner.key !== input.paymentKey) return [];
  const now = storedTimestamp(input.now);
  return [
    db
      .prepare(
        `UPDATE credit_account SET
           paid_until = MAX(strftime('%Y-%m-%dT%H:%M:%f', paid_until, '-30 days') || '000Z', ?2),
           updated_at = ?2
         WHERE organization_id = ?1 AND paid_source = 'granted' AND paid_until > ?2
           AND EXISTS (SELECT 1 FROM credit_grant WHERE key = ?3 AND reversed_micros = 0)`,
      )
      .bind(grant.organization_id, now, key),
    // A granted access that a later invoice overwrote keeps its end aside. The same thirty days come off that end only when
    // the reward came before the invoice captured it: a reward granted later never extended the access the invoice kept.
    db
      .prepare(
        `UPDATE credit_account SET granted_until = MAX(strftime('%Y-%m-%dT%H:%M:%f', granted_until, '-30 days') || '000Z', ?2), updated_at = ?2
         WHERE organization_id = ?1 AND paid_source = 'stripe' AND granted_source = 'granted' AND granted_until > ?2
           AND granted_captured_at >= ?4
           AND EXISTS (SELECT 1 FROM credit_grant WHERE key = ?3 AND reversed_micros = 0)`,
      )
      .bind(grant.organization_id, now, key, grant.granted_at),
    ...reverseGrant(db, {
      organizationId: grant.organization_id,
      grantKey: key,
      now: input.now,
      detail: { payerId: input.payerId },
    }).statements,
  ];
}

/**
 * The referral reward of an organization's first payment. The payer's first onboarding request names where it came from:
 * `ref-<organization>` or `flag-<project>` (the owner of a project that carries the powered-by flag). The referrer gets
 * the reward once per paying organization (grant key `referral_reward:<payer>`), so a repeat, a later payment or a
 * concurrent observation changes nothing. A referrer that is not Paid gets 30 days of granted Paid access, a granted
 * access is extended by 30 days, and a Paid access of Stripe or of an operator is never touched.
 */
export async function rewardReferrer(
  db: D1Database,
  input: { readonly payerId: string; readonly now: string },
): Promise<{ readonly rewarded: boolean }> {
  const links = (
    await db
      .prepare(
        `SELECT u.attributed_source AS source FROM onboarding_requests r JOIN user_signup u ON u.first_request_id = r.request_id
         WHERE r.organization_id = ?1 ORDER BY r.request_id LIMIT 2`,
      )
      .bind(input.payerId)
      .all<{ source: string | null }>()
  ).results;
  if (links.length > 1) throw new Error("referral_payment_scope_changed");
  const matched = /^(flag|ref)-([0-7][0-9a-hjkmnp-tv-z]{25})$/u.exec(links[0]?.source ?? "");
  if (matched === null) return { rewarded: false };
  const id = (matched[2] as string).toUpperCase();
  const target = await db
    .prepare(
      matched[1] === "ref"
        ? "SELECT organization_id FROM organizations WHERE organization_id = ?1 AND state = 'active'"
        : `SELECT p.organization_id AS organization_id FROM project_directory d
           JOIN projects p ON p.organization_id = d.organization_id AND p.project_id = d.project_id
           JOIN organizations o ON o.organization_id = p.organization_id
           WHERE d.project_id = ?1 AND p.owner_state = 'active' AND o.state = 'active'`,
    )
    .bind(id)
    .first<Target>();
  if (target === null || target.organization_id === input.payerId) return { rewarded: false };
  const grant = grantCredit(db, {
    organizationId: target.organization_id,
    key: `referral_reward:${input.payerId}`,
    kind: "onetime",
    amountMicros: REFERRAL_REWARD_MICROS,
    now: input.now,
    detail: { payerId: input.payerId, source: links[0]?.source },
  });
  try {
    await db.batch([
      guard(
        db,
        "precondition_changed",
        "(SELECT count(*) FROM credit_grant WHERE organization_id = ?1 AND key LIKE 'referral_reward:%') >= ?2",
        [target.organization_id, REFERRAL_REWARDS_PER_ORGANIZATION],
      ),
      ...grant.statements,
      db
        .prepare(
          `UPDATE credit_account SET
             paid_until = strftime('%Y-%m-%dT%H:%M:%f', MAX(COALESCE(paid_until, ?2), ?2), '+30 days') || '000Z',
             paid_source = 'granted', updated_at = ?2
           WHERE organization_id = ?1 AND (paid_until IS NULL OR paid_until <= ?2 OR paid_source = 'granted')`,
        )
        .bind(target.organization_id, storedTimestamp(input.now)),
    ]);
  } catch (error) {
    if (isDuplicate(error)) return { rewarded: false };
    const failure = classifyFailure(error);
    if (failure.kind === "guard" && failure.code === "precondition_changed")
      return { rewarded: false };
    throw error;
  }
  return { rewarded: true };
}
