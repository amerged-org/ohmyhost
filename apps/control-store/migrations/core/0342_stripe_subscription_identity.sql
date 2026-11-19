-- Original157 primary key: subscription-end identity is global within a Stripe account/mode.
-- An organization is attribution, not a second namespace for the same ended subscription.
CREATE UNIQUE INDEX credit_subscription_ends_global_identity
  ON credit_subscription_ends(account_id,mode,subscription_id);
