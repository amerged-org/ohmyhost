import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("customer database JSON parameters cross a real Worker RPC binding", async () => {
  const sdkPath = fileURLToPath(
    new URL("../packages/customer-runtime/src/database.ts", import.meta.url),
  );
  const client = await build({
    stdin: {
      contents: `import { createPrivateDatabaseClient } from ${JSON.stringify(sdkPath)};
        export default { async fetch(request, env) {
          try {
            const db = createPrivateDatabaseClient(env.DB);
            return Response.json(await db.query({
              text: 'select $1::jsonb',
              values: [{ nested: { values: ['✓', 1, null, true] } }]
            }));
          } catch (error) { return Response.json({error:error.message}, {status:500}); }
        }};`,
      loader: "js",
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "database-client",
          compatibilityDate: "2026-08-21",
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./database-client.mjs", import.meta.url)),
              contents: client.outputFiles[0].text,
            },
          ],
          serviceBindings: { DB: { name: "database-echo", entrypoint: "DatabaseEcho" } },
        },
        {
          name: "database-echo",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./database-echo.mjs", import.meta.url)),
              contents: `import { WorkerEntrypoint } from 'cloudflare:workers';
            export class DatabaseEcho extends WorkerEntrypoint {
              query(input) { return {command:'SELECT',rowCount:1,rows:[{echo:input.values[0]}]}; }
              transaction(input) { return input.map(query => this.query(query)); }
            }
            export default {fetch() {return new Response(null,{status:404});}};`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const response = await mf.dispatchFetch("http://localhost/database-json");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result, {
      command: "SELECT",
      rowCount: 1,
      rows: [{ echo: { nested: { values: ["✓", 1, null, true] } } }],
    });
  } finally {
    await mf.dispose();
  }
});
