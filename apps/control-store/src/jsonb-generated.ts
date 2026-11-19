/** PostgreSQL JSONB text for freshly generated JavaScript metadata only. Never parse or rewrite captured Source strings. */
export function generatedJsonb(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Invalid generated JSON metadata");
  const normalized: unknown = JSON.parse(serialized),
    encoder = new TextEncoder();
  const string = (input: string) => {
    for (let index = 0; index < input.length; index++) {
      const c = input.charCodeAt(index);
      if (c === 0 || (c >= 0xdc00 && c <= 0xdfff))
        throw new TypeError("Invalid PostgreSQL JSON metadata string");
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = input.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw new TypeError("Invalid PostgreSQL JSON metadata string");
      }
    }
    return JSON.stringify(input);
  };
  const number = (input: number) => {
    const lexical = String(input);
    if (!/[eE]/u.test(lexical)) return lexical;
    const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(lexical);
    if (!match) throw new TypeError("Invalid PostgreSQL JSON metadata number");
    const sign = match[1] ?? "",
      whole = match[2] ?? "",
      fraction = match[3] ?? "",
      digits = whole + fraction,
      point = whole.length + Number(match[4]);
    return (
      sign +
      (point <= 0
        ? "0." + "0".repeat(-point) + digits
        : point >= digits.length
          ? digits + "0".repeat(point - digits.length)
          : digits.slice(0, point) + "." + digits.slice(point))
    );
  };
  const render = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "string") return string(input);
    if (typeof input === "number") return number(input);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (Array.isArray(input)) return "[" + input.map(render).join(", ") + "]";
    if (typeof input !== "object") throw new TypeError("Invalid generated JSON metadata");
    const object = input as Record<string, unknown>,
      keys = Object.keys(object).map((key) => ({ key, bytes: encoder.encode(key) }));
    keys.sort((a, b) => {
      if (a.bytes.length !== b.bytes.length) return a.bytes.length - b.bytes.length;
      for (let i = 0; i < a.bytes.length; i++) {
        const x = a.bytes[i],
          y = b.bytes[i];
        if (x !== undefined && y !== undefined && x !== y) return x - y;
      }
      return 0;
    });
    return "{" + keys.map(({ key }) => string(key) + ": " + render(object[key])).join(", ") + "}";
  };
  return render(normalized);
}
