/* global URL, document */
import { createHash, randomBytes } from "node:crypto";
import { fixtures } from "./statistics.mjs";
import { GUEST_ACCEPTANCE } from "../mail/adapter.mjs";

const ID = /^[a-zA-Z0-9-]{1,80}$/u;
const emailValid = (value) =>
  typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+$/u.test(value);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const active = (signal) => {
  if (signal?.aborted) throw new Error("journey_aborted");
};
const nonce = (prefix) => `${prefix}-${randomBytes(16).toString("hex")}`;

async function clickResponse(page, selector, path, method, signal) {
  active(signal);
  const origin = new URL(page.url()).origin;
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.origin === origin && url.pathname === path && candidate.request().method() === method
      );
    }),
    page.locator(selector).click(),
  ]);
  active(signal);
  if (new URL(page.url()).origin !== origin) throw new Error("browser_origin_changed");
  return response;
}

async function shown(page, selector, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const output = page.locator(selector);
  await output
    .filter({ hasText: new RegExp(`^${escapeRegex(text)}$`, "u") })
    .waitFor({ state: "visible" });
  if ((await output.textContent()) !== text) throw new Error("fixture_output_mismatch");
}

async function noteAction(page, method, signal, fixture) {
  const selector =
    method === "GET" ? "#note-read" : method === "POST" ? "#note-save" : "#note-delete";
  if (fixture === "tanstack-start") {
    active(signal);
    const origin = new URL(page.url()).origin;
    const before = await page.locator("#note-result").textContent();
    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).origin === origin &&
          candidate.request().method() === "POST" &&
          candidate.request().headers()["x-tsr-serverfn"] === "true",
      ),
      page.locator(selector).click(),
    ]);
    active(signal);
    if (!response.ok() || new URL(page.url()).origin !== origin)
      throw new Error("database_read_failed");
    // TanStack serializes its server function response. The client decodes it, then renders
    // the fixture's JSON string. Require a fresh render after this particular request.
    await page.waitForFunction((previous) => {
      const text = document.querySelector("#note-result")?.textContent;
      if (!text || text === previous) return false;
      try {
        const value = JSON.parse(text);
        return Boolean(value && typeof value === "object" && !Array.isArray(value));
      } catch {
        return false;
      }
    }, before);
    return JSON.parse(await page.locator("#note-result").textContent());
  }
  const response = await clickResponse(page, selector, "/api/notes", method, signal);
  if (!response.ok()) throw new Error("database_read_failed");
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("database_response_invalid");
  await shown(page, "#note-result", value);
  return value;
}

async function readNotes(page, signal, fixture) {
  const value = await noteAction(page, "GET", signal, fixture);
  if (!Array.isArray(value.notes)) throw new Error("database_response_invalid");
  return value.notes;
}

/** A user-visible, hydrated action waits for the real database reply, inside the timer. */
export async function exerciseUsable(page, fixture, { signal } = {}) {
  if (!fixtures.includes(fixture)) throw new Error("fixture_invalid");
  if (fixture !== "next-native-auth") {
    await readNotes(page, signal, fixture);
    return;
  }
  await page.locator('#auth-readiness[data-hydrated="true"]').waitFor({ state: "visible" });
  const response = await clickResponse(page, "#auth-readiness", "/api/readiness", "GET", signal);
  if (!response.ok() || (await response.json())?.ready !== true)
    throw new Error("auth_database_readiness_failed");
  await shown(page, "#auth-readiness-result", "DB ready");
}

/** Real UI CRUD, including persistence after navigation and verification after deletion. */
export async function exerciseNotes(
  page,
  { id, body = "first", updated = "updated", retain = false, fixture, signal } = {},
) {
  if (
    !ID.test(id ?? "") ||
    typeof body !== "string" ||
    !body ||
    typeof updated !== "string" ||
    !updated
  )
    throw new Error("note_id_invalid");
  await page.locator("#note-id").fill(id);
  await page.locator("#note-body").fill(body);
  let value = await noteAction(page, "POST", signal, fixture);
  if (value.note?.id !== id || value.note?.body !== body) throw new Error("database_create_failed");
  await page.locator("#note-body").fill(updated);
  value = await noteAction(page, "POST", signal, fixture);
  if (value.note?.id !== id || value.note?.body !== updated)
    throw new Error("database_update_failed");
  active(signal);
  const previousUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  if (page.url() !== previousUrl) throw new Error("browser_origin_changed");
  if (
    !(await readNotes(page, signal, fixture)).some((row) => row.id === id && row.body === updated)
  )
    throw new Error("database_persistence_failed");
  if (!retain) {
    await page.locator("#note-id").fill(id);
    if ((await noteAction(page, "DELETE", signal, fixture)).deleted !== true)
      throw new Error("database_delete_failed");
    if ((await readNotes(page, signal, fixture)).some((row) => row.id === id))
      throw new Error("database_delete_failed");
  }
}

function messageMatches(message, { recipient, sender, startedAt }) {
  const received = typeof message?.receivedAt === "string" ? Date.parse(message.receivedAt) : NaN;
  return (
    typeof message?.id === "string" &&
    message.id.length > 0 &&
    message.to === recipient &&
    message.from === sender &&
    Number.isFinite(received) &&
    received >= startedAt - 1000 &&
    typeof message.subject === "string" &&
    typeof message.text === "string"
  );
}

/** The mailbox driver returns actual message bodies, not a claimed success or token. */
export function verificationTokenFromInbox(messages, options) {
  const invalid = () => {
    throw new Error("verification_inbox_unverified");
  };
  if (!Array.isArray(messages)) return invalid();
  const matches = messages.filter(
    (message) =>
      messageMatches(message, options) && /^Verify your .+ email$/u.test(message.subject),
  );
  if (matches.length !== 1) return invalid();
  const lines = matches[0].text.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 2 || lines[0] !== matches[0].subject) return invalid();
  let link;
  try {
    link = new URL(lines[1]);
  } catch {
    return invalid();
  }
  const callback = link.searchParams.get("callbackURL");
  if (
    link.origin !== options.origin ||
    link.pathname !== "/api/auth/v1/verify-email" ||
    link.hash ||
    link.username ||
    link.password ||
    link.searchParams.getAll("token").length !== 1 ||
    !link.searchParams.get("token") ||
    link.searchParams.get("token").length > 4096 ||
    link.searchParams.getAll("callbackURL").length > 1 ||
    [...link.searchParams.keys()].some((key) => !["token", "callbackURL"].includes(key)) ||
    (callback !== null &&
      (new URL(callback, options.origin).origin !== options.origin || !callback.startsWith("/")))
  )
    return invalid();
  return link.searchParams.get("token");
}

/** Two sends use one idempotency key; delivery is established from actual mailbox content. */
export async function exerciseMail(
  page,
  { id, key, recipient, sender, readInbox, startedAt = Date.now(), signal } = {},
) {
  if (
    !ID.test(id ?? "") ||
    typeof key !== "string" ||
    !key ||
    !emailValid(recipient) ||
    !emailValid(sender) ||
    typeof readInbox !== "function" ||
    !Number.isFinite(startedAt)
  )
    throw new Error("mail_acceptance_input_invalid");
  await page.locator("#mail-id").fill(id);
  await page.locator("#mail-key").fill(key);
  async function send() {
    const response = await clickResponse(page, "#mail-send", "/api/mail", "POST", signal);
    if (!response.ok()) throw new Error("mail_send_failed");
    const receipt = (await response.json())?.receipt;
    if (
      receipt?.state !== "accepted" ||
      typeof receipt.messageId !== "string" ||
      !receipt.messageId ||
      typeof receipt.requestId !== "string" ||
      !receipt.requestId
    )
      throw new Error("mail_receipt_uncertain");
    return receipt;
  }
  try {
    const first = await send();
    const second = await send();
    if (first.messageId !== second.messageId || first.requestId !== second.requestId)
      throw new Error("mail_receipt_mismatch");
    await verifyMailInbox({ id, recipient, sender, readInbox, startedAt, signal });
    return { mailReceiptMatched: true, mailDeliveredOnce: true };
  } finally {
    await page.locator("#mail-key").fill("");
  }
}

async function verifyMailInbox({ id, recipient, sender, readInbox, startedAt, signal }) {
  active(signal);
  const messages = await readInbox({
    kind: "mail",
    recipient,
    since: startedAt,
    subject: `Preview acceptance ${id}`,
    signal,
  });
  active(signal);
  const matches = Array.isArray(messages)
    ? messages.filter(
        (message) =>
          messageMatches(message, { recipient, sender, startedAt }) &&
          message.subject === `Preview acceptance ${id}`,
      )
    : [];
  if (matches.length !== 1 || matches[0].text !== `Preview acceptance ${id}`)
    throw new Error("mail_delivery_unverified");
}

async function authClick(page, kind, path, method, signal) {
  const response = await clickResponse(page, `#auth-${kind}`, path, method, signal);
  if (!response.ok()) throw new Error(`auth_${kind}_failed`);
}

async function protectedStatus(page, headers) {
  return (
    await page.request.get(new URL("/api/notes", page.url()).href, {
      ...(headers ? { headers } : {}),
    })
  ).status();
}

async function signupAndLogin(page, user, sender, readInbox, signal) {
  const origin = new URL(page.url()).origin;
  const endpoint = (path) => new URL(path, origin).href;
  await page.locator('#auth-readiness[data-hydrated="true"]').waitFor({ state: "visible" });
  if ((await protectedStatus(page)) !== 401) throw new Error("anonymous_auth_not_denied");
  for (const headers of [{ origin: "https://foreign.invalid" }, {}]) {
    active(signal);
    const denied = await page.request.post(endpoint("/api/auth/v1/sign-in/email"), {
      headers,
      data: { email: user.email, password: user.password },
    });
    if (denied.status() !== 404) throw new Error("auth_csrf_not_denied");
  }
  await page.locator("#auth-email").fill(user.email);
  await page.locator("#auth-name").fill(user.name);
  await page.locator("#auth-password").fill(user.password);
  const startedAt = Date.now();
  await authClick(page, "signup", "/api/auth/v1/sign-up/email", "POST", signal);
  if ((await protectedStatus(page)) !== 401) throw new Error("pending_user_authenticated");
  active(signal);
  const messages = await readInbox({
    kind: "verification",
    recipient: user.email,
    since: startedAt,
    signal,
  });
  active(signal);
  const token = verificationTokenFromInbox(messages, {
    recipient: user.email,
    sender,
    origin,
    startedAt,
  });
  const redirect = new URL("/api/auth/v1/verify-email", origin);
  redirect.searchParams.set("token", token);
  redirect.searchParams.set("callbackURL", "https://foreign.invalid/");
  const denied = await page.request.get(redirect.href, { maxRedirects: 0 });
  if (denied.status() !== 400) throw new Error("auth_foreign_redirect_not_denied");
  await page.locator("#auth-token").fill(token);
  await authClick(page, "verify", "/api/auth/v1/verify-email", "GET", signal);
  await page.locator("#auth-token").fill("");
  if ((await protectedStatus(page)) !== 401) throw new Error("verification_created_session");
  active(signal);
  const wrong = await page.request.post(endpoint("/api/auth/v1/sign-in/email"), {
    headers: { origin },
    data: { email: user.email, password: `${user.password}-incorrect` },
  });
  if (wrong.status() !== 401) throw new Error("incorrect_password_not_denied");
  await authClick(page, "login", "/api/auth/v1/sign-in/email", "POST", signal);
  await page.locator("#auth-password").fill("");
  if ((await protectedStatus(page)) !== 200) throw new Error("auth_login_failed");
  const cookies = await page.context().cookies(page.url());
  const native = cookies.filter(({ name }) =>
    /^__Host-omh_native_preview_[A-Za-z0-9_-]+\.session_token$/u.test(name),
  );
  if (
    native.length !== 1 ||
    native.some(
      (cookie) =>
        !cookie.secure ||
        !cookie.httpOnly ||
        !["Lax", "Strict"].includes(cookie.sameSite) ||
        cookie.path !== "/" ||
        cookie.domain !== new URL(origin).hostname,
    )
  )
    throw new Error("native_cookie_scope_invalid");
  active(signal);
  const csrf = await page.request.post(endpoint("/api/notes"), {
    headers: { origin: "https://foreign.invalid" },
    data: { id: "csrf-denied", body: "must not persist" },
  });
  if (csrf.status() !== 403) throw new Error("notes_csrf_not_denied");
}

async function logout(page, signal) {
  const cookie = (await page.context().cookies(page.url()))
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  await authClick(page, "logout", "/api/auth/v1/sign-out", "POST", signal);
  if ((await protectedStatus(page)) !== 401 || (await protectedStatus(page, { cookie })) !== 401)
    throw new Error("auth_logout_or_replay_failed");
}

/** Hold two independently authenticated browser contexts through the wake/edit cohort. */
export async function startAuthJourney({
  browser,
  url,
  users,
  sender,
  readInbox,
  signal,
  recordSignup = async () => {},
}) {
  if (
    !browser ||
    typeof browser.newContext !== "function" ||
    !Array.isArray(users) ||
    users.length !== 2 ||
    !emailValid(sender) ||
    typeof readInbox !== "function" ||
    users.some(
      (user) =>
        !emailValid(user?.email) ||
        typeof user.password !== "string" ||
        user.password.length < 12 ||
        typeof user.name !== "string" ||
        !user.name,
    ) ||
    users[0].email.toLowerCase() === users[1].email.toLowerCase()
  )
    throw new Error("auth_adapter_required");
  const id = nonce("auth"),
    contexts = [],
    pages = [];
  let finished = false;
  async function close() {
    for (const context of contexts) await context.close();
  }
  try {
    for (const user of users) {
      active(signal);
      const context = await browser.newContext();
      if (contexts.includes(context)) throw new Error("auth_context_not_isolated");
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      if (page.url() !== url) throw new Error("browser_origin_changed");
      const accountHash = createHash("sha256").update(user.email.toLowerCase()).digest("hex");
      await recordSignup({ event: "intent", operation: "auth_signup", accountHash });
      try {
        await signupAndLogin(page, user, sender, readInbox, signal);
      } catch (error) {
        await recordSignup({
          event: "result",
          operation: "auth_signup",
          accountHash,
          outcome: "unknown",
        });
        throw error;
      }
      await recordSignup({
        event: "result",
        operation: "auth_signup",
        accountHash,
        outcome: "confirmed",
      });
    }
    await exerciseNotes(pages[0], { id: nonce("auth-crud"), signal });
    await exerciseNotes(pages[0], { id, updated: "user-a", retain: true, signal });
    if ((await readNotes(pages[1], signal)).some((row) => row.id === id))
      throw new Error("auth_isolation_failed");
    await pages[1].locator("#note-id").fill(id);
    if ((await noteAction(pages[1], "DELETE", signal)).deleted !== false)
      throw new Error("auth_isolation_failed");
    await pages[1].locator("#note-body").fill("user-b");
    if ((await noteAction(pages[1], "POST", signal)).note?.body !== "user-b")
      throw new Error("auth_isolation_failed");
    async function continuity(checkSignal = signal) {
      for (let i = 0; i < pages.length; i += 1) {
        active(checkSignal);
        await pages[i].reload({ waitUntil: "domcontentloaded" });
        if (pages[i].url() !== url) throw new Error("browser_origin_changed");
        if (
          (await protectedStatus(pages[i])) !== 200 ||
          !(await readNotes(pages[i], checkSignal)).some(
            (row) => row.id === id && row.body === (i ? "user-b" : "user-a"),
          )
        )
          throw new Error("auth_continuity_failed");
      }
    }
    await continuity(signal);
    return {
      async continuity(options = {}) {
        await continuity(options.signal);
      },
      async finish(options = {}) {
        if (finished) throw new Error("auth_journey_finished");
        await continuity(options.signal);
        await exerciseNotes(pages[0], { id: nonce("auth-crud"), signal: options.signal });
        for (const page of pages) {
          await page.locator("#note-id").fill(id);
          if ((await noteAction(page, "DELETE", options.signal)).deleted !== true)
            throw new Error("database_delete_failed");
          if ((await readNotes(page, options.signal)).some((row) => row.id === id))
            throw new Error("database_delete_failed");
          await logout(page, options.signal);
        }
        finished = true;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Per-session capability work is kept outside the timed wake/edit windows. */
export async function startCapabilityJourney({
  browser,
  page,
  fixture,
  url,
  sessionId,
  qa,
  signal,
  recordOperation,
}) {
  if (!fixtures.includes(fixture)) throw new Error("fixture_invalid");
  if (typeof recordOperation !== "function") throw new Error("capability_journal_required");
  if (page.url() !== url) throw new Error("browser_origin_changed");
  let auth;
  if (fixture === "next-native-auth") {
    if (!qa || typeof qa.auth !== "function" || typeof qa.readInbox !== "function")
      throw new Error("auth_adapter_required");
    const setup = await qa.auth({ sessionId, signal });
    active(signal);
    auth = await startAuthJourney({
      browser,
      url,
      users: setup?.users,
      sender: setup?.sender,
      readInbox: qa.readInbox,
      signal,
      recordSignup: (event) => recordOperation({ ...event, sessionId }),
    });
  } else await exerciseNotes(page, { id: nonce("db"), fixture, signal });
  let mail = {},
    mailbox;
  if (fixture === "next-app-mail") {
    if (
      !qa ||
      typeof qa.mail !== "function" ||
      typeof qa.armMail !== "function" ||
      typeof qa.readInbox !== "function"
    )
      throw new Error("mail_adapter_required");
    const id = nonce("mail"),
      startedAt = Date.now();
    const setup = await qa.mail({ sessionId, id, signal });
    active(signal);
    if (!emailValid(setup?.recipient) || !emailValid(setup?.sender))
      throw new Error("mail_adapter_invalid");
    await recordOperation({ event: "intent", operation: "fixture_mail", sessionId, messageId: id });
    try {
      await qa.armMail({ sessionId, id, signal });
      active(signal);
      mailbox = {
        id,
        recipient: setup?.recipient,
        sender: setup?.sender,
        readInbox: qa.readInbox,
        startedAt,
      };
      mail = await exerciseMail(page, { ...mailbox, key: GUEST_ACCEPTANCE, signal });
    } catch (error) {
      await recordOperation({
        event: "result",
        operation: "fixture_mail",
        sessionId,
        messageId: id,
        outcome: "unknown",
      });
      throw error;
    }
    await recordOperation({
      event: "result",
      operation: "fixture_mail",
      sessionId,
      messageId: id,
      outcome: "confirmed",
    });
  }
  let wakeConfirmed = false;
  return {
    before: {
      databaseCrud: true,
      ...(auth ? { twoUserAuth: true, userIsolation: true } : {}),
      ...mail,
    },
    async afterWake(options = {}) {
      if (auth && !wakeConfirmed) {
        await auth.continuity(options);
        wakeConfirmed = true;
      }
    },
    async finish(options = {}) {
      if (page.url() !== url) throw new Error("browser_origin_changed");
      if (auth) {
        if (!wakeConfirmed) throw new Error("auth_wake_not_verified");
        await auth.finish(options);
        return { databaseCrud: true, authAfterWake: true, authAfterEdit: true, authLogout: true };
      }
      await exerciseNotes(page, { id: nonce("db"), fixture, signal: options.signal });
      if (mailbox) await verifyMailInbox({ ...mailbox, signal: options.signal });
      return {
        databaseCrud: true,
        ...(fixture === "next-app-mail"
          ? {
              mailReceiptMatched: mail.mailReceiptMatched,
              mailDeliveredOnce: mail.mailDeliveredOnce,
            }
          : {}),
      };
    },
    async close() {
      if (auth) await auth.close();
    },
  };
}
