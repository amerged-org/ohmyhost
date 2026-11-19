import type { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { splitStatements } from "./sql.js";

/** Local fixture only: each original migration remains a separate D1 transaction. */
export const coreBootstrapWorker = `
export default {
  async fetch(request, env) {
    try {
      const files = await request.json();
      let completed = 0;
      for (const file of files) {
        await env.CONTROL_CORE.batch(file.map((sql) => env.CONTROL_CORE.prepare(sql)));
        completed++;
      }
      return Response.json({ completed });
    } catch (error) {
      return Response.json({ error: String(error && error.message || error) }, { status: 500 });
    }
  },
};`;

type Fixture = Pick<Miniflare, "dispatchFetch" | "getD1Database" | "dispose">;
type Migration = Readonly<{ name: string; sql: string }>;

export async function bootstrapCore(
  fixture: Fixture,
  files: readonly Migration[],
): Promise<number> {
  const response = await fixture.dispatchFetch("http://fixture.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(files.map((file) => splitStatements(file.sql))),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : "Core fixture migration failed";
    throw new Error(message);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("completed" in body) ||
    body.completed !== files.length
  )
    throw new Error("Core fixture migration receipt is invalid");
  return body.completed;
}

/** Dispose on initialization failure; retain both errors when cleanup also fails. */
export async function initializeCoreFixture(
  fixture: Fixture,
  files: () => readonly Migration[],
  activate?: (core: D1Database) => Promise<void>,
): Promise<D1Database> {
  try {
    const core = (await fixture.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    await bootstrapCore(fixture, files());
    if (activate) await activate(core);
    return core;
  } catch (error) {
    try {
      await fixture.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Core fixture initialization and cleanup failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
