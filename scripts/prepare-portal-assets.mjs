import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { format } from "prettier";
const root = new URL("../", import.meta.url);
// The brand lives in the website repository, with the pages it styles. It arrives here as one
// reviewed bundle written by that repository's prepare-brand-bundle script.
const brand = JSON.parse(await readFile(new URL("brand/brand-bundle.json", root), "utf8"));
const { css, mark: svg, fonts } = brand;
if (!css || !svg || !fonts) throw Error("The brand bundle is missing its design assets");
const style = await readFile(new URL("apps/control-api/site/portal.css", root), "utf8");
const script = await readFile(new URL("apps/control-api/site/portal.js", root), "utf8");
const makeDomino = await readFile(new URL("apps/control-api/site/make-domino.png", root));
const portalCss = fonts + css + style;
const release = JSON.parse(
  await readFile(new URL("apps/product-cli/package.json", root), "utf8"),
).version;
if (!/^\d+\.\d+\.\d+$/u.test(release ?? "")) throw Error("Public client version missing");
await writeFile(
  new URL("apps/control-api/src/generated-portal-assets.ts", root),
  await format(
    "// Generated from the approved homepage and portal assets.\n" +
      Object.entries({
        PORTAL_CSS: portalCss,
        PORTAL_CSS_HASH: "sha256-" + createHash("sha256").update(portalCss).digest("base64"),
        PORTAL_SVG: svg,
        PORTAL_SCRIPT: script,
        PORTAL_SCRIPT_HASH: "sha256-" + createHash("sha256").update(script).digest("base64"),
        PORTAL_CLIENT_RELEASE: release,
        MAKE_DOMINO_ICON_DATA: "data:image/png;base64," + makeDomino.toString("base64"),
      })
        .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`)
        .join("\n"),
    { parser: "typescript", printWidth: 100 },
  ),
);
