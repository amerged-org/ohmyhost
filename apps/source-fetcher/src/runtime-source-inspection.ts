import { FrameworkConversionDiagnosticError } from "@ohmyhost/contracts";
import { SOCKET_PRIMITIVE_SPECIFIER } from "@ohmyhost/contracts/framework-source-rules";
import {
  inspectWorkerRuntimeImports,
  NextRuntimeSourceSyntaxError,
  NextWorkersIncompatibleError,
} from "@ohmyhost/adapter-next";
import type { FrameworkPlan } from "@ohmyhost/platform";

const SOURCE = /(?:\.[cm]?[jt]sx?|\.astro)$/u;
const EXTENSIONS = [
  ".astro",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
] as const;
const SOCKET_DRIVER = /^(?:pg|postgres|pg-native|mysql2)(?:\/|$)/u;

export class RuntimeSourceInspectionLimitError extends Error {
  public constructor() {
    super("Runtime source inspection limit exceeded");
  }
}

/**
 * Follows local server imports over the original archive bytes without loading customer code. The
 * parser yields decoded module specifiers (static imports, re-exports, `import()` and `require`),
 * so a spelling escape or a regex literal cannot hide `socketPrimitivePath`, the first module
 * that loads the raw socket primitive. A specifier built at run time stays unseen.
 *
 * A file whose body the archive reader did not retain is a limit refusal once the traversal
 * reaches it: the traversal never skips a file it cannot read.
 */
export function inspectReachableRuntimeSources(
  plan: FrameworkPlan,
  archive: ReadonlyMap<string, Uint8Array | null>,
) {
  const prefix = plan.applicationRoot === "." ? "" : `${plan.applicationRoot}/`;
  const files = new Map<string, Uint8Array | null>(
    [...archive]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, body]) => [name.slice(prefix.length), body]),
  );
  const sources = new Map<string, string>();
  if (plan.runtime === "static") return { sources, socketPath: null, socketPrimitivePath: null };
  const pending = [...files.keys()].filter((name) =>
    plan.adapter === "astro"
      ? /^(?:src\/(?:pages\/|middleware(?:\.|\/))|src\/components\/)/u.test(name) &&
        SOURCE.test(name)
      : plan.adapter === "nextjs"
        ? /^(?:(?:src\/)?(?:app|pages)\/|(?:src\/)?(?:middleware|proxy)\.)/u.test(name) &&
          SOURCE.test(name)
        : plan.adapter === "tanstack-start"
          ? /^(?:src\/routes\/|src\/(?:server|start|ssr)\.)/u.test(name) && SOURCE.test(name)
          : name ===
            (plan.adapter === "vite-static"
              ? "src/ohmyhost/companion.ts"
              : "src/ohmyhost/worker.ts"),
  );
  if (plan.functions !== undefined && files.has("src/ohmyhost/worker.ts"))
    pending.push("src/ohmyhost/worker.ts");
  const aliases = readAliases(files);
  let total = 0;
  let socketPath: string | null = null;
  let socketPrimitivePath: string | null = null;
  while (pending.length) {
    const name = pending.pop();
    if (name === undefined || sources.has(name)) continue;
    const body = files.get(name);
    if (body === undefined || !SOURCE.test(name)) continue;
    if (body === null) throw new RuntimeSourceInspectionLimitError();
    total += body.byteLength;
    if (body.byteLength > 256 * 1024 || total > 8 * 1024 * 1024 || sources.size >= 2_000)
      throw new RuntimeSourceInspectionLimitError();
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new NextRuntimeSourceSyntaxError(name);
    }
    if (name.endsWith(".astro")) {
      const fences = [
        ...source.matchAll(
          /^(?:\uFEFF)?[ \t]*---[ \t]*\r?\n([\s\S]*?)^[ \t]*---[ \t]*(?:\r?\n|$)/gmu,
        ),
      ];
      let template = "";
      let offset = 0;
      for (const fence of fences) {
        template += source.slice(offset, fence.index);
        offset = fence.index + fence[0].length;
      }
      template += source.slice(offset);
      if (/^(?:\uFEFF)?[ \t]*---(?:[ \t]*$|[ \t]*\r?\n)/mu.test(template))
        throw new NextRuntimeSourceSyntaxError(name);
      if (importsDynamically(template))
        throw new FrameworkConversionDiagnosticError({
          code: "astro_template_import_unsupported",
          path: name,
        });
      source = fences.map((fence) => fence[1]).join("\n");
    }
    sources.set(name, source);
    const inspected = inspectWorkerRuntimeImports(name, source);
    if (inspected.findings.length) throw new NextWorkersIncompatibleError(inspected.findings);
    for (const imported of inspected.imports) {
      if (SOCKET_DRIVER.test(imported)) socketPath ??= name;
      if (imported === SOCKET_PRIMITIVE_SPECIFIER) socketPrimitivePath ??= name;
      const candidates =
        imported.startsWith("./") || imported.startsWith("../")
          ? [normalize(`${directory(name)}${imported}`)]
          : aliases.flatMap(({ pattern, targets }) => {
              const [before, after = ""] = pattern.split("*");
              if (
                before === undefined ||
                !imported.startsWith(before) ||
                !imported.endsWith(after) ||
                (!pattern.includes("*") && imported !== pattern)
              )
                return [];
              const wildcard = imported.slice(before.length, imported.length - after.length);
              return targets.map((target) => normalize(target.replace("*", wildcard)));
            });
      for (const candidate of candidates) {
        if (candidate === null) continue;
        const stem = candidate.replace(/\.(?:mjs|cjs|js)$/u, "");
        const resolved = [
          candidate,
          ...EXTENSIONS.map((extension) => `${stem}${extension}`),
          ...EXTENSIONS.map((extension) => `${candidate}/index${extension}`),
        ].find((target) => files.has(target));
        if (resolved !== undefined) {
          pending.push(resolved);
          break;
        }
      }
    }
  }
  return { sources, socketPath, socketPrimitivePath };
}

/**
 * Whether an `import` or `require` token is followed, past whitespace and comments, by `(` or by
 * `.` with optional whitespace and `meta`. A block comment may end at any later terminator, as
 * the matching regular expression allows, so the answer is computed for every position from the
 * end backwards: one pass, linear in the template length.
 */
function importsDynamically(template: string): boolean {
  const length = template.length;
  const isSpace = (index: number) => index < length && /\s/u.test(template.charAt(index));
  // reaches[q] is 1 when a path of whitespace and comments from q ends at `(` or `.meta`.
  const reaches = new Uint8Array(length + 2);
  let closerReaches = false;
  let newline = -1;
  for (let q = length; q >= 0; q -= 1) {
    if (template.startsWith("*/", q + 2)) closerReaches ||= reaches[q + 4] === 1;
    if (template.charAt(q + 2) === "\n") newline = q + 2;
    const character = template.charAt(q);
    let value = false;
    if (character === "(") value = true;
    else if (character === ".") {
      let meta = q + 1;
      while (isSpace(meta)) meta += 1;
      value = template.startsWith("meta", meta);
    } else if (isSpace(q)) value = reaches[q + 1] === 1;
    else if (template.startsWith("/*", q)) value = closerReaches;
    else if (template.startsWith("//", q)) value = newline !== -1 && reaches[newline + 1] === 1;
    reaches[q] = value ? 1 : 0;
  }
  for (const token of template.matchAll(/\b(?:import|require)/gu)) {
    if (reaches[(token.index ?? 0) + token[0].length] === 1) return true;
  }
  return false;
}

function directory(name: string): string {
  const at = name.lastIndexOf("/");
  return at < 0 ? "" : name.slice(0, at + 1);
}
function normalize(name: string): string | null {
  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function readAliases(
  files: ReadonlyMap<string, Uint8Array | null>,
): readonly { pattern: string; targets: readonly string[] }[] {
  const root = files.has("tsconfig.json") ? "tsconfig.json" : "jsconfig.json";
  const seen = new Set<string>();
  const read = (
    name: string,
  ): {
    base: string | null | undefined;
    pathsDirectory: string;
    paths: Record<string, unknown>;
  } => {
    const body = files.get(name);
    // An alias config the reader did not retain could hide a module that the traversal must follow.
    if (body === null) throw new RuntimeSourceInspectionLimitError();
    if (body === undefined || body.byteLength > 256 * 1024 || seen.has(name) || seen.size >= 8)
      return { base: undefined, pathsDirectory: "", paths: {} };
    seen.add(name);
    let value: unknown;
    try {
      value = JSON.parse(jsonc(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    } catch {
      return { base: undefined, pathsDirectory: "", paths: {} };
    }
    if (!record(value)) return { base: undefined, pathsDirectory: "", paths: {} };
    const parent =
      typeof value["extends"] === "string" && value["extends"].startsWith(".")
        ? normalize(`${directory(name)}${value["extends"]}`)
        : null;
    const inherited =
      parent === null
        ? { base: undefined, pathsDirectory: "", paths: {} }
        : read(parent.endsWith(".json") ? parent : `${parent}.json`);
    const options = record(value["compilerOptions"]) ? value["compilerOptions"] : {};
    const base =
      typeof options["baseUrl"] === "string"
        ? normalize(`${directory(name)}${options["baseUrl"]}`)
        : inherited.base;
    return {
      base,
      pathsDirectory: record(options["paths"]) ? directory(name) : inherited.pathsDirectory,
      paths: record(options["paths"]) ? options["paths"] : inherited.paths,
    };
  };
  const { base, pathsDirectory, paths } = read(root);
  if (base === null) return [];
  const aliases = Object.entries(paths)
    .slice(0, 128)
    .flatMap(([pattern, targets]) => {
      if (pattern.split("*").length > 2 || !Array.isArray(targets)) return [];
      const values = targets
        .filter((target): target is string => typeof target === "string" && target.length <= 512)
        .slice(0, 16)
        // Final baseUrl overrides apply to inherited paths; without it, paths retain their
        // declaring config's directory, exactly as TypeScript's pathsBasePath does.
        .map((target) => normalize(`${base ?? pathsDirectory}/${target}`))
        .filter((target): target is string => target !== null);
      return [{ pattern, targets: values }];
    });
  if (base !== undefined) aliases.push({ pattern: "*", targets: [`${base}/*`] });
  return aliases;
}

/** JSON-with-comments remains data; quoted contents never become comment or comma syntax. */
function jsonc(source: string): string {
  let out = "";
  let quoted = false;
  for (let at = 0; at < source.length; at++) {
    const character = source[at];
    if (quoted) {
      out += character;
      if (character === "\\") out += source[++at] ?? "";
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      out += character;
    } else if (character === "/" && source[at + 1] === "/") {
      while (at < source.length && source[at] !== "\n") at++;
      out += "\n";
    } else if (character === "/" && source[at + 1] === "*") {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new TypeError("Invalid configuration comment");
      at = end + 1;
      out += " ";
    } else if (character === "," && /^[\s]*[}\]]/u.test(source.slice(at + 1))) out += " ";
    else out += character;
  }
  return out;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
