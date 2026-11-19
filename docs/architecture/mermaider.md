# Mermaider pilot

Mermaider maintains selected, source-backed views within the existing architecture documentation. The canonical explanations remain [Services and Workers](services-and-workers.md) and [Build and deploy](build-and-deploy.md). The existing diagrams and their coverage reviews stay in place. This pilot contributes to the tooling portion of A34; it does not close integrated documentation or release acceptance.

## Selected views

Open [the saved HTML diagram atlas](mermaider/index.html) to browse all eight views, inspect their evidence or view a diagram at full size. This committed, self-contained file includes its renderer and works offline. Markdown and Mermaid source files remain beside it for source review.

Customer deployment:

- [Deployment worker resources](mermaider/deployment-resources.md) describes the services and Workflows declared by the Production deployment-worker profile, including W47's private Next cache retirement binding. It is checked-in configuration, not a live Cloudflare inventory. The binding and Worker names `NEON_MANAGEMENT` and `ohmyho-neon-management-production` are historical: that Worker manages PGCF databases through the Core, and no Neon service remains.
- [Customer deployment outcomes](mermaider/customer-deployment.md) describes the orchestration path after an accepted `DeploymentRequestedV1` command and pending-cleanup handling. It includes refresh reuse with a matching current provider target, bounded mail and database provisioning waits, typed failure, supersession and uncertain outcomes. PGCF source support is represented without claiming the live cutover.
- [Successful deployment sequence](mermaider/customer-deployment-sequence.md) follows a fresh source/build deployment through candidate activation and persistence in the Core D1. It deliberately excludes refresh, failure and replay branches; the outcomes view and owning chapter cover those branches.

Credit account and usage billing (one credit account per organization in the Core D1, after the 2026-10-30 replacement of the lot, hold and metering chain):

- [Credit Service resources](mermaider/credit-service-resources.md) describes the Production Credit Service profile: the usage (minutes 27 and 57 of every hour) and daily (00:00 UTC) crons, the `ohmyho-usage-production` Logpush bucket, the `ohmyho-credit-log-production` bucket and the service bindings to the Core `CreditRuntime`, the PGCF usage collector and the R2 usage collector. It is checked-in configuration, not a live inventory.
- [Hourly usage pass](mermaider/credit-usage-pass.md) follows the four usage sources (WFP Logpush objects, PGCF memory rollups, R2 days, WFP script and hostname days) through pricing, idempotent posting to the Core and cursor advance, then the rotation attempt. A failed posting holds its window for up to four passes, or is dead at once when repeating it cannot help; a dead posting is kept in the Core with its lines and replayed with backoff.
- [Credit charge](mermaider/credit-charge.md) follows one posted usage window inside the Core: first-touch account creation, lazy monthly renewal, the spend order (monthly, one-time, platform overrun), the unique `credit_log` key as the double-posting guard and the per-project use of the month, all in one D1 batch.
- [Credit log rotation and usage report](mermaider/credit-log-rotation.md) follows the daily move of the Core credit log to R2 (objects created once, read back, then deleted from the Core) and the usage report that merges the rows still in the Core with the rotated days.
- [Credit tables](mermaider/credit-tables.md) shows the six Core tables of migration 0600 (`credit_account`, `project_credit`, `credit_reservation`, `credit_grant`, `usage_cursor`, `credit_log`) as left by the replay of every Core migration, including the removal of the old chain by 0601. The tables declare no foreign keys; they relate through `organization_id` and `project_id`, so the view shows no relationships. Its source list names every replayed migration because the replay needs the whole stream.

The audience is maintainers reviewing deployment and credit changes. These are bounded views, not a complete resource inventory, a platform release pipeline, or a replacement for the existing data and security diagrams. The credit views do not model reservations, grants, admission decisions, Stripe settlement, mail charges or the exhaustion warnings; the [billing chapter](billing-and-pricing.md) owns those. Additional discovered diagrams remain proposals until selected.

## Sources, generation and review

The versioned selection lives in [the configuration](../../.mermaider/config.json); the five process models live in [the outcomes model](../../.mermaider/models/customer-deployment.json), [the sequence model](../../.mermaider/models/customer-deployment-sequence.json), [the usage pass model](../../.mermaider/models/credit-usage-pass.json), [the credit charge model](../../.mermaider/models/credit-charge.json) and [the credit log model](../../.mermaider/models/credit-log-rotation.json). Every modeled node, relationship and message cites a source hash and line, plus a symbol when it resolves unambiguously. The two resource views are extracted from their declared Wrangler profiles and the credit tables from the replayed Core migrations. Models describe implemented code and do not claim deployed provider state.

Use a local installation of [Mermaider](https://github.com/sebmer-com/mermaider) at the revision recorded in [the tool revision file](../../.mermaider/tool-revision), built from that revision, from the repository root:

```sh
mermaider discover --json
mermaider update
mermaider check
pnpm plan:check
pnpm verify:fast
```

`discover` proposes the currently available views. It does not change the selection. `update` deterministically renders the selected models and declarations; `check` verifies generated bytes and evidence. A changed source hash requires reading the affected behavior, correcting the model if necessary and explicitly renewing its reviewed evidence. Regeneration never establishes semantic correctness by itself.

The existing coverage ledger remains authoritative for repository accounting and the nineteen original diagrams. Register new generated files and diagram blocks there after reading their changes. Refresh only the new pilot entries or the exact existing sources actually reviewed; never use a whole-ledger hash refresh to silence unrelated changes. Mermaid syntax and rendered readability are separate checks. The original documentation validator still needs to pass alongside Mermaider.

## Native agent hooks

The project configuration enables commit-triggered Mermaider notices for an installed Codex or Claude Code integration. The native integration runs inside the existing agent session; external commits are detected at the next supported event. Session start also reconciles stale diagrams without requiring a new commit. The detector inspects the current working tree, which may contain changes beyond `HEAD`. It does not run a background service, create commits or launch another agent.

When a notice arrives, read repository rules and the Mermaider Skill, inspect changed evidence, regenerate the selected views, review them and run the checks above. Existing hooks and trust settings remain owned by the host integration. Plan mode, a user's cancellation and existing permissions still apply. At most one completion-time continuation is requested for the same input in a session; the agent must report unresolved failures when this limit is reached.

Keep architecture and source changes in the same commit as required by [development rules](../development.md#release-and-documentation). Run the update and checks before committing; the post-commit notice is a backstop. Mermaider's general suggestion of a separate documentation commit does not override this repository rule. No deployment or release authority comes from a successful diagram check.
