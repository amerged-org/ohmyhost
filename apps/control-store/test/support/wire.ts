/**
 * The Worker RPC seam between a consumer adapter and the real Core entrypoint: every method is the real entrypoint's,
 * except those a test replaces with an exact reply (a corrupted or foreign answer) or an exact refusal message
 * (the text a Core command throws). Nothing else is simulated.
 */
export function seam<T extends object>(real: T) {
  const replaced = new Map<string, () => Promise<unknown>>();
  const binding = new Proxy(real, {
    get(target, name) {
      const replacement = typeof name === "string" ? replaced.get(name) : undefined;
      if (replacement !== undefined) return replacement;
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    binding,
    reply(name: keyof T & string, value: unknown) {
      replaced.set(name, async () => value);
    },
    refuse(name: keyof T & string, message: string, errorName?: string) {
      replaced.set(name, async () => {
        const error = new Error(message);
        if (errorName !== undefined) error.name = errorName;
        throw error;
      });
    },
    restore() {
      replaced.clear();
    },
  };
}
