import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type * as MiniflareModule from "miniflare";
import * as typescript from "typescript";

/**
 * Called once from W25's third top-level regression pack. Exact source in native workerd: no Node
 * fetch shim and no internet-dependent CI proof.
 */
export async function assertScopedIdentityPack(): Promise<void> {
  // The credit service's Wrangler brings a workerd that honors this service's production date.
  const tooling = createRequire(new URL("../../credit-service/package.json", import.meta.url));
  const wrangler = tooling.resolve("wrangler/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(wrangler)(
    "miniflare",
  ) as typeof MiniflareModule;
  const compatibility = (name: string) => {
    const value: unknown = typescript.parseConfigFileTextToJson(
      name,
      readFileSync(new URL(`../${name}`, import.meta.url), "utf8"),
    ).config;
    return {
      compatibilityDate: Reflect.get(Object(value), "compatibility_date") as string,
      compatibilityFlags: Reflect.get(Object(value), "compatibility_flags") as string[],
    };
  };
  const config = compatibility("wrangler.development.jsonc");
  expect(config).toEqual({
    compatibilityDate: "2026-08-29",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  });
  expect(compatibility("wrangler.production.jsonc")).toEqual(config);
  const observer = fileURLToPath(new URL("../src/application-domain-identity.ts", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import { observeApplicationIdentityTxt } from ${JSON.stringify(observer)};
        export default { async fetch(request) {
          const redirect = new URL(request.url).pathname === '/redirect';
          const name = '_omh-project.' + (redirect ? 'redirect' : 'match') + '.example.com';
          try {
            const matched = await observeApplicationIdentityTxt(
              (input, init) => globalThis.fetch(input, init), name, 'omh-domain-v1=' + 'A'.repeat(43));
            return Response.json({ matched });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.name : 'unknown' }, { status: 503 });
          }
        }};`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "identity-dns-native-fixture.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:workers"],
    plugins: [
      {
        name: "unused-identity-management-dependencies",
        setup(builder) {
          // The pure observer uses none of the database/authority factory imports. Drop only
          // those unused imports; the observer and its local validation remain exact source.
          builder.onResolve({ filter: /^@ohmyhost\// }, ({ path }) => ({
            path,
            external: true,
            sideEffects: false,
          }));
          builder.onResolve({ filter: /^\.\/scoped-dns-authorization\.js$/ }, ({ path }) => ({
            path,
            external: true,
            sideEffects: false,
          }));
        },
      },
    ],
    write: false,
    logLevel: "error",
  });
  const script = bundle.outputFiles[0]?.text;
  if (script === undefined) throw new Error("Native identity observer bundle is empty");
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "identity-observer",
          ...config,
          modules: true,
          script,
          outboundService: "dns-fixture",
        },
        {
          name: "dns-fixture",
          ...config,
          modules: true,
          script: `let requests = []; let followed = 0;
        export default { async fetch(request) {
          const url = new URL(request.url);
          if (url.origin === 'https://fixture.invalid') return Response.json({requests, followed});
          requests.push({origin:url.origin, method:request.method, accept:request.headers.get('accept'),
            name:url.searchParams.get('name'), type:url.searchParams.get('type'), redirect:request.redirect});
          if (url.origin !== 'https://cloudflare-dns.com') { followed++; return new Response(null, {status:503}); }
          const name = url.searchParams.get('name');
          if (name === '_omh-project.redirect.example.com') return new Response(null,
            {status:302,headers:{location:'https://redirect-target.invalid/dns-query'}});
          return Response.json({Status:0,Answer:[{name:name+'.',type:16,data:'"omh-domain-v1='+'A'.repeat(43)+'"'}]});
        }};`,
        },
      ],
    }),
  );
  try {
    const matched = await runtime.dispatchFetch("https://observer.invalid/match");
    const fixture = await runtime.getWorker("dns-fixture");
    const initial = (await (await fixture.fetch("https://fixture.invalid/state")).json()) as {
      requests: unknown[];
      followed: number;
    };
    expect({
      status: matched.status,
      body: await matched.json(),
      outboundRequests: initial.requests.length,
    }).toEqual({ status: 200, body: { matched: true }, outboundRequests: 1 });
    const redirect = await runtime.dispatchFetch("https://observer.invalid/redirect");
    expect(redirect.status).toBe(503);
    expect(await redirect.json()).toEqual({ error: "Error" });
    expect(await (await fixture.fetch("https://fixture.invalid/state")).json()).toEqual({
      requests: ["match", "redirect"].map((name) => ({
        origin: "https://cloudflare-dns.com",
        method: "GET",
        accept: "application/dns-json",
        name: `_omh-project.${name}.example.com`,
        type: "TXT",
        redirect: "manual",
      })),
      followed: 0,
    });
  } finally {
    await runtime.dispose();
  }
}
