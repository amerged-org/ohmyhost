# Development QA database bridge

This private G1 path supplies the `query` and `transaction` methods used by the seven W41 fixtures. It is limited to platform Development, EU, and seven separately isolated project data assignments. It does not implement held connections, RLS sessions, Native Auth or mail. A valid manifest is configuration, not proof that its projects or registrations exist; live QA readbacks and hosted acceptance remain separate.

## Trusted bindings and identity

`buildQaBindings` validates the seven fixture identities in fixed order, including their project, logical and physical environment, registration generation, operator grant and Dev origin. It generates the same manifest for the spike Worker and the regional database Worker. The spike binds `QA_SCOPED_DATABASE` to `ProjectDatabaseQa` on `ohmyho-project-database-development-eu`. The database Worker binds `QA_DATABASE_AUTHORITY` to Core's `PreviewQaDatabaseAuthority`, `QA_DEV_ACCESS` to `DevAccessRuntime` and `QA_CREDIT` to `GatewayCreditRuntime`; it also receives `QA_DATABASE_PLATFORM=development` and `QA_DATABASE_MANIFEST`. The Core authority exposes only the existing `readRuntimeBinding` and `readApiProjectDataChangeState` reads and refuses a non-Development Core. Neither Worker puts a provider or database credential in the guest.

The executor checks that the call matches its independently configured manifest, then routes to the Durable Object named by the exact organization, project and physical environment. Before SQL, immediately before COMMIT and after COMMIT, it reads the current Core data-change snapshot, current PGCF binding, Dev access and credit decision. The snapshot must say `isolated`, assign Dev to the selected physical identity and Prod elsewhere, and contain the same latest registration generation including pending reservations. The matching local registry receipt must be active, exact, and authorize only the selected Dev environment. The Dev grant, epoch, origin, owner and funding must still pass their actual services. A changed or unavailable check fails closed.

Each QA query and transaction runs in an explicit server-owned PostgreSQL transaction. A failed pre-commit check rolls it back; a stalled check or SQL operation reaches one 30-second executor deadline, which terminates the held database client so PostgreSQL rolls back an uncommitted transaction. Statements that PostgreSQL requires outside a transaction are not supported by this QA path. The underlying Core and PostgreSQL are separate systems: the immediate pre-COMMIT read is not an atomic lock on a concurrent Core mutation, and a change in the interval before COMMIT can race. The post-commit check can suppress the result but cannot undo an already committed write.

## Guest transport and uncertain outcomes

The sandbox Durable Object registers the host-specific `preview.capabilities` intercept before the catch-all using `ctx.exports.QaDatabaseOutbound({ props: { fixture: state.config.fixture } })`. Only the authenticated create flow may select the fixture. The guest cannot choose a scope through paths, headers, bodies or environment variables. `QaDatabaseOutbound` must be exported from the trusted Worker's top-level module.

The container runs `guest-binding.mjs` as a local workerd service bound to the fixture's `OHMYHOST_DATABASE`. It sends tagged query/transaction values through `transport.mjs` to the virtual hostname. Body reads are limited to 2 MiB, 1,024 chunks including empty chunks, and one 15-second total deadline. The bridge also rechecks Dev access and credit before and after the executor RPC and bounds the post-body operation to 35 seconds.

After dispatch, revocation, failed post-checks, a lost or timed-out RPC reply, or rejected result serialization produce HTTP `409` with `{ error: "qa_database_outcome_unknown", outcome: "unknown", retryable: false }`. A write may already have committed. The bridge suppresses result data, does not roll back or retry, and cannot assert that execution was prevented. The guest transport maps unknown outcomes, lost HTTP replies and malformed or unexpected responses to the existing SDK envelope `{ type: "ohmyhost.database-error/v1", sqlstate: "08007" }`; the customer runtime treats this SQLSTATE as non-retryable. Only an exact pre-dispatch bridge denial maps to ordinary unavailability. Callers must reconcile an unknown operation independently before another write.

## Activation and verification

Generated configuration retains `activation.allowed=false` with `qa_live_scopes_unverified`: valid syntax cannot verify actual QA ownership, isolated data assignments, grants, funding or matching active registrations. Verify all seven exact Development projects and their current records before enabling the spike. Deploy the narrow Core authority and the Development EU database Worker before binding the spike Worker, preserving its existing service bindings and registry secret. Review the complete affected release cohort and compatibility before any provider write. Native Auth and mail have their own independent prerequisites.

Local checks use deterministic authority services. The workerd integration executes the real QA entrypoint and registry over real local PostgreSQL sockets, including a cross-tenant denial, rollback on a changed assignment, and a committed operation whose response is suppressed after a later change. These checks do not prove live QA scope or hosted customer acceptance.

```sh
pnpm exec vitest run apps/project-database-runtime/test/qa-database.test.ts apps/project-database-runtime/test/qa-worker.integration.test.mjs
node --test scripts/preview-spike/capabilities/bridge.test.mjs
pnpm --filter @ohmyhost/project-database-runtime typecheck
pnpm exec eslint 'scripts/preview-spike/capabilities/*.mjs' --max-warnings 0
pnpm exec prettier --check scripts/preview-spike/capabilities
```
