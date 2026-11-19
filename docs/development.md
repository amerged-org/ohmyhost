# Development rules

Use the Node and pnpm versions in the repository. Install dependencies with
`pnpm install --frozen-lockfile`. See [architecture](architecture/index.md)
for the source map and [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution
and review expectations.

## Shared checkout and Git

Use a branch for the change and preserve other work in the checkout. The
verification workflow runs on GitHub-hosted runners, with read-only tokens
for contributor code. Release jobs use a trusted deployment context with
installation-specific configuration.

## Scope, authorization and credentials

Provide provider credentials through the installation's secret store.
Use synthetic fixtures for customer records and test credentials. Worker
configuration templates describe binding shapes and logical service roles.
Supply actual account bindings and resource identifiers at deployment time.

For signup feedback, provide `SIGNUP_FEEDBACK_REPLY_TO` and
`SIGNUP_FEEDBACK_SENDER_NAME` in the installation. Optionally configure
`SIGNUP_FEEDBACK_PROFILE_URL` with an HTTPS profile link. The mail Worker
uses this configuration before claiming campaign records.

Configure `RECOVERY_R2_ACCOUNT_ID` with the archive-signing account in the
installation whenever the SQL export service is enabled. The API verifies
returned archive URLs against this account.

## Superpowers workflow

For significant work, start with a reproducible failure or acceptance case.
Implement the change together with the affected tests and the smallest
documentation update that preserves the current contract.

## Implementation and verification

Run the focused tests for the change. Run `pnpm verify:fast` before handing
off the source. On a new Git root it checks the complete tree. The CI run for
the exact commit includes the build, contract and SDK drift checks, test
shards, coverage and the secret scan.

The public documentation check validates the current source inventory,
architecture decisions, Markdown links and Mermaid source and coverage.
Archived operational documents remain with the historical release records.

## Release and documentation

Trace every production release to its repository and full commit. Build and
verify the selected source in Development before promoting it to Production.
Keep customer documentation aligned with release evidence and preserve
historical receipt provenance.

## API and plugin contract synchronization

Generate the SDK and tool metadata from the REST/OpenAPI contract. Update
affected CLI and MCP behavior, Skills and customer docs together. Verify the
local and remote MCP tool descriptors and the actual OpenAI and Claude
package surfaces through their respective release paths.

## Search-engine notification (IndexNow)

Send indexing notifications from the website release process for updated
public URLs. Keep indexing configuration with the deployed website.
