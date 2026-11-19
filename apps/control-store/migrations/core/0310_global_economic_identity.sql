-- GLOBAL economic identities of the shared core (core-v1 only). Restores the original PostgreSQL guarantees that the tenant
-- lineage weakened to per-organization uniqueness when organizations lived in different shards:
--   079 organization_credit_grants   UNIQUE (kind, source_reference) and a global grant id
--   081 organization_credit_reservations UNIQUE (kind, source_reference) and a global reservation (hold) id
--   085 usage_credit_valuations      a global valuation id (the observation tuple was already global)
--   091 organization_credit_grant_adjustments a global adjustment id
--   Stripe invoice and subscription-period identities of the paid periods
-- One economic source can therefore never be granted, held or debited again under another organization, whatever the
-- ownership history. The per-organization constraints of the lineage stay (they are implied by these) and no row is rewritten.
-- Applied over populated tables the CREATE UNIQUE INDEX statements fail without changing anything when a duplicate exists, so
-- an import with a cross-organization collision is refused instead of silently half-accepted.

CREATE UNIQUE INDEX credit_lots_global_source ON credit_lots (kind, source_reference);
CREATE UNIQUE INDEX credit_lots_global_grant_id ON credit_lots (grant_id);
CREATE UNIQUE INDEX credit_holds_global_source ON credit_holds (kind, source_reference);
CREATE UNIQUE INDEX credit_holds_global_hold_id ON credit_holds (hold_id);
CREATE UNIQUE INDEX usage_valuations_global_id ON usage_valuations (valuation_id);
CREATE UNIQUE INDEX credit_lot_adjustments_global_id ON credit_lot_adjustments (adjustment_id);
CREATE UNIQUE INDEX credit_paid_periods_global_invoice ON credit_paid_periods (account_id, mode, invoice_id);
CREATE UNIQUE INDEX credit_paid_periods_global_period ON credit_paid_periods (account_id, mode, subscription_id, period_start);

-- The epoch / operation / event identities of the operation spine and the operator Paid access event are GLOBAL in the original
-- (001 `billing_epochs.billing_epoch_id` PRIMARY KEY, `operations.operation_id` UNIQUE, `operation_events.event_id`,
-- `outbox_events.event_id` and `audit_events.audit_event_id` primary keys, 113 `organization_paid_access_events.event_id`
-- PRIMARY KEY). The lineage keyed them (organization_id, id); an id another organization retains is refused again. An
-- ownership return opens a FRESH epoch id, so these indexes never touch a retained history row. Idempotency keys that were
-- scoped in the original (`api_idempotency_records`, `mail_send_requests`, ...) are deliberately NOT globalized here.
CREATE UNIQUE INDEX billing_epochs_global_id ON billing_epochs (billing_epoch_id);
CREATE UNIQUE INDEX operations_global_id ON operations (operation_id);
CREATE UNIQUE INDEX operation_events_global_id ON operation_events (event_id);
CREATE UNIQUE INDEX outbox_events_global_id ON outbox_events (event_id);
CREATE UNIQUE INDEX audit_events_global_id ON audit_events (audit_event_id);
CREATE UNIQUE INDEX credit_paid_access_events_global_id ON credit_paid_access_events (event_id);
