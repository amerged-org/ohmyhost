import { describe, expect, it } from "vitest";

import {
  analyzeNextWorkersCompatibility,
  assertNextWorkersCompatibility,
  inspectWorkerRuntimeImports,
  NextWorkersIncompatibleError,
  nextRuntimeSourcePaths,
} from "./next-workers-compatibility.js";

describe("Next.js Workers compatibility analysis", () => {
  it("reads the imports of decorated TypeScript instead of refusing its decorator syntax", () => {
    const decorated = [
      'import { LitElement } from "lit";',
      'import { customElement, property } from "lit/decorators.js";',
      '@customElement("my-card")',
      "export class MyCard extends LitElement {",
      '  @property({ type: String }) title = "";',
      "}",
    ].join("\n");
    const card = inspectWorkerRuntimeImports("src/components/card.ts", decorated);
    expect([...card.imports].sort()).toEqual(["lit", "lit/decorators.js"]);
    expect(card.findings).toEqual([]);
    const decoratedTsx = [
      'import { exec } from "node:child_process";',
      "@sealed class Runner { @log run() { return exec; } }",
    ].join("\n");
    expect(inspectWorkerRuntimeImports("src/components/runner.tsx", decoratedTsx).findings).toEqual(
      [
        {
          code: "workers_node_stub_module",
          path: "src/components/runner.tsx",
          module: "node:child_process",
        },
      ],
    );
  });

  it("keeps the normal Next.js Node runtime on Workers", () => {
    const sources = [
      {
        path: "src/app/page.tsx",
        source: `export const runtime = "nodejs"; import { createHash } from "node:crypto";`,
      },
    ];
    expect(analyzeNextWorkersCompatibility(sources)).toEqual([]);
    expect(() => assertNextWorkersCompatibility(sources)).not.toThrow();
  });

  it("accepts nested template literals without treating their text as module imports", () => {
    const sources = [
      {
        path: "src/app/api/inquiry/route.ts",
        source: [
          'import { randomUUID } from "node:crypto";',
          'const subject = `Inquiry${preferredPlace ? `: ${preferredPlace}` : ""}`;',
          'const html = `<div>${message ? `<p>${message}</p>` : ""}</div>`;',
          'const example = `import("node:worker_threads")`;',
          'const escaped = html.replace(/"/g, "&quot;");',
          "void randomUUID; void subject; void html; void example; void escaped;",
        ].join("\n"),
      },
    ];

    expect(analyzeNextWorkersCompatibility(sources)).toEqual([]);
    expect(() => assertNextWorkersCompatibility(sources)).not.toThrow();
  });

  it("admits Node Proxy but defers native addons and non-functional Worker modules", () => {
    const sources = [
      { path: "src/proxy.ts", source: `export default function proxy() {}` },
      {
        path: "src/app/api/report/route.ts",
        source: `
          import type { Worker } from "node:worker_threads";
          import { Worker as RuntimeWorker } from "node:worker_threads";
          const child = require("child_process");
          void import("node:sqlite");
          void import("./build/addon.node");
          export { open } from "node:sqlite";
          // require("node:v8")
          const text = "node:cluster";
          export { child, RuntimeWorker };
        `,
      },
    ];
    expect(analyzeNextWorkersCompatibility(sources.slice(0, 1))).toEqual([]);
    const findings = analyzeNextWorkersCompatibility(sources);
    expect(findings).toEqual([
      {
        code: "native_addon_unsupported",
        path: "src/app/api/report/route.ts",
        module: "./build/addon.node",
      },
      {
        code: "workers_node_stub_module",
        path: "src/app/api/report/route.ts",
        module: "child_process",
      },
      {
        code: "workers_node_stub_module",
        path: "src/app/api/report/route.ts",
        module: "node:sqlite",
      },
      {
        code: "workers_node_stub_module",
        path: "src/app/api/report/route.ts",
        module: "node:worker_threads",
      },
    ]);
    expect(() => assertNextWorkersCompatibility(sources)).toThrow(NextWorkersIncompatibleError);
    try {
      assertNextWorkersCompatibility(sources);
    } catch (error) {
      expect(error).toMatchObject({
        code: "next_workers_runtime_incompatible",
        classification: "unsupported",
        message:
          "Next.js source uses a native addon or a Node.js API that does not function on Workers",
        findings,
      });
    }
  });

  it("admits ordinary JSX text and attributes while checking executable imports", () => {
    const source = `import { withAuth } from '@workos-inc/authkit-nextjs';
      export default async function Page() {
        const {user} = await withAuth();
        return <main><p>{user ? 'Signed in' : 'Signed out'}</p>
          <nav><a href='/login'>Sign in</a> | <a href='/logout'>Sign out</a></nav>
          <p>Don't parse import("node:vm") from displayed JSX text.</p>
          <span>{3 < /x/.source.length ? 'small' : 'large'}</span>
        </main>;
      }`;
    expect(analyzeNextWorkersCompatibility([{ path: "app/page.tsx", source }])).toEqual([]);
    expect(() =>
      analyzeNextWorkersCompatibility([{ path: "app/page.tsx", source: "export default <div>" }]),
    ).toThrow(TypeError);
  });

  it("finds runtime imports inside JSX and template expressions without treating types as runtime", () => {
    const source = `import type { Worker } from 'node:worker_threads';
      export type { Worker as WorkerType } from 'node:worker_threads';
      import Child = require('node:child_process');
      export const view = <span>{import('node:vm')}</span>;
      export const rendered = \`value: \${import('node:sqlite')}\`;
      const native = module.require('./addon.node');
      void Child; void native;`;
    expect(
      analyzeNextWorkersCompatibility([{ path: "app/page.tsx", source }]).map((f) => f.module),
    ).toEqual(["./addon.node", "node:child_process", "node:sqlite", "node:vm"]);
  });

  it("selects only Next runtime entry sources and rejects unbounded inventories", () => {
    expect(
      nextRuntimeSourcePaths([
        "src/app/page.tsx",
        "src/lib/server.ts",
        "pages/api/report.js",
        "proxy.ts",
        "scripts/build.ts",
      ]),
    ).toEqual(["pages/api/report.js", "proxy.ts", "src/app/page.tsx"]);
    expect(() =>
      analyzeNextWorkersCompatibility([
        { path: "src/app/page.tsx", source: "x".repeat(256 * 1024 + 1) },
      ]),
    ).toThrow("exceeds inspection limits");
    expect(() =>
      analyzeNextWorkersCompatibility([{ path: "src/lib/server.ts", source: "" }]),
    ).toThrow("inventory is invalid");
  });
});
