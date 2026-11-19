import type { PlatformContext } from "../platform-support.js";
import {
  prepareStripeCustomer,
  confirmStripeCustomer,
  renewStripeCustomerIntent,
  readOrganizationPaid,
  readStripeBillingCustomer,
} from "./stripe-metadata.js";
import { recordStripeSubscriptionEnd } from "./stripe-subscription.js";
import { claimStripeBillingClosure, finishStripeBillingClosure } from "./stripe-closure.js";
import {
  claimStripeInboxEvent,
  finishStripeInboxEvent,
  recoverExpiredStripeInboxClaims,
} from "./stripe-inbox.js";
import { grantStripePayment, reverseStripePayment } from "./stripe-payment.js";
import {
  readRechargePolicy,
  readRecharge,
  configureRecharge,
  claimRecharge,
  saveRechargeSetup,
  transitionRechargePolicy,
  listRechargeCandidates,
} from "./stripe-recharge-metadata.js";

/** Billing's complete fixed capability: the customer, the credit a verified payment grants and takes back, the
 * recharge policy and the separate original inbox ACK. No SQL, generic grant, provider secret or unrelated command. */
export function createStripeBillingCommands(
  fenced: <Result>(
    command: (context: PlatformContext, input: unknown) => Promise<Result>,
  ) => (input: unknown) => Promise<Result>,
) {
  return Object.freeze({
    prepareStripeCustomer: fenced(prepareStripeCustomer),
    confirmStripeCustomer: fenced(confirmStripeCustomer),
    renewStripeCustomerIntent: fenced(renewStripeCustomerIntent),
    readStripeBillingCustomer: fenced(readStripeBillingCustomer),
    readOrganizationPaid: fenced(readOrganizationPaid),
    recordStripeSubscriptionEnd: fenced(recordStripeSubscriptionEnd),
    claimStripeBillingClosure: fenced(claimStripeBillingClosure),
    finishStripeBillingClosure: fenced(finishStripeBillingClosure),
    claimStripeInboxEvent: fenced(claimStripeInboxEvent),
    finishStripeInboxEvent: fenced(finishStripeInboxEvent),
    recoverExpiredStripeInboxClaims: fenced(recoverExpiredStripeInboxClaims),
    grantStripePayment: fenced(grantStripePayment),
    reverseStripePayment: fenced(reverseStripePayment),
    readRechargePolicy: fenced(readRechargePolicy),
    readRecharge: fenced(readRecharge),
    configureRecharge: fenced(configureRecharge),
    claimRecharge: fenced(claimRecharge),
    saveRechargeSetup: fenced(saveRechargeSetup),
    transitionRechargePolicy: fenced(transitionRechargePolicy),
    listRechargeCandidates: fenced(listRechargeCandidates),
  });
}
