/**
 * One JSON line per outcome. Only closed tokens, ids, the model and counts may be passed: never a prompt, an answer,
 * a key, an orq body or a URL with a secret.
 */
export function warnLine(event: string, fields: Readonly<Record<string, string | number>>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}
