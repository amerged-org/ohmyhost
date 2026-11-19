# tofu-state-backend

Private OpenTofu state and locking service. Its Durable Object serializes state; R2 preserves immutable snapshots.

See [the current architecture chapter](../../docs/architecture/services-and-workers.md) for contracts, trust boundaries, credentials, lifecycle and verification limits. Previous module prose is retained in `docs/plan/history/module-readmes/` as historical context.
