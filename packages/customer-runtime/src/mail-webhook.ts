/** Verify before parsing JSON. Only call this from the application's server-side route. */
export async function verifyMailWebhook(input: {
  body: string;
  headers: Headers;
  secret: string;
  now?: Date;
}): Promise<string> {
  const id = input.headers.get("webhook-id"),
    timestamp = input.headers.get("webhook-timestamp"),
    signatures = input.headers.get("webhook-signature"),
    now = input.now ?? new Date();
  if (
    !id ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(id) ||
    !timestamp ||
    !/^\d{1,12}$/u.test(timestamp) ||
    !Number.isFinite(now.getTime()) ||
    Math.abs(now.getTime() - Number(timestamp) * 1000) > 300000 ||
    !signatures ||
    signatures.length > 1024 ||
    !/^whsec_[A-Za-z0-9+/]{43}=$/u.test(input.secret)
  )
    throw new Error("Invalid mail webhook signature");
  const bytes = Uint8Array.from(atob(input.secret.slice(6)), (character) =>
    character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const message = new TextEncoder().encode(`${id}.${timestamp}.${input.body}`);
  for (const part of signatures.split(" ")) {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/u.test(part)) continue;
    const signature = Uint8Array.from(atob(part.slice(3)), (character) => character.charCodeAt(0));
    if (await crypto.subtle.verify("HMAC", key, signature, message)) return id;
  }
  throw new Error("Invalid mail webhook signature");
}
