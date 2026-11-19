# Changelog

## November 16, 2026 (0.1.59)

The AI gateway's realtime voice route is accepted on Development and Production: a hosted application opened a session through `/realtime`, received the model's audio and transcript events, and closed cleanly; the recorded cost was charged at the AI rate. A session ends after five minutes at most, and the provider's keepalive events keep an idle session open until then, so close it from your server when the conversation is over. The Skills for building a portable app say so now, and CLI and MCP 0.1.59 carry the corrected Skill text. No command, tool or API changed. See the [AI guide](https://docs.ohmyho.st/ai).

## Upcoming — 0.1.57

The prepared CLI and MCP clients add explicit Prod-only project creation, adding Dev later, custom domains in project status, and generation-based database webhook subscription actions. Activation saves the signing secret to a new private local file; local MCP reads optional receiver headers from a private file. Migration failures retain validated SQLSTATE and statement position without exposing SQL. Browser PDF and opt-in Next.js path revalidation require the coordinated platform release and verified hosted readiness before use.

## Upcoming — 0.1.47

Paid workspaces can declare `ai.enabled` and an explicit `eu` or `any` jurisdiction in `ohmyhost.yaml`. The platform injects an OpenAI-compatible AI gateway URL and a project key for chat, responses, images, speech, transcription, classifiers and OCR, using models served by orq.ai. Calls use the workspace's prepaid credit and project budget. Realtime voice runs through a server-side WebSocket route. See the [AI guide](https://docs.ohmyho.st/ai) when this release goes live.

## November 14, 2026 (0.1.56)

CLI and MCP 0.1.56 add `ohmyhost github disconnect`, `ohmyhost organization mcp-connections list` and `revoke`, `ohmyhost mail webhook rotate` and the matching MCP tools. A workspace Owner can rotate an installed AI, mail, storage or auth key in place with `POST .../secrets/{secret_name}/rotate`; the old key stops authorizing at once for AI, mail and storage, and the new value reaches the running app at its next delivery. A Paid custom hostname is proven with its own `_omh-project` TXT record, shown by `ohmyhost domain paid status`, which no longer interferes with mail setup.

## November 14, 2026

CLI and MCP 0.1.55 add `ohmyhost export download-link` and the MCP tool `project_export_download_link_create`: reading an export reports its progress and never a download address, so you request a signed 24-hour link for a finished export separately. Custom hostnames on Paid projects now need the verified `_omh-project` TXT proof before they are served, and a workspace owner can list and revoke connected MCP clients and disconnect GitHub through the API. Several operations accept an `Idempotency-Key` so that a retried request returns the original result.

## November 13, 2026

CLI and MCP 0.1.54 update the Skills they bundle for private application secrets in a connected chat. A `secret_input_request` link needs no sign-in, names the secret, can generate a random value and expires after one hour; its first save uses it up, even when the write fails. The Skills now tell an agent to confirm the name with `secrets_list` before it relies on `secret_submitted`, to ask for a fresh link when one expired, and to send a value of several lines, such as a PEM key, through the local stdin command instead. The command and tool lists and the API are unchanged.

## November 1, 2026

CLI and MCP 0.1.45 add database table watches: `ohmyhost database watch create` sends a signed webhook event for each insert, update and delete on the columns you choose, with matching MCP tools. `ohmyhost operation get` and every `--wait` find existing deployment, source and project operations again, a project handle change now ends as succeeded, and a fault that stopped deployments before the build started is fixed. Customer database dumps leave out the platform event schema, and a user token can be created again under the same idempotency key after a rejection. The Claude plugin, the documentation and the website show the same release.

## October 31, 2026

CLI and MCP 0.1.42 add database webhooks, schedules and execution counters: `ohmyhost database webhook`, `database schedule` and `database executions` manage signed webhooks for database state changes and scheduled SQL, with the matching MCP tools.

CLI and MCP 0.1.43 make `ohmyhost credits balance` return the organization balance only; consumption moves to `ohmyhost credits usage`, which covers the last 14 days.

CLI, MCP and SDK 0.1.44 count executions without a separate price, because the cost of a run is the time the database is awake, and a project that reaches its Stop budget has its schedules turned off.

## October 30, 2026

CLI and MCP 0.1.41 introduce one credit account per organization that all of its projects share. Top-up, auto-recharge, bonus and referral credits do not expire, monthly credits still end with their period, and the usage report covers the last 14 days. Customer PostgreSQL databases run on the PostgreSQL platform PGCF, and the previous database provider is retired.

## October 28, 2026

Native `psql` access needs CLI 0.1.39 or later, and the get-started Skill now installs CLI and MCP 0.1.40.

## October 23, 2026

Customer Workers can use the mail and storage gateway bindings again; under the outbound egress policy they had answered with an error. Next.js apps must now use version 16.4.1 or later: Next.js 15 and 16.0.0 through 16.4.0 are refused at deployment with the required change named.

## October 17, 2026

CLI and MCP 0.1.35 deploy Astro sites, both static sites and sites with server rendering.

## October 16, 2026

CLI, MCP and API 0.1.34 return the current account email and the names and IDs of its organizations, for example in `ohmyhost whoami` and the identity tool.

## October 10, 2026

CLI and MCP 0.1.32 deploy framework versions above the published security floors, and a refusal names the file, the version and the change needed. CLI and MCP 0.1.33 deploy Next.js 16.4 apps, including apps that use Cache Components, and finish deleting projects that use managed Git. Cache Components apps that use on-demand or time-based revalidation are refused at deployment with a fixed message.

## October 9, 2026

CLI and MCP 0.1.30 add opt-in row-level security per table for customer databases; existing databases are not converted automatically. CLI and MCP 0.1.31 make onboarding prefer the project access that matches the application.

## September 29, 2026

CLI and MCP 0.1.26 complete the secure handling of browser policy, and the Production release followed on the same day.

## September 28, 2026

CLI and MCP 0.1.24 add hosting, data changes and bulk file handling, and 0.1.25 publishes hosting and recovery corrections on the same day.

## September 16, 2026

Signup is open to everyone: there is no invitation, waitlist or access code. Every visitor gets the agent prompt and the login link, and a link's r value is kept only as signup attribution that may carry its configured promotional credit.

## September 13, 2026

The website then distinguished invited signup from registering interest. Task Skills cover initial connection, GitHub deployment, database sizing, DNS and email, usage and budgets, troubleshooting and encrypted SQL export.

Public CLI/MCP releases provide project context, operation diagnostics, usage reports and user-owned deployment tokens. See the current [release manifest](https://docs.ohmyho.st/cli) for the exact published version.

[Documentation](https://docs.ohmyho.st/) · [Skills](https://docs.ohmyho.st/skills) · [Introduction](/blog/introducing-ohmyho-st)
