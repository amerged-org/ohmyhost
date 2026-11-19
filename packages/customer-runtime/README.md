# `@ohmyhost/customer-runtime`

Web-Standard clients for application code using ohmyhost database, transactional mail and
private files, with separate browser and server entrypoints for Native Auth. Gateway clients accept only project-scoped runtime capability keys. The package never accepts or
returns AWS, Cloudflare, PGCF, R2, SES, or other provider-management credentials.

## Install

Install the published runtime under its import name as an exact npm alias pinned to the client
version you run:

```json
{
  "dependencies": {
    "@ohmyhost/customer-runtime": "npm:@amerged/ohmyhost-runtime@<version>"
  }
}
```

Imports such as `@ohmyhost/customer-runtime/storage` stay unchanged. `ohmyhost init --dry-run --json`
reports that exact alias under `runtime.packages.customerRuntime`, `companion.packages.customerRuntime` or `worker.packages` whenever
the application declares a database, files, mail or Native Auth. Refresh the lockfile with the project's package
manager, commit it and install from it frozen. A bare `@ohmyhost/customer-runtime` version cannot be
resolved and fails the platform build; replace any older `https://ohmyho.st/releases/…` runtime URL
with the alias.

Database access uses the private `OHMYHOST_DATABASE` service binding. Customer code receives only
the provider-neutral `query`, `transaction` and `withConnection(callback)` methods. Database
credentials remain in the regional platform database service.

```ts
const database = createPrivateDatabaseClient(env.OHMYHOST_DATABASE);
const result = await database.query({
  text: "select id from booking where id=$1",
  values: [bookingId],
});
```

SQL `DATE` values, also inside a `date[]`, are returned as `YYYY-MM-DD` strings without timezone conversion; PostgreSQL timestamps retain their timestamp type. Keep transaction work inside `withConnection`, and release the connection before external mail, storage or AI requests.

The optional `database-kysely` entrypoint supports Kysely `^0.29.5`. The repository baseline stays
at `0.29.5`; the packaged adapter's strict consumer types, compiler and transaction behavior are
also checked at `0.29.8`. Other minor lines are outside this contract.

A missing binding throws `database_binding_missing`. The client refuses `PREPARE` outside
`withConnection`, a chained `COMMIT` or `ROLLBACK ... [NO] CHAIN` inside it, and a JSON parameter
over 64 KiB before sending, with `database_query_invalid` and `retryable: false`. More than 1,000
result rows or 1 MiB, and the 101st statement of a `withConnection`, throw `CustomerDatabaseError`
with code `54000` and `retryable: false`; do not repeat the statement, page with `LIMIT`, split the
write or open a new `withConnection`. A `withConnection` idle for 5 s or open for 30 s is closed,
rolls back what it had not committed and answers `database_unavailable`; open a new
`withConnection` instead of retrying on the closed one.

A write whose `RETURNING` rows, or a `WITH` statement whose rows, exceed a limit is rolled back
when it runs through `query()`, `transaction()` or as an autocommit statement inside
`withConnection`. Inside your own `BEGIN`, a `54000` result limit leaves the statement's effects in
the open transaction, so send `ROLLBACK` (or let `withConnection` end without `COMMIT`).

## Cloudflare Worker or TanStack Start

Mail and storage gateway URLs are origins constructed by the client and intercepted by the
platform egress policy. Pass `(request) => fetch(request)` for the gateway transport; the egress
Worker forwards only supported routes over its own private bindings. Customer gateway service
bindings are unsupported under this policy. Files receive `OHMYHOST_STORAGE_GATEWAY_URL`,
`OHMYHOST_STORAGE_KEY`, `OHMYHOST_PROJECT_ID` and `OHMYHOST_ENVIRONMENT_ID`; the legacy binding may
remain attached until it is removed by a later platform release. Use global `fetch` for
`capabilityFetch` too, which transfers bytes using the short-lived signed R2 URL. Both explicit
transport options remain available for tests. Gateway clients run only on the server; resolve
configuration from the hosted Worker request context.

```ts
const storage = createPrivateStorageClient({
  endpoint: env.OHMYHOST_STORAGE_GATEWAY_URL,
  fetch: (request) => fetch(request),
  capabilityFetch: (request) => fetch(request),
  projectId: env.OHMYHOST_PROJECT_ID,
  environmentId: env.OHMYHOST_ENVIRONMENT_ID,
  key: env.OHMYHOST_STORAGE_KEY,
});

// Store: reserve the object, PUT the bytes to the signed URL, then complete the transfer.
await storage.upload({
  idempotencyKey,
  objectKey: `clips/${clipId}.mp4`,
  contentType: "video/mp4",
  bytes,
});

// Serve: hand out a short-lived signed read instead of proxying the object.
const capability = await storage.createSignedRead(`clips/${clipId}.mp4`);
return Response.redirect(capability.url, 302);
```

`upload` performs reserve, signed PUT and complete in one call; use `reserveUpload`,
`completeUpload` and `deleteObject` when the application drives those steps itself. Repeat a
failed `upload` with the same `idempotencyKey` and `objectKey`: bytes an earlier attempt stored
are recorded instead of uploaded again. `storage_upload_rejected` is retryable for a 5xx or 429
answer from the signed URL.

`readMany` streams 1–4,000 distinct keys with at most 4 MiB of control data; consume or cancel
each found body before advancing and finish the iterator to validate exact EOF. `deleteMany`
returns durable per-file completed, pending or failed outcomes. Completion verifies payload
erasure and releases quota; expired links or old absence receipts alone do not establish it.
Keep every original idempotency key when replaying unfinished work. Its configured timeout
covers both response headers and complete JSON, so a timeout may leave durable partial progress.

Mail uses the same server-only pattern with `createTransactionalMailClient`,
`OHMYHOST_MAIL_GATEWAY_URL`, `OHMYHOST_MAIL_KEY` and `OHMYHOST_PROJECT_ID`. Supply
`fetch: (request) => fetch(request)`; resolve its values from the hosted request context.
`timeoutMilliseconds` defaults to 10000 ms and accepts integer values from 100 to 30000 ms.
`gateway_not_enabled` and `gateway_route_denied` are final 403 errors: enable the required
capability and redeploy, or use the supported routes of the current runtime client.
`gateway_rate_limited` (429), `gateway_unavailable` (503) and a storage 502 transfer rejection (`gateway_unavailable`) are retryable; wait and retain the
original idempotency keys. A malformed or non-JSON gateway response is `gateway_response_invalid`
with the received HTTP status and no raw response text.

Inbound attachments use `createMailAttachmentClient` with the same mail endpoint/key and global
`fetch`. Pass the canonical `download_path` from received-mail metadata; the client validates its
project and sends the fixed read-only `POST /v1/attachments/download`, never a caller-selected URL.
Set `environmentId` when the application has an expected `OHMYHOST_ENVIRONMENT_ID`; otherwise the
metadata path supplies it and the server checks it against the receiving key's environment.

```ts
const attachments = createMailAttachmentClient({
  endpoint: env.OHMYHOST_MAIL_GATEWAY_URL,
  key: env.OHMYHOST_MAIL_KEY,
  projectId: env.OHMYHOST_PROJECT_ID,
  fetch: (request) => fetch(request),
});
const body = await attachments.download(downloadPath, { signal: request.signal });
return new Response(body, { headers: { "content-type": "application/octet-stream" } });
```

`download` returns a `ReadableStream<Uint8Array>` without buffering the attachment. Consume it to
EOF for success, or cancel it when its bytes are no longer needed. Cancellation and the optional
signal abort the upstream transfer. The gateway preserves the 72-hour access window, 50 MiB limit
and 15-second transfer deadline, and rechecks ownership during streaming. HTTP 200 only starts the
stream: an expiry, revocation, size mismatch or deadline after headers fails the body instead of
replacing the status. The configured timeout covers headers and error JSON; it does not extend
the gateway's transfer deadline. Preheader expired content is `mail_content_expired` (410), a
missing message/attachment is `mail_message_not_found` (404), and an excessive size is
`mail_attachment_too_large` (413).

Replay an uncertain send only with the same message and idempotency key. A send that needs payment
throws the gateway's own code, never retryable: `paid_plan_required`,
`insufficient_organization_credits` or `project_budget_exceeded`. `to` and `replyTo` follow the
provider's address rule, so an apostrophe, a trailing underscore and mixed case are accepted. The
sender must use the project's mail domain exactly as configured, with a local part of letters,
digits and `._%+-`; any other sender throws `gateway_request_invalid` with status 400.

## Next.js and Vite

Next.js route handlers instantiate the gateway clients from server runtime configuration. A Vite browser
application uses an authenticated same-origin server companion which owns these gateway clients. Never
import or construct gateway clients in browser components, and never return gateway keys in responses.

## Native Auth source candidate

These entrypoints are implemented in source and are awaiting hosted qualification and release.
Application-owned forms use `createNativeAuthBrowser` from
`@ohmyhost/customer-runtime/auth-browser` in the browser. It sends same-origin requests to
`/api/auth/v1`; it requires no provider secret or application database. Keep an operation's
idempotency key when deliberately retrying an uncertain signup, verification, invitation or
recovery request.

Server handlers use `createNativeAuthServer(env.OHMYHOST_AUTH)` from
`@ohmyhost/customer-runtime/auth-server`. `getSession(request)` reads the live Native session;
`requireUser(request)` requires one. The application still authorizes access to its own resources.

The password-first launch candidate requires a current Owner, a Paid project, the customer's own
verified sender authorized for the project, and an approved application origin and form paths.
The application identity must be verified for the same registrable main domain as the sender.
Check Paid, sender and origin prerequisites before the first Native-capable deployment; that
deployment provisions Auth storage, so storage readiness can be false before it. Configure each
logical environment separately and verify readiness after provisioning. OAuth activation
is limited to projects on the Native Auth launch allowlist. A project Owner supplies their own
Google or GitHub OAuth application credentials and registers the exact callback for the environment. Existing
customer-owned providers retain their own SDK and lifecycle. These requirements describe the source
candidate, not hosted availability.

## Scheduled Worker handlers

Declared `functions.crons` invoke the `scheduled(controller, env, ctx)` export of the Worker
module with the same bindings as `fetch`. Construct these clients from `env` inside that handler;
the platform adds no separate scheduled context.

Usage guides: [Database](https://docs.ohmyho.st/database), [Files](https://docs.ohmyho.st/files) and [Email](https://docs.ohmyho.st/email).
