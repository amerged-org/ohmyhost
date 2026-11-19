# Development-only preview measurement spike

This is a disposable, public-fixture-only Cloudflare SDK 1.0 experiment. It is **not** a product
runtime and does not establish the W41 isolation boundary. In particular, Cloudflare documents
that processes under the `durable_object` container scheduling policy retain root capabilities
even when given UID 10001. Never run customer source, credentials, provider tokens, or real data
in this container. The local activity script can be imitated by same-origin application code; it
is a measurement aid, not an enforceable billing or human-presence signal.

The seven pinned fixture graphs are installed with scripts disabled. The image seed contains
public packages; choose `cacheMode: "empty"` to use a separate initially empty package cache.
The fixture copies and image helpers are recreated in an isolated build context from Git commit
`67c2c0cc04c4a257dcb82b062b61b30ae6c250fd`. Re-run `npm run prepare-context` after **every**
helper change and record/check the actual built image digest before any hosted measurement.
The build context is generated, ignored, and contains no checkout secrets.

For the React/Vite, Vanilla/Vite and Astro HMR transport probe, preparation applies a deterministic
script-tag and self-accepting module overlay to the disposable workspace before its first backup.
The pinned image archive and fixture tree remain unchanged. The descriptor hash is included in
image metadata and runtime status and must match the benchmark pin. This tests that module's update,
not React Fast Refresh or a change to Astro's server-rendered page.

The SDK stores `tar+zstd` archives as ordinary R2 objects; its restore writes ordinary files.
Before initial readiness, the worker makes a quiescent backup with no guest process. Later
edits are durably retained in the DO and replayed after restore. Explicit checkpointing destroys
the running VM, restores and checkpoints in a fresh VM before starting a server. A separate
DO admits exactly one session at a time and holds its lease until cleanup is confirmed; a
12-hour alarm attempts cleanup. A durable operation journal precedes each checkpoint upload;
its SDK `name` contains the session and operation identity. Returned backup records are stored
before the selected checkpoint changes, and previous-object deletion remains journaled until
the SDK confirms it. Cleanup removes every known record, including unselected checkpoints.
An upload error, timeout or crash before its record is persisted can still leave an object or
multipart upload without a known object ID: the SDK generates that ID internally. Cleanup
then fails with `backup_reconciliation_required`, retains the journal and slot, and never
claims the bucket is clean. The operator must inventory and reconcile the dedicated bucket
under the recorded operation identity; this prototype provides no unverified force-clear API.
A persisted `created` record whose checkpoint handoff did not finish also blocks serving and
wake after actor restart. Its known object can be removed by the existing cleanup operation;
the runtime does not select it or create another upload based on an assumed commit.

Edit paths use the same narrow grammar as the native helper, including rejection of `..`.
An edit intent is durable before the write, but the revision and replay set advance only in
an atomic commit after a confirmed write. The helper's pre-write path/target refusals leave
the live session usable. A transport error, deadline, late rename failure or unconfirmed
commit retains its intent and fences use; no previous revision is asserted to have been
restored. Deleting a session records cleanup intent before destructive work, so a partial
cleanup cannot wake a checkpoint that may already have been deleted.

Wake may make one additional attempt only after a settled SDK `BACKUP_TRANSFER` restore
refusal or the worker's own read-only readiness failure, and only after the previous VM is
confirmed stopped. Attempts remain visible in the operation journal. Unknown transport or
deadline outcomes are not retried. This is recovery for public fixtures with no backend
capabilities; it is not a product mutation or billing recovery contract.

The generated `build-context/fixture-provenance.json` records the immutable fixture commit,
SHA-256 of the exact Git archive bytes and each pristine fixture tree hash. Docker copies it
to `/opt/preview-spike/fixture-provenance.json`, read before guest preparation in every fresh
VM. `status().provenance` also reports `CF_VERSION_METADATA.id` and the optional
`SPIKE_SOURCE_REVISION` deployment variable; missing runtime/source metadata stays `null`.
The latter is an operator source claim. These fields support source/image/readback comparison,
not cryptographic build attestation or isolation against root-capable guest processes.

## Local checks

From this directory, using Node 24, Docker and the pinned npm dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare-context
npm test
node test/context-smoke.mjs
docker build --platform linux/amd64 -f Dockerfile -t ohmyho-preview-spike-local build-context
node test/docker-smoke.mjs
```

The Docker smoke checks a real Astro server, normal file writing, and root/inner symlink
rejection. The separate context smoke uses a network-disabled scratch build to verify that the
actual Docker allowlist includes the provenance manifest and excludes a public fake environment
canary; its temporary image tag and unstarted container are removed afterward. A local Workerd
plus Docker and local R2 roundtrip can be run with this public,
synthetic loopback-only value (not a real credential):

```sh
npx wrangler dev --local --ip 127.0.0.1 --port 8891 --local-protocol https --infer-origin-from-routes=false --var SPIKE_CONTROL_TOKEN:synthetic-local-token-not-a-real-secret --show-interactive-dev-session=false
```

In a second terminal, run `node test/workerd-local.mjs`, then stop the first process. Local
Workerd/R2 results are not hosted Cloudflare timing, placement, billing, or security evidence.
`npm run check` performs a local build/dry run and does not publish. Hosted setup is a separate
operator step; do not deploy until account, exact zone, DNS, wildcard TLS, R2, image, budget,
and cleanup have been verified and that step is authorized.

On 14 November 2026, the local Workerd/Docker/local-R2 roundtrip passed for `react-vite`:
initial checkpoint, file edit, manual stop, restore with edit replay, idle stop, a second restore,
and cleanup. The separate SDK-only run, with no open browser WebSocket and no intermediate
status requests, observed the local container stopped after 44,996 ms for a configured 5,000 ms
inactivity timeout, then restored the edit and cleaned up. This is one local observation, not a
hosted latency percentile or a test of an idle open tab. A separate run of `next-edge` reached a successful initial checkpoint and HTTP-ready
server, but its edit failed against an earlier version of the helper. That helper has since been
corrected and a normal file write plus root and inner symlink refusals have passed in Linux.
The full Next roundtrip has **not** been repeated: Colima's `/var/lib/docker` volume reached
100% capacity and returned `ENOSPC`. An earlier Astro fixture start returned HTTP 200, but the
full Astro smoke after the helper correction also hit that disk limit. Free space through the
owner's normal infrastructure process, then repeat both tests before claiming those paths pass.

## Test interface

Control origin is `https://control.preview.dev.omh.st`. All `/__spike/*` control operations
require `Authorization: Bearer <SPIKE_CONTROL_TOKEN>` and no control token is sent to the
container. Set the actual secret in the approved secret store and follow the repository's
append-only credential procedure. Never include it in commands, spike files, images, logs,
receipts, or requests to a fixture.

| Method | Path                           | Effect                                                                                                                                                                                                                                                |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/__spike/sessions`            | `{fixture, instance, inactivityMs?, cacheMode?, idleMode?}`; returns `{id,url}`. `basic` and `basic-custom-equivalent` are distinct instance choices.                                                                                                 |
| GET    | `/__spike/lease`               | Read the one outstanding ID and expiry after an uncertain create.                                                                                                                                                                                     |
| POST   | `/__spike/sessions/:id/setup`  | Start, install, save initial backup, then start the dev server.                                                                                                                                                                                       |
| GET    | `/__spike/sessions/:id/status` | Returns `running`, `ready`, `generation`, `wakeCount`, `sourceRevision`, `backup`, `phases`, `coldProof`, stop reason, and `capabilityVerification`. It does not start a container, but it is DO activity: **never poll during an idle measurement**. |
| POST   | `/__spike/sessions/:id/edit`   | `{path,content}` for an existing file below `src/`, at most 64 KiB. Replies with revision and generation.                                                                                                                                             |
| POST   | `/__spike/sessions/:id/backup` | Re-checkpoint the latest source and dependency state in a fresh, quiescent container.                                                                                                                                                                 |
| POST   | `/__spike/sessions/:id/stop`   | Destroy the VM and record `manual`; this does not prove idle expiry.                                                                                                                                                                                  |
| DELETE | `/__spike/sessions/:id`        | Record deletion intent, stop the VM, delete all known backup records, clear state only when reconciliation is complete, then release the slot.                                                                                                        |

The browser opens the signed capability hostname from `url`. HTTP and HMR WebSockets flow
through the same hostname, and the SDK `bridge()` keeps a socket open. The product-idle alarm
still stops an unused tab after `inactivityMs`; HMR frames and reconnects do not renew the
deadline or wake the VM. A trusted browser event invokes `/__spike/activity`, or a real top-level
navigation wakes it. The app is reloaded after a wake. These are test-only semantics, not proof
that a customer application cannot forge activity. A status request itself counts as DO traffic,
so sample the idle state only after the complete idle period. Record native Cloudflare
inactivity separately from the explicitly enforced product-idle stop.
`stopRequestedAt`, `stoppedAt` and `stopGeneration` describe the worker's request and subsequent
observation that the matching generation is stopped. They reset on every start and are not
backdated to the configured idle deadline. They do not establish Cloudflare billing counters.
Set `idleMode: "sdk"` to disable the product alarm and observe SDK inactivity alone; the
default `"product"` enforces the required idle deadline even with a bridged HMR socket.
`observedProviderStop` means the SDK container was found stopped, and does not establish why.
Actor restart restores the product alarm from durable last activity (or persisted initial
server readiness) before network work, without starting a fresh idle window. An already
expired deadline stops the VM immediately; incomplete, poisoned or deleting runtimes are
stopped. The global lease actor likewise restores its original 12-hour expiry alarm. SDK-only
mode does not acquire a product alarm during this recovery. An existing earlier alarm is not
postponed; an already-expired lease is triggered just in the future without changing its stored
expiry. Duplicate idle-alarm delivery preserves an already recorded stop for that generation.

Treat a timed-out operation as ambiguous: do not issue a second operation on that session.
Read the lease/status without starting a new sample, resolve cleanup, and record the result.
All stage times are server-side timestamps, while edit-to-paint and first usable page are
measured independently in a real browser.

All seven fixtures require a database bridge; Auth and Mail additionally need their real
isolated services and operator-side inbox checks. These test bindings are not present yet.
`capabilityVerification` therefore stays `"unavailable"`; a rendered page or HMR measurement
does not qualify as the full seven-fixture customer-path acceptance or a gate pass.
