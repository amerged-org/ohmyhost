# Development G1 release

The separate QA adapter and benchmark share `control-target.mjs` for fresh exact route/version checks before sending the private control bearer. The operator supplies the non-secret verified `PREVIEW_SPIKE_ROUTE_ID` and `PREVIEW_SPIKE_WORKER_VERSION_ID` from this release journal; the Cloudflare API token remains only in the process. These sampled checks do not make routing and HTTP dispatch atomic.

This is the fixed, Development-only operator for the W41 spike. It accepts only account
`00000000000000000000000000000001`, zone `0000000000000000000000000000000b`, the named
spike resources and the five Development shared Workers in its source. Production is outside
its scope. The runner requires the checked-out source to be clean, exactly pushed, descended from
current `origin/main`, and covered by the complete successful CI workflow for that exact commit. Before any Worker write,
the source revision recorded on each live shared Worker must also be an ancestor of that commit;
a missing or unproven source annotation stops the release. It uses the existing `CLOUDFLARE_API_TOKEN` in the process, never another Cloudflare credential.

Before starting, the already-authorized bucket and wildcard DNS must have a private,
append-only resource journal recording absent baseline, create intent, provider response and
verified readback. The runner checks the journal and re-reads both exact resources before every
stage. A collision or changed ID stops the run; these operations never replace or delete either.
The private journal does not by itself authorize cleanup. The created bucket lacks a stable
Cloudflare ID and therefore still needs explicit reconciliation before deletion.

Use absolute paths to a new journal and the original resource journal inside an owner-only
private directory outside the release checkout. Paths contain no values. Put the verified
Cloudflare token and Development `SPIKE_CONTROL_TOKEN` in the process environment; never pass
secret values in arguments or print them. Credential creation and storage must follow the
repository's append-only procedure. The fixed CLI is:

```sh
node scripts/preview-spike/deployment/cli.mjs baseline --journal /private/directory/g1.jsonl --resources /private/directory/resources.jsonl
node scripts/preview-spike/deployment/cli.mjs core --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs custody --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs auth --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs mail-bootstrap --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs gateway --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs native --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs database --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs spike --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs route --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs activate-auth --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs activate-database --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs activate-spike --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs activate-gateway --journal /private/directory/g1.jsonl
node scripts/preview-spike/deployment/cli.mjs mail-final --journal /private/directory/g1.jsonl
```

The Core step uses its current live D1 binding and launch policy, verifies the exact Development
D1 resource and requires its migration receipts already to match the source commit. It performs no
migration. Shared Worker uploads retain existing secrets, check every prior binding and compare
routes and schedules before and after the deployment. The journal records each prior and new
version, so the ordinary Native, Gateway, Database and secret-delivery versions can be restored
and verified before disposable dependencies are removed. No route or schedule is detached.

The private Auth Worker and bootstrap Mail Worker start fail-closed. The spike initially has its
control secret but no QA manifest, and the wildcard route is attached only after its active version
and Container application are read back. The authenticated `qa-inventory` endpoint then reads
and validates the current seven Development project scopes from the existing authorities. Each
activation fetches that inventory again; its digest must stay identical across the cohort. Each
fetch first rechecks the exact route ID, pattern and Worker, together with the active spike
version and deployment, and repeats those checks before using the response. These checks cannot
make a provider route change and an HTTP request one atomic operation.

`activate-gateway` additionally requires `QA_NATIVE_PREVIEW_MAIL_SCOPE` in the process. It is a
JSON object with platform, fixture, organization/project/environment IDs and two to eight distinct,
verified operator-controlled recipients; it must match the live Native Auth scope. This bounded list
can preauthorize two fresh aliases for each of the four instance-type journeys; each journey still
uses exactly two fresh users. `mail-final`
requires `QA_MAIL_SCOPE` (the verified mail fixture scope and one authorized recipient) and
`QA_MAIL_OPERATOR_TOKEN` equal to `SPIKE_CONTROL_TOKEN`. These values are copied only to a
mode-600 temporary secrets file for Wrangler and not to the journal or command arguments. Direct and nested
Wrangler processes use an explicit empty private environment file, so they do not load checkout
`.env` or `.env.local` files. The
private mail key remains with the existing secret custody service. Do not use synthetic values
for a hosted mail qualification.

For SDK 1.0 the first spike deployment builds the checked-in Dockerfile and public generated
context through the named `images.fixture` entry. Its version-bound digest, DO namespace and
Container application ID are read back and recorded. Later activation reuses that exact digest;
it does not use a scheduled-application rollout. This source identity is not a cryptographic
attestation of the provider's build. The separate benchmark provenance check must also pass.

Every provider mutation has a durable intent before submission and an exact readback before it is
marked verified. A timeout, interruption, ambiguous result or existing intent stops the sequence:
inspect the journal and provider state, reconcile manually, and do not simply retry a write. The
outer runner does not retry writes, but Wrangler itself may retry an immutable version upload on
transient API failures. If more than one matching version appears, the runner refuses to choose one;
reconcile the journal and provider readback before proceeding. The runner does not claim G1
benchmark success or perform cleanup. Provider diagnostics and secret values are never copied into
output or the journal.

Local simulated-provider checks:

```sh
node --test scripts/preview-spike/deployment/deployment.test.mjs
```
