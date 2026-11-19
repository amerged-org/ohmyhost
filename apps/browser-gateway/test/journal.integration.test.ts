import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

it("persists a measured receipt across a real alarm retry and sends the exact decimal to Core RPC", async () => {
  const output = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../src", import.meta.url)),
      loader: "ts",
      contents: `
    import { BrowserSettlementJournal } from './journal.ts';
    export class JournalTest extends BrowserSettlementJournal { nextAlarm() { return this.ctx.storage.getAlarm(); } }
    export default { async fetch(request, env) {
      const {action, job} = await request.json();
      if (action === 'record') { await env.JOURNAL.getByName(job.reservationId).record(job); return Response.json({ok:true}); }
      if (action === 'recover') { await env.BROWSER_RUNTIME.recover(); return Response.json({ok:true}); }
      if (action === 'hang') { await env.BROWSER_RUNTIME.hang(); return Response.json({ok:true}); }
      if (action === 'alarm') { return Response.json({nextAlarm:await env.JOURNAL.getByName(job.reservationId).nextAlarm()}); }
      return Response.json(await env.BROWSER_RUNTIME.status());
    } };`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["source", "workerd", "worker", "browser"],
    external: ["cloudflare:workers", "node:*"],
    banner: {
      js: 'import {createRequire as __testCreateRequire} from "node:module";const require=__testCreateRequire("/fixture.js");',
    },
    write: false,
  });
  const script = output.outputFiles[0]?.text;
  if (!script) throw new Error("missing journal fixture bundle");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "journal",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: "journal.mjs", contents: script }],
          durableObjects: { JOURNAL: { className: "JournalTest", useSQLite: true } },
          serviceBindings: { BROWSER_RUNTIME: { name: "core", entrypoint: "Core" } },
        },
        {
          name: "core",
          compatibilityDate: "2026-09-14",
          modules: [
            {
              type: "ESModule",
              path: "core.mjs",
              contents: `import {WorkerEntrypoint} from 'cloudflare:workers'; let mode='fail',calls=[]; export class Core extends WorkerEntrypoint { settle(input) { calls.push(input); if(mode==='fail') throw new Error('offline'); if(mode==='hang') return new Promise(()=>{}); return {settled:true,chargedMicros:6968}; } recover(){ mode='ok'; } hang(){ mode='hang'; } status(){ return {calls}; } } export default {};`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const job = {
      scope: {
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      },
      reservationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      browserMs: "1393.57373046875",
    };
    const call = async (action: string) =>
      (
        await mf.dispatchFetch("https://journal.invalid", {
          method: "POST",
          body: JSON.stringify({ action, job }),
        })
      ).json() as Promise<{ calls?: unknown[]; nextAlarm?: number | null }>;
    await call("record");
    await vi.waitFor(async () => expect((await call("status")).calls).toHaveLength(1), {
      timeout: 5_000,
      interval: 100,
    });
    await call("recover");
    // Re-recording the same receipt advances the alarm, as a replay would after a lost acknowledgement.
    await call("record");
    await vi.waitFor(async () => expect((await call("status")).calls).toHaveLength(2), {
      timeout: 5_000,
      interval: 100,
    });
    expect((await call("status")).calls).toEqual([job, job]);
    await call("hang");
    await call("record");
    await vi.waitFor(async () => expect((await call("status")).calls).toHaveLength(3), {
      timeout: 5_000,
      interval: 100,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
    expect((await call("alarm")).nextAlarm).toBeGreaterThan(Date.now());
    await call("recover");
    await call("record");
    await vi.waitFor(async () => expect((await call("status")).calls).toHaveLength(4), {
      timeout: 5_000,
      interval: 100,
    });
    expect((await call("status")).calls).toEqual([job, job, job, job]);
  } finally {
    await mf.dispose();
  }
}, 30_000);
