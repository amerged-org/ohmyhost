/**
 * Splits a migration file into single statements. D1 `exec` splits on newlines and cannot take a
 * multi-line statement, so migrations are applied one statement at a time. A `;` ends a statement only
 * outside strings, quoted identifiers, comments and `BEGIN ... END` / `CASE ... END` blocks (trigger bodies).
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let index = 0;
  const flush = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (text !== "" && !/^(--[^\n]*(\n|$)\s*)*$/u.test(text)) statements.push(text);
    start = end + 1;
  };
  while (index < sql.length) {
    const char = sql[index] as string;
    if (char === "'" || char === '"') {
      index += 1;
      while (index < sql.length && !(sql[index] === char && sql[index + 1] !== char)) {
        index += sql[index] === char ? 2 : 1;
      }
      index += 1;
    } else if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
    } else if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
    } else if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/u.test(sql[end] as string)) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      if (word === "BEGIN" || word === "CASE") depth += 1;
      else if (word === "END" && depth > 0) depth -= 1;
      index = end;
    } else {
      if (char === ";" && depth === 0) flush(index);
      index += 1;
    }
  }
  flush(sql.length);
  return statements;
}
