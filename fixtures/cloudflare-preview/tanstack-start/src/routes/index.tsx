import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
} from "@ohmyhost/customer-runtime/database";
import { useState } from "react";
type Input = { method: "GET" | "POST" | "DELETE"; id: string; body: string };
const notes = createServerFn({ method: "POST" })
  .validator((value: Input) => value)
  .handler(async ({ data }) => {
    if (
      !data ||
      !["GET", "POST", "DELETE"].includes(data.method) ||
      typeof data.id !== "string" ||
      typeof data.body !== "string" ||
      data.id.length > 80 ||
      data.body.length > 200
    )
      throw new Error("invalid input");
    const db = createPrivateDatabaseClient(
      (env as unknown as { OHMYHOST_DATABASE: CustomerDatabaseBinding }).OHMYHOST_DATABASE,
    );
    if (data.method === "GET")
      return JSON.stringify({
        notes: (
          await db.query({
            text: "SELECT id, body FROM public.preview_notes ORDER BY id",
            values: [],
          })
        ).rows,
      });
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(data.id)) throw new Error("invalid id");
    if (data.method === "DELETE")
      return JSON.stringify({
        deleted:
          (
            await db.query({
              text: "DELETE FROM public.preview_notes WHERE id = $1 RETURNING id",
              values: [data.id],
            })
          ).rowCount === 1,
      });
    if (!data.body) throw new Error("empty body");
    const result = await db.transaction([
      {
        text: "INSERT INTO public.preview_notes (id, body) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body RETURNING id, body",
        values: [data.id, data.body],
      },
      { text: "SELECT count(*) AS count FROM public.preview_notes", values: [] },
    ]);
    return JSON.stringify({ note: result[0]?.rows[0], count: result[1]?.rows[0]?.count });
  });
export const Route = createFileRoute("/")({ component: Home });
function Home() {
  const [id, setId] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  async function action(method: Input["method"]) {
    try {
      setStatus(await notes({ data: { method, id, body } }));
    } catch {
      setStatus("request failed");
    }
  }
  return (
    <main>
      <h1>Preview notes</h1>
      <label>
        Id
        <input id="note-id" value={id} onChange={(e) => setId(e.target.value)} />
      </label>
      <label>
        Body
        <input id="note-body" value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <button id="note-save" onClick={() => action("POST")}>
        Save
      </button>
      <button id="note-read" onClick={() => action("GET")}>
        Read
      </button>
      <button id="note-delete" onClick={() => action("DELETE")}>
        Delete
      </button>
      <output id="note-result">{status}</output>
    </main>
  );
}
