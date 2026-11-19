import { parseStateName } from "./state.js";

export interface TofuStateStub {
  fetch(request: Request): Promise<Response>;
}

export interface TofuStateNamespace {
  getByName(name: string): TofuStateStub;
}

export interface TofuHttpBindings {
  readonly STATE_ORIGIN: string;
  readonly STATE_PREFIX: string;
  readonly STATE_PASSWORD_SHA256: string;
  readonly STATES: TofuStateNamespace;
}

/** Only an operator holding the environment-specific Basic credential reaches the state object. */
export function createTofuHttpWorker(
  bindings: TofuHttpBindings,
  crypto: Pick<Crypto, "subtle"> = globalThis.crypto,
) {
  if (
    !/^https:\/\/[a-z0-9.-]+$/u.test(bindings.STATE_ORIGIN) ||
    !/^(?:poc-private-fullstack|production)\/$/u.test(bindings.STATE_PREFIX) ||
    !/^[a-f0-9]{64}$/u.test(bindings.STATE_PASSWORD_SHA256)
  )
    throw new TypeError("State backend configuration is invalid");
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== bindings.STATE_ORIGIN || !(await authorized(request, bindings, crypto)))
        return denied();
      if (!url.pathname.startsWith("/state/")) return denied();
      let name: string;
      try {
        name = parseStateName(decodeURIComponent(url.pathname.slice(7)));
      } catch {
        return denied();
      }
      if (!name.startsWith(bindings.STATE_PREFIX)) return denied();
      if ([...url.searchParams.keys()].some((key) => key !== "ID")) return denied();
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.set("x-ohmyhost-state-name", name);
      return bindings.STATES.getByName(name).fetch(new Request(request, { headers }));
    },
  });
}

async function authorized(
  request: Request,
  bindings: TofuHttpBindings,
  crypto: Pick<Crypto, "subtle">,
): Promise<boolean> {
  const value = request.headers.get("authorization");
  if (value === null || !/^Basic [A-Za-z0-9+/=]{8,1024}$/u.test(value)) return false;
  let plaintext: string;
  try {
    plaintext = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value.slice(6)), (character) => character.charCodeAt(0)),
    );
  } catch {
    return false;
  }
  if (!plaintext.startsWith("tofu:") || plaintext.length > 512) return false;
  const bytes = new TextEncoder().encode(plaintext.slice(5));
  if (bytes.length < 32 || bytes.length > 256) return false;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const expected = Uint8Array.from(bindings.STATE_PASSWORD_SHA256.match(/../gu) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  let different = 0;
  for (let index = 0; index < 32; index++) different |= (hash[index] ?? 0) ^ (expected[index] ?? 0);
  return different === 0;
}

function denied(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
