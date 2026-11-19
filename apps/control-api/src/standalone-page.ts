import { MAKE_DOMINO_ICON_DATA, PORTAL_CSS, PORTAL_CSS_HASH } from "./generated-portal-assets.js";
import {
  WEBSITE_HEADER_HTML,
  WEBSITE_HEADER_CSS,
  WEBSITE_HEADER_CSS_HASH,
} from "./website-brand.js";

export const PORTAL_COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>';

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function copyButton(target: string, label: string, secondary = false): string {
  return `<button type="button" class="portal-button${secondary ? " secondary" : ""}" data-copy-target="${escape(target)}">${PORTAL_COPY_ICON}<span aria-live="polite">${escape(label)}</span></button>`;
}

export interface StandalonePageOptions {
  title: string;
  message: string;
  status: number;
  body?: string;
  head?: boolean;
  referrerPolicy: "same-origin" | "strict-origin" | "no-referrer";
  development?: boolean;
  agentReturnUrl?: string | null;
  formRedirectOrigin?: string | null;
  /** Caller must validate the destination before rendering. */
  refreshUrl?: string;
  script?: { source: string; hash: string };
  markdownAlternate?: string;
  helpLink?: boolean;
  providerIcon?: "make";
}

/** Shared CSP; redirects remain limited to the existing approved origins. */
export function standalonePageCsp(
  formRedirectOrigin: string | null = null,
  scriptHash?: string,
  includeMakeIcon = false,
): string {
  if (
    formRedirectOrigin !== null &&
    !["https://chatgpt.com", "https://claude.ai", "https://github.com"].includes(formRedirectOrigin)
  )
    throw new TypeError("Invalid form redirect origin");
  return `default-src 'none'; style-src '${PORTAL_CSS_HASH}' '${WEBSITE_HEADER_CSS_HASH}'; ${scriptHash ? `script-src '${scriptHash}'; ` : ""}font-src https://ohmyho.st; img-src https://ohmyho.st${includeMakeIcon ? " data:" : ""}; form-action 'self'${formRedirectOrigin === null ? "" : ` ${formRedirectOrigin}`}; base-uri 'none'; frame-ancestors 'none'`;
}

/** Shared shell for platform-owned single-use and control-flow pages. */
export function renderStandalonePage(options: StandalonePageOptions): Response {
  const {
    title,
    message,
    status,
    body,
    head = false,
    development = false,
    agentReturnUrl = null,
    formRedirectOrigin = null,
    referrerPolicy,
    script,
  } = options;
  const action =
    body ??
    `<div class="mcp-actions"><a class="portal-button" href="${agentReturnUrl === null ? "/" : escape(agentReturnUrl)}">${agentReturnUrl === null ? "Back to your workspace" : "Back to your agent"}</a>${status >= 400 ? "" : '<a class="portal-button secondary" href="https://docs.ohmyho.st/agents/mcp">Connection help</a>'}</div>`;
  const showMakeIcon = options.providerIcon === "make";
  const icon =
    status >= 400 || body?.includes("<form")
      ? '<path d="M8 12h8m-3-3 3 3-3 3"/>'
      : '<path d="m7 12 3 3 7-7"/>';
  return new Response(
    head
      ? null
      : `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — ohmyho.st</title><link rel="icon" href="https://ohmyho.st/favicon.svg" type="image/svg+xml">${options.markdownAlternate === undefined ? "" : `<link rel="alternate" type="text/markdown" href="${escape(options.markdownAlternate)}">`}${options.refreshUrl === undefined ? "" : `<meta http-equiv="refresh" content="0;url=${escape(options.refreshUrl)}">`}<style>${PORTAL_CSS}</style><style>${WEBSITE_HEADER_CSS}</style></head><body><div class="website-header top"><div class="wrap"><nav>${WEBSITE_HEADER_HTML}${options.helpLink ? '<a class="mcp-help" href="https://docs.ohmyho.st/agents/mcp">Help</a>' : ""}</nav></div></div><main class="mcp-layout"><section class="portal-panel mcp-panel" aria-labelledby="mcp-title"><div class="mcp-icon"${showMakeIcon ? ' data-provider-icon="make"' : ""} aria-hidden="true">${showMakeIcon ? `<img src="${MAKE_DOMINO_ICON_DATA}" alt="" width="38" height="38">` : `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"/>${icon}</svg>`}</div><p class="mcp-eyebrow">${development ? "Development · " : ""}ohmyho.st connection</p><h1 id="mcp-title">${escape(title)}</h1><p class="portal-description">${escape(message)}</p><div class="mcp-content">${action}</div></section></main><footer class="portal-footer"><span>ohmyho.st · Hosting for agents.</span><div><a href="https://ohmyho.st/privacy">Privacy</a><a href="https://ohmyho.st/contact">Contact</a></div></footer>${script ? `<script>${script.source}</script>` : ""}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": referrerPolicy,
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
        "content-security-policy": standalonePageCsp(
          formRedirectOrigin,
          script?.hash,
          showMakeIcon,
        ),
      },
    },
  );
}
