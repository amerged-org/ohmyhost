import { parseUlid, type Ulid } from "@ohmyhost/platform";

export async function deterministicUlid(value: string): Promise<Ulid> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let number = 0n;
  for (const byte of bytes.slice(0, 16)) number = (number << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(number & 31n)] + encoded;
    number >>= 5n;
  }
  return parseUlid(encoded);
}
