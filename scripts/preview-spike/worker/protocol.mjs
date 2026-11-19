/* global TextEncoder, crypto, URL */
const fixtures = new Set([
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
]);
const instances = new Set([
  "basic",
  "basic-custom-equivalent",
  "standard-1",
  "standard-2",
  "standard-3",
]);
const allowedHosts = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "codeload.github.com",
  "github.com",
]);
const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function signature(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))).slice(0, 12),
  );
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

export async function authorized(header, secret) {
  if (typeof secret !== "string" || encoder.encode(secret).length < 32) return false;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return same(hex(new Uint8Array(given)), hex(new Uint8Array(expected)));
}

export function createId() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signId(id, secret) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid_id");
  return `${id}-${await signature(id, secret)}`;
}

export async function verifyId(id, secret) {
  if (typeof secret !== "string" || encoder.encode(secret).length < 32) return false;
  const match = /^([a-f0-9]{32})-([a-f0-9]{24})$/.exec(id);
  return Boolean(match && same(match[2], await signature(match[1], secret)));
}

export function previewId(host, domain) {
  if (typeof domain !== "string" || !/^[a-z0-9.-]+$/.test(domain)) return null;
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const id = host.slice(0, -suffix.length);
  return /^[a-f0-9]{32}-[a-f0-9]{24}$/.test(id) ? id : null;
}

export function parseControl(path) {
  if (path === "/__spike/sessions") return { action: "create" };
  if (path === "/__spike/lease") return { action: "lease" };
  const match =
    /^\/__spike\/sessions\/([^/]+)(?:\/(setup|backup|stop|status|edit|mail-permit))?$/.exec(path);
  return match ? { action: match[2] ?? "delete", id: match[1] } : null;
}

export function validateCreate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (
    Object.keys(input).some(
      (key) => !["fixture", "instance", "inactivityMs", "cacheMode", "idleMode"].includes(key),
    )
  )
    return null;
  const {
    fixture,
    instance,
    inactivityMs = 600_000,
    cacheMode = "seeded",
    idleMode = "product",
  } = input;
  if (!fixtures.has(fixture) || !instances.has(instance)) return null;
  if (!Number.isInteger(inactivityMs) || inactivityMs < 5_000 || inactivityMs > 600_000)
    return null;
  if (!["seeded", "empty"].includes(cacheMode)) return null;
  if (!["product", "sdk"].includes(idleMode)) return null;
  return { fixture, instance, inactivityMs, cacheMode, idleMode };
}

export function allowedEdit(path, content) {
  return (
    typeof path === "string" &&
    /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(path) &&
    !path.includes("..") &&
    typeof content === "string" &&
    encoder.encode(content).length <= 65_536
  );
}

export function allowedOutbound(target) {
  try {
    const url = new URL(target);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      allowedHosts.has(url.hostname)
    );
  } catch {
    return false;
  }
}
