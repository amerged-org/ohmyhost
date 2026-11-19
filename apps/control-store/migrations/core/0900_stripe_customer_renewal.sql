-- A customer intent without a provider identity may start a new attempt once it is a day old and Stripe's metadata search
-- found no customer: its request id and creation instant move forward while the provider identity is still absent. The
-- organization, account, mode and creator stay fixed, and an acquired provider identity never changes (0340).
DROP TRIGGER stripe_customer_identity;
CREATE TRIGGER stripe_customer_identity BEFORE UPDATE ON stripe_billing_customers
WHEN NOT (
  OLD.provider_id IS NULL AND
  NEW.organization_id=OLD.organization_id AND NEW.account_id=OLD.account_id AND NEW.mode=OLD.mode AND NEW.created_by=OLD.created_by AND
  ((NEW.provider_id IS NOT NULL AND NEW.request_id=OLD.request_id AND NEW.created_at=OLD.created_at) OR
   (NEW.provider_id IS NULL AND NEW.request_id<>OLD.request_id AND NEW.created_at>OLD.created_at))
)
BEGIN SELECT RAISE(ABORT,'Billing intent may only acquire its first provider identity or start a new attempt'); END;
