"use client";
import { useState } from "react";
export default function Mail() {
  const [id, setId] = useState("");
  const [key, setKey] = useState("");
  const [result, setResult] = useState("");
  async function send() {
    const r = await fetch("/api/mail", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ id }),
    });
    setResult(r.ok ? JSON.stringify(await r.json()) : `HTTP ${r.status}`);
  }
  return (
    <section>
      <label>
        Mail id
        <input id="mail-id" value={id} onChange={(e) => setId(e.target.value)} />
      </label>
      <label>
        Acceptance key
        <input id="mail-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <button id="mail-send" onClick={send}>
        Send mail
      </button>
      <output id="mail-result">{result}</output>
    </section>
  );
}
