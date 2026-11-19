import { LEGAL_DOCUMENTS } from "./legal-documents.js";
import MCP_REFERENCE from "./generated-mcp-tools.json" with { type: "json" };
import { LAUNCH_DOCUMENTS } from "./launch-pages.js";
import { listOhmyhostSkillResources } from "@ohmyhost/agent-skills";
import { CLIENT_RELEASE } from "./generated-client-release.js";
export { CLIENT_RELEASE };
export const RELEASE_PATH = `/releases/${CLIENT_RELEASE}`;
const CLIENT_PACKAGES = [
  "product-cli",
  "mcp",
  "sdk-ts",
  "customer-runtime",
  "customer-auth-better-auth",
];

const skills = listOhmyhostSkillResources();
export const DOCS_ORIGIN = "https://docs.ohmyho.st";
export const MCP_CONFIG = {
  mcpServers: {
    ohmyho: { command: "ohmyhost-mcp", env: { OHMYHOST_ENVIRONMENT: "production" } },
  },
};

const DOC_ALIASES: Readonly<Record<string, string>> = {
  mcp: "agents/mcp",
  "agents/mcp": "agents/mcp",
  nextjs: "frameworks/nextjs",
  vite: "frameworks/vite",
  react: "frameworks/vite",
  tanstack: "frameworks/tanstack",
  postgres: "database",
  credits: "usage",
  "spend-cap": "budgets",
  "dev-and-prod": "environments",
};

export function documentationRedirect(path: string, markdown = false): string | null {
  if (path === "/llms-full.txt") return `${DOCS_ORIGIN}/llms-full.txt`;
  if (path === "/api" || path === "/api.md")
    return `${DOCS_ORIGIN}/api${markdown || path.endsWith(".md") ? ".md" : ""}`;
  if (path === "/docs/index.md") return `${DOCS_ORIGIN}/llms.txt`;
  if (path === "/docs" || path === "/docs/" || path === "/docs.md")
    return `${DOCS_ORIGIN}/${markdown || path.endsWith(".md") ? "index.md" : ""}`;
  if (!path.startsWith("/docs/")) return null;
  const raw = path.slice(6).replace(/\/$/u, "");
  const isMarkdown = markdown || raw.endsWith(".md");
  const slug = raw.endsWith(".md") ? raw.slice(0, -3) : raw;
  // Assign pathname on a fixed URL: a customer path never selects another origin.
  const target = new URL(DOCS_ORIGIN);
  target.pathname = `/${DOC_ALIASES[slug] ?? slug}${isMarkdown ? ".md" : ""}`;
  return target.href;
}

export const DOCUMENTATION: Record<string, string> = {
  ...LAUNCH_DOCUMENTS,
  ...LEGAL_DOCUMENTS,
  "/auth.md": `# Authenticate an ohmyho.st agent

Before continuing an existing app, inspect the execution environment, reachable checkout and saved project binding; reuse a matching local CLI/MCP profile or private token source unless the user explicitly chooses remote access. The availability of remote tools alone does not choose a route; verify the chosen identity and workspace before continuing, and stop on a mismatch.

## Connected chat

For a chat that supports authenticated remote MCP, connect https://app.ohmyho.st/mcp and complete the client's OAuth sign-in. Confirm the intended account with identity_get. The connection has your current user rights across your workspaces and projects, subject to any explicit token restrictions. Existing active connections receive the same access without reconnecting. A new app developed entirely in chat keeps its versions with ohmyho.st; GitHub is needed only when it is the selected source. No copied API token or device-code login is needed for this connection.

The get-started Skill verifies the account and workspace without another connection-approval screen. Publish only when the user requests it and their current role permits it. The portal must be signed in as the same person as the chat connection for GitHub and Native Auth inputs. A plain application secret needs no sign-in: give the person the link that secret_input_request returns. It is valid for one hour and dead after the first save attempt, even if that save fails. Keep values out of chat, source and tool arguments. Verify an authenticated tool call before proceeding.

## Local CLI and MCP

Run ohmyhost login --json, open its sign-in link and confirmation code, then use ohmyhost whoami --json to confirm the selected organization. The local stdio MCP server uses that saved CLI login. Reuse the selected account and the project's current source.

## Private automation

For an automation platform, create a user API token from Profile → API Tokens or the interactive CLI. New tokens do not expire and remain valid until revoked. The full token is shown once; keep it in a private environment file or the automation platform's secret field. Send it as a Bearer token to the API. Never put it in a URL, project notes or a prompt.

Existing tokens keep their original expiry. Browser and CLI login sessions have separate lifetimes. Use an interactive-login process without OHMYHOST_TOKEN for organization or token management; do not delete the saved token file.

[Get started](https://docs.ohmyho.st/quickstart.md) · [Login and tokens](https://docs.ohmyho.st/login-tokens.md) · [MCP](https://docs.ohmyho.st/agents/mcp.md)
`,
  "/login": `# Log in to ohmyho.st

[Continue to login](https://app.ohmyho.st/login). A supported connected chat uses [remote MCP](https://app.ohmyho.st/mcp) and OAuth; a local agent uses the [CLI](https://docs.ohmyho.st/cli) or [stdio MCP server](https://docs.ohmyho.st/agents/mcp).

Ask your agent for project status, usage and changes.
`,
};

/** Instructions for a coding agent that meets ohmyho.st in a repository or a prompt. */
export const PUBLIC_AGENTS = `# AGENTS.md — working with ohmyho.st

ohmyho.st hosts Next.js, Vite/React and TanStack apps, keeps their versions with ohmyho.st or connects a GitHub repository the customer authorizes. Postgres, domains, transactional mail and credits use one organization balance. Operate through authenticated remote MCP, the ohmyhost CLI, local stdio MCP or the REST /v1 API, using the capabilities available in this client.

1. Read https://ohmyho.st/llms.txt, the get-started Skill at https://ohmyho.st/skills/ohmyhost-get-started/SKILL.md and the source-routing Skill at https://ohmyho.st/skills/ohmyhost-deploy/SKILL.md.
2. Inspect the execution environment, reachable checkout and saved project binding; reuse a matching local CLI/MCP profile or private token source unless the user explicitly chooses remote access. The availability of remote tools alone does not choose a route; verify the chosen identity and workspace with identity_get before continuing, and stop on a mismatch. A supported remote chat connects https://app.ohmyho.st/mcp through OAuth. A local agent installs current clients when needed and keeps the sign-in link/code flow from \`ohmyhost login --json\`. Never paste credentials into chat.
3. Reuse the existing project; read project_context_get and source_get before acting. The server's current source binding comes first. Choose a new source from the actual checkout and the customer's preference: a new app developed entirely in chat keeps versions with ohmyho.st; an explicitly selected GitHub repository uses GitHub. For an unbound local checkout without GitHub, ask once whether to keep versions with ohmyho.st or set up GitHub. An explicit choice skips that question. Source choice follows the app across local and cloud agents.
4. Keep the customer's authentication provider, region, data and existing project URLs. Deliver remote-chat secrets through secret_input_request and its private portal link; local agents use the stdin command from secret_set_command. Plan the exact saved commit with deployment_plan, run deployment_create, observe its accepted operation and verify Dev. Publish only when requested and authorized, using the deployment Skill's guarded promotion flow.
5. Discover remote tools from the connected server; read the local catalog at https://ohmyho.st/mcp-tools.json and API errors at https://docs.ohmyho.st/limits.md. Reuse the original operation and idempotency key after uncertainty. Connection, source saving and a successful build each need their own returned proof; report a working address only after app verification.

Pricing and limits: https://ohmyho.st/pricing.md · https://docs.ohmyho.st/limits.md · Report a defect: the feedback_submit tool.
`;

export const AGENT_INDEX = `# ohmyho.st

> Hosting for agents. Develop and save app versions with ohmyho.st or connect the GitHub repository you choose. Preview and publish Next.js, Vite/React and TanStack apps, then manage databases, domains, email, credits and SQL exports through connected chat, CLI, MCP or REST API.

## When to use ohmyho.st

- Develop or update an app using its saved ohmyho.st or authorized GitHub source.
- Resume the same project: authenticate, identify its workspace and read project context and current source before acting.
- Connect a domain or sender, follow DNS/TLS/DKIM readiness, or diagnose a failed deployment.
- Check measured consumption, change a monthly project budget, or request an encrypted SQL export.
- Keep the app's existing authentication provider; enable only the hosting capabilities it needs.

## Get started

- [AGENTS.md](https://ohmyho.st/AGENTS.md): Five rules for a coding agent that operates ohmyho.st.
- [Agent setup playbook](https://ohmyho.st/skills/ohmyhost-get-started/SKILL.md): Connect the available client, verify its account and reuse the customer's workspace.
- [Develop and deploy](https://ohmyho.st/skills/ohmyhost-deploy/SKILL.md): Reuse the saved source or choose managed versions or GitHub once, then verify Dev and publish when requested.
- [Quickstart](https://docs.ohmyho.st/quickstart.md): Select the app's source, deploy one version and verify it.
- [Authentication](https://ohmyho.st/auth.md): Connected-chat OAuth, local CLI sessions and private automation tokens.
- [Account portal](https://app.ohmyho.st/login): Projects, profile, credits and billing after sign-in.

## Connected chat, CLI, MCP and REST

- [Remote product MCP](https://app.ohmyho.st/mcp): For clients that support authenticated remote MCP, complete OAuth. Current membership, role and any token restrictions determine access. Verify actual tool access after connecting.
- [CLI installation and commands](https://docs.ohmyho.st/cli.md): Install the published npm archive and run ohmyhost login.
- [MCP setup](https://docs.ohmyho.st/agents/mcp.md): Connect through the client's supported transport; preserve the local stdio workflow for terminal agents.
- [Local MCP tool reference](https://docs.ohmyho.st/mcp-tools.md): Actual local-client tool names and input schemas; discover remote tools from the connected server.
- [MCP client configuration](https://ohmyho.st/mcp.json): Token-free local server settings to merge into your harness.
- [MCP machine-readable catalog](https://ohmyho.st/mcp-tools.json): Discover the current tools; this is not an authenticated remote endpoint.
- [OpenAPI JSON](https://ohmyho.st/api/openapi.json): Canonical REST /v1 schemas; production API base https://app.ohmyho.st.
- [OpenAPI YAML](https://ohmyho.st/api/openapi.yaml): The same contract in YAML.
- [API errors and limits](https://docs.ohmyho.st/limits.md): Typed errors, authorization and polling.
- [Current release](https://ohmyho.st/client-release.json): Current version and immutable manifest URL.
- [Release manifest](https://ohmyho.st${RELEASE_PATH}/manifest.json): Exact CLI, MCP and SDK archives with integrity hashes.

Connected chats use client-managed OAuth, with no copied platform token. A new app developed entirely in chat starts with managed versions; the existing server binding and an explicit source choice remain authoritative. Private application values go through the portal secret-input link. Local agents retain their CLI login or private automation credential. New user API tokens have no expiry and remain valid until revoked; existing keys retain their recorded expiry. Browser and CLI sessions are separate. Use Bearer authentication for private REST requests. Public discovery and project/user IDs grant no authority. Product access is checked for the current user, organization, project and action. Read the operation's returned polling guidance and reuse mutation idempotency keys after uncertainty.

## Task Skills

- [Skill catalog](https://ohmyho.st/.well-known/agent-skills/index.json): Installable Skills and their descriptions.
${skills
  .filter((skill) => skill.relativePath === "SKILL.md")
  .map((skill) => `- [${skill.skillName}](https://ohmyho.st/skills/${skill.skillName}/SKILL.md)`)
  .join("\n")}

## Documentation by task

- [Documentation index](https://docs.ohmyho.st/llms.txt): All product guides with titles.
- [Full product documentation](https://docs.ohmyho.st/llms-full.txt): Complete published guides and API reference.
- [Selected GitHub sources](https://docs.ohmyho.st/github.md): Repository consent and deployment when GitHub is the app's source.
- [Databases and compute](https://docs.ohmyho.st/database.md): Profiles, Dev/Prod choices and migrations.
- [Domains and mail](https://docs.ohmyho.st/domains.md): Setup and follow-up checks.
- [Usage and budgets](https://docs.ohmyho.st/usage.md): Shared credits, measured costs and project limits.
- [Billing](https://docs.ohmyho.st/billing.md): Plan access, monthly and non-expiring credits, Stripe when enabled.
- [SQL exports](https://docs.ohmyho.st/backups.md): Asynchronous password-encrypted ZIP exports and downloads.
- [Troubleshooting](https://docs.ohmyho.st/troubleshooting.md): Actionable errors and customer-agent feedback.

## Pricing and comparisons

- [Pricing](https://ohmyho.st/pricing.md): Free 200 credits a month; Paid $10 for 1,000 monthly credits; one balance for every project.
- [Cost breakdown](https://ohmyho.st/pricing/breakdown.md): Every published rate, worked workloads in credits and the same workloads as separate subscriptions.
- [ohmyho.st vs Vercel](https://ohmyho.st/vs/vercel.md): Dated list prices, the same small app priced both ways, where Vercel is the better choice.
- [ohmyho.st vs Supabase](https://ohmyho.st/vs/supabase.md): Postgres compute and storage by usage against Supabase Pro and per-project compute.
- [ohmyho.st vs Resend](https://ohmyho.st/vs/resend.md): Mail per recipient plus a sender zone against Resend plans; break-even by volume.
- [ohmyho.st vs Railway](https://ohmyho.st/vs/railway.md): Requests, CPU time and database credits against per-second vCPU, memory and volumes.

## Deploy from your agent

- [Claude Code](https://ohmyho.st/for/claude-code.md): One prompt, the MCP tool sequence, what Claude Code asks, Dev and Prod, costs.
- [Cursor](https://ohmyho.st/for/cursor.md): Cursor MCP settings and the same deployment path.
- [Codex](https://ohmyho.st/for/codex.md): Codex MCP registration, tokens and budgets for agents that run unattended.
- [From Lovable](https://ohmyho.st/from/lovable.md): Export to GitHub, what breaks by hand, keep or migrate Supabase, verify the login.
- [From Bolt](https://ohmyho.st/from/bolt.md): Export from Bolt.new and deploy with secrets, callback URLs and a domain.
- [From Replit](https://ohmyho.st/from/replit.md): Move a Replit app to Dev and Prod hosting with Postgres.
- [From Vercel and Supabase](https://ohmyho.st/from/vercel-supabase.md): Two bills become one balance; keep Supabase or import a dump.

## Company and legal

- [About](https://ohmyho.st/about.md): Amerged B.V., Venray, Netherlands; founder ohmyho.st team; how the service runs.
- [Philosophy](https://ohmyho.st/philosophy.md): Buy in bulk, add a small margin, one balance for every project, take your database and go.
- [Open source](https://ohmyho.st/open-source.md): The MIT-licensed docs, the public Skills, llms.txt, MCP catalog and OpenAPI contract; the platform is private.
- [Blog](https://ohmyho.st/blog.md): Notes from the build with dated, priced comparisons and migration guides.
- [Brand](https://ohmyho.st/brand.md)
- [Privacy](https://ohmyho.st/privacy.md)
- [DPA](https://ohmyho.st/dpa.md)
- [Contact](https://ohmyho.st/contact)
`;

export function customerDocument(path: string): { text: string; type: string } | null {
  if (path === "/mcp.json") return { text: JSON.stringify(MCP_CONFIG), type: "application/json" };
  if (path === "/client-release.json")
    return {
      text: JSON.stringify({
        version: CLIENT_RELEASE,
        manifest_url: `https://ohmyho.st${RELEASE_PATH}/manifest.json`,
      }),
      type: "application/json",
    };
  if (path === "/mcp-tools.json")
    return { text: JSON.stringify(MCP_REFERENCE), type: "application/json" };
  if (path === "/.well-known/agent-skills/index.json") path = "/.well-known/skills/index.json";
  if (path === "/llms.txt") return { text: AGENT_INDEX, type: "text/plain; charset=utf-8" };
  if (path === "/AGENTS.md") return { text: PUBLIC_AGENTS, type: "text/markdown; charset=utf-8" };
  const documentPath = path === "/auth.md" ? path : path.endsWith(".md") ? path.slice(0, -3) : path;
  const markdown = DOCUMENTATION[documentPath];
  if (markdown && path.endsWith(".md"))
    return {
      text: markdown.replaceAll(/<svg[\s\S]*?<\/svg>/gu, ""),
      type: "text/markdown; charset=utf-8",
    };
  if (path === "/.well-known/skills/index.json")
    return {
      text: JSON.stringify({
        skills: skills
          .filter((skill) => skill.relativePath === "SKILL.md")
          .map((skill) => ({
            name: skill.skillName,
            description: skill.description,
            url: `https://ohmyho.st/skills/${skill.skillName}/SKILL.md`,
          })),
      }),
      type: "application/json",
    };
  const skill = skills.find((item) => path === `/skills/${item.skillName}/${item.relativePath}`);
  return skill ? { text: skill.text, type: "text/markdown; charset=utf-8" } : null;
}

export function isClientDownload(path: string): boolean {
  const parts = path.split("/");
  const version = parts[2] ?? "";
  const file = parts[3] ?? "";
  // Early releases have no backwards-support window: serve the current version only.
  if (
    parts.length !== 4 ||
    parts[0] !== "" ||
    parts[1] !== "releases" ||
    version !== CLIENT_RELEASE
  )
    return false;
  return (
    ["manifest.json", "SHA256SUMS", "openapi.json", "mcp-tools.json"].includes(file) ||
    CLIENT_PACKAGES.some((name) => file === `ohmyhost-${name}-${version}.tgz`)
  );
}
