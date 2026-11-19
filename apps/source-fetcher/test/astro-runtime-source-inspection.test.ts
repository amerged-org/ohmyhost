import { describe, expect, it } from "vitest";
import { inspectReachableRuntimeSources } from "../src/runtime-source-inspection.js";
import type { FrameworkPlan } from "@ohmyhost/platform";

const plan = { adapter: "astro", runtime: "edge", applicationRoot: "." } as FrameworkPlan;
const archive = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([name, text]) => [name, new TextEncoder().encode(text)]));
describe("Astro server source graph", () => {
  it("follows frontmatter component imports, nested middleware and server utilities", () => {
    const result = inspectReachableRuntimeSources(
      plan,
      archive({
        "src/pages/index.astro":
          '---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout />',
        "src/layouts/Layout.astro":
          '---\nimport value from "../lib/data.js";\n---\n<html>{value}</html>',
        "src/lib/data.ts": 'import postgres from "postgres"; export default postgres;',
        "src/middleware/index.ts": 'import "node:crypto"; export const onRequest = () => {};',
      }),
    );
    expect([...result.sources.keys()]).toEqual(
      expect.arrayContaining([
        "src/pages/index.astro",
        "src/layouts/Layout.astro",
        "src/lib/data.ts",
        "src/middleware/index.ts",
      ]),
    );
    expect(result.socketPath).toBe("src/lib/data.ts");
    expect(result.socketPrimitivePath).toBeNull();
  });
  it("reads the raw socket primitive from decoded specifiers, wherever the file hides it", () => {
    // The parser, not a textual scan, decides: an escape in the specifier, a regex literal that a
    // comment scanner would mistake for a comment, and every module-loading form are all found.
    const worker = {
      adapter: "functions",
      runtime: "functions",
      applicationRoot: ".",
    } as FrameworkPlan;
    const inspect = (source: string, files: Record<string, string> = {}) =>
      inspectReachableRuntimeSources(
        worker,
        archive({ "src/ohmyhost/worker.ts": source, ...files }),
      ).socketPrimitivePath;
    for (const source of [
      'import { connect } from "cloudflare:sockets";\nexport default { fetch: () => new Response(String(connect)) };\n',
      'import "cloudflare:sockets";\nexport default {};\n',
      'export { connect } from "cloudflare:sockets";\n',
      'export default { async fetch() { return new Response(String(await import("cloudflare\\x3asockets"))); } };\n',
      'const { connect } = require("cloudflare\\u003asockets");\nexport default { fetch: () => new Response(String(connect)) };\n',
      "export default { fetch: async () => new Response(String(await import(`cloudflare:sockets`))) };\n",
      'const hidden = /[/*]/;\nimport { connect } from "cloudflare:sockets";\nexport default { fetch: () => new Response(String(hidden) + String(connect)) };\n',
      'const hidden = /[//]/; export default { async fetch() { await import("cloudflare:sockets"); return new Response(String(hidden)); } };\n',
      'import net = require("cloudflare:sockets");\nexport default { fetch: () => new Response(String(net)) };\n',
    ])
      expect(inspect(source), source).toBe("src/ohmyhost/worker.ts");
    // A local module the Worker imports is judged where it lives.
    expect(
      inspect('import "./tcp.js";\nexport default { fetch: () => new Response() };\n', {
        "src/ohmyhost/tcp.ts": 'export const open = () => import("cloudflare:sockets");\n',
      }),
    ).toBe("src/ohmyhost/tcp.ts");
    // Deliberate limits: other Node networking modules, a type-only import, a comment and a
    // specifier built at run time are not found by the source walk.
    for (const source of [
      'import net from "node:net";\nimport tls from "node:tls";\nexport default { fetch: () => new Response(String(net) + String(tls)) };\n',
      'import type { Socket } from "cloudflare:sockets";\nexport default { fetch: () => new Response() };\n',
      '// import { connect } from "cloudflare:sockets";\nexport default { fetch: () => new Response() };\n',
      'const name = "cloudflare:" + "sockets";\nexport default { fetch: () => import(name).then(() => new Response()) };\n',
    ])
      expect(inspect(source), source).toBeNull();
  });
  it("refuses non-functional Workers imports and server template imports including script attributes and dynamic browser script imports", () => {
    expect(() =>
      inspectReachableRuntimeSources(
        plan,
        archive({
          "src/pages/index.astro": '---\nimport cp from "node:child_process";\n---\n<p>Hello</p>',
        }),
      ),
    ).toThrow();
    for (const prefix of [
      "\n",
      "  ",
      "<!-- before -->\n",
      "<div>before</div>\n---\nconst before = 1;\n---\n",
    ])
      expect(() =>
        inspectReachableRuntimeSources(
          plan,
          archive({
            "src/pages/index.astro":
              prefix + '---\nimport cp from "node:child_process";\n---\n<h1>Hello</h1>',
          }),
        ),
      ).toThrow();
    expect(() =>
      inspectReachableRuntimeSources(
        plan,
        archive({ "src/pages/index.astro": '<p>{await import("node:child_process")}</p>' }),
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostic: { code: "astro_template_import_unsupported", path: "src/pages/index.astro" },
      }),
    );
    expect(() =>
      inspectReachableRuntimeSources(
        plan,
        archive({ "src/pages/index.astro": '<script>import "./browser.ts";</script><p>Hello</p>' }),
      ),
    ).not.toThrow();
    for (const source of [
      '<script define:vars={{x: await import("node:child_process")}}>console.log(x)</script>',
      '<script>import("./browser.ts")</script>',
      '<p>{require("pg")}</p>',
    ])
      expect(() =>
        inspectReachableRuntimeSources(plan, archive({ "src/pages/index.astro": source })),
      ).toThrowError(
        expect.objectContaining({
          diagnostic: { code: "astro_template_import_unsupported", path: "src/pages/index.astro" },
        }),
      );
  });
  it("scans a template in linear time when imports are followed by unterminated comments", () => {
    const started = performance.now();
    expect(() =>
      inspectReachableRuntimeSources(
        plan,
        archive({ "src/pages/index.astro": "import/*".repeat(32_000) }),
      ),
    ).not.toThrow();
    expect(performance.now() - started).toBeLessThan(200);
  });
  it("does not inspect static build-only Node code and names malformed server frontmatter", () => {
    expect(
      inspectReachableRuntimeSources(
        { ...plan, runtime: "static" },
        archive({ "src/pages/index.astro": '---\nimport "node:child_process";' }),
      ).sources.size,
    ).toBe(0);
    expect(() =>
      inspectReachableRuntimeSources(
        plan,
        archive({ "src/pages/index.astro": "---\nconst value = 1;" }),
      ),
    ).toThrowError(expect.objectContaining({ path: "src/pages/index.astro" }));
  });
});
