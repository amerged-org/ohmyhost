import { parse } from "@babel/parser";

const SOURCE_PATH_PATTERN =
  /^(?:(?:(?:src\/)?(?:app|pages)\/)[\s\S]*|(?:src\/)?(?:middleware|proxy))\.(?:[cm]?[jt]sx?)$/u;
const MAXIMUM_SOURCE_FILES = 2_000;
const MAXIMUM_SOURCE_BYTES = 256 * 1024;
const MAXIMUM_TOTAL_SOURCE_BYTES = 8 * 1024 * 1024;
const NON_FUNCTIONAL_NODE_MODULES = new Set([
  "node:_stream_wrap",
  "node:child_process",
  "node:cluster",
  "node:dgram",
  "node:domain",
  "node:http2",
  "node:inspector",
  "node:readline",
  "node:repl",
  "node:sqlite",
  "node:trace_events",
  "node:tty",
  "node:v8",
  "node:vm",
  "node:wasi",
  "node:worker_threads",
]);
export class NextRuntimeSourceSyntaxError extends TypeError {
  public constructor(public readonly path: string) {
    super("Next.js runtime source contains invalid JavaScript or TypeScript");
    this.name = "NextRuntimeSourceSyntaxError";
  }
}

export interface NextRuntimeSource {
  readonly path: string;
  readonly source: string;
}

export type NextWorkersIncompatibilityFinding =
  | Readonly<{
      code: "native_addon_unsupported";
      path: string;
      module: string;
    }>
  | Readonly<{
      code: "workers_node_stub_module";
      path: string;
      module: string;
    }>;

export class NextWorkersIncompatibleError extends Error {
  public readonly code = "next_workers_runtime_incompatible";
  public readonly classification = "unsupported";
  public readonly findings: readonly NextWorkersIncompatibilityFinding[];

  public constructor(findings: readonly NextWorkersIncompatibilityFinding[]) {
    super("Next.js source uses a native addon or a Node.js API that does not function on Workers");
    this.name = "NextWorkersIncompatibleError";
    if (findings.length === 0) throw new TypeError("Workers incompatibility findings are required");
    this.findings = Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
  }
}

export function nextRuntimeSourcePaths(files: readonly string[]): readonly string[] {
  const paths = files.filter((path) => SOURCE_PATH_PATTERN.test(path)).sort(compareText);
  if (paths.length > MAXIMUM_SOURCE_FILES || new Set(paths).size !== paths.length) {
    throw new TypeError("Next.js runtime source inventory is invalid");
  }
  return Object.freeze(paths);
}

export function analyzeNextWorkersCompatibility(
  sources: readonly NextRuntimeSource[],
): readonly NextWorkersIncompatibilityFinding[] {
  if (sources.length > MAXIMUM_SOURCE_FILES) {
    throw new TypeError("Next.js runtime source inventory is invalid");
  }
  const findings: NextWorkersIncompatibilityFinding[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of sources) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      typeof entry.source !== "string" ||
      !SOURCE_PATH_PATTERN.test(entry.path) ||
      paths.has(entry.path)
    ) {
      throw new TypeError("Next.js runtime source inventory is invalid");
    }
    paths.add(entry.path);
    const bytes = new TextEncoder().encode(entry.source).byteLength;
    totalBytes += bytes;
    if (bytes > MAXIMUM_SOURCE_BYTES || totalBytes > MAXIMUM_TOTAL_SOURCE_BYTES) {
      throw new TypeError("Next.js runtime source inventory exceeds inspection limits");
    }
    findings.push(...inspectWorkerRuntimeImports(entry.path, entry.source).findings);
  }
  findings.sort((left, right) =>
    compareText(
      `${left.path}\n${left.code}\n${left.module}`,
      `${right.path}\n${right.code}\n${right.module}`,
    ),
  );
  return Object.freeze(findings);
}

/** Parses one reachable server module without evaluating it, including re-exports and literals. */
export function inspectWorkerRuntimeImports(
  path: string,
  source: string,
): Readonly<{
  imports: readonly string[];
  findings: readonly NextWorkersIncompatibilityFinding[];
}> {
  const imports = [...importedModules(source, path)];
  const findings = imports.flatMap((module): NextWorkersIncompatibilityFinding[] => {
    if (module.endsWith(".node")) return [{ code: "native_addon_unsupported", path, module }];
    if (isNonFunctionalNodeModule(module))
      return [{ code: "workers_node_stub_module", path, module }];
    return [];
  });
  return Object.freeze({
    imports: Object.freeze(imports),
    findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
  });
}

export function assertNextWorkersCompatibility(sources: readonly NextRuntimeSource[]): void {
  const findings = analyzeNextWorkersCompatibility(sources);
  if (findings.length > 0) throw new NextWorkersIncompatibleError(findings);
}

function importedModules(source: string, path: string): ReadonlySet<string> {
  let tree: unknown;
  try {
    // decorators-legacy is the TypeScript experimentalDecorators syntax; Babel takes only one decorators plugin.
    tree = parse(source, {
      sourceType: "unambiguous",
      plugins: /\.[cm]?ts$/u.test(path)
        ? ["typescript", "decorators-legacy"]
        : ["typescript", "jsx", "decorators-legacy"],
      createImportExpressions: true,
      attachComment: false,
      allowUndeclaredExports: true,
    });
  } catch {
    throw new NextRuntimeSourceSyntaxError(path);
  }
  const modules = new Set<string>();
  const pending: unknown[] = [tree];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    let literal: unknown;
    if (node["type"] === "ImportDeclaration" && node["importKind"] !== "type") {
      literal = node["source"];
    } else if (
      (node["type"] === "ExportNamedDeclaration" || node["type"] === "ExportAllDeclaration") &&
      node["exportKind"] !== "type"
    ) {
      literal = node["source"];
    } else if (node["type"] === "ImportExpression") {
      literal = node["source"];
    } else if (node["type"] === "TSImportEqualsDeclaration" && node["importKind"] !== "type") {
      const reference = node["moduleReference"] as Record<string, unknown>;
      if (reference["type"] === "TSExternalModuleReference") literal = reference["expression"];
    } else if (node["type"] === "CallExpression") {
      const callee = node["callee"] as Record<string, unknown>;
      const property = callee["property"] as Record<string, unknown> | undefined;
      if (
        (callee["type"] === "Identifier" && callee["name"] === "require") ||
        (callee["type"] === "MemberExpression" &&
          (property?.["name"] === "require" || property?.["value"] === "require"))
      )
        literal = (node["arguments"] as unknown[])[0];
    }
    if (literal !== null && typeof literal === "object") {
      const candidate = literal as Record<string, unknown>;
      if (candidate["type"] === "StringLiteral" && typeof candidate["value"] === "string") {
        modules.add(candidate["value"]);
      } else if (
        candidate["type"] === "TemplateLiteral" &&
        (candidate["expressions"] as unknown[]).length === 0
      ) {
        const quasis = candidate["quasis"] as Array<{ value: { cooked: string | null } }>;
        const module = quasis[0]?.value.cooked;
        if (typeof module === "string") modules.add(module);
      }
    }
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return modules;
}

function isNonFunctionalNodeModule(value: string): boolean {
  return NON_FUNCTIONAL_NODE_MODULES.has(value.startsWith("node:") ? value : `node:${value}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
