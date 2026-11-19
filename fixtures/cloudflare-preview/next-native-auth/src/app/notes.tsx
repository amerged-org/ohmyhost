"use client";
import { useState } from "react";
export default function Notes() {
  const [id, setId] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  async function action(method: string) {
    const r = await fetch(
      "/api/notes",
      method === "GET"
        ? { cache: "no-store" }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, body }),
          },
    );
    setStatus(r.ok ? JSON.stringify(await r.json()) : `HTTP ${r.status}`);
  }
  return (
    <>
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
    </>
  );
}
