import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { currentArchitectureErrors, runPlanStructureCheck } from "./check-plan-structure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const COVERAGE_PATH = "docs/architecture/coverage.json";
const HASH = /^[a-f0-9]{64}$/u;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".c",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".sql",
  ".tf",
  ".hcl",
  ".sh",
  ".css",
  ".html",
  ".toml",
  ".conf",
  ".py",
]);
const ROOT_CONFIGURATION = new Set([
  ".gitignore",
  ".gitleaks.toml",
  ".gitattributes",
  ".npmrc",
  ".node-version",
  ".prettierignore",
  ".prettierrc.json",
  ".env.example",
]);
const HISTORICAL = /^docs\/plan\/(?:evidence|history)\//u;

export function sourceHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safePath(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part === ".." || part === "")
  )
    throw new Error(`Invalid documentation path: ${String(relative)}`);
  const absolute = path.resolve(root, relative);
  if (existsSync(absolute)) {
    const resolved = realpathSync(absolute);
    if (!resolved.startsWith(`${realpathSync(root)}${path.sep}`) || !lstatSync(absolute).isFile())
      throw new Error(`Non-file or escaping documentation path: ${relative}`);
  }
  return absolute;
}

export function candidateFiles(root = ROOT) {
  const names = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set(names)].filter((name) => existsSync(path.join(root, name))).sort();
}

export function requiresSourceReview(file) {
  if (file === COVERAGE_PATH || HISTORICAL.test(file)) return false;
  return (
    ROOT_CONFIGURATION.has(file) ||
    SOURCE_EXTENSIONS.has(path.extname(file)) ||
    path.basename(file).startsWith("Dockerfile")
  );
}

export function extractResources(root, files) {
  const result = [];
  for (const file of files.filter((name) =>
    /^apps\/[^/]+\/wrangler(?:\.[\w-]+)*\.jsonc?$/u.test(name),
  )) {
    const parsed = ts.parseConfigFileTextToJson(file, readFileSync(safePath(root, file), "utf8"));
    if (parsed.error) throw new Error(`Invalid Worker configuration: ${file}`);
    const addProfile = (config, profile) => {
      const add = (kind, binding, target = "", entrypoint = "") => {
        if (
          typeof binding !== "string" ||
          !binding ||
          typeof target !== "string" ||
          typeof entrypoint !== "string"
        )
          throw new Error(`Invalid ${kind} resource declaration: ${file}`);
        result.push({
          id: `${file}::${profile}::${kind}::${binding}`,
          file,
          profile,
          kind,
          binding,
          target,
          entrypoint,
        });
      };
      if (config.name) add("worker", config.name, config.main ?? "");
      if (config.browser) add("browser", config.browser.binding);
      for (const item of config.services ?? [])
        add("service", item.binding, item.service, item.entrypoint ?? "default");
      for (const item of config.durable_objects?.bindings ?? [])
        add("durable-object", item.name, item.script_name ?? config.name ?? "", item.class_name);
      for (const item of config.workflows ?? [])
        add("workflow", item.binding, item.name, item.class_name);
      for (const item of config.r2_buckets ?? []) add("r2", item.binding, item.bucket_name);
      for (const item of config.artifacts ?? []) add("artifacts", item.binding, item.namespace);
      for (const item of config.hyperdrive ?? []) add("hyperdrive", item.binding, item.id);
      for (const item of config.dispatch_namespaces ?? []) {
        add("wfp-namespace", item.binding, item.namespace);
        if (item.outbound)
          add(
            "wfp-outbound",
            `${item.binding}.outbound`,
            item.outbound.service,
            (item.outbound.parameters ?? []).join(","),
          );
      }
      for (const item of config.tail_consumers ?? [])
        add("tail-consumer", item.service, item.service, item.entrypoint ?? "default");
      for (const item of config.d1_databases ?? [])
        add("d1", item.binding, item.database_name, item.database_id);
      for (const item of config.kv_namespaces ?? []) add("kv", item.binding, item.id);

      for (const item of config.queues?.producers ?? [])
        add("queue-producer", item.binding, item.queue);
      for (const item of config.queues?.consumers ?? [])
        add("queue-consumer", item.queue, item.queue);
      for (const item of config.queues?.consumers ?? []) {
        if (item.dead_letter_queue)
          add("queue-dlq", `${item.queue}.dead-letter`, item.dead_letter_queue);
      }
      for (const item of config.containers ?? []) {
        add("container", item.class_name, item.image ?? "", item.class_name);
        for (const [name, image] of Object.entries(item.images ?? {}))
          add(
            "container-image",
            `${item.class_name}.${name}`,
            image.dockerfile ?? image.image ?? "",
            item.class_name,
          );
      }
      for (const cron of config.triggers?.crons ?? []) add("cron", cron, config.name ?? "");
      for (const item of config.routes ?? [])
        add("route", typeof item === "string" ? item : item.pattern, config.name ?? "");
      if (config.assets)
        add("assets", config.assets.binding ?? "ASSETS", config.assets.directory ?? "");
      for (const [name, env] of Object.entries(config.env ?? {})) addProfile(env, name);
    };
    addProfile(parsed.config, "default");
  }
  if (new Set(result.map(({ id }) => id)).size !== result.length)
    throw new Error("Duplicate declared Worker resource identity");
  return result.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

export function markdownAnchors(text) {
  const anchors = new Set();
  for (const match of text.matchAll(/<a\s+id=["']([^"']+)["'][^>]*>/gu)) anchors.add(match[1]);
  const headings = new Map();
  for (const line of text.replace(/```[^\n]*\n[\s\S]*?```/gu, "").split("\n")) {
    const match = /^#{1,6}\s+(.+?)(?:\s+#+)?$/u.exec(line);
    if (!match) continue;
    const base = match[1]
      .replace(/<[^>]+>/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/ /gu, "-");
    const seen = headings.get(base) ?? 0;
    anchors.add(seen ? `${base}-${seen}` : base);
    headings.set(base, seen + 1);
  }
  return anchors;
}

function checkDocumentReference(root, reference, errors, label) {
  if (
    typeof reference !== "string" ||
    !reference.startsWith("docs/") ||
    HISTORICAL.test(reference) ||
    reference.includes("/tmp/")
  ) {
    errors.push(`Missing current documentation mapping: ${label}`);
    return;
  }
  const [file, fragment] = reference.split("#");
  try {
    const location = safePath(root, file);
    if (!existsSync(location)) errors.push(`Missing documentation file: ${label}: ${file}`);
    else if (fragment && !markdownAnchors(readFileSync(location, "utf8")).has(fragment))
      errors.push(`Missing documentation anchor: ${label}: ${reference}`);
  } catch (error) {
    errors.push(error.message);
  }
}

export function validateFileReviews({ root, files, coverage }) {
  const errors = [],
    records = new Map();
  if (coverage?.schemaVersion !== 2 || !Array.isArray(coverage.fileReviews))
    return ["Invalid file-review ledger"];
  for (const record of coverage.fileReviews) {
    if (!record || typeof record.path !== "string" || records.has(record.path)) {
      errors.push("Duplicate or invalid file-review record");
      continue;
    }
    records.set(record.path, record);
    if (
      typeof record.category !== "string" ||
      !record.category ||
      typeof record.reviewer !== "string" ||
      !record.reviewer ||
      typeof record.summary !== "string" ||
      record.summary.trim().length < 20 ||
      record.reviewState !== "reviewed" ||
      typeof record.reviewMethod !== "string" ||
      record.reviewMethod.trim().length < 5
    )
      errors.push(`Incomplete source review: ${record.path}`);
    checkDocumentReference(root, record.document, errors, record.path);
    if (!HISTORICAL.test(record.path) && record.path !== COVERAGE_PATH) {
      if (!HASH.test(record.sha256 ?? ""))
        errors.push(`Missing reviewed source hash: ${record.path}`);
      else {
        try {
          if (sourceHash(readFileSync(safePath(root, record.path))) !== record.sha256)
            errors.push(`Changed source requires explicit review: ${record.path}`);
        } catch {
          errors.push(`Unavailable reviewed source: ${record.path}`);
        }
      }
    }
  }
  const expected = new Set(files.filter((file) => file !== COVERAGE_PATH));
  for (const file of expected)
    if (!records.has(file)) errors.push(`Unreviewed or unclassified file: ${file}`);
  for (const file of records.keys())
    if (!expected.has(file)) errors.push(`Removed or untracked review record: ${file}`);
  return errors;
}

export function validateResources({ root, resources, coverage }) {
  const errors = [],
    actual = new Map(resources.map((record) => [record.id, record])),
    seen = new Set();
  if (!Array.isArray(coverage.resources)) return ["Missing resource coverage ledger"];
  for (const { document, ...record } of coverage.resources) {
    if (seen.has(record.id)) errors.push(`Duplicate resource mapping: ${record.id}`);
    seen.add(record.id);
    if (!isDeepStrictEqual(record, actual.get(record.id)))
      errors.push(`Stale or unknown resource mapping: ${record.id}`);
    checkDocumentReference(root, document, errors, record.id);
  }
  for (const id of actual.keys())
    if (!seen.has(id)) errors.push(`Unmapped declared resource: ${id}`);
  for (const feature of coverage.features ?? [])
    checkDocumentReference(
      root,
      feature.document,
      errors,
      feature.decisions?.join(",") ?? "feature",
    );
  for (const boundary of coverage.manualBoundaries ?? [])
    checkDocumentReference(root, boundary.document, errors, boundary.name);
  return errors;
}

export function collectDiagrams(root, files) {
  const diagrams = [];
  for (const file of files.filter((name) => /^docs\/architecture\/.*\.md$/u.test(name))) {
    const text = readFileSync(safePath(root, file), "utf8");
    let index = 0;
    for (const match of text.matchAll(/^```mermaid\s*\n([\s\S]*?)^```\s*$/gmu)) {
      diagrams.push({
        id: `${file}::${index++}`,
        document: file,
        source: match[1].trim(),
        sha256: sourceHash(match[1].trim()),
      });
    }
  }
  return diagrams;
}

export function validateDiagrams({ root, diagrams, resources, coverage }) {
  const errors = [],
    actual = new Map(diagrams.map((diagram) => [diagram.id, diagram])),
    knownResources = new Set(resources.map(({ id }) => id)),
    seen = new Set();
  if (!Array.isArray(coverage.diagrams) || coverage.diagrams.length === 0)
    return ["Current architecture Mermaid diagrams must be present and reviewed"];
  for (const record of coverage.diagrams) {
    if (seen.has(record.id)) errors.push(`Duplicate diagram review: ${record.id}`);
    seen.add(record.id);
    const diagram = actual.get(record.id);
    if (!diagram || diagram.sha256 !== record.sha256 || diagram.document !== record.document)
      errors.push(`Changed or missing Mermaid diagram requires review: ${record.id}`);
    checkDocumentReference(root, record.document, errors, record.id);
    if (
      !record.reviewer ||
      typeof record.summary !== "string" ||
      record.summary.trim().length < 20 ||
      !Array.isArray(record.sourceRefs) ||
      record.sourceRefs.length === 0
    )
      errors.push(`Incomplete diagram source review: ${record.id}`);
    for (const ref of record.sourceRefs ?? []) {
      try {
        if (
          !requiresSourceReview(ref.path) ||
          !HASH.test(ref.sha256 ?? "") ||
          sourceHash(readFileSync(safePath(root, ref.path))) !== ref.sha256
        )
          errors.push(`Stale diagram source: ${record.id}: ${ref.path}`);
      } catch {
        errors.push(`Unavailable diagram source: ${record.id}: ${ref.path}`);
      }
    }
    const dependencyFiles = new Set((record.sourceRefs ?? []).map((ref) => ref.path));
    for (const id of record.resources ?? []) {
      const resource = resources.find((item) => item.id === id);
      if (resource && !dependencyFiles.has(resource.file))
        errors.push(`Diagram resource lacks source dependency: ${record.id}: ${id}`);
    }
    if (!Array.isArray(record.resources) || record.resources.some((id) => !knownResources.has(id)))
      errors.push(`Unknown diagram resource mapping: ${record.id}`);
  }
  for (const id of actual.keys())
    if (!seen.has(id)) errors.push(`Unreviewed Mermaid diagram: ${id}`);
  return errors;
}

export function validateHistoricalMigration(root, expectedRevision) {
  const errors = [],
    file = "docs/plan/history/source-migration.json";
  if (!existsSync(path.join(root, file))) return ["Historical source migration map is missing"];
  const migration = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  if (
    !/^[a-f0-9]{40}$/u.test(migration.baseRevision ?? "") ||
    !Array.isArray(migration.moves) ||
    migration.moves.length === 0 ||
    migration.baseRevision !== expectedRevision
  )
    return ["Historical source migration map is invalid or empty"];
  const originals = new Set(
    execFileSync("git", ["ls-tree", "-r", "--name-only", migration.baseRevision, "plan"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean),
  );
  const seen = new Set(),
    destinations = new Set();
  for (const record of migration.moves) {
    if (
      !record ||
      typeof record.from !== "string" ||
      seen.has(record.from) ||
      destinations.has(record.to) ||
      !HASH.test(record.sha256 ?? "")
    ) {
      errors.push("Duplicate or invalid historical migration entry");
      continue;
    }
    seen.add(record.from);
    destinations.add(record.to);
    try {
      safePath(root, record.from);
      let destination = record.to;
      if (record.mutable !== undefined && record.mutable !== false) {
        if (
          record.mutable !== true ||
          record.from !== "plan/architecture-coverage.json" ||
          record.to !== COVERAGE_PATH
        ) {
          errors.push(`Unauthorized historical mutable exception: ${record.from}`);
          continue;
        }
        destination = "docs/plan/history/architecture-coverage-original.json";
      }
      const original = execFileSync("git", ["show", `${migration.baseRevision}:${record.from}`], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (
        sourceHash(original) !== record.sha256 ||
        sourceHash(readFileSync(safePath(root, destination))) !== record.sha256
      )
        errors.push(`Historical bytes changed: ${record.from}`);
    } catch {
      errors.push(`Historical original unavailable: ${record.from}`);
    }
  }
  for (const file of originals)
    if (!seen.has(file)) errors.push(`Missing retained historical original: ${file}`);
  return errors;
}

function checkSourceLine(root, file, fragment, errors, label, revision = "main") {
  const match = /^L([1-9][0-9]*)$/u.exec(fragment);
  if (!match) {
    errors.push(`Invalid source line fragment: ${label}`);
    return;
  }
  if (revision !== "main" && !/^[a-f0-9]{40}$/u.test(revision)) {
    errors.push(`Invalid source revision: ${label}`);
    return;
  }
  try {
    safePath(root, file);
    const text =
      revision === "main"
        ? readFileSync(safePath(root, file), "utf8")
        : execFileSync("git", ["show", `${revision}:${file}`], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 16 * 1024 * 1024,
          });
    const line = Number(match[1]);
    if (!Number.isSafeInteger(line) || !text.split("\n")[line - 1]?.trim())
      errors.push(`Broken source line: ${label}`);
  } catch {
    errors.push(`Unavailable source link: ${label}`);
  }
}

export function validateMarkdownLinks(root, files) {
  const errors = [];
  for (const file of files.filter(
    (name) => /^(?:AGENTS\.md|PLAN\.md|docs\/.*\.md)$/u.test(name) && !HISTORICAL.test(name),
  )) {
    const text = readFileSync(safePath(root, file), "utf8").replace(/```[^\n]*\n[\s\S]*?```/gu, "");
    for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
      const target = match[1].replace(/^<|>$/gu, "");
      const github =
        /^https:\/\/github\.com\/amerged-org\/(?:ohmyhost|ohmyho)\/blob\/([^/]+)\/([^#]+)#(.+)$/u.exec(
          target,
        );
      if (github) {
        checkSourceLine(root, github[2], github[3], errors, `${file}: ${target}`, github[1]);
        continue;
      }
      if (/^(?:https?:|mailto:|app:|codex:)/u.test(target) || target.includes(" ")) continue;
      const [location, fragment] = target.split("#");
      const relative = location
        ? path
            .relative(root, path.resolve(path.dirname(path.join(root, file)), location))
            .split(path.sep)
            .join("/")
        : file;
      try {
        const resolved = safePath(root, relative);
        if (!existsSync(resolved)) errors.push(`Broken local link: ${file}: ${target}`);
        else if (fragment?.startsWith("L") || (fragment && !relative.endsWith(".md")))
          checkSourceLine(root, relative, fragment, errors, `${file}: ${target}`);
        else if (
          fragment &&
          relative.endsWith(".md") &&
          !HISTORICAL.test(relative) &&
          !markdownAnchors(readFileSync(resolved, "utf8")).has(fragment)
        )
          errors.push(`Broken local anchor: ${file}: ${target}`);
      } catch (error) {
        errors.push(`${file}: ${error.message}`);
      }
    }
  }
  return errors;
}

let mermaidParser;

export async function validateDiagramSyntax(diagrams) {
  // Mermaid's strict label sanitizer requires a DOM even when only parsing grammar.
  // This is an inert in-process DOM: no browser, scripts, layout or remote resources run.
  if (!mermaidParser)
    mermaidParser = (async () => {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM("");
      globalThis.window = dom.window;
      globalThis.document = dom.window.document;
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    })();
  const mermaid = await mermaidParser;
  for (const diagram of diagrams) {
    try {
      await mermaid.parse(diagram.source);
    } catch (error) {
      throw new Error(`Mermaid syntax invalid for ${diagram.id}: ${error.message}`);
    }
  }
}

export async function runDocumentationCheck(root = ROOT, { archive = false } = {}) {
  const structure = archive ? runPlanStructureCheck(root) : {};
  const files = candidateFiles(root);
  const coverage = JSON.parse(readFileSync(path.join(root, COVERAGE_PATH), "utf8"));
  const resources = extractResources(root, files),
    diagrams = collectDiagrams(root, files);
  const errors = [
    ...(archive ? [] : currentArchitectureErrors(root)),
    ...validateFileReviews({ root, files, coverage }),
    ...validateResources({ root, resources, coverage }),
    ...validateDiagrams({ root, diagrams, resources, coverage }),
    ...(archive ? validateHistoricalMigration(root, coverage.sourceRevision) : []),
    ...validateMarkdownLinks(root, files),
  ];
  for (const name of ["AGENTS.md", "PLAN.md"]) {
    const text = readFileSync(path.join(root, name), "utf8");
    if (text.trimEnd().split("\n").length > (name === "AGENTS.md" ? 30 : 45))
      errors.push(`${name} must remain a short entry/status document`);
  }
  if (errors.length) throw new Error(`Documentation validation failed:\n- ${errors.join("\n- ")}`);
  await validateDiagramSyntax(diagrams);
  return {
    ...structure,
    files: files.length,
    reviewedSources: files.filter(requiresSourceReview).length,
    resources: resources.length,
    diagrams: diagrams.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--archive"))
    throw new Error("usage: node scripts/check-documentation.mjs [--archive]");
  const result = await runDocumentationCheck(ROOT, { archive: args.length > 0 });
  process.stdout.write(`Documentation verified: ${JSON.stringify(result)}\n`);
}
