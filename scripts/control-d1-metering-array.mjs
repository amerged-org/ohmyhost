import { fail } from "./control-d1-codec.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  MIN = -2147483648,
  MAX = 2147483647;
const invalid = () => fail("METERING_UUID_ARRAY_UNREPRESENTABLE");

/** Original PostgreSQL UUID[] structure, not a flattened list. Empty arrays have zero dimensions. */
function dimensions(value, depth = 0) {
  if (!Array.isArray(value) || depth >= 6) return invalid();
  if (value.length === 0) return depth === 0 ? [] : invalid();
  const nested = Array.isArray(value[0]);
  let child;
  for (const element of value) {
    if (Array.isArray(element) !== nested) return invalid();
    if (nested) {
      const shape = dimensions(element, depth + 1);
      if (child !== undefined && JSON.stringify(child) !== JSON.stringify(shape)) return invalid();
      child = shape;
    } else if (element !== null && (typeof element !== "string" || !UUID.test(element)))
      return invalid();
  }
  return [value.length, ...(child ?? [])];
}
function checked(value, bounds) {
  if (value === null) {
    if (bounds !== null) return invalid();
    return [];
  }
  const shape = dimensions(value),
    count = shape.reduce((total, size) => total * size, 1);
  if (shape.length !== 0 && count > 16) return invalid();
  if (
    bounds !== null &&
    (!Array.isArray(bounds) || shape.length === 0 || bounds.length !== shape.length)
  )
    return invalid();
  if (bounds !== null && bounds.every((lower) => lower === 1)) return invalid();
  const lower = bounds ?? shape.map(() => 1);
  for (let i = 0; i < shape.length; i++) {
    const start = lower[i],
      end = start + shape[i] - 1;
    // PG18 rejects an upper bound of INT_MAX too: it must retain the one-past-end position.
    if (!Number.isInteger(start) || start < MIN || start > MAX || end >= MAX) return invalid();
  }
  return shape;
}
function body(value) {
  return `{${value.map((element) => (Array.isArray(element) ? body(element) : element === null ? "NULL" : element)).join(",")}}`;
}
/** Exact native array_out form. The lower bounds are captured facts; NULL metadata means native ordinary bounds. */
export function meteringUuidArrayText(value, bounds) {
  const shape = checked(value, bounds);
  if (value === null) return null;
  const prefix =
    bounds !== null && bounds.some((lower) => lower !== 1)
      ? bounds.map((lower, index) => `[${lower}:${lower + shape[index] - 1}]`).join("") + "="
      : "";
  return prefix + body(value);
}
/** Parse only canonical native UUID-array output and prove exact reconstruction before emitting target values. */
export function parseMeteringUuidArray(text) {
  if (text === null) return { values: null, bounds: null };
  if (typeof text !== "string") return invalid();
  let offset = 0;
  const declared = [];
  while (text[offset] === "[") {
    const match = /^\[(-?(?:0|[1-9][0-9]*)):(-?(?:0|[1-9][0-9]*))\]/u.exec(text.slice(offset));
    if (match === null || declared.length === 6) return invalid();
    const lower = Number(match[1]),
      upper = Number(match[2]);
    if (
      !Number.isInteger(lower) ||
      !Number.isInteger(upper) ||
      lower < MIN ||
      upper >= MAX ||
      upper < lower
    )
      return invalid();
    declared.push([lower, upper]);
    offset += match[0].length;
  }
  if (declared.length > 0) {
    if (text[offset] !== "=") return invalid();
    offset++;
  }
  const read = (depth = 0) => {
    if (depth >= 6 || text[offset++] !== "{") return invalid();
    const result = [];
    if (text[offset] === "}") {
      offset++;
      return result;
    }
    for (;;) {
      if (text[offset] === "{") result.push(read(depth + 1));
      else {
        const start = offset;
        while (offset < text.length && text[offset] !== "," && text[offset] !== "}") offset++;
        const atom = text.slice(start, offset);
        if (atom !== "NULL" && !UUID.test(atom)) return invalid();
        result.push(atom === "NULL" ? null : atom);
      }
      const separator = text[offset++];
      if (separator === "}") return result;
      if (separator !== ",") return invalid();
    }
  };
  const values = read(),
    shape = dimensions(values);
  if (
    offset !== text.length ||
    (declared.length > 0 &&
      (declared.length !== shape.length ||
        declared.some(([lower, upper], index) => upper - lower + 1 !== shape[index])))
  )
    return invalid();
  const bounds =
    declared.length > 0 && declared.some(([lower]) => lower !== 1)
      ? declared.map(([lower]) => lower)
      : null;
  if (meteringUuidArrayText(values, bounds) !== text) return invalid();
  return { values, bounds };
}
