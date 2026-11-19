import type { PageMeta } from "./page-meta.js";
import { OG_IMAGES } from "./generated-site-frame.js";

/** The page's rendered social card when one exists, else the declared or site-wide image. */
export function ogImagePath(path: string, meta: PageMeta): string {
  const slug = path.slice(1).replaceAll("/", "-");
  return OG_IMAGES.includes(slug) ? `/og/${slug}.png` : (meta.ogImage ?? "/og.png");
}

/** Escapes text for an HTML attribute value. */
export function attribute(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
