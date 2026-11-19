import { DatabaseProviderConflictError } from "./contracts.js";
import { generatedJsonb } from "../../jsonb-generated.js";

/** Fresh validated typed requests only; captured Source strings never enter this serializer. */
export function providerRequestJsonb(canonicalRequest: string): string {
  try {
    return generatedJsonb(JSON.parse(canonicalRequest) as unknown);
  } catch {
    throw new DatabaseProviderConflictError();
  }
}

function numericIdentity(token: string): string {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(token);
  if (!match) throw new DatabaseProviderConflictError();
  const fraction = match[3] ?? "";
  let digits = ((match[2] ?? "") + fraction).replace(/^0+/u, ""),
    exponent = Number(match[4] ?? "0") - fraction.length;
  if (!Number.isSafeInteger(exponent)) throw new DatabaseProviderConflictError();
  if (digits === "") return "0";
  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += trailing;
  return (match[1] ?? "") + digits + "e" + exponent;
}

/** Lossless JSONB equality token: number lexemes never enter a JavaScript Number. */
function semanticIdentity(text: string): string {
  let offset = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(text[offset] ?? "")) offset++;
  };
  const string = (): string => {
    if (text[offset] !== '"') throw new DatabaseProviderConflictError();
    const start = offset++;
    for (; offset < text.length; offset++) {
      if (text[offset] === "\\") offset++;
      else if (text[offset] === '"') {
        const value: unknown = JSON.parse(text.slice(start, ++offset));
        if (typeof value !== "string" || value.includes("\0") || /[\uD800-\uDFFF]/u.test(value))
          throw new DatabaseProviderConflictError();
        return value;
      }
    }
    throw new DatabaseProviderConflictError();
  };
  const value = (): string => {
    whitespace();
    if (text[offset] === '"') return "s" + JSON.stringify(string());
    if (text[offset] === "{") {
      offset++;
      whitespace();
      const entries: [string, string][] = [],
        keys = new Set<string>();
      if (text[offset] !== "}")
        for (;;) {
          whitespace();
          const key = string();
          if (keys.has(key)) throw new DatabaseProviderConflictError();
          keys.add(key);
          whitespace();
          if (text[offset++] !== ":") throw new DatabaseProviderConflictError();
          entries.push([key, value()]);
          whitespace();
          if (text[offset] !== ",") break;
          offset++;
        }
      if (text[offset++] !== "}") throw new DatabaseProviderConflictError();
      return "o" + JSON.stringify(entries.sort(([left], [right]) => (left < right ? -1 : 1)));
    }
    if (text[offset] === "[") {
      offset++;
      whitespace();
      const items: string[] = [];
      if (text[offset] !== "]")
        for (;;) {
          items.push(value());
          whitespace();
          if (text[offset] !== ",") break;
          offset++;
        }
      if (text[offset++] !== "]") throw new DatabaseProviderConflictError();
      return "a" + JSON.stringify(items);
    }
    for (const [literal, token] of [
      ["null", "z"],
      ["true", "b1"],
      ["false", "b0"],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return token;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      text.slice(offset),
    )?.[0];
    if (token === undefined) throw new DatabaseProviderConflictError();
    offset += token.length;
    return "n" + numericIdentity(token);
  };
  const result = value();
  whitespace();
  if (offset !== text.length) throw new DatabaseProviderConflictError();
  return result;
}

/** Stored Source bytes remain untouched; JSONB numeric scale/key order is compared without precision collapse. */
export function sameProviderRequestJsonb(left: string, right: string): boolean {
  try {
    return semanticIdentity(left) === semanticIdentity(right);
  } catch {
    return false;
  }
}
