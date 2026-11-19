"use client";
import { useEffect, useRef, useState } from "react";
import {
  createNativeAuthBrowser,
  createNativeAuthIdempotencyKey,
} from "@ohmyhost/customer-runtime/auth-browser";
export default function Auth() {
  const signupKey = useRef<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [readiness, setReadiness] = useState("");
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  async function checkReadiness() {
    setCheckingReadiness(true);
    setReadiness("Checking DB");
    try {
      const response = await fetch("/api/readiness", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await response.json();
      setReadiness(response.status === 200 && body?.ready === true ? "DB ready" : "DB unavailable");
    } catch {
      setReadiness("DB unavailable");
    } finally {
      setCheckingReadiness(false);
    }
  }

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  async function action(kind: string) {
    try {
      const client = createNativeAuthBrowser();
      let response: unknown;
      if (kind === "signup") {
        signupKey.current ??= createNativeAuthIdempotencyKey();
        response = await client.signUp.email(
          { email, name, password, callbackURL: "/" },
          { headers: { "Idempotency-Key": signupKey.current } },
        );
        if (response && typeof response === "object" && (!("error" in response) || !response.error))
          signupKey.current = null;
      }
      if (kind === "verify") response = await client.verifyEmail({ query: { token } });
      if (kind === "login") response = await client.signIn.email({ email, password });
      if (kind === "logout") response = await client.signOut();
      setStatus(
        response && typeof response === "object" && "error" in response && response.error
          ? "request failed"
          : "ok",
      );
    } catch {
      setStatus("request failed");
    }
  }
  return (
    <section>
      <button
        id="auth-readiness"
        data-hydrated={hydrated ? "true" : "false"}
        disabled={!hydrated || checkingReadiness}
        onClick={checkReadiness}
      >
        Readiness DB check
      </button>
      <output id="auth-readiness-result" aria-live="polite">
        {readiness}
      </output>
      <label>
        Email
        <input id="auth-email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Name
        <input id="auth-name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Password
        <input
          id="auth-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        Token
        <input
          id="auth-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {["signup", "verify", "login", "logout"].map((k) => (
        <button key={k} id={`auth-${k}`} onClick={() => action(k)}>
          {k}
        </button>
      ))}
      <output id="auth-result">{status}</output>
    </section>
  );
}
