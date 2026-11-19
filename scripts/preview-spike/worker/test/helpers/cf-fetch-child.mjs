import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

const require = createRequire(path.join(process.env.CF_TEST_TOOLING_ROOT, "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const started = performance.now();
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "cf-regression",
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        modules: [
          {
            type: "ESModule",
            path: "main.mjs",
            contents: "export default { fetch(request) { return Response.json(request.cf); } };",
          },
        ],
      },
    ],
  }),
);
try {
  const response = await runtime.dispatchFetch("http://localhost/");
  const cf = await response.json();
  process.stdout.write(
    JSON.stringify({
      status: response.status,
      cf,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
} finally {
  await runtime.dispose();
}
