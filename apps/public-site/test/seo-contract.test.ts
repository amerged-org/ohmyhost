import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { PAGE_META } from "../src/page-meta.js";
import { externalLinkRel, footerColumnsHtml } from "../src/site-links.js";
import worker from "../src/worker-main.js";

const publicDir = new URL("../public/", import.meta.url);

it("marks only anchors that leave ohmyho.st as opener-safe", () => {
  expect(
    externalLinkRel(
      '<a href="https://example.com/x">Out</a> <a href="https://ohmyho.st/pricing">Price</a> <a href="https://example.com/y" rel="me">Kept</a>',
    ),
  ).toBe(
    '<a href="https://example.com/x" rel="noopener">Out</a> <a href="https://ohmyho.st/pricing">Price</a> <a href="https://example.com/y" rel="me">Kept</a>',
  );
});

function attribute(html: string, tag: string): string {
  const match = html.match(new RegExp(`<meta ${tag} content="([^"]*)"`, "u"));
  expect(match, tag).not.toBeNull();
  return match?.[1] ?? "";
}

it("serves crawler, cache and transport metadata", async () => {
  const assets = new PagesFixture();
  const robots = await worker.fetch(new Request("https://ohmyho.st/robots.txt"));
  const rules = await robots.text();
  expect(rules).toContain("User-agent: *\nAllow: /\nDisallow: /login\nDisallow: /*?r=\n");
  for (const agent of ["GPTBot", "ClaudeBot", "anthropic-ai", "PerplexityBot", "OAI-SearchBot"])
    expect(rules).toContain(`User-agent: ${agent}\n`);
  expect(rules).toContain("Sitemap: https://ohmyho.st/sitemap.xml\n");
  expect(robots.headers.get("cache-control")).toBe("public, max-age=3600");
  const sitemap = await worker.fetch(new Request("https://ohmyho.st/sitemap.xml"));
  const xml = await sitemap.text();
  expect(sitemap.headers.get("cache-control")).toBe("public, max-age=3600");
  const urls = [
    ...xml.matchAll(
      /<url><loc>https:\/\/ohmyho\.st([^<]*)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod><\/url>/gu,
    ),
  ];
  expect(urls.length).toBe(xml.match(/<url>/gu)?.length);
  const listed = urls.map((entry) => entry[1] ?? "");
  // Without the website binding this Worker answers only its own pages, so the sitemap lists only those: every other
  // page, the blog, the legal and the pricing pages included, answers 503 here and must not be offered to a crawler.
  expect(listed.sort()).toEqual(["/", "/brand"]);
  for (const path of Object.keys(PAGE_META)) expect(listed, path).not.toContain(path);
  expect(listed.some((path) => path.endsWith(".md"))).toBe(false);
  for (const url of [
    "https://ohmyho.st/",
    "https://ohmyho.st/about",
    "https://ohmyho.st/docs",
    "https://ohmyho.st/missing",
  ]) {
    const response = await worker.fetch(new Request(url), { ASSETS: assets });
    expect(response.headers.get("strict-transport-security"), url).toBe(
      "max-age=31536000; includeSubDomains",
    );
  }
  expect(
    (await worker.fetch(new Request("https://ohmyho.st/about"))).headers.get("cache-control"),
  ).toBe("no-store");
  const font = await worker.fetch(new Request("https://ohmyho.st/fonts/3386a05f6ece969e.ttf"), {
    ASSETS: assets,
  });
  expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const logo = await worker.fetch(new Request("https://ohmyho.st/logos/workos.svg"), {
    ASSETS: assets,
  });
  expect(logo.headers.get("cache-control")).toBe("public, max-age=86400");
  const favicon = await worker.fetch(new Request("https://ohmyho.st/favicon.svg"));
  expect(favicon.headers.get("cache-control")).toBe("public, max-age=86400");
});

it("hardens the approved homepage markup for search and social", async () => {
  const assets = new PagesFixture();
  const home = await (
    await worker.fetch(new Request("https://ohmyho.st/"), { ASSETS: assets })
  ).text();
  expect(home).toContain('<main class="wrap">');
  expect(home.match(/<meta name="description"/gu)).toHaveLength(1);
  expect(home).not.toContain('href="#"');
  const columns = home.slice(
    home.indexOf('<div class="fcol">'),
    home.indexOf('<div class="fbot">'),
  );
  expect(columns.trim()).toBe(footerColumnsHtml());
  expect(home).toContain('href="/philosophy"');
  expect(home).toContain('href="/open-source"');
  expect(home).not.toContain("github.com/amerged/docs");
  for (const [img] of home.matchAll(/<img src="logos\/[^"]+"[^>]*>/gu))
    expect(img).toMatch(/width="\d+" height="\d+"/u);
  for (const [anchor] of home.matchAll(/<a [^>]*href="https:\/\/docs\.ohmyho\.st[^>]*>/gu))
    expect(anchor).toContain('rel="noopener"');
  // The owner's approved social copy is set in page preparation and may differ from the meta
  // description on purpose; the contract is that both exist and are not empty.
  expect(attribute(home, 'property="og:description"').length).toBeGreaterThan(20);
  expect(attribute(home, 'name="twitter:description"').length).toBeGreaterThan(20);
  const brand = await (
    await worker.fetch(new Request("https://ohmyho.st/brand"), { ASSETS: assets })
  ).text();
  expect(brand.match(/<meta name="description"/gu)).toHaveLength(1);
  expect(brand).toContain('<meta property="og:image" content="https://ohmyho.st/og.png">');
});

class PagesFixture {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (
      !/^\/(?:pages\/[a-z0-9./-]+|logos\/[a-z0-9]+\.svg|fonts\/[a-f0-9]{16}\.ttf|og\/[a-z0-9-]+\.png|shots\/[a-z0-9-]+\.png)$/u.test(
        path,
      )
    )
      return new Response(null, { status: 404 });
    const file = new URL(`.${path}`, publicDir);
    if (!existsSync(file)) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(await readFile(file)));
  }
}
