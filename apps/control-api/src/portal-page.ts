import type {
  AccountProfile,
  OrganizationAccount,
  Project,
  ProjectStatus,
  ProjectCreditBudget,
  PoweredByFlag,
  UserApiKeyCreation,
  UserApiKeyPage,
} from "@ohmyhost/sdk-ts";
import { copyButton, renderStandalonePage } from "./standalone-page.js";
import { renderWebsiteLogo, WEBSITE_HEADER_CSS } from "./website-brand.js";
import { signupUtm } from "./signup-utm.js";
import {
  PORTAL_CSS,
  PORTAL_SVG,
  PORTAL_SCRIPT,
  PORTAL_SCRIPT_HASH,
  PORTAL_CLIENT_RELEASE,
} from "./generated-portal-assets.js";
export type PortalView = "connect" | "billing" | "usage" | "profile" | "tokens";
/**
 * Where the GitHub callback sends the customer's browser. Each outcome is its own path, so the
 * address bar keeps neither the OAuth code nor the state, and the page can say what to do next.
 */
export const GITHUB_AUTHORIZED_PATH = "/github/authorized";
export const GITHUB_AUTHORIZATION_PENDING_PATH = "/github/authorization-pending";
export const GITHUB_AUTHORIZATION_FAILED_PATH = "/github/authorization-failed";

export const PORTAL_PATHS = [
  "/",
  GITHUB_AUTHORIZED_PATH,
  GITHUB_AUTHORIZATION_PENDING_PATH,
  GITHUB_AUTHORIZATION_FAILED_PATH,
  "/index.md",
  "/login",
  "/login.md",
  "/login/start",
  "/login/callback",
  "/billing",
  "/billing.md",
  "/usage",
  "/usage.md",
  "/profile",
  "/profile.md",
  "/logout",
  "/workspace",
  "/budget",
  "/flag",
  "/dev-access",
  "/billing/stripe",
  "/billing/recharge",
  "/tokens",
  "/tokens.md",
  "/tokens/revoke",
];
const referralIcons =
  '<svg class="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg><svg class="check-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
type HostingRegionHint = "eu" | "us" | null;
function browserRegionHint(request: Request): HostingRegionHint {
  // Only a browser navigation supplies this advisory context. API/device-flow requests may
  // originate from an agent's server, so their address must never choose a customer's region.
  if (
    request.headers.get("sec-fetch-mode") !== "navigate" ||
    request.headers.get("sec-fetch-dest") !== "document"
  )
    return null;
  const cf = (request as Request & { cf?: { country?: unknown; continent?: unknown } }).cf;
  if (typeof cf?.country !== "string" || !/^[A-Z]{2}$/u.test(cf.country) || cf.country === "XX")
    return null;
  if (cf.country === "CY" || cf.continent === "EU") return "eu";
  return typeof cf.continent === "string" && /^(AF|AN|AS|NA|OC|SA)$/u.test(cf.continent)
    ? "us"
    : null;
}
export function portalPrompt(
  source = "",
  development = false,
  region: HostingRegionHint = null,
  account: PromptAccount | null = null,
): string {
  return (
    "Read https://ohmyho.st/llms.txt and https://ohmyho.st/skills/ohmyhost-get-started/SKILL.md. Connect this agent to ohmyho.st and help build and deploy my application using only the capabilities it needs. Keep the project's saved source choice unless I request a source change. For an unbound workspace without GitHub, offer direct deployment with ohmyho.st versioning or GitHub setup once. In a new chat without a workspace, start with ohmyho.st versioning. " +
    (source ? `I came from https://ohmyho.st/?r=${encodeURIComponent(source)}. ` : "") +
    (development ? "Use the development platform. " : "") +
    (account === null
      ? "After signing in, use the user and organization that identity_get over remote MCP or whoami over the CLI or local MCP reports; never guess an account, organization or project ID. "
      : `${accountContext(account, development)} `) +
    (region
      ? `For a new project, use ${region.toUpperCase()} based on this browser's region unless I specify another region. `
      : "For a new project, ask me once whether to use EU or US unless I already specified a region. ") +
    "Keep existing projects in their current region. " +
    "Follow the deployment Skill, keep my existing project decisions and verify the app."
  );
}

/** The signed-in account a copied prompt names. Identifiers are context, never credentials. */
export interface PromptAccount {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
}

/**
 * Tells the agent which saved login to act as, so an agent on a computer with several accounts
 * neither guesses nor uses whichever login happens to be saved there.
 */
function accountContext(account: PromptAccount, development: boolean): string {
  const cli = `${development ? "OHMYHOST_ENVIRONMENT=development " : ""}ohmyhost`;
  if (account.organizationId === null)
    return `Use my ohmyho.st account user ${account.userId}; it has no organization yet. These IDs are context, not credentials. With remote MCP, confirm this account with identity_get and use workspace_setup to finish workspace setup, then call identity_get again before project work. With the CLI or local MCP, confirm with ${cli} whoami --json that this is the user before creating anything.`;
  // Earlier clients ignore profile_name, so the prompt names the release that honours it.
  return `Use my ohmyho.st account user ${account.userId} in organization ${JSON.stringify(account.organizationName ?? account.organizationId)} (${account.organizationId}). These IDs are context, not credentials. With remote MCP, confirm this account with identity_get and check current workspace membership and role for the requested action. With the CLI or local MCP, reuse my saved login. Choosing the login needs ohmyhost ${PORTAL_CLIENT_RELEASE} or newer; if ${cli} --version is older or the local MCP server has no profile_list tool, update both first. Then run ${cli} profile list --json and act only as the saved login with this user and organization (pass its name with --profile-name, or profile_name over local MCP); if none exists, run ${cli} login --organization ${account.organizationId} --user ${account.userId} --json. Confirm with whoami before any change.`;
}

/** A project card's prompt: the account and the project, then the customer's own question. */
export function projectPrompt(
  account: PromptAccount & { readonly organizationId: string },
  project: { readonly id: string; readonly name: string },
  development = false,
): string {
  return `Read https://ohmyho.st/llms.txt. ${accountContext(account, development)} Then read project context for project ${JSON.stringify(project.name)} (${project.id}) before answering my question or making changes. My question: `;
}
export interface PortalPage {
  profile?: AccountProfile;
  account?: OrganizationAccount | null;
  accountDenied?: boolean;
  csrf?: string;
  organizationId?: string | null;
  /** The selected workspace's referral link for the account menu's copy chip. */
  referralUrl?: string | null;
  projects?: Array<{
    project: Project;
    status: ProjectStatus;
    budget: ProjectCreditBudget | null;
    flag: PoweredByFlag | null;
  }>;
  nextCursor?: string | null;
  request: Request;
  origin: string;
  status?: number;
  title?: string;
  message?: string;
  /** Render title and message alone, without the onboarding card or a sign-in form. */
  notice?: boolean;
  source?: string;
  view?: PortalView;
  login?: boolean;
  resumeId?: string;
  billingEnabled?: boolean;
  recharge?: import("@ohmyhost/sdk-ts").BillingRecharge | null;
  userKeys?: UserApiKeyPage;
  createdKey?: UserApiKeyCreation;
  tokenDraft?: { name: string; requestKey: string };
  signedIn?: boolean;
  organization?: string;
}
/** The HSTS value every human-facing response of the control API carries, the same as its JSON answers. */
export const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains; preload";

export function renderPortalPage(options: PortalPage): Response {
  if (options.signedIn && options.profile) return renderAccountPortal(options, options.profile);
  const {
    request,
    origin,
    source = "",
    view = "connect",
    login = false,
    signedIn = false,
  } = options;
  const development = origin !== "https://app.ohmyho.st";
  const prompt = portalPrompt(source, development, browserRegionHint(request));
  const { cli, mcp } = clientSetup(development);
  const title =
    options.title ??
    (login
      ? "Sign in or create your account."
      : view === "billing"
        ? "Billing, simply."
        : view === "usage"
          ? "Usage & credits."
          : "Ready when you are.");
  const message =
    options.message ??
    (login
      ? "Sign in, or create your account if you do not have one yet."
      : view === "billing"
        ? "Manage your plan, payment method and invoices in Stripe."
        : view === "usage"
          ? "Your shared balance. Ask your agent for the details."
          : "Paste one prompt. Your agent takes it from here.");
  const query = new URLSearchParams();
  if (source) query.set("r", source);
  if (view !== "connect") query.set("view", view);
  if (options.organization) query.set("organization", options.organization);
  if (login && options.resumeId) query.set("resume", options.resumeId);
  if (login)
    for (const [key, value] of Object.entries(signupUtm(new URL(request.url).searchParams)))
      query.set(key, value);
  const suffix = query.size ? "?" + query : "";
  const connectQuery = source ? "?r=" + encodeURIComponent(source) : "";
  const markdownPath = view === "connect" ? (login ? "/login.md" : "/index.md") : `/${view}.md`;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "strict-transport-security": STRICT_TRANSPORT_SECURITY,
    // Every portal page submits a form back to the portal. Under no-referrer the browser
    // sends Origin: null, and the origin check then refuses the portal's own request.
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    link: `<${markdownPath}>; rel="alternate"; type="text/markdown"`,
  });
  const authkitOrigin = development
    ? "https://orderly-laugh-73-staging.authkit.app"
    : "https://divine-climb-22.authkit.app";
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; font-src https://ohmyho.st; img-src https://ohmyho.st; script-src '${PORTAL_SCRIPT_HASH}'; form-action 'self' https://api.workos.com ${authkitOrigin}${view === "billing" ? " https://billing.stripe.com" : ""}; base-uri 'none'; frame-ancestors 'none'`,
  );
  let content: string;
  // A notice reports the outcome of something the customer did elsewhere, so it carries no
  // onboarding card and no sign-in form: its title and message are the whole page.
  if (options.notice) content = "";
  else if (login)
    content = `<form action="/login/start${escape(suffix)}" method="post"><button class="portal-button" type="submit">Continue <span aria-hidden="true">→</span></button></form><p class="portal-legal">By signing up, you agree to our <a href="https://ohmyho.st/terms">Terms of Service</a> and <a href="https://ohmyho.st/dpa">Data Processing Agreement</a> and acknowledge our <a href="https://ohmyho.st/privacy">Privacy Notice</a>.</p>`;
  else
    content = `<div class="portal-prompt"><textarea id="agent-prompt" aria-label="Agent prompt" readonly spellcheck="false">${escape(prompt)}</textarea>${copyButton("agent-prompt", "Copy prompt")}</div><div class="portal-options"><details class="portal-option"><summary>MCP</summary><p>${MCP_INSTALL_FIRST}</p><textarea id="mcp-config" aria-label="MCP configuration" readonly spellcheck="false">${escape(mcp)}</textarea>${copyButton("mcp-config", "Copy configuration", true)}</details><details class="portal-option"><summary>CLI</summary><p>Prefer the terminal? Install and sign in.</p><textarea id="cli-command" aria-label="CLI command" readonly spellcheck="false">${escape(cli)}</textarea>${copyButton("cli-command", "Copy command", true)}</details></div><p class="portal-hint">Questions, changes, usage? Ask your agent.<br>Everything is available through the CLI and MCP.</p>`;
  if (
    new URL(request.url).pathname.endsWith(".md") ||
    request.headers.get("accept")?.includes("text/markdown")
  ) {
    headers.set("content-type", "text/markdown; charset=utf-8");
    headers.set("vary", "Accept");
    return new Response(
      request.method === "HEAD"
        ? null
        : `# ${title}\n\n${message}\n\n${login ? `[Continue](/login${connectQuery})` : `## Agent prompt\n\n${prompt}\n\n## MCP\n\n${MCP_INSTALL_FIRST}\n\n\`\`\`json\n${mcp}\n\`\`\`\n\n## CLI\n\n\`\`\`sh\n${cli}\n\`\`\``}\n\n[Billing](/billing) · [Usage](/usage) · [Docs](https://docs.ohmyho.st/)\n\nAsk your agent for the details.\n`,
      { status: options.status ?? 200, headers },
    );
  }
  // A notice is the end of a flow the customer started somewhere else, usually in their agent.
  // The marketing hero, the sign-in link and the workspace actions all say "there is more to do
  // here", so the outcome gets its own page instead of the portal shell.
  if (options.notice) {
    const response = renderStandalonePage({
      title,
      message,
      body: "",
      status: options.status ?? 200,
      head: request.method === "HEAD",
      referrerPolicy: "same-origin",
      markdownAlternate: markdownPath,
    });
    response.headers.set("strict-transport-security", STRICT_TRANSPORT_SECURITY);
    const alternateLink = headers.get("link");
    if (alternateLink !== null) response.headers.set("link", alternateLink);
    response.headers.set("vary", "Accept");
    return response;
  }

  return new Response(
    request.method === "HEAD"
      ? null
      : `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="https://ohmyho.st/favicon.svg" type="image/svg+xml"><link rel="alternate icon" href="https://ohmyho.st/favicon.ico"><link rel="apple-touch-icon" href="https://ohmyho.st/apple-touch-icon.png"><title>${escape(title)} — ohmyho.st</title><link rel="alternate" type="text/markdown" href="${markdownPath}"><style>${PORTAL_CSS}</style><style>${WEBSITE_HEADER_CSS}</style></head><body data-return-path="${escape((options.status ?? 200) >= 400 ? "/login" : (view === "connect" ? "/" : `/${view}`) + connectQuery)}"><nav class="portal-nav">${renderWebsiteLogo("https://ohmyho.st/")}<div class="portal-links"><a href="https://docs.ohmyho.st/">Docs</a><a href="${login ? "https://ohmyho.st/" : (signedIn ? "/" : "/login") + connectQuery}">${login ? "Back home" : signedIn ? "Connect" : "Log in"}</a></div></nav><main class="portal-layout"><div class="portal-art"><h1>Your apps.<br><span>Your agent.</span></h1><p>One place to host everything you build.</p><div class="art">${PORTAL_SVG}</div><div class="portal-proof"><i></i> Hosting for agents.</div></div><section class="portal-panel${login ? " login" : ""}" style="padding-top:${login ? "48" : "34"}px"><div class="portal-eyebrow">${development ? "Development · " : ""}${login ? "Welcome to ohmyho.st" : "Your workspace"}</div>${signedIn ? '<div class="portal-live">Signed in</div>' : ""}<h2>${escape(title)}</h2><p class="portal-description">${escape(message)}</p>${content}${!login ? `<div class="portal-actions"><a href="/${connectQuery}">Connect</a><a href="/billing${connectQuery}">Billing</a></div>` : ""}</section></main><footer class="portal-footer"><span>ohmyho.st · Hosting for agents.</span><div><a href="https://ohmyho.st/privacy">Privacy</a><a href="https://ohmyho.st/terms">Terms</a><a href="https://ohmyho.st/contact">Contact</a></div></footer><script>${PORTAL_SCRIPT}</script></body></html>`,
    { status: options.status ?? 200, headers },
  );
}
function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function displayCredits(value: string): string {
  if (!/^-?\d{1,40}$/u.test(value)) throw Error("Invalid credit balance");
  const raw = BigInt(value),
    absolute = raw < 0n ? -raw : raw;
  const fraction = (absolute % 1000000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${raw < 0n ? "-" : ""}${(absolute / 1000000n).toLocaleString("en-US")}${fraction ? "." + fraction : ""}`;
}

function renderAccountPortal(options: PortalPage, profile: AccountProfile): Response {
  const created = options.view === "tokens" ? options.createdKey : undefined;
  const markdownRequest =
    options.request.headers.get("accept")?.includes("text/markdown") ||
    new URL(options.request.url).pathname.endsWith(".md");
  if (created && !markdownRequest) {
    const title = created.value ? "Save your token" : "Token already created";
    const message = created.value
      ? "This is the only time the full token is shown. Save it in your automation tool or a private environment file."
      : "The full value cannot be shown again. Use the copy you saved when creating this token.";
    const body = `<div class="token-created">${created.value ? `<textarea id="created-token" readonly spellcheck="false" aria-label="New API token">${escape(created.value)}</textarea>${copyButton("created-token", "Copy to clipboard")}` : ""}<p class="account-note">${escape(created.key.name)} · ${created.key.expires_at ? "Expires " + escape(created.key.expires_at) : "Never expires"}</p><a class="portal-button" href="/tokens">Done</a></div>`;
    const response = renderStandalonePage({
      title,
      message,
      body,
      status: options.status ?? 200,
      head: options.request.method === "HEAD",
      referrerPolicy: "same-origin",
      script: { source: PORTAL_SCRIPT, hash: PORTAL_SCRIPT_HASH },
      markdownAlternate: "/tokens.md",
    });
    response.headers.set("strict-transport-security", STRICT_TRANSPORT_SECURITY);
    response.headers.set("link", '</tokens.md>; rel="alternate"; type="text/markdown"');
    response.headers.set("vary", "Accept");
    return response;
  }
  const view = options.view ?? "connect",
    csrf = options.csrf ?? "",
    selected = profile.organizations.find((x) => x.id === options.organizationId),
    region = browserRegionHint(options.request);
  const title =
    view === "tokens"
      ? "API Tokens"
      : view === "profile"
        ? "Profile"
        : view === "billing"
          ? "Billing"
          : view === "usage"
            ? "Usage"
            : "Your projects";
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const nav = `<nav class="account-nav">${renderWebsiteLogo()}<div class="account-tabs"><a href="/" ${view === "connect" || view === "usage" ? 'aria-current="page"' : ""}>Projects</a></div><details class="account-menu"><summary aria-label="Account menu">${escape((profile.name || profile.email).slice(0, 1).toUpperCase())}</summary><div><p>${escape(profile.name || profile.email)}</p><a href="/profile">Profile</a><a href="/tokens">API Tokens</a><a href="/billing">Billing</a><form action="/logout" method="post">${hidden}<button type="submit">Sign out</button></form>${options.referralUrl ? `<input type="hidden" id="referral-link" value="${escape(options.referralUrl)}"><button type="button" class="referral-chip" data-copy-target="referral-link" data-copy-feedback="icon" title="Copy your referral link"><span>Refer and earn</span>${referralIcons}</button>` : ""}</div></details></nav>`;
  const workspace =
    profile.organizations.length > 1
      ? `<form class="workspace-select" action="/workspace" method="post">${hidden}<label for="workspace">Workspace</label><select id="workspace" name="organization">${profile.organizations.map((x) => `<option value="${escape(x.id)}" ${x.id === options.organizationId ? "selected" : ""}>${escape(x.name)}</option>`).join("")}</select><button type="submit">Switch</button></form>`
      : `<p class="account-eyebrow">${escape(selected?.name ?? "Your workspace")}</p>`;
  let content = "",
    markdown = `# ${title}

`;
  // A refused or failed action keeps the signed-in shell and states its reason. The view it came from
  // is not loaded on that page, so its content (an empty project list or no account) is not shown.
  // Tokens keep their form, so the customer can correct a name and retry.
  if ((options.status ?? 200) >= 400 && view !== "tokens") {
    const back = view === "connect" || view === "usage" ? "/" : `/${view}`;
    content = `<section class="account-card" role="alert"><h2>${escape(options.title ?? title)}</h2><p class="account-note">${escape(options.message ?? "")}</p></section><p><a class="account-button" href="${back}">Back</a></p>`;
    markdown = `# ${options.title ?? title}\n\n${options.message ?? ""}\n\n[Back](${back})\n`;
  } else if (view === "tokens") {
    const created = options.createdKey,
      keys = options.userKeys?.data ?? [];
    content = `<p class="account-note token-intro">Connect your agents and automations. New tokens never expire; revoke them here when you no longer need them.</p>`;
    if (options.message)
      content += `<p class="account-note" role="alert">${escape(options.message)}</p>`;
    if (created) {
      content += `<section class="account-card token-created"><h2>${created.value ? "Save your token" : "Token already created"}</h2><p class="account-note">${created.value ? "This is the only time the full token is shown. Save it in your automation tool or a private environment file." : "The full value cannot be shown again. Use the copy you saved when creating this token."}</p>${created.value ? `<textarea id="created-token" readonly spellcheck="false" aria-label="New API token">${escape(created.value)}</textarea>${copyButton("created-token", "Copy to clipboard")}` : ""}<p class="account-note">${escape(created.key.name)} · ${created.key.expires_at ? "Expires " + escape(created.key.expires_at) : "Never expires"}</p><a class="account-button" href="/tokens">Done</a></section>`;
      markdown += `Token: ${created.key.name}\n${created.key.expires_at ? "Expires: " + created.key.expires_at : "Never expires"}\n[Manage tokens](/tokens)\n`;
    } else if (selected) {
      content += `<section class="account-card"><form action="/tokens" method="post" class="token-form">${hidden}<input type="hidden" name="organization" value="${escape(selected.id)}"><input type="hidden" name="request_key" value="${escape(options.tokenDraft?.requestKey ?? crypto.randomUUID())}"><label for="token-name">Token name</label><div><input id="token-name" name="name" value="${escape(options.tokenDraft?.name ?? "")}" maxlength="64" required placeholder="My automation" autocomplete="off"><button class="account-button" type="submit">Create token</button></div></form></section><div class="token-list">${keys.length ? keys.map((key) => `<article class="account-card token-row"><div><h2>${escape(key.name)}</h2><code>${escape(key.obfuscated_value)}</code><p class="account-note">${key.expires_at ? "Expires " + escape(new Date(key.expires_at).toLocaleDateString("en-US", { timeZone: "UTC" })) : "Never expires"}${key.last_used_at ? " · Last used " + escape(new Date(key.last_used_at).toLocaleDateString("en-US", { timeZone: "UTC" })) : " · Not used yet"}</p></div><form method="post" action="/tokens/revoke">${hidden}<input type="hidden" name="organization" value="${escape(selected.id)}"><input type="hidden" name="key_id" value="${escape(key.id)}"><button class="account-button" type="submit">Revoke</button></form></article>`).join("") : '<p class="account-note">No API tokens in this workspace.</p>'}</div>${options.userKeys?.next_cursor ? `<a class="account-button" href="/tokens?cursor=${encodeURIComponent(options.userKeys.next_cursor)}">More tokens →</a>` : ""}`;
    } else
      content += `<p class="account-note">Create or select a workspace with your agent to manage API tokens.</p>`;
    markdown +=
      "New API tokens remain valid until revoked. Full values are displayed only on creation.\n\n" +
      keys
        .map(
          (key) =>
            `- ${key.name}: ${key.obfuscated_value}; ${key.expires_at ? "expires " + key.expires_at : "Never expires"}`,
        )
        .join("\n");
  } else if (view === "profile") {
    const fields = [
      ["Name", profile.name || "—"],
      ["Email", profile.email],
      ["UID", profile.user_id],
      ["Workspace", selected?.name ?? "Not set up"],
      ["Signup source", profile.signup_source ?? "Direct"],
      ["Attributed", profile.attributed_at ?? "—"],
    ];
    content = `<section class="account-card account-profile"><dl>${fields.map(([key, value]) => `<div><dt>${key}</dt><dd>${escape(value ?? "")}</dd></div>`).join("")}</dl></section>`;
    markdown += fields.map(([key, value]) => `- ${key}: ${value}`).join("\n");
  } else if (view === "billing") {
    if (options.account) {
      const a = options.account;
      content = `<section class="account-card"><div class="billing-heading"><div><p class="account-eyebrow">Your plan</p><h2>${a.plan === "paid" ? "Paid" : "Free"} ${a.plan_source === "granted" || a.plan_source === "manual" ? '<span class="account-badge">Granted</span>' : ""}</h2></div>${options.recharge?.portal_available ? `<form action="/billing/stripe" method="post">${hidden}<button class="account-button" type="submit">Manage in Stripe ↗</button></form>` : ""}</div><div class="account-balances"><div><span>Available credits</span><strong>${displayCredits(a.available_micros)}</strong></div><div><span>Monthly credits</span><strong>${displayCredits(a.monthly_micros)}</strong><small>${a.next_expiry ? "Expires " + escape(new Date(a.next_expiry).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })) : "No expiring balance"}</small></div><div><span>Top-ups and other credits</span><strong>${displayCredits(a.one_time_micros)}</strong><small>Top-ups do not expire</small></div></div><p class="account-note">${a.plan_source === "granted" || a.plan_source === "manual" ? `Paid features are granted${a.paid_until ? " until " + escape(new Date(a.paid_until).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })) : ""}. This is not a Stripe subscription.` : "Credits are shared across this workspace."}</p></section>`;
      const r = options.recharge;
      if (r?.billing_issue) {
        const issue = r.billing_issue;
        const message =
          issue.code === "billing_tax_location_required"
            ? "Update your billing address in Stripe. Your existing invoice is retained; do not start another purchase."
            : issue.code === "billing_tax_calculation_failed"
              ? "Tax could not be calculated. Your existing invoice is retained. Contact us before starting another purchase."
              : "The tax setup for your existing invoice needs review. Contact us before starting another purchase.";
        content += `<section class="account-card recharge-card" role="alert"><h2>Billing needs your attention</h2><p class="account-note">${message}</p><p class="account-note">Invoice ${escape(issue.invoice_id)}</p>${issue.required_action === "open_billing_portal" ? `<form action="/billing/stripe" method="post">${hidden}<button class="account-button" type="submit">Update billing details ↗</button></form>` : `<a class="account-button" href="https://ohmyho.st/contact">Contact us</a>`}</section>`;
        markdown += `Billing issue: ${issue.code}\n${message}\nInvoice: ${issue.invoice_id}\n${issue.required_action === "open_billing_portal" ? "Open Stripe from [Billing](/billing) to update billing details." : "[Contact us](https://ohmyho.st/contact)."}\n\n`;
      }
      if (r) {
        const dollars = (r.monthly_limit_minor / 100).toFixed(2);
        content += `<section class="account-card recharge-card"><div class="billing-heading"><div><p class="account-eyebrow">Keep building</p><h2>Auto-recharge <span class="account-badge">${!r.enabled ? "Off" : a.plan !== "paid" ? "Paused" : r.status === "on" ? "On" : r.status === "setup_required" ? "Card setup" : "Paused"}</span></h2></div></div><p>1,000 credits for $9 + tax. Automatically refill below 100 credits.</p>${r.enabled && a.plan !== "paid" ? "<p>Auto-recharge is paused. Refills resume only with active Paid access.</p>" : ""}<p class="account-note">10% off. Every refill includes an invoice. Top-ups do not expire.</p><form action="/billing/recharge" method="post">${hidden}<input type="hidden" name="revision" value="${r.revision}"><label for="recharge-limit">Monthly spending limit · USD, including tax</label>${r.enabled ? `<p>$${dollars}</p><input type="hidden" name="monthly_limit_minor" value="${r.monthly_limit_minor}">` : `<select id="recharge-limit" name="monthly_limit_minor" class="account-input">${[1000, 2500, 5000, 10000, 25000, 50000, 100000].map((v) => `<option value="${v}" ${v === r.monthly_limit_minor ? "selected" : ""}>$${v / 100}</option>`).join("")}</select><label class="recharge-consent"><input type="checkbox" name="consent" value="off_session_v1" required> I authorize automatic charges to my saved card for these refills, up to my monthly limit. I can turn this off at any time.</label>`}<button class="account-button" type="submit" role="switch" aria-checked="${r.enabled}" ${a.plan !== "paid" && !r.enabled ? "disabled" : ""} name="enabled" value="${!r.enabled}">${r.enabled ? "Turn off" : a.plan === "paid" ? "Enable auto-recharge" : "Paid required"}</button></form><p class="account-note">$${(r.spent_minor / 100).toFixed(2)} charged this UTC calendar month.${r.enabled ? " Payments already initiated may finish after switching off." : ""}</p>${r.status === "setup_required" ? "<p>Complete card setup to activate automatic refills.</p>" : r.status === "monthly_limit" ? "<p>Monthly limit reached. Auto-recharge resumes next month.</p>" : r.status === "payment_required" ? "<p>A payment needs your attention. Automatic attempts are paused.</p>" : r.status === "needs_reconciliation" ? "<p>A payment is being checked. No new charge will be started.</p>" : r.status === "tax_required" ? "<p>Auto-recharge is paused until the existing invoice’s tax issue is resolved.</p>" : ""}${r.setup_url && safePortalUrl(r.setup_url) ? `<a class="account-button" href="${escape(r.setup_url)}">Continue card setup ↗</a>` : ""}${r.invoice_url && safePortalUrl(r.invoice_url) ? `<a class="account-button" href="${escape(r.invoice_url)}">Review invoice ↗</a>` : ""}</section>`;
        markdown += `Auto-recharge: ${!r.enabled ? "Off" : a.plan !== "paid" ? "Paused, Paid required" : "On"} (${r.status}). 1,000 credits for $9 plus tax, below 100 credits. Gross monthly limit: $${dollars}. This month: $${(r.spent_minor / 100).toFixed(2)}. Manage consent in [Billing](/billing).\n\n`;
      }
      markdown += `Plan: ${a.plan} (${a.plan_source})

Available: ${displayCredits(a.available_micros)}
Expiring monthly credits: ${displayCredits(a.monthly_micros)}
Top-ups and other credits: ${displayCredits(a.one_time_micros)}
Top-ups do not expire.
`;
    } else
      content = `<div class="account-card"><p>${options.accountDenied ? "Billing is available to the workspace owner." : "Your workspace has not been set up yet."}</p></div>`;
  } else {
    const projects = options.projects ?? [];
    const development = options.origin !== "https://app.ohmyho.st";
    // Every prompt copied here names the signed-in user and the selected organization, so the
    // agent acts as exactly this account even when the computer holds logins of several.
    const account: PromptAccount = {
      userId: profile.user_id,
      organizationId: selected?.id ?? null,
      organizationName: selected?.name ?? null,
    };
    const setupPrompt = portalPrompt(profile.signup_source ?? "", development, region, account);
    const promptOf = (project: Project): string =>
      projectPrompt(
        {
          userId: profile.user_id,
          organizationId: project.organization_id,
          organizationName:
            profile.organizations.find((x) => x.id === project.organization_id)?.name ?? null,
        },
        project,
        development,
      );
    if (!projects.length) {
      content = `<section class="account-empty"><div class="empty-mark">↗</div><h2>Your next app starts here.</h2><p>Paste the prompt into your agent. It handles the setup.</p>${setupCard(setupPrompt, development)}</section>`;
      markdown += `${setupPrompt}\n`;
    } else {
      content = `<div class="project-grid">${projects
        .map(({ project, status, budget, flag }) => {
          const prompt = promptOf(project);
          const live =
            status.lifecycle === "active" && status.prod_url && safePortalUrl(status.prod_url);
          const state =
            status.lifecycle === "deleting"
              ? "Deleting"
              : status.lifecycle === "deleted"
                ? "Deleted"
                : live
                  ? "Deployed · Live"
                  : "Not deployed";
          const cursor = new URL(options.request.url).searchParams.get("cursor") ?? "";
          const budgetForm = budget
            ? `<div class="project-usage"><div><span>This month</span><strong>${displayCredits(budget.used_micros)} <small>credits</small></strong></div></div><form class="budget-form" action="/budget" method="post">${hidden}<input type="hidden" name="project" value="${project.id}"><input type="hidden" name="cursor" value="${escape(cursor)}"><input type="hidden" name="request_key" value="${crypto.randomUUID()}"><label for="limit-${project.id}">Monthly limit · credits</label><div class="budget-controls"><input id="limit-${project.id}" name="limit" inputmode="decimal" placeholder="No limit" value="${budget.amount_micros === null ? "" : displayCredits(budget.amount_micros).replaceAll(",", "")}" aria-describedby="budget-note-${project.id}"><select name="mode" aria-label="At limit"><option value="stop" ${budget.mode === "stop" ? "selected" : ""}>Stop at limit</option><option value="continue" ${budget.mode === "continue" ? "selected" : ""}>Keep running</option></select><button class="account-button" type="submit">Save</button></div></form><p class="account-note" id="budget-note-${project.id}">Monthly limits use UTC calendar months. Existing work and delayed measurements may settle after a limit is reached. Leave the limit empty to remove it.</p>`
            : '<p class="account-note">Usage and monthly limits are available to the workspace owner.</p>';
          const flagForm = flag
            ? `<form id="flag-${project.id}" action="/flag" method="post">${hidden}<input type="hidden" name="project" value="${project.id}"><input type="hidden" name="cursor" value="${escape(cursor)}"><input type="hidden" name="request_key" value="${crypto.randomUUID()}"><input type="hidden" name="enabled" value="${flag.enabled ? "false" : "true"}"><button type="submit" title="Your own domain uses no domain credits and also works on Free. Each Paid period bought through Stripe adds 250 credits per workspace.">${flag.enabled ? "Hide" : "Show"} ohmyho.st flag</button></form>`
            : "";
          const flagNote = flag
            ? `<p class="account-note">The ohmyho.st flag is a small “Powered by ohmyho.st” link on the right edge of your production site${flag.enabled ? ", shown now" : ""}. While it shows, this project's own domain uses no domain credits and also works on Free, and each Paid period you buy through Stripe adds 250 credits to the workspace, however many projects show the flag.</p>`
            : "";
          const usageDialog = `<dialog class="usage-dialog" id="usage-${project.id}" aria-labelledby="usage-title-${project.id}"><div class="usage-dialog-heading"><div><p class="account-eyebrow">${escape(project.name)}</p><h2 id="usage-title-${project.id}">Usage &amp; limits</h2></div><button class="project-icon-button dialog-close" type="button" data-dialog-close aria-label="Close usage and limits"><span aria-hidden="true">×</span></button></div>${budgetForm}${flagNote}<p class="account-note">Credits are shared across your workspace. <a href="/billing">Billing ↗</a></p></dialog>`;
          const appLink = live
            ? `<a class="project-icon-button project-live-link" href="${escape(live)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escape(project.name)} in production" title="Open live app"><span aria-hidden="true">↗</span></a>`
            : '<button class="project-icon-button project-live-link" type="button" disabled aria-label="Production app is not available" title="Production app is not available"><span aria-hidden="true">↗</span></button>';
          return `<article class="account-card project-card"><div class="project-card-top"><button class="project-icon-button project-usage-button" type="button" data-dialog-target="usage-${project.id}" aria-haspopup="dialog" aria-controls="usage-${project.id}" aria-label="Usage and monthly limit for ${escape(project.name)}" title="Usage and monthly limit"><span aria-hidden="true">$</span></button><div class="project-deployment"><span class="account-badge${live ? " is-live" : ""}">${state}</span>${appLink}</div></div><h2>${escape(project.name)}</h2><p class="project-handle">${escape(project.handle)}</p><div class="project-links">${status.dev_url ? `<form action="/dev-access" method="post">${hidden}<input type="hidden" name="project" value="${project.id}"><button type="submit">Open dev ↗</button></form>` : ""}${flagForm}</div>${usageDialog}<details class="project-prompt"><summary>Want to know anything? Ask your agent. <span>+</span></summary><textarea id="project-${project.id}" readonly aria-label="Project prompt" spellcheck="false">${escape(prompt)}</textarea>${copyButton("project-" + project.id, "Copy project prompt", true)}</details></article>`;
        })
        .join(
          "",
        )}</div>${options.nextCursor ? `<a class="account-button" href="/?cursor=${encodeURIComponent(options.nextCursor)}">More projects →</a>` : ""}${view === "connect" ? `<details class="add-project"><summary>Deploy another app +</summary>${setupCard(setupPrompt, development)}</details>` : ""}`;
      markdown += projects
        .map(
          ({ project, status, budget }) => `## ${project.name}

Project: ${project.id}
Organization: ${project.organization_id}
User: ${profile.user_id}
Status: ${status.lifecycle !== "active" ? status.lifecycle : status.prod_url && safePortalUrl(status.prod_url) ? "Deployed · Live" : "Not deployed"}
${budget ? "Used: " + displayCredits(budget.used_micros) + " credits; limit: " + (budget.amount_micros === null ? "none" : displayCredits(budget.amount_micros)) + "; mode: " + budget.mode : ""}
Prompt: ${promptOf(project)}
`,
        )
        .join("\n");
      if (view === "connect") markdown += `\n## Deploy another app\n\n${setupPrompt}\n`;
    }
  }
  const devOrigins = [
    ...new Set(
      (options.projects ?? []).flatMap(({ status }) => {
        const target = status.dev_url && safePortalUrl(status.dev_url);
        return target ? [new URL(target).origin] : [];
      }),
    ),
  ].join(" ");
  const headers = new Headers({
    "cache-control": "no-store",
    "strict-transport-security": STRICT_TRANSPORT_SECURITY,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    link: `<${view === "connect" ? "/index" : `/${view}`}.md>; rel="alternate"; type="text/markdown"`,
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; font-src https://ohmyho.st; img-src https://ohmyho.st; script-src '${PORTAL_SCRIPT_HASH}'; form-action 'self' https://billing.stripe.com https://checkout.stripe.com ${devOrigins}; base-uri 'none'; frame-ancestors 'none'`,
  });
  const md =
    options.request.headers.get("accept")?.includes("text/markdown") ||
    new URL(options.request.url).pathname.endsWith(".md");
  headers.set("content-type", md ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8");
  headers.set("vary", "Accept");
  return new Response(
    options.request.method === "HEAD"
      ? null
      : md
        ? markdown
        : `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="https://ohmyho.st/favicon.svg" type="image/svg+xml"><link rel="alternate icon" href="https://ohmyho.st/favicon.ico"><link rel="apple-touch-icon" href="https://ohmyho.st/apple-touch-icon.png"><title>${title} — ohmyho.st</title><style>${PORTAL_CSS}</style><style>${WEBSITE_HEADER_CSS}</style></head><body class="account-body">${nav}<main class="account-main">${workspace}<div class="account-page-heading"><h1>${title}</h1>${view === "connect" ? '<a href="https://docs.ohmyho.st/">Docs ↗</a>' : ""}</div>${content}<p class="agent-footer">Need anything else? Ask your agent. <a href="https://docs.ohmyho.st/agents/mcp">MCP</a> · <a href="https://docs.ohmyho.st/cli">CLI</a></p></main><footer class="portal-footer"><span>ohmyho.st</span><div><a href="https://ohmyho.st/privacy">Privacy</a><a href="https://ohmyho.st/contact">Contact</a></div></footer><script>${PORTAL_SCRIPT}</script></body></html>`,
    { status: options.status ?? 200, headers },
  );
}
function safePortalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
/**
 * The CLI line installs both current archives once; the MCP configuration a customer saves runs
 * the installed command, because a versioned archive URL answers 404 after the next release.
 * That command cannot start before it is installed, so every MCP option names the install first.
 */
const MCP_INSTALL_FIRST =
  "Install once with the CLI command, then add this to your agent's MCP configuration.";
function clientSetup(development: boolean): { cli: string; mcp: string } {
  const v = PORTAL_CLIENT_RELEASE,
    base = `https://ohmyho.st/releases/${v}`;
  return {
    cli: `npm install --global ${base}/ohmyhost-product-cli-${v}.tgz ${base}/ohmyhost-mcp-${v}.tgz
${development ? "OHMYHOST_ENVIRONMENT=development " : ""}ohmyhost login --json`,
    mcp: JSON.stringify(
      {
        mcpServers: {
          ohmyho: {
            command: "ohmyhost-mcp",
            env: { OHMYHOST_ENVIRONMENT: development ? "development" : "production" },
          },
        },
      },
      null,
      2,
    ),
  };
}
function setupCard(prompt: string, development: boolean): string {
  const { cli, mcp } = clientSetup(development);
  return `<div class="account-setup"><textarea id="agent-prompt" aria-label="Agent prompt" readonly spellcheck="false">${escape(prompt)}</textarea>${copyButton("agent-prompt", "Copy prompt")}<div class="portal-options"><details class="portal-option"><summary>MCP</summary><p>${MCP_INSTALL_FIRST}</p><textarea id="mcp-config" aria-label="MCP configuration" readonly>${escape(mcp)}</textarea>${copyButton("mcp-config", "Copy configuration", true)}</details><details class="portal-option"><summary>CLI</summary><textarea id="cli-command" aria-label="CLI command" readonly>${escape(cli)}</textarea>${copyButton("cli-command", "Copy command", true)}</details></div></div>`;
}
