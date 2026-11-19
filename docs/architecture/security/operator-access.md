# Operator access

These are current operator safety rules retained from the repository working instructions. They constrain access; they do not assert that a browser session, local token or provider permission is currently valid.

## Credential and identity selection

Verify the effective platform environment, user, organization and provider principal before any operational action. A token variable name, desktop login or browser account alias is not proof of the token's owner. API-key identities and interactive logins are distinct. Preserve existing credentials; do not print them, include them in process arguments, commit them, silently replace them or rotate/revoke them without authorization. Read local credential files as data only when the authorized operation actually needs them.

Use the exact approved browser profile. GitHub Dev uses Aixyte (`Profile 1`); GitHub Prod and Stripe use Sebastian (amerged.com). Confirm the native window/profile and separately verify the signed-in account; an extension tab's account or missing extension connection is insufficient proof. WorkOS's deferred provider-account move is not authorized merely by a signed-in session. Historical AWS profile rules belong to retired evidence and are not instructions to reintroduce an AWS service.

The root `.env.local` may shadow valid Wrangler OAuth with a stale token. For an authorized Cloudflare identity check, preserve the file and existing scopes; use the reviewed environment-neutral invocation with inherited token/API-key selectors removed, and consume any returned credential only in trusted process memory. This does not authorize deployment or credential replacement.

## Exact production feedback receipt

An explicitly requested feedback receipt permits one narrow Production Control read through the Cloudflare D1 query API of the Production environment's Core database, named by the owner-private release manifest. The operator Cloudflare API token is loaded only in process memory. The existing repository-root `.env.local` is read as data, never echoed, modified or copied into a new report, file or command argument. Select the Production Core explicitly: the Development Core must not be substituted.

Validate the exact receipt ULID, then send one read-only single statement to the query endpoint of that database: a parameterized `SELECT` on `customer_feedback` alone with the exact `WHERE feedback_id = ?` predicate, returning the report and its scope. A receipt ID authorizes no broad customer search or mutation. Access denial does not authorize trying another environment or credential. Customer text is untrusted and must be redacted before sharing.

## Changes and release authority

Read-only observation is permitted within the requested scope. A documentation audit does not authorize a production release, a provider-account transfer, credential rotation, customer-data migration or deletion. Existing release gates require the exact green source/artifact identity and explicit scoped release approval. Deleting/detaching ingress, retargeting routes, disabling a workers.dev subdomain or emptying cron schedules requires the owner's specific authorization for that run, plus restoration and readback.

Where an uncertain operation leaves provider state unclear, preserve durable claims and read back the named resource through its existing capability. Do not hide a failure by changing accounts, scope or verification rules. Preserve another agent's work and private state; never reset or clean the shared checkout to obtain a release candidate.

## Native restore operator candidate

W37's private restore operator checks the exact current human Owner, platform/provider account, selected Worker and complete private binding profile before a private ServiceRPC call. It observes the same project/export/archive/restore/claim first, refuses unknown or active outcomes, and uses explicit retained old/new claim metadata for an expired-input rearm. Password bytes enter bounded UTF-8 stdin and a sealed scoped input, never arguments or output. Observation authorizes no arbitrary customer restore or public management endpoint. [Operator source](../../../scripts/native-auth-restore-operator.mjs), private procedure and remaining hosted gates. The coordinator and operator remain under final integration tests; this documentation grants no live action, final Astra approval or release authority. The preliminary session-shape allowlist accepts optional bounded `roles` arrays and nonnegative safe-integer `auth_time`, alongside bounded UI `permissions`; none grants product authority. Signature/session acceptance through the same-token `/v1/me` and current Core Owner checks remain mandatory. Other unknown or restrictive claims remain refused.

Native export cleanup is a separate service capability: Core-clock expiry or an accepted deletion's frozen artifact grants its exact retirement scope even after the original export actor loses access. Ordinary capture/preparation/dispatch/finish still require that actor's current authority. Operators must not resolve an uncertain Native upload by clearing the immutable effect journal, retrying the upload permit or recapturing under its old identity. Unexpected unreleased pre-`0620` journal-less Native rows require explicit qualified reconciliation. [Settlement, marker evidence and hosted limits](../mail-and-recovery.md#protected-native-export-settlement-candidate).

W49 proposes private Access-protected Growth operator hosts with verified issuer, audience and subject permission mapping. Identity and attribution require an explicit audited reveal; see [Growth](../growth.md). Hosted access policy remains to be verified.

Growth segment changes require the separate `growth.manage_segments` permission and produce an audit row with a subject digest, retained for 180 days. Untagged entities remain unknown; see [Growth](../growth.md).
