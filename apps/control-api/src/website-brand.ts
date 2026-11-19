// Normal website header, from ohmyhost-web d46be1b99db4f3973b360b9eaac274f2901c85a6.
const WEBSITE_LOGO_MARKUP = `<a class="fbrandrow" href="/" aria-label="ohmyhost"><svg class="ohm" viewBox="0 0 100 100" aria-hidden="true"><path d="M30 87 H14 L27 63 A31 31 0 1 1 73 63 L86 87 H70"/></svg><span class="mark">ohmyho<i>st</i></span></a>`;
export function renderWebsiteLogo(href = "/"): string {
  const safeHref = href
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  return WEBSITE_LOGO_MARKUP.replace('href="/"', `href="${safeHref}"`);
}
export const WEBSITE_HEADER_HTML = renderWebsiteLogo();
export const WEBSITE_HEADER_CSS = `.website-header{--background:#000000;--foreground:#F0F1F2;--muted-foreground:#83878D;--subtle:#3E4247;--border:#17181A;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;position:sticky;top:0;z-index:40;background:color-mix(in srgb, var(--background) 72%, transparent);backdrop-filter:blur(16px) saturate(140%);border-bottom:1px solid transparent;transition:border-color .3s ease,background .3s ease}
.website-header .wrap{max-width:900px;margin:0 auto;padding:0 22px}
.website-header nav{height:66px;display:flex;align-items:center;gap:26px}
.fbrandrow .mark{font-family:var(--mono);font-size:14.5px;letter-spacing:-.02em;color:var(--foreground);font-weight:400}
.fbrandrow .mark i{font-style:normal;color:var(--muted-foreground)}
.fbrandrow .ohm{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:12.5;stroke-linecap:round;stroke-linejoin:round;color:var(--foreground);display:block;flex:0 0 22px}
.fbrandrow{--foreground:#F0F1F2;--muted-foreground:#83878D;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;align-items:center;gap:10px}
.website-header .mcp-help{margin-left:auto}`;
export const WEBSITE_HEADER_CSS_HASH = "sha256-1nuQu56xGcxD5bxkkyOEFHhsJgBqbSet6FQ8/ZcA/Gk=";
