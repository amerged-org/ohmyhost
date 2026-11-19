# Local Development spike operator

This is an **offline review aid, not a deployable operator**. It has no provider adapter,
authentication, network client, resource creation, or deletion. It cannot prove that the input
came from Cloudflare, that a principal is authorized, or that a planned deletion can be made
atomically. Every result deliberately reports `deployable: false` or `executable: false` and
`providerIdentityVerified: false` where applicable. Do not use it as approval to deploy or delete.

The fixed scope is Cloudflare account `00000000000000000000000000000001`, platform
`development`, and zone `0000000000000000000000000000000b` (`omh.st`). The planned
Worker and container application are both `ohmyho-preview-spike-development`; the backup bucket
is `ohmyho-preview-spike-backups-development`. The route is
`*.preview.dev.omh.st/*`, and the DNS name is `*.preview.dev.omh.st`. Registry repository and
digest are deliberately **not** guessed: the exact pair must come from an authenticated
post-creation container/image readback.

## Interface

- `inspectManifest(manifest)` checks the exact local Wrangler configuration shape, including
  account and zone IDs, the Development resource names, bindings, flags, and container policy.
  The version metadata binding must be exactly `CF_VERSION_METADATA`. The optional
  `SPIKE_SOURCE_REVISION` must be a nonzero, 40-character lowercase hexadecimal value. When
  absent, the reported `sourceRevision` is `null`; when present it is only an unverified claim,
  with `sourceRevisionVerified: false`. The checker does not derive or inject a revision, inspect
  the source, or establish the identity of any provider session.
- `inspectInventory(snapshot, now?)` validates a normalized inventory's scope, completeness,
  freshness and collisions for those exact names. An expected-name match is a conflict. A
  `true` completeness field is a caller assertion, not independently established by this tool.
  Different but overlapping Worker routes require a separate provider check.
- `planCleanup({ baseline, receipt, current, creationJournal }, now?)` compares an absent-before
  snapshot, a claimed creation snapshot, a fresh current snapshot and a caller-supplied create
  timeline. It requires matching Worker tag, container ID, route and DNS IDs, DNS configuration,
  and the exact registry repository and digest; the repository must be absent in the baseline.
  The timeline records each local intent, submission and claimed successful provider response
  before the creation snapshot. It is an assertion, not proof of a provider request or ownership:
  every resource is explicitly blocked until independently authenticated create attribution,
  fresh provider readback, review of shared references and supported conditional deletion.
- The R2 bucket always remains `blocked_no_stable_provider_id`. Cloudflare's documented bucket
  properties include a name, creation timestamp, and jurisdiction, but no stable bucket ID;
  a timestamp is useful comparison data, not an ID or an atomic deletion guard. Never infer an
  executable bucket deletion from this plan.

The optional CLI accepts only a fixed subcommand and JSON on standard input:

```sh
node scripts/preview-spike/operator/cli.mjs manifest
node scripts/preview-spike/operator/cli.mjs preflight
node scripts/preview-spike/operator/cli.mjs cleanup-plan
```

Supply a normalized manifest, snapshot, or
`{ baseline, receipt, current, creationJournal }` respectively via standard input. The manifest
input accepts JSONC comments and trailing commas, while inventory and cleanup input use strict
JSON. Manifest parsing uses the repository's pinned TypeScript dependency and rejects duplicate
keys, invalid JSON string and number tokens, and malformed input. TypeScript also tolerates extra
ECMAScript whitespace, including vertical tab, form feed, non-breaking space, and U+2028; the
manifest parser therefore does not guarantee strict JSONC lexical conformance. This tolerance does
not change the manifest's interpreted values or make the operator deployable. The CLI rejects
other arguments, unknown JSON fields and inputs over 8 MiB. It
emits only the result or a fixed error code; it does not read environment variables or credential
stores. **Do not include credentials, tokens, raw provider responses, customer data or secret
values in input, output, command arguments, logs or files.** In particular, normalize DNS collision
records to metadata without TXT values.

## Snapshot contract

The caller must construct the following strictly shaped object from authorized, independently
verified, read-only observations. No such Cloudflare adapter is implemented here. Timestamps
must be UTC ISO strings with milliseconds. A current inventory must be no older than ten minutes
and may be at most 30 seconds in the future.

```text
{
  accountId: fixed account ID,
  environment: "development",
  zoneId: fixed zone ID,
  observedAt: UTC ISO timestamp,
  complete: { workers: true, containers: true, buckets: true,
              routes: true, dns: true, images: true },
  workers:    [{ name, tag }],
  containers: [{ name, id, image: { repository, digest } }],
  buckets:    [{ name, creationDate, jurisdiction }],
  routes:     [{ id, pattern, script }],
  dns:        [{ id, name, type, content, proxied }],
  images:     [{ repository, digest }]
}
```

Each name-specific collection must include **every** matching resource, including DNS records of
any type and HTTP/HTTPS route variants; `images` must include every registry image across all
pages so the later repository can be checked against the baseline. An adapter may omit unrelated
name-specific resources. Records with an unavailable Worker tag, container ID, R2 creation date,
R2 jurisdiction or route script may use `null` for that field. Metadata-only DNS records use
`content: null` and `proxied: false`; actual TXT values must never be included. A creation
receipt needs the non-null identities and full A, AAAA or CNAME record metadata used by the spike.
Unknown, incomplete, ambiguous or mismatched records fail closed.

For cleanup, all snapshots must have the fixed scope, and the current readback must be fresh.
The expected Worker, container, bucket, route, and DNS identities must have been absent in the
baseline and must match exactly between receipt and current observation. Each image repository is
a `registry.cloudflare.com/<fixed-account-id>/<repository>` value, and each image digest is a
`sha256:` digest. The receipt's container image must match an actual image record; its repository
must be absent from the entire baseline image list.

`creationJournal` is strictly shaped as `{ runId, events }`, with a non-secret UUID or
32-character hexadecimal identifier for the run. `events` contains exactly one item per kind:
`worker`, `container`, `bucket`, `route`, `dns`, and `image`. Each item has
`{ kind, intentId, intentAt, startedAt, completedAt, outcome, identity }`. The intent ID is a
non-secret UUID or 32-character hexadecimal identifier; the outcome must be `created`; identity
must match that resource in the creation snapshot exactly. All timestamps use the same UTC ISO
format as snapshots.

The baseline must precede every intent, and every submission must begin within ten minutes after
the baseline. For each event, intent must precede or equal submission, submission must precede or
equal completion, and completion must precede or equal the creation snapshot. The current
snapshot must follow the creation snapshot. The bucket creation timestamp must follow the baseline,
be no earlier than its intent, and be no later than its completed event. Clock precision or skew
may reject real observations; do not weaken these checks to manufacture a plan.

A consistent journal and snapshot are still caller assertions: no verified request transcript,
provider identity or ownership proof is available in this offline module. The result keeps all
resources blocked. A real operator must independently verify original intent, request and response
attribution as well as current identity and provider-side conditional-deletion semantics.

## Local verification

```sh
node --test scripts/preview-spike/operator/operator.test.mjs
```

The test fixtures are synthetic. They are not Cloudflare readback or acceptance evidence.

Cloudflare references: [bucket properties](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/get/),
[image management](https://developers.cloudflare.com/containers/guides/image-management/), and
[API permission groups](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
