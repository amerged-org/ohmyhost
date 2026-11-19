const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const NONCE = /^[a-f0-9]{32}$/u;

// The brand Ω (brand/assets/omega-light.svg) drawn in the tab's text colour.
const OMEGA =
  '<svg viewBox="0 0 100 100" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="12.5" stroke-linecap="round" stroke-linejoin="round"><path d="M30 87 H14 L27 63 A31 31 0 1 1 73 63 L86 87 H70"/></svg>';

const STYLE = [
  ":host{all:initial;position:fixed;right:0;bottom:96px;z-index:2147483647}",
  "a{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:10px 0 0 10px;background:#000;color:#F0F1F2;font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;box-shadow:0 0 0 1px rgba(240,241,242,.18),0 2px 8px rgba(0,0,0,.24)}",
  "svg{width:16px;height:16px;flex:none}",
  "span{max-width:0;margin-left:0;overflow:hidden;white-space:nowrap;transition:max-width .2s ease,margin-left .2s ease}",
  "a:hover span,a:focus-visible span{max-width:160px;margin-left:8px}",
  "a:focus-visible{outline:2px solid #F0F1F2;outline-offset:-4px}",
  "@media (prefers-reduced-motion:reduce){span{transition:none}}",
  "@media print{:host{display:none}}",
].join("");

/**
 * The opt-in "Powered by ohmyho.st" tab. A declarative shadow root keeps the site's CSS out, the
 * style carries the response's CSP nonce, and nothing is loaded until a visitor clicks the link.
 */
export function poweredByFlagMarkup(input: Readonly<{ projectId: string; nonce: string }>): string {
  if (!ULID.test(input.projectId) || !NONCE.test(input.nonce))
    throw new TypeError("Invalid powered-by flag input");
  const href = `https://ohmyho.st/?r=flag-${input.projectId.toLowerCase()}`;
  return `<ohmyhost-flag><template shadowrootmode="open"><style nonce="${input.nonce}">${STYLE}</style><a href="${href}" target="_blank" rel="sponsored noopener" aria-label="Powered by ohmyho.st">${OMEGA}<span>Powered by ohmyho.st</span></a></template></ohmyhost-flag>`;
}
