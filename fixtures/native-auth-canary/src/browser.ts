import {
  createNativeAuthBrowser,
  createNativeAuthIdempotencyKey,
} from "@ohmyhost/customer-runtime/auth-browser";

const client = createNativeAuthBrowser();
const form = document.querySelector<HTMLFormElement>("#auth");
const result = document.querySelector<HTMLElement>("#result");
if (!form || !result) throw new Error("canary form missing");
const tokenInput = form.elements.namedItem("token") as HTMLInputElement;
const initialUrl = new URL(window.location.href);
const initialToken = initialUrl.searchParams.get("token");
if (initialToken !== null) {
  tokenInput.value = initialToken;
  initialUrl.searchParams.delete("token");
  window.history.replaceState(
    null,
    "",
    `${initialUrl.pathname}${initialUrl.search}${initialUrl.hash}`,
  );
}
// Salted fingerprints avoid storing credentials in the retry map. The map is bounded and
// refuses new uncertain operations when full instead of losing a key needed for reconciliation.
const salt = createNativeAuthIdempotencyKey();
const pending = new Map<string, string>();
async function keyFor(payload: unknown): Promise<{ fingerprint: string; key: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify([salt, payload]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let key = pending.get(fingerprint);
  if (!key) {
    if (pending.size >= 64) throw new Error("pending limit");
    key = createNativeAuthIdempotencyKey();
    pending.set(fingerprint, key);
  }
  return { fingerprint, key };
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const action = (event as SubmitEvent).submitter?.getAttribute("value");
  const fields = new FormData(form);
  const email = String(fields.get("email") ?? "");
  const name = String(fields.get("name") ?? "");
  const password = String(fields.get("password") ?? "");
  const token = String(fields.get("token") ?? "");
  try {
    const payload =
      action === "signup"
        ? [action, email, name, password]
        : action === "send-verification" || action === "request-reset"
          ? [action, email]
          : action === "invite"
            ? [action, token, password, name]
            : action === "recovery"
              ? [action]
              : null;
    const retained = payload ? await keyFor(payload) : null;
    const options = retained ? { headers: { "Idempotency-Key": retained.key } } : {};
    let response: { error?: unknown } | Response;
    switch (action) {
      case "signup":
        response = await client.signUp.email(
          { email, name, password, callbackURL: "/login" },
          options,
        );
        break;
      case "verify":
        response = await client.verifyEmail({ query: { token } });
        break;
      case "send-verification":
        response = await client.sendVerificationEmail({ email, callbackURL: "/login" }, options);
        break;
      case "login":
        response = await client.signIn.email({ email, password });
        break;
      case "logout":
        response = await client.signOut();
        break;
      case "request-reset":
        response = await client.requestPasswordReset(
          { email, redirectTo: "/reset-password" },
          options,
        );
        break;
      case "reset":
        response = await client.resetPassword({ newPassword: password, token });
        break;
      case "invite":
        response = await client.acceptInvitation(
          { token, password, name },
          { idempotencyKey: retained?.key },
        );
        break;
      case "reauth":
        response = await client.reauthenticate({ password });
        break;
      case "recovery":
        response = await client.enrollRecovery(
          { callbackURL: "/login" },
          { idempotencyKey: retained?.key },
        );
        break;
      case "google":
      case "github":
        response = await client.signIn.social({ provider: action, callbackURL: "/login" });
        break;
      case "link-google":
      case "link-github":
        response = await client.linkSocial({
          provider: action === "link-google" ? "google" : "github",
          callbackURL: "/login",
        });
        break;
      case "reauth-google":
      case "reauth-github":
        response = await client.reauthenticate({
          provider: action === "reauth-google" ? "google" : "github",
          callbackURL: "/login",
        });
        break;
      case "protected":
        response = await fetch("/protected", { credentials: "same-origin", cache: "no-store" });
        break;
      default:
        return;
    }
    if (
      !(response instanceof Response) &&
      "data" in response &&
      response.data &&
      typeof response.data === "object" &&
      "redirect" in response.data &&
      response.data.redirect === true &&
      "url" in response.data &&
      typeof response.data.url === "string"
    ) {
      const destination = new URL(response.data.url, window.location.origin);
      if (destination.protocol !== "https:") throw new Error("invalid redirect");
      window.location.assign(destination.href);
      return;
    }
    const ok = response instanceof Response ? response.ok : !response.error;
    if (ok && retained) pending.delete(retained.fingerprint);
    result.textContent = ok ? `${action}: accepted` : `${action}: refused or unavailable`;
  } catch {
    result.textContent = `${action}: outcome unknown; inspect before retrying`;
  } finally {
    const passwordInput = form.elements.namedItem("password") as HTMLInputElement;
    passwordInput.value = "";
    tokenInput.value = "";
  }
});
