/* global TextEncoder, atob, btoa */
// Tagged transport adapted from W41's preview transport; no credentials or tenant scope cross it.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 16;
const invalid = () => {
  throw new Error("qa_transport_invalid");
};

export function encodeValue(value) {
  let nodes = 0;
  function encode(input, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    if (input === null) return ["null", null];
    if (typeof input === "string" || typeof input === "boolean") return [typeof input, input];
    if (typeof input === "number" && Number.isFinite(input)) return ["number", input];
    if (input instanceof Date && Number.isFinite(input.getTime()))
      return ["date", input.toISOString()];
    if (input instanceof Uint8Array) {
      let binary = "";
      for (let offset = 0; offset < input.length; offset += 32_768)
        binary += String.fromCharCode(...input.subarray(offset, offset + 32_768));
      return ["bytes", btoa(binary)];
    }
    if (Array.isArray(input)) return ["array", input.map((child) => encode(child, depth + 1))];
    if (
      typeof input === "object" &&
      input !== null &&
      Object.getPrototypeOf(input) === Object.prototype
    )
      return [
        "object",
        Object.entries(input).map(([key, child]) => [key, encode(child, depth + 1)]),
      ];
    return invalid();
  }
  const text = JSON.stringify(encode(value, 0));
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) invalid();
  return text;
}

export function decodeValue(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_BYTES) invalid();
  let nodes = 0;
  function decode(input, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || !Array.isArray(input) || input.length !== 2)
      invalid();
    const [tag, value] = input;
    if (tag === "null" && value === null) return null;
    if (tag === "string" && typeof value === "string") return value;
    if (tag === "boolean" && typeof value === "boolean") return value;
    if (tag === "number" && typeof value === "number" && Number.isFinite(value)) return value;
    if (tag === "date" && typeof value === "string") {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid();
      return date;
    }
    if (tag === "bytes" && typeof value === "string") {
      const binary = atob(value);
      if (btoa(binary) !== value) invalid();
      return Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
    }
    if (tag === "array" && Array.isArray(value))
      return value.map((child) => decode(child, depth + 1));
    if (tag === "object" && Array.isArray(value)) {
      const result = {};
      for (const pair of value) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          Object.hasOwn(result, pair[0])
        )
          invalid();
        Object.defineProperty(result, pair[0], {
          enumerable: true,
          configurable: true,
          writable: true,
          value: decode(pair[1], depth + 1),
        });
      }
      return result;
    }
    return invalid();
  }
  try {
    return decode(JSON.parse(text), 0);
  } catch {
    return invalid();
  }
}
