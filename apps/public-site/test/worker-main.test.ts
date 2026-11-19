import { readdir, readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { CLIENT_RELEASE } from "../src/customer-entry.js";
import worker from "../src/worker-main.js";

describe("public entry and unassigned Free-host fallback", () => {
  it("serves the public home and favicon without reflecting request data", async () => {
    const assetRules = await readFile(new URL("../public/.assetsignore", import.meta.url), "utf8");
    expect(assetRules).toContain("!pages/**");
    expect(assetRules).toContain("!logos/**");
    const assets = new SiteAssetFixture();
    const home = await worker.fetch(new Request("https://ohmyho.st/?ticket=private-ticket"), {
      ASSETS: assets,
    });
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    const html = await home.text();
    expect(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/u)?.[1]).toBe(
      '<span class="thin">Host your app.</span><br>Supabase Vercel Resend alternative',
    );
    for (const [attribute, name] of [
      ["property", "og:title"],
      ["property", "og:description"],
      ["name", "twitter:title"],
      ["name", "twitter:description"],
    ])
      expect(html).toContain(
        `<meta ${attribute}="${name}" content="Supabase Vercel Resend Alternative - all in one from 10$. Hoster for vibe-coded apps.">`,
      );
    // The document title, the search result and every shared link say the same approved line.
    expect(html).toContain(
      "<title>Supabase Vercel Resend Alternative - all in one from 10$. Hoster for vibe-coded apps.</title>",
    );
    // The shared card carries that copy as text instead of the bare brand mark.
    expect(html).toContain('<meta property="og:image" content="https://ohmyho.st/og/home.png">');
    expect(html).toContain('<meta name="twitter:image" content="https://ohmyho.st/og/home.png">');
    expect(html).toContain('<meta property="og:image:alt" content="ohmyho.st — Supabase');
    expect(html).toContain("Copy prompt for your agent");
    expect(html).toContain("<span>Copy prompt</span>");
    expect(html).not.toContain("Get beta access");
    expect(html).not.toContain("Beta access");
    expect(html).not.toContain('id="beta-modal"');
    expect(html).not.toContain('id="beta-form"');
    expect(html).not.toContain("showModal");
    expect(html.match(/rel="icon"/gu)).toHaveLength(1);
    expect(html).not.toContain("fetch('/stats.json'");
    expect(html).not.toContain('id="proof"');
    expect(html).toContain("updatePlaybackRate(1.25)");
    expect(html).toContain("Your database, exported &amp; connected.");
    expect(html).toContain('width="96" height="96" loading="lazy"');
    const pricing = html.slice(
      html.indexOf('<section id="price">'),
      html.indexOf('<div class="slid up">'),
    );
    expect(pricing.match(/data-copy/gu)).toHaveLength(1);
    expect(pricing).toContain("More capacity when you need it <em>uses credits</em>");
    expect(html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"))).not.toContain(
      'href="#export"',
    );
    expect(html).toContain(
      'powered by <a href="https://amerged.com" rel="noopener">amerged.com</a>',
    );
    expect(html).toContain('<a class="sales" href="/contact">Bigger than this? Talk to us.</a>');
    expect(html).toContain(
      'href="https://docs.ohmyho.st/pricing" rel="noopener">See all usage rates</a>',
    );
    const comparisonStart = html.indexOf('<div class="vs stag">');
    const comparison = html.slice(comparisonStart, html.indexOf("</section>", comparisonStart));
    expect(comparison.match(/<details class="bill" open><summary>/gu)).toHaveLength(2);
    expect(comparison.match(/class="li"/gu)).toHaveLength(13);
    expect(html).not.toMatch(/AI (models|credits)/u);
    expect(html).toContain("<span><h3>1,000 emails</h3><u>180 credits</u></span>");
    expect(comparison.match(/Functions &amp; cron/gu)).toHaveLength(2);
    for (const card of comparison.split('<div class="card').slice(1)) {
      const bill = card.indexOf('<details class="bill" open>');
      const billEnd = card.indexOf("</details>");
      expect(bill).toBeGreaterThan(card.indexOf('<p class="scen">'));
      expect(billEnd).toBeLessThan(card.indexOf('<div class="tot">'));
      expect(card.slice(bill, billEnd).match(/class="li"/gu)?.length).toBeGreaterThanOrEqual(6);
      expect(card.slice(billEnd)).not.toContain('class="li"');
    }
    const comparisonEnd = html.indexOf("</section>", comparisonStart);
    expect(html.indexOf("details.bill")).toBeGreaterThan(
      html.lastIndexOf("</details>", comparisonEnd),
    );
    expect(html.indexOf("details.bill")).toBeLessThan(comparisonEnd);
    expect(html).toContain(".vs .card .tot{order:-1");
    expect(html).toContain("details.bill");
    expect(html).not.toContain("Auth0");
    const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    for (const [cf, requestHeaders, expectedRegion] of [
      [{ country: "NL", continent: "EU" }, navigation, "eu"],
      [{ country: "US", continent: "NA" }, navigation, "us"],
      [undefined, { ...navigation, "cf-ipcountry": "NL" }, ""],
      [{ country: "NL", continent: "EU" }, {}, ""],
    ] as const) {
      const request = new Request("https://ohmyho.st/", { headers: requestHeaders });
      Object.defineProperty(request, "cf", { value: cf });
      const response = await worker.fetch(request, { ASSETS: assets });
      const page = await response.text();
      expect(page).toContain(`<meta name="ohmyhost-region-hint" content="${expectedRegion}">`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
        .map((match) => match[1] ?? "")
        .find((text) => text.includes('meta[name="ohmyhost-region-hint"]'));
      expect(script).toBeDefined();
      let copied = "";
      let click: ((event: unknown) => Promise<void>) | undefined;
      const label = { textContent: "" };
      const button = { querySelector: () => label, closest: () => null, classList: { add() {} } };
      runInNewContext(script ?? "", {
        document: {
          querySelector: (selector: string) =>
            selector.includes("ohmyhost-region-hint") ? { content: expectedRegion } : null,
          querySelectorAll: () => [],
          getElementById: () => null,
          addEventListener: (_name: string, handler: (event: unknown) => Promise<void>) => {
            click = handler;
          },
        },
        navigator: {
          clipboard: {
            writeText: async (text: string) => {
              copied = text;
            },
          },
        },
        setTimeout: () => undefined,
      });
      if (!click) throw Error("Homepage copy handler missing");
      await click({
        target: { closest: () => button },
        preventDefault() {},
        stopImmediatePropagation() {},
      });
      expect(copied).toContain(
        expectedRegion
          ? `use ${expectedRegion.toUpperCase()} based on this browser's region unless I specify another region`
          : "ask me once whether to use EU or US unless I already specified a region",
      );
      expect(copied).toContain("Keep existing projects in their current region.");
    }
    expect(html).not.toContain("logos/auth0.svg");
    expect(html).toContain("Better Auth, WorkOS or anything else that speaks OAuth, OIDC or SAML");
    expect(html).toContain('id="auth-logos" style="grid-template-columns:repeat(3,1fr)"');
    expect(
      (await worker.fetch(new Request("https://ohmyho.st/logos/auth0.svg"), { ASSETS: assets }))
        .status,
    ).toBe(503);
    expect(
      (await worker.fetch(new Request("https://ohmyho.st/logos/workos.svg"), { ASSETS: assets }))
        .status,
    ).toBe(200);
    const icon = await worker.fetch(new Request("https://ohmyho.st/favicon.svg"));
    expect(await icon.text()).toContain("M30 86 H15 L27 63");
    for (const [path, mime] of [
      ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/brand/assets/omega-dark.png", "image/png"],
      ["/brand/assets/omega-light.svg", "image/svg+xml"],
    ]) {
      const response = await worker.fetch(new Request(`https://ohmyho.st${path}`), {
        ASSETS: assets,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mime);
    }
    expect(
      (
        await worker.fetch(
          new Request("https://ohmyho.st/brand/reference/2026-09-14/manifest.json"),
          { ASSETS: assets },
        )
      ).status,
    ).toBe(503);
    const installer = await worker.fetch(
      new Request("https://omh.st/0.sh?r=hostmebaby&token=private"),
      { ASSETS: assets },
    );
    expect(installer.status).toBe(200);
    const installerText = await installer.text();
    expect(installerText).toContain("OHMYHOST_SIGNUP_SOURCE='hostmebaby'");
    expect(
      await (await worker.fetch(new Request("https://omh.st/0.sh"), { ASSETS: assets })).text(),
    ).toContain("OHMYHOST_SIGNUP_SOURCE=''");
    expect(installerText).toContain(`omh_release='${CLIENT_RELEASE}'`);
    expect(installerText).toContain(
      "Read the current project source binding first and continue its saved source. For an unbound directory, honor an explicit source choice without asking again.",
    );
    expect(installerText).toContain(
      "Otherwise keep a relevant authorized GitHub repository when present; only an unbound directory without one needs the single choice of saving versions with ohmyho.st or setting up GitHub.",
    );
    expect(installerText).toContain("Plan and deploy the exact saved version");
    expect(installerText).not.toContain("using only my explicitly authorized GitHub repository");
    expect(installerText).not.toMatch(/upload source path|source uploads/u);
    expect(installerText).toContain("Hermes 0.21 or newer is required for interactive onboarding.");
    expect(installerText.indexOf("Hermes 0.21 or newer")).toBeLessThan(
      installerText.indexOf("npm install --global"),
    );
    expect(installerText).toContain("Project directory (JSON string): $omh_project_json");
    expect(installerText).toContain("do not deploy a different workspace");
    expect(installerText).not.toContain("private");
    expect(installerText).not.toContain("@CLIENT_RELEASE@");
    // The installer checks each tarball against the published checksums and the manifest's source commit before npm runs.
    expect(installerText).toContain("SHA256SUMS");
    expect(installerText).toContain("manifest.json");
    expect(installerText).toContain("source_commit");
    expect(installerText.indexOf("failed its published checksum")).toBeLessThan(
      installerText.indexOf("npm install --global"),
    );
    // The EXIT trap never runs after exec, so the downloaded tarballs are removed explicitly before the agent starts.
    const cleanup = installerText.indexOf('\nrm -rf "$omh_work"\n');
    expect(cleanup).toBeGreaterThan(installerText.indexOf("npm install --global"));
    expect(cleanup).toBeLessThan(installerText.indexOf('\ncase "$omh_agent" in'));
    expect((await worker.fetch(new Request("http://omh.st/0.sh"))).status).toBe(308);
    expect(html).toContain("ohmyhost-get-started");
    for (const image of ["/og.png", "/logo.png"]) {
      const response = await worker.fetch(new Request(`https://ohmyho.st${image}`), {
        ASSETS: assets,
      });
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 4))).toEqual([
        137, 80, 78, 71,
      ]);
    }
    const brand = await worker.fetch(new Request("https://ohmyho.st/brand"), { ASSETS: assets });
    expect(await brand.text()).toBe(
      await readFile(new URL("../public/pages/brand.html", import.meta.url), "utf8"),
    );
    for (const path of [
      "/index.md",
      "/brand.md",
      "/api/openapi.yaml",
      "/robots.txt",
      "/sitemap.xml",
      "/mcp-tools.json",
      "/mcp.json",
      "/client-release.json",
      "/.well-known/agent-skills/index.json",
    ]) {
      const response = await worker.fetch(new Request(`https://ohmyho.st${path}`), {
        ASSETS: assets,
      });
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(30);
    }
    for (const path of [
      "/docs",
      "/docs/cli",
      "/docs/mcp",
      "/docs/skills",
      "/docs/domains",
      "/docs/usage",
      "/docs/backups",
    ]) {
      expect((await worker.fetch(new Request(`https://ohmyho.st${path}.md`))).status).toBe(308);
    }
    const login = await worker.fetch(
      new Request("https://ohmyho.st/login?r=hostmebaby&next=https://foreign.example&token=secret"),
    );
    expect(login.headers.get("location")).toBe("https://app.ohmyho.st/login?r=hostmebaby");
    expect(home.headers.get("link")).toContain("/index.md");
    expect(home.headers.get("content-security-policy")).toContain("font-src 'self'");
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/u);
    expect(html).toContain('id="cookie-notice"');
    const font = (await readdir(new URL("../public/fonts", import.meta.url))).find((name) =>
      name.endsWith(".ttf"),
    );
    const fontResponse = await worker.fetch(new Request(`https://ohmyho.st/fonts/${font}`), {
      ASSETS: assets,
    });
    expect(fontResponse.headers.get("content-type")).toBe("font/ttf");
    expect(Array.from(new Uint8Array(await fontResponse.arrayBuffer()).slice(0, 4))).toEqual([
      0, 1, 0, 0,
    ]);
    expect(html).toContain('href="https://docs.ohmyho.st/"');
    const docs = await worker.fetch(new Request("https://ohmyho.st/docs"));
    expect(docs.status).toBe(308);
    expect(docs.headers.get("location")).toBe("https://docs.ohmyho.st/");
    const llms = await worker.fetch(new Request("https://ohmyho.st/llms.txt"));
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain("/skills/ohmyhost-build-portable-app/SKILL.md");
    const skill = await worker.fetch(
      new Request("https://ohmyho.st/skills/ohmyhost-build-portable-app/SKILL.md"),
    );
    expect(skill.status).toBe(200);
    expect(await skill.text()).toContain("feedback");
    // The legal and pricing copy belongs to the website repository: without its binding these pages
    // answer 503, and this Worker holds no copy to compare.
    for (const path of ["/terms", "/pricing", "/pricing/breakdown.md", "/privacy"]) {
      const unavailable = await worker.fetch(new Request(`https://ohmyho.st${path}`));
      expect(unavailable.status, path).toBe(503);
      expect(unavailable.headers.get("retry-after"), path).toBe("300");
    }
    expect(html).not.toContain("private-ticket");
    expect(home.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(
      await (await worker.fetch(new Request("https://ohmyho.st/", { method: "HEAD" }))).text(),
    ).toBe("");
    expect(
      (await worker.fetch(new Request("https://ohmyho.st/favicon.svg"))).headers.get(
        "content-type",
      ),
    ).toContain("image/svg+xml");
    expect((await worker.fetch(new Request("https://ohmyho.st/missing"))).status).toBe(503);
  });

  it("tracks one bounded signup source as escaped page metadata on the home page, never as a gate", async () => {
    const ASSETS = new SiteAssetFixture();
    for (const path of ["/"]) {
      const tracked = await worker.fetch(
        new Request(
          `https://ohmyho.st${path}?r=${encodeURIComponent("<b>\"'&")}&ticket=do-not-reflect`,
        ),
        { ASSETS },
      );
      expect(tracked.status).toBe(200);
      const html = await tracked.text();
      expect(html).toContain(
        '<meta name="ohmyhost-signup-source" content="&lt;b&gt;&quot;&#39;&amp;">',
      );
      expect(html).not.toContain("do-not-reflect");
      for (const query of ["", "?r=one&r=two", `?r=${"x".repeat(65)}`]) {
        const untracked = await worker.fetch(new Request(`https://ohmyho.st${path}${query}`), {
          ASSETS,
        });
        expect(untracked.status).toBe(200);
        expect(await untracked.text()).not.toContain('<meta name="ohmyhost-signup-source"');
      }
    }
  });

  it("moves legacy documentation directly to its canonical HTML or Markdown page", async () => {
    const routes: Record<string, string> = {
      "/docs": "/",
      "/docs/": "/",
      "/docs.md": "/index.md",
      "/docs/index.md": "/llms.txt",
      "/docs/mcp": "/agents/mcp",
      "/docs/agents/mcp.md": "/agents/mcp.md",
      "/docs/mcp.md": "/agents/mcp.md",
      "/docs/nextjs": "/frameworks/nextjs",
      "/docs/vite": "/frameworks/vite",
      "/docs/react.md": "/frameworks/vite.md",
      "/docs/tanstack": "/frameworks/tanstack",
      "/docs/postgres": "/database",
      "/docs/credits": "/usage",
      "/docs/spend-cap": "/budgets",
      "/docs/dev-and-prod": "/environments",
      "/docs/changelog": "/changelog",
      "/docs/cli/": "/cli",
      "/docs/missing.md": "/missing.md",
      "/api": "/api",
      "/api.md": "/api.md",
      "/llms-full.txt": "/llms-full.txt",
    };
    for (const [path, target] of Object.entries(routes))
      for (const method of ["GET", "HEAD"]) {
        const response = await worker.fetch(
          new Request(`https://ohmyho.st${path}?token=private&next=https://foreign.example`, {
            method,
          }),
        );
        expect(response.status).toBe(308);
        expect(response.headers.get("location")).toBe(`https://docs.ohmyho.st${target}`);
        expect(response.headers.get("vary")).toBe("Accept");
        expect(await response.text()).toBe("");
      }
    for (const path of ["/docs", "/docs/cli", "/api"]) {
      const response = await worker.fetch(
        new Request(`https://ohmyho.st${path}`, { headers: { accept: "text/markdown" } }),
      );
      expect(response.headers.get("location")).toBe(
        `https://docs.ohmyho.st${path === "/docs" ? "/index" : path.replace("/docs", "")}.md`,
      );
      expect(
        (await worker.fetch(new Request(`https://ohmyho.st${path}`, { method: "POST" }))).status,
      ).toBe(405);
    }
    const config = await worker.fetch(new Request("https://ohmyho.st/mcp.json"));
    expect(await config.json()).toEqual({
      mcpServers: {
        ohmyho: { command: "ohmyhost-mcp", env: { OHMYHOST_ENVIRONMENT: "production" } },
      },
    });
    const release = await worker.fetch(new Request("https://ohmyho.st/client-release.json"));
    expect(await release.json()).toEqual({
      version: CLIENT_RELEASE,
      manifest_url: `https://ohmyho.st/releases/${CLIENT_RELEASE}/manifest.json`,
    });
    const index = await worker.fetch(new Request("https://ohmyho.st/llms.txt"));
    const text = await index.text();
    expect(text).toContain("https://docs.ohmyho.st/quickstart.md");
    expect(text).not.toContain("https://ohmyho.st/docs/");
    expect(text).toContain("https://ohmyho.st/mcp.json");
    expect(text).toContain("https://app.ohmyho.st/mcp");
    expect(text).toContain("For clients that support authenticated remote MCP");
    expect(text).toContain(
      "existing server binding and an explicit source choice remain authoritative",
    );
    expect(text).toContain("A new app developed entirely in chat starts with managed versions");
    const rules = await (await worker.fetch(new Request("https://ohmyho.st/AGENTS.md"))).text();
    expect(rules.match(/^\d\. /gmu)).toHaveLength(5);
    expect(rules).toContain("server's current source binding comes first");
    expect(rules).toContain("An explicit choice skips that question");
    expect(rules).toContain("Source choice follows the app across local and cloud agents");
    expect(rules).toContain("secret_input_request and its private portal link");
    expect(rules).toContain("stdin command from secret_set_command");
    expect(rules).toContain("Publish only when requested and authorized");
    const authentication = await (
      await worker.fetch(new Request("https://ohmyho.st/auth.md"))
    ).text();
    expect(authentication).toContain("No copied API token or device-code login is needed");
    expect(authentication).toContain(
      "your current user rights across your workspaces and projects",
    );
    expect(authentication).toContain(
      "Existing active connections receive the same access without reconnecting",
    );
    expect(authentication).not.toContain("approve the workspace and selected projects");
    expect(authentication).not.toContain("after approval");
    expect(authentication).toContain("same person as the chat connection");
    expect(authentication).toContain("local stdio MCP server uses that saved CLI login");
    // Public copied guidance must choose the existing app's matching context before OAuth.
    const authRouting = authentication.slice(0, authentication.indexOf("## Connected chat"));
    const entryRule = rules.match(/^2\. (.+)$/mu)?.[1] ?? "";
    for (const guidance of [authRouting, entryRule]) {
      expect(guidance).toMatch(/execution environment.*reachable checkout.*saved project binding/u);
      expect(guidance).toMatch(
        /matching local CLI\/MCP profile or private token source.*explicitly chooses remote/u,
      );
      expect(guidance).toMatch(/remote tools alone does not choose/u);
      expect(guidance).toMatch(/verify.*identity and workspace.*continuing.*stop.*mismatch/u);
    }
    expect(authentication).toContain("# Authenticate an ohmyho.st agent");
    const sitemap = await worker.fetch(new Request("https://ohmyho.st/sitemap.xml"));
    expect(await sitemap.text()).not.toContain("https://ohmyho.st/docs");
    const unsafe = await worker.fetch(
      new Request("https://ohmyho.st/docs//foreign.example/path.md"),
    );
    expect(new URL(unsafe.headers.get("location") ?? "").origin).toBe("https://docs.ohmyho.st");
  });

  it("redirects bare and unassigned Free hosts to the fixed home without ticket or query", async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request("https://www.ohmyho.st/pricing?r=hostmebaby&token=private", { method }),
      );
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("https://ohmyho.st/pricing?r=hostmebaby");
      expect(await response.text()).toBe("");
      expect(
        (await worker.fetch(new Request("http://www.ohmyho.st/docs/mcp?r=one&r=two"))).headers.get(
          "location",
        ),
      ).toBe("https://ohmyho.st/docs/mcp");
    }
    for (const host of [
      "omh.st",
      "check.omh.st",
      "dev.check.omh.st",
      "calm-river-builds.check.omh.st",
      "dev-calm-river-builds.dev.check.omh.st",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await worker.fetch(
          new Request(
            `https://${host}/private?ticket=private-ticket&next=https://foreign.example`,
            { method },
          ),
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("https://ohmyho.st/");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(await response.text()).toBe("");
        const referred = await worker.fetch(
          new Request(
            `https://${host}/private?r=hostmebaby&ticket=private-ticket&next=https://foreign.example`,
            { method },
          ),
        );
        expect(referred.headers.get("location")).toBe(
          host === "omh.st" || host === "check.omh.st"
            ? "https://ohmyho.st/?r=hostmebaby"
            : "https://ohmyho.st/",
        );
        const ambiguous = await worker.fetch(
          new Request(`https://${host}/?r=one&r=two`, { method }),
        );
        expect(ambiguous.headers.get("location")).toBe("https://ohmyho.st/");
      }
    }
  });

  it("does not redirect writes, protected API hosts or foreign domains", async () => {
    for (const host of ["ohmyho.st", "omh.st", "check.omh.st", "missing.check.omh.st"]) {
      const response = await worker.fetch(
        new Request(`https://${host}/`, { method: "POST", body: "private-payload" }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.has("location")).toBe(false);
      expect(await response.text()).not.toContain("private-payload");
    }
    for (const host of [
      "app.ohmyho.st",
      "dev.app.ohmyho.st",
      "poc.tenant-fixture.com",
      "foreigncheck.omh.st",
      "check.omh.st.foreign.example",
      "ohm.st",
    ]) {
      const response = await worker.fetch(
        new Request(`https://${host}/`, { headers: { host: "ohmyho.st" } }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.has("location")).toBe(false);
    }
  });
});

it("serves only pinned public client assets and strips credentials before the asset binding", async () => {
  const fixture = new PublicAssetFixture();
  const url = `https://ohmyho.st/releases/${CLIENT_RELEASE}/ohmyhost-product-cli-${CLIENT_RELEASE}.tgz`;
  const response = await worker.fetch(
    new Request(url + "?token=private", {
      headers: { authorization: "Bearer private", cookie: "private" },
    }),
    { ASSETS: fixture },
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("test-client-archive");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.url).toBe(url);
  expect(fixture.requests[0]?.headers.has("authorization")).toBe(false);
  expect(fixture.requests[0]?.headers.has("cookie")).toBe(false);
  expect((await worker.fetch(new Request(url))).status).toBe(503);
  const unknown = await worker.fetch(new Request("https://ohmyho.st/releases/0.1.1/.env.local"), {
    ASSETS: fixture,
  });
  expect(unknown.status).toBe(404);
  expect(fixture.requests).toHaveLength(1);
  expect(
    (
      await worker.fetch(new Request("https://ohmyho.st/.well-known/skills/index.json"))
    ).headers.get("content-type"),
  ).toContain("application/json");
  const index = await (
    await worker.fetch(new Request("https://ohmyho.st/.well-known/skills/index.json"))
  ).json();
  expect(index.skills).toHaveLength(10);
  expect(index.skills).toContainEqual(
    expect.objectContaining({
      name: "ohmyhost-deploy",
      url: "https://ohmyho.st/skills/ohmyhost-deploy/SKILL.md",
    }),
  );
  for (const entry of index.skills) {
    const document = await worker.fetch(new Request(entry.url));
    expect(document.status).toBe(200);
    expect(await document.text()).toContain(`name: ${entry.name}`);
  }
  // Only the current release is downloadable; superseded versions never reach assets.
  const currentUrl = `https://ohmyho.st/releases/${CLIENT_RELEASE}/ohmyhost-product-cli-${CLIENT_RELEASE}.tgz`;
  expect((await worker.fetch(new Request(currentUrl), { ASSETS: fixture })).status).toBe(200);
  expect(fixture.requests).toHaveLength(2);
  for (const retired of ["0.1.9", "0.1.8", "0.1.7", "0.1.6", "0.1.5"])
    expect(
      (
        await worker.fetch(
          new Request(
            `https://ohmyho.st/releases/${retired}/ohmyhost-customer-runtime-${retired}.tgz`,
          ),
          { ASSETS: fixture },
        )
      ).status,
    ).toBe(404);
  for (const invalid of [
    "https://ohmyho.st/releases/0.1.3/ohmyhost-product-cli-0.1.3.tgz",
    "https://ohmyho.st/releases/0.1.0/manifest.json",
    "https://ohmyho.st/releases/0.1.4/ohmyhost-product-cli-0.1.4.tgz",
    `https://ohmyho.st/releases/${CLIENT_RELEASE}/ohmyhost-product-cli-0.1.3.tgz`,
    "https://ohmyho.st/releases/0.1.9/manifest.json",
    `https://ohmyho.st/releases/${CLIENT_RELEASE}/.env.local`,
  ])
    expect((await worker.fetch(new Request(invalid), { ASSETS: fixture })).status).toBe(404);
  expect(fixture.requests).toHaveLength(2);
});

it("serves the released tool catalog beside the client archives, for the current release only", async () => {
  const fixture = new PublicAssetFixture();
  const url = `https://ohmyho.st/releases/${CLIENT_RELEASE}/mcp-tools.json`;
  const response = await worker.fetch(new Request(url), { ASSETS: fixture });
  expect(response.status).toBe(200);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.url).toBe(url);
  for (const retired of ["0.1.9", "0.1.0"])
    expect(
      (
        await worker.fetch(new Request(`https://ohmyho.st/releases/${retired}/mcp-tools.json`), {
          ASSETS: fixture,
        })
      ).status,
    ).toBe(404);
  expect(fixture.requests).toHaveLength(1);
});

class PublicAssetFixture {
  readonly requests: Request[] = [];
  async fetch(request: Request) {
    this.requests.push(request);
    return new Response("test-client-archive", { headers: { "content-type": "application/gzip" } });
  }
}

class SiteAssetFixture {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (
      ![
        "/pages/home.html",
        "/pages/og.png",
        "/pages/logo.png",
        "/pages/brand.html",
        "/pages/index.md",
        "/pages/brand.md",
        "/pages/openapi.yaml",
        "/pages/0.sh",
        "/logos/workos.svg",
      ].includes(path) &&
      !/^\/pages\/brand-assets\/(?:omega-(?:light|dark)\.(?:svg|png)|favicon\.(?:svg|ico)|apple-touch-icon\.png|founder\.png|og\.png)$/u.test(
        path,
      ) &&
      !/^\/fonts\/[a-f0-9]{16}\.ttf$/u.test(path)
    )
      return new Response(null, { status: 404 });
    const text = await readFile(new URL(`../public${path}`, import.meta.url));
    return new Response(new Uint8Array(text));
  }
}

describe("website delegation", () => {
  it("hands pages to the website Worker and keeps the client downloads itself", async () => {
    const forwarded: string[] = [];
    const website = {
      fetch: async (request: Request) => {
        forwarded.push(new URL(request.url).pathname);
        return new Response("<!doctype html><p>from the website repository</p>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    };
    const assets = new SiteAssetFixture();

    const page = await worker.fetch(new Request("https://ohmyho.st/pricing"), {
      ASSETS: assets,
      WEBSITE: website,
    });
    expect(await page.text()).toContain("from the website repository");

    // The released clients, their installer and the current-release pointer stay here.
    const release = await worker.fetch(new Request("https://ohmyho.st/client-release.json"), {
      ASSETS: assets,
      WEBSITE: website,
    });
    expect(JSON.parse(await release.text())).toMatchObject({ version: CLIENT_RELEASE });
    const installer = await worker.fetch(new Request("https://omh.st/0.sh"), {
      ASSETS: assets,
      WEBSITE: website,
    });
    expect(installer.headers.get("content-type")).toContain("text/x-shellscript");
    expect(forwarded).toEqual(["/pricing"]);

    // Without the binding this Worker serves no copy of the legal, pricing or content pages: they
    // answer 503, so a removed binding cannot publish superseded copy. The released installer and the
    // current release pointer stay here.
    for (const path of ["/pricing", "/terms", "/dpa/subprocessors", "/privacy"]) {
      const direct = await worker.fetch(new Request(`https://ohmyho.st${path}`), {
        ASSETS: assets,
      });
      expect(direct.status, path).toBe(503);
    }
    expect(
      await (
        await worker.fetch(new Request("https://ohmyho.st/pricing", { method: "HEAD" }))
      ).text(),
    ).toBe("");
    const api = await worker.fetch(new Request("https://ohmyho.st/v1/projects"), {
      ASSETS: assets,
    });
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toBe("application/problem+json");
    expect(
      (await worker.fetch(new Request("https://omh.st/0.sh"), { ASSETS: assets })).status,
    ).toBe(200);
    expect(
      (await worker.fetch(new Request("https://ohmyho.st/client-release.json"), { ASSETS: assets }))
        .status,
    ).toBe(200);
  });

  it("answers the agent instruction documents itself, so a customer's agent reads this release's instructions", async () => {
    const forwarded: string[] = [];
    const website = {
      fetch: async (request: Request) => {
        forwarded.push(new URL(request.url).pathname);
        return new Response("a copy held by the website repository");
      },
    };
    const assets = new SiteAssetFixture();
    for (const path of [
      "/llms.txt",
      "/AGENTS.md",
      "/mcp.json",
      "/mcp-tools.json",
      "/auth.md",
      "/.well-known/agent-skills/index.json",
      "/.well-known/skills/index.json",
      "/skills/ohmyhost-get-started/SKILL.md",
    ]) {
      const response = await worker.fetch(new Request(`https://ohmyho.st${path}`), {
        ASSETS: assets,
        WEBSITE: website,
      });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toContain("a copy held by the website repository");
    }
    expect(forwarded).toEqual([]);
  });

  it("answers HEAD for an agent instruction document here, and an unknown skill with 404 without the website", async () => {
    const forwarded: string[] = [];
    const website = {
      fetch: async (request: Request) => {
        forwarded.push(new URL(request.url).pathname);
        return new Response("a copy held by the website repository");
      },
    };
    const assets = new SiteAssetFixture();
    const head = await worker.fetch(new Request("https://ohmyho.st/llms.txt", { method: "HEAD" }), {
      ASSETS: assets,
      WEBSITE: website,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/plain");
    expect(await head.text()).toBe("");
    const unknown = await worker.fetch(new Request("https://ohmyho.st/skills/x"), {
      ASSETS: assets,
      WEBSITE: website,
    });
    expect(unknown.status).toBe(404);
    expect(forwarded).toEqual([]);
  });
});
