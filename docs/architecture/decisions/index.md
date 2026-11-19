# Decision register

This register preserves every accepted D identifier through D630. The 593 distinct decisions have stable anchors. D063 was absent from the original register, D457 was withdrawn without an anchor, and D486 to D489, D560 to D569, D572, D576 to D589 and D594 to D599 are unused. D468 to D549 record the security wave of November 2026: hostname and sender ownership, authority withdrawal, shared sweeps, rate-limit isolation, billing ceilings, build and database limits, the control-API surface and the release tooling. Never renumber or reuse an ID. Each decision has a stable `#dNNN` fragment in its topic file. Update its existing row in the same behavior/configuration change, including exact verified source references.

`Implemented` means checked-in behavior; release/customer evidence remains scoped. `Required`, `Deferred`, `Proposed` and `Superseded` identify different contracts explicitly. Code existence, a successful fixture or a recent package version does not establish full Production/customer acceptance.

| Topic                                                                        | Decisions |
| ---------------------------------------------------------------------------- | --------- |
| [Product and module foundations](foundations.md)                             | 11        |
| [Identity, authorization and local profiles](identity.md)                    | 54        |
| [Source admission, builds and artifacts](source-and-build.md)                | 59        |
| [Runtime, operations and deletion](runtime-and-lifecycle.md)                 | 89        |
| [Database, data identities and PostgreSQL](data.md)                          | 78        |
| [Domains, DNS and managed mail](domains-and-mail.md)                         | 60        |
| [Credits, billing and usage](billing-and-usage.md)                           | 65        |
| [Files, schedules and recovery](files-functions-recovery.md)                 | 32        |
| [Project state and private feedback](project-and-feedback.md)                | 16        |
| [Delivery, verification and operator boundaries](delivery-and-operations.md) | 33        |
| [Clients, public content and agent discovery](clients-and-public-content.md) | 95        |

[Foundation rationale](rationale.md) reconciles the six original ADRs with the current system. Original ADR/register text remains in historical documentation; preserve commit-pinned links to its earlier code rather than presenting retired code as the current graph.

During the 6 October rebuild, Resend and regional-database statuses were reconciled with their September rollout record, and Builder/artifact pending labels with the final 0.1.28 receipt. Other old version-specific pending labels are marked for capability-specific reconciliation where the later record does not prove that entire capability; independent-account, referral, direct SQL revocation and broader customer gates stay explicit in the plan registry.

[D424](delivery-and-operations.md#d424) records the implemented documentation/freshness-check restructuring. Full per-file review and exact-source CI remain pending until their actual final checks complete.

[D425](delivery-and-operations.md#d425) records bounded dependency maintenance needed for the mandatory security gate. It is a source change; provider rollout and full final verification are not inferred from the new pins.

[D426](clients-and-public-content.md#d426) records the implemented managed-source/remote-MCP target and actual Dev Artifacts proof. It supersedes earlier exclusive-source/deferred-remote-MCP target assumptions; exact-source rollout and native client acceptance remain pending.

Code references describe the reviewed current implementation. The managed-source/remote-MCP plan distinguishes source implementation, scoped provider proof, exact-source rollout and native customer acceptance. Dated release labels retain their original receipt scope, and final exact-source CI remains unclaimed until its actual checks complete.

[D428](domains-and-mail.md#d428) records the bounded PGCF operator-notification adapter. Source and local verification are complete; exact Development release and real notification delivery remain separate evidence. It does not authorize customer migration, P39 work or Production release.

[D429](delivery-and-operations.md#d429) records the policy cohort release gate of W15, which ships the security-floor admission of [D032](source-and-build.md#d032) to SourceFetcher, BuildRunner with its containers and Control together. It is implemented and released: the 0.1.32 Development and Production trains completed with one policy fingerprint across every consumer, and customer commit `66f1ca4` was accepted and promoted.

[D430](source-and-build.md#d430) records Next.js 16.4 and Cache Components on the immutable per-deployment cache through a pinned, fail-closed OpenNext overlay that is removed when OpenNext ships the fixes, and the refusals that remain. It is implemented in source and proven on local workerd with the real image and pipeline; it ships with the 0.1.33 clients in the D429 policy cohort, Development before Production, and a real Cloudflare deployment is verified only after that release.

[D431](data.md#d431) records W21's bounded unresolved-placement lease-retention guard. Its exact source/independent review, final candidate checks, complete CI and publisher-only Dev/Prod release at `c85d274` passed. Fresh Production customer DB acceptance and provider cleanup are evidenced independently of the original `80a61d3` Neon/Control runtime release; A42 covers only the original pre-fix unsupported metadata custody, and the owner approved on 2026-11-15 deleting its two historical reservations and their claims through the publisher sweep ([D614](runtime-and-lifecycle.md#d614)); both fresh acceptance projects are terminally deleted.

[D432](source-and-build.md#d432) records native Astro static/Workers SSR hosting, its bounded resource contract and W23 release/customer proof. Source implementation is separate from hosted acceptance.

[D433](billing-and-usage.md#d433) recorded PostgreSQL credit authority with one bounded owner-fair Metering cycle; it is superseded by [D445](billing-and-usage.md#d445).

[D434](domains-and-mail.md#d434) records the approved W25 same-main-domain shared-sender and independent predeployment application-proof contract. Implementation, exact-source release and customer acceptance are recorded separately in W25 progress.

[D435](source-and-build.md#d435) records the earlier Next.js security floor 16.4.1 and no 15.x floor. Its [16 November source follow-up](source-and-build.md#d435-20261116) raises the floor to 16.4.5 after GHSA-mfr8-8qww-v76h; the standalone and live-preview fixtures follow under [D425](delivery-and-operations.md#d425). Exact-source CI, the Development and Production [D429](delivery-and-operations.md#d429) cohort release, a full 16.4.5 build and hosted acceptance remain pending. A refused source must move to the reported minimum before its next plan; running deployments are untouched.

[D436](delivery-and-operations.md#d436) records that Turbo hashes only declared inputs and never replays a typecheck, that every package typechecks incrementally from restored build information keyed on every `tsconfig`, that every job that calls the shared setup action restores the Turbo outputs and the typecheck job the build information, that each is saved once per commit and the Turbo entry only after a build that left every tracked file as committed, and the weekly build and typecheck without any cache, which shows a failure or stale tracked file a cache hid but compares no outputs. It is implemented in source and was compared with cold computations locally; the hosted cache behaviour and timings are unverified until the first CI runs on the new keys.

[D437](domains-and-mail.md#d437) records that customer Workers reach the mail and storage gateways only through ordinary `fetch` to the injected gateway URLs: the egress policy Worker answers those origins, forwards the fixed routes over its own private bindings (storage through the named `StorageEgressEntrypoint`, with the project stamped over anything the caller sent) and never falls back to a public fetch for a gateway host. The key row, per-environment key custody and a scope frozen for each request replace the binding props on that path, and the deployment-bound data identity is not enforced there (restoration: W28); the customer service bindings stay attached and unsupported until W29. It was released to Development and Production on 23 October 2026 (`f865963e`, then the route-first correction `35b0fa58`) and accepted on disposable tenants (on Development also the retained W25 QA project); no per-project rate limit exists yet (W28 item 1 is the first follow-up and a precondition of the customer contract), and the customer contract (Unit C), the permanent Production canary and the matrix rows that were not run are open.

The [D437 Unit C candidate](domains-and-mail.md#d437-customer-contract--unit-c-candidate-0138)
records the locally prepared 0.1.38 client/error/Skill contract. Its source
readiness is separate from the limiter's live proof, exact-source CI and public
publication; the remaining W26/W28 obligations stay open.

The [D437 provider correction](domains-and-mail.md#provider-activation-correction-storage-owned-admission-rpc) keeps the shared limiter on the existing Storage Worker and requires private marked RPC admission before both gateway fetches. The Unit C candidate above preserves that boundary; source readiness does not establish complete CI, provider rollout or customer acceptance.

[D438](domains-and-mail.md#d438) records canonical Storage scope origins and intrinsic
private Mail/Storage roles. Missing native props readback supersedes the old
criterion; it is not a successful props attestation. [D439](delivery-and-operations.md#d439)
records the C3 layout fence, identity-only old candidates and the distinct
Management/Egress rollback boundaries. [D440](domains-and-mail.md#d440) records
bounded, cancellable receiving-attachment streams. These current source decisions
supersede the affected residuals described in historical D437 text; source checks
do not establish C3 hosted acceptance, later public-client publication or C4 closure.

[D441](data.md#d441), [D442](billing-and-usage.md#d442) and [D443](delivery-and-operations.md#d443) record the implemented PGCF provider/transport boundary, fixed memory tariff and native/release tooling. Exact releases, application migration/recovery checks, activation and application-provider traffic retirement remain separate live evidence under W01.

[D444](data.md#d444) records the owner-approved scope split: W01 migrated twelve
application databases to PGCF and W32 moved both Control databases to the Core D1.
Its last implementation record deletes the PostgreSQL and Neon Control code from
source; whole-platform zero-Neon also needs the Neon resources and secrets removed
after the observation window.

[D445](billing-and-usage.md#d445) records the W33 credit model: one credit account per organization in the Core, every change one atomic batch with a unique log key, the day's log rotated to R2 and kept 14 days by the private credit service, one-time credits that do not expire, and the removal of the lot, hold and valuation chain, the Metering Workers and the Logpush importer. It was rolled out to Development and Production on 30 October 2026; the first log rotation and the first PGCF-hour billing are still to be observed.

[D446](data.md#d446) records the database event surface; its 31 October 2026 clause makes a reached Stop budget disable the project's schedules (sweep after the hourly pgcf pass, Stop budgets only, re-enabling manual): PGCF webhooks, schedules and execution usage exposed through OMH REST, CLI, MCP and SDK, isolated to the environment's one PGCF database, with executions as counters only, whose cost is the awake compute time of the database. It is implemented in source; release and Development acceptance are pending under W34, and the PGCF webhook cap of 20 per project is a blocker for real use until the operator raises it with `WEBHOOKS_MAX_PER_PROJECT`.

[D452](billing-and-usage.md#d452) records the owner-approved LLM-only USD 0.01 missing-cost fallback after bounded telemetry lookup. Reported zero or a smaller measured cost always wins; other modalities retain unmeasured zero settlement. Source verification and release evidence stay separate.

[D453](clients-and-public-content.md#d453) records the owner-approved single-OAuth account policy, replacing D426's separate remote project grants while preserving its managed-source custody. Implementation is in progress; exact-source verification, installed-client acceptance and release evidence remain separate.

[D610](delivery-and-operations.md#d610) records the selected-profile private Broker bootstrap and same-profile Development prerequisite.

[D609](identity.md#d609) records the W44 owner-scoped Make OAuth and read-only custody boundary. The W44 record distinguishes the published pilot from the workspace-grant successor awaiting hosted acceptance.

[D454](identity.md#d454) records the approved optional Native Auth boundary. The private runtime, isolated Auth resource and management surfaces are an implementation in progress; the full lifecycle and hosted qualification remain open. The [18 November source candidate](identity.md#d454-native-oauth-activation--source-candidate-18-november-2026) permits explicit customer-owned OAuth configuration for allowlisted projects.

[D455](runtime-and-lifecycle.md#d455) was parked by the owner on 8 November 2026 and removed from `main` on 13 November 2026. The W38 disposition, the parked source and branch `feat/sandbox` (commit ccf25327) retain the Preview/Paid-Dev design and evidence.

D457 is withdrawn by the owner on 13 November 2026: native commit previews were removed from `main` and Development on that day (W41; `main` at `c396865e` was released to Development in 30 steps and to Production in 24 steps) and never ran in Production. The work is preserved at commit ccf25327 on the branch `feat/sandbox` (paused, not released) and resumes only when the owner reopens it. Core migrations 0629 and 0630 stay in the repository and are applied in Development and Production.

[D458](clients-and-public-content.md#d458) records the plain environment-secret link without sign-in: one hour, one value, consumed by the first save, written under the stored handoff authority. The form has a browser-side dice and eye under one hash-pinned script. It was released to Development and Production with `c396865e`, but its browser Save did not work (the form page sent `Referrer-Policy: no-referrer`, so browsers posted `Origin: null`); `6039c11b` fixes it (`strict-origin`, a retry form for an oversized value) and passed a real browser Save on Development on 13 November 2026. A real browser Save on Production with an owner-connected account is pending. GitHub and Native Auth handoffs are unchanged.

D468 to D549 are implemented in source on the security-wave branch and are released only with it; each row states `Implemented in source; release pending` until the Development and Production evidence exists. [D468](domains-and-mail.md#d468) to [D477](domains-and-mail.md#d477) cover hostname and sender ownership, [D478](identity.md#d478) to [D485](identity.md#d485) authority withdrawal and the export link, [D490](billing-and-usage.md#d490) to [D500](billing-and-usage.md#d500) billing, [D501](source-and-build.md#d501) to [D511](source-and-build.md#d511) builds, [D512](runtime-and-lifecycle.md#d512) to [D516](runtime-and-lifecycle.md#d516) forward paths and cookies, [D517](delivery-and-operations.md#d517) to [D519](delivery-and-operations.md#d519) release tooling, [D520](data.md#d520) to [D533](data.md#d533) the database plane, [D534](clients-and-public-content.md#d534) to [D543](clients-and-public-content.md#d543) the control-API surface and limits, [D544](project-and-feedback.md#d544) to [D545](project-and-feedback.md#d545) feedback and [D546](files-functions-recovery.md#d546) to [D549](files-functions-recovery.md#d549) scheduler and sweeps.

D550 to D593 record the second wave of the same review: [D550](identity.md#d550) to [D554](identity.md#d554) the in-place owner rotation of installed platform keys, [D555](domains-and-mail.md#d555) to [D558](domains-and-mail.md#d558) the separate Paid hostname proof, [D570](runtime-and-lifecycle.md#d570) and [D571](runtime-and-lifecycle.md#d571) the release of ended operations' bucket reservations, [D573](source-and-build.md#d573) the failed managed-source initialization, [D574](files-functions-recovery.md#d574) the upload sweep stamps, [D559](data.md#d559) and [D575](data.md#d575) the access sweep (D559 was D459 before the signup feedback mail took that number) and its stamps, [D590](clients-and-public-content.md#d590) and [D591](clients-and-public-content.md#d591) the platform Worker's agent documents and the owner administration surfaces, [D592](billing-and-usage.md#d592) and [D593](delivery-and-operations.md#d593) the parked Stripe warning.
The third security wave implements the following decisions in source. Exact-candidate release and hosted acceptance remain pending. [D624](billing-and-usage.md#d624) restores eligible Paid access after Stripe coverage ends, [D625](billing-and-usage.md#d625) renews a stalled customer intent, [D626](billing-and-usage.md#d626) closes a deleted organization’s billing, [D627](source-and-build.md#d627) bounds an acknowledged dispatch, [D628](runtime-and-lifecycle.md#d628) bounds a switched data change, [D629](source-and-build.md#d629) limits egress origins, [D612](data.md#d612) supersedes orphan reservations, [D613](runtime-and-lifecycle.md#d613) restores a native head, [D614](runtime-and-lifecycle.md#d614) releases stale claims, [D615](delivery-and-operations.md#d615) bounds GitHub push bodies, [D616](runtime-and-lifecycle.md#d616) validates egress DNS names, [D617](identity.md#d617) retains source and e-mail sign-in budgets, [D618](identity.md#d618) records secret-write outcomes, [D619](identity.md#d619) revokes an API key by ID, [D620](identity.md#d620) switches the portal workspace, [D621](domains-and-mail.md#d621) handles Paid domain repeats, [D622](clients-and-public-content.md#d622) assigns website page ownership, and [D623](data.md#d623) bounds PGCF compute observation.

The Wave register at `b97c9caca` used four numbers already assigned on the Make and Preview branches. References in that historical revision map to the integrated decisions as follows.

| Wave decision | Integrated decision                                              |
| ------------- | ---------------------------------------------------------------- |
| D607          | [D625 – Stripe customer intent](billing-and-usage.md#d625)       |
| D608          | [D626 – deleted organization billing](billing-and-usage.md#d626) |
| D609          | [D627 – managed-source dispatch](source-and-build.md#d627)       |
| D610          | [D628 – switched data change](runtime-and-lifecycle.md#d628)     |
| D611          | [D629 – customer egress limit](source-and-build.md#d629)         |

D600 to D605 record the approved W47 feedback closeout: [D600](runtime-and-lifecycle.md#d600) direct Prod and optional Dev, [D601](source-and-build.md#d601) opt-in writable path revalidation, [D602](source-and-build.md#d602) managed Browser PDF and twice-provider billing, [D603](project-and-feedback.md#d603) the private feedback operator, [D604](data.md#d604) durable webhook subscription activations and [D605](data.md#d605) closed migration diagnostics. Their source/local results are separate from the exact release and hosted receipts.

[D607](runtime-and-lifecycle.md#d607) records the private Development-only database, Native Auth and mail integration source for the W41 measurement spike. Local preparation is distinct from hosted qualification, G1, G2 and a product Preview release.

[D606](data.md#d606) records the W49 private Growth measurement boundary; its source candidate is not a release receipt.

[D608](runtime-and-lifecycle.md#d608) records the Cloudflare product Live Preview implementation, durable Save → Hot Reload path, private capability custody, lifecycle and reconciled usage accounting. The W41 release receipt records the Dev and Prod rollout and bounded hosted acceptance.

[D611](clients-and-public-content.md#d611) records the owner-approved W51 Master Tool Contract: every current API operation has explicit MCP coverage, separately named tools use one internal executor, and the OpenAI/Claude package and native-host boundaries remain distinct. Source implementation is separate from exact-release and native acceptance evidence.

[D630](data.md#d630) records that the current migration SQL policy applies only to files the database ledger has not applied: an already applied file, proven by an exact ordered path and digest prefix under the migrations lock, is neither re-checked nor re-run, while pending files keep the unchanged policy. It is implemented in source (a hosted Sign redeploy of an unchanged applied file failed `not_admitted`); exact-source CI, the Development and Production release of the deployment workflow and PGCF-runtime Workers and hosted acceptance remain pending.

[W53 under D458](clients-and-public-content.md#d458-w53) extends plain-secret links to multiple named fields and one Save with per-field Copy and status.
