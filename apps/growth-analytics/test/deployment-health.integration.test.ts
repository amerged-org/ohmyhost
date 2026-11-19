import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { splitStatements } from "../../control-store/test/support/sql.js";
import type { GrowthD1 } from "../src/event-store.js";
import {
  appendDeploymentHealth,
  parseDeploymentHealth,
  readDeploymentHealth,
} from "../src/deployment-health.js";
import { reportDeploymentHealth } from "../../wfp-management/src/growth-health.js";

it("retains scoped observed probe evidence without affecting the producer", async () => {
  const manifest = createRequire(import.meta.url).resolve("../../control-store/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    createRequire(manifest).resolve("wrangler/package.json"),
  )("miniflare");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "growth",
          modules: true,
          script: "export default { fetch(){ return new Response() } }",
          d1Databases: { DB: "db" },
        },
      ],
    }),
  );
  try {
    const db = (await mf.getD1Database("DB", "growth")) as GrowthD1;
    await db.batch(
      splitStatements(
        readFileSync(new URL("../migrations/0002_deployment_health.sql", import.meta.url), "utf8"),
      ).map((sql) => db.prepare(sql)),
    );
    const observation = {
      schema_version: 1 as const,
      observation_id: "a1b2c3d4-0000-4000-8000-000000000000",
      candidate_receipt_id: "01M21T9VB6J0P0QWQJ4J3086ZH",
      organization_id: "01M21T9VB6J0P0QWQJ4J3086ZJ",
      project_id: "01M21T9VB6J0P0QWQJ4J3086ZK",
      environment_id: "01M21T9VB6J0P0QWQJ4J3086ZM",
      deployment_id: "01M21T9VB6J0P0QWQJ4J3086ZN",
      health_status: "passed" as const,
      http_status: 200,
      observed_at: "2026-11-15T01:00:00.000Z",
    };
    expect(() => parseDeploymentHealth({ ...observation, path: "/secret" })).toThrow();
    expect(await appendDeploymentHealth(db, observation)).toBe("inserted");
    expect(await appendDeploymentHealth(db, observation)).toBe("duplicate");
    expect(await appendDeploymentHealth(db, { ...observation, http_status: 201 })).toBe("conflict");
    expect(await readDeploymentHealth(db, observation)).toEqual(observation);
    expect(
      await readDeploymentHealth(db, {
        ...observation,
        candidate_receipt_id: "01M21T9VB6J0P0QWQJ4J3086ZP",
      }),
    ).toBeNull();
    const tasks: Promise<unknown>[] = [];
    expect(() =>
      reportDeploymentHealth(
        {
          observeHealth: async () => {
            throw new Error("offline");
          },
        },
        { waitUntil: (task) => tasks.push(task) },
        observation,
      ),
    ).not.toThrow();
    await Promise.all(tasks);
  } finally {
    await mf.dispose();
  }
});
