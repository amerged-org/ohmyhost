import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_GATES = Object.freeze([
  "GATE-AUTH",
  "GATE-HEADLESS-CONTRACT",
  "GATE-HEADLESS",
  "GATE-HOSTING-POC",
  "GATE-P02",
]);
const REQUIRED_TASK_IDS = Array.from(
  { length: 38 },
  (_, index) => `P${String(index + 1).padStart(2, "0")}`,
);

export function readPlanDocuments(rootDir) {
  return ["docs/plan/index.md", "docs/plan/completed.md"]
    .map((file) => readFileSync(path.join(rootDir, file), "utf8"))
    .join("\n");
}

export function readDecisionDocuments(rootDir) {
  const directory = path.join(rootDir, "docs/architecture/decisions");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => readFileSync(path.join(directory, file), "utf8"))
    .join("\n");
}

function splitMarkdownRow(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) return undefined;
  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of line.slice(1, -1)) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parsePlanTasks(planText) {
  return planText
    .split("\n")
    .map(splitMarkdownRow)
    .filter((cells) => cells?.length === 5 && /^P\d{2}$/.test(cells[0]))
    .map(([id, state, deliverable, currentResult, doneWhen]) => ({
      id,
      state,
      deliverable,
      currentResult,
      doneWhen,
    }));
}

export function parsePlanGates(planText) {
  return planText
    .split("\n")
    .map(splitMarkdownRow)
    .filter((cells) => cells?.length === 3 && /^GATE-[A-Z0-9-]+$/.test(cells[0]))
    .map(([id, state, closesWith]) => ({ id, state, closesWith }));
}

// Retained as a compatibility export for callers during the P02 path migration.
export const parseLedgerRows = parsePlanTasks;

export function validatePlanStructure({ rootDir, planText, architectureText }) {
  const errors = [];
  const tasks = parsePlanTasks(planText),
    gates = parsePlanGates(planText);
  const taskIds = new Set(tasks.map(({ id }) => id));
  if (taskIds.size !== tasks.length)
    errors.push("plan task IDs must be unique across active and completed records");
  for (const id of REQUIRED_TASK_IDS)
    if (!taskIds.has(id)) errors.push(`missing retained task: ${id}`);
  const gateIds = new Set(gates.map(({ id }) => id));
  if (
    gateIds.size !== gates.length ||
    gates.length !== REQUIRED_GATES.length ||
    REQUIRED_GATES.some((id) => !gateIds.has(id))
  ) {
    errors.push("retained gates must appear exactly once across plan documents");
  }
  for (const item of [...tasks, ...gates]) {
    if (item.state !== "OPEN" && item.state !== "DONE")
      errors.push(`${item.id} has invalid state ${item.state}`);
  }
  for (const task of tasks) {
    if (!task.deliverable || !task.currentResult || !task.doneWhen)
      errors.push(`${task.id} has incomplete scope, evidence or completion criteria`);
  }
  if (typeof architectureText !== "string" || !architectureText.trim())
    errors.push("architecture decision records must remain non-empty");
  if (!existsSync(path.join(rootDir, "docs/plan/history/ohmyhost.md")))
    errors.push("immutable masterplan baseline is missing");
  return errors;
}

// This is a source inventory/link check, not proof of semantic coverage or live deployment.
const ARCHITECTURE_INTERFACE_KINDS = ["rest", "cliKinds", "mcpTools", "resources", "entrypoints"];

function visitSyntax(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => visitSyntax(child, visitor));
}

function readSyntax(rootDir, file) {
  return ts.createSourceFile(
    file,
    readFileSync(path.join(rootDir, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

export function inspectArchitectureInterfaces(rootDir) {
  const { parse } = createRequire(path.join(rootDir, "packages/contracts/package.json"))("yaml");
  const contract = parse(
    readFileSync(path.join(rootDir, "packages/contracts/openapi.yaml"), "utf8"),
  );
  const rest = [];
  for (const route of Object.values(contract.paths)) {
    for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      if (route[method]) {
        if (typeof route[method].operationId !== "string")
          throw new Error("OpenAPI operation has no operationId");
        rest.push(route[method].operationId);
      }
    }
  }
  const cliKinds = [];
  const commands = readSyntax(rootDir, "apps/product-cli/src/command.ts");
  const aliases = new Map(
    commands.statements
      .filter(ts.isTypeAliasDeclaration)
      .map((declaration) => [declaration.name.text, declaration]),
  );
  const visitedAliases = new Set();
  const inspectCommand = (name) => {
    if (visitedAliases.has(name)) return;
    visitedAliases.add(name);
    const declaration = aliases.get(name);
    if (declaration !== undefined) {
      visitSyntax(declaration.type, (node) => {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName))
          inspectCommand(node.typeName.text);
        if (
          ts.isPropertySignature(node) &&
          node.name.getText(commands) === "kind" &&
          node.type &&
          ts.isLiteralTypeNode(node.type) &&
          ts.isStringLiteral(node.type.literal)
        ) {
          cliKinds.push(node.type.literal.text);
        }
      });
    }
  };
  inspectCommand("ProductCliCommand");
  const mcpTools = [],
    resources = [];
  visitSyntax(readSyntax(rootDir, "apps/mcp/src/local-server.ts"), (node) => {
    if (ts.isCallExpression(node)) {
      const argument =
        ts.isIdentifier(node.expression) && node.expression.text === "registerProductTool"
          ? node.arguments[2]
          : ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === "registerTool"
            ? node.arguments[0]
            : undefined;
      if (argument && ts.isStringLiteral(argument)) mcpTools.push(argument.text);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "ResourceTemplate"
    ) {
      const argument = node.arguments?.[0];
      if (argument && ts.isStringLiteral(argument)) resources.push(argument.text);
    }
  });
  visitSyntax(
    readSyntax(rootDir, "packages/agent-skills/src/generated-skill-resources.ts"),
    (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "uri" &&
        ts.isStringLiteral(node.initializer)
      )
        resources.push(node.initializer.text);
    },
  );
  const entrypoints = new Set();
  for (const application of readdirSync(path.join(rootDir, "apps"), { withFileTypes: true })) {
    if (!application.isDirectory()) continue;
    const directory = path.join(rootDir, "apps", application.name);
    for (const file of readdirSync(directory)) {
      if (!/^wrangler(?:\.[\w-]+)*\.jsonc?$/u.test(file)) continue;
      const config = ts.parseConfigFileTextToJson(
        file,
        readFileSync(path.join(directory, file), "utf8"),
      );
      if (config.error)
        throw new Error(`Invalid Worker configuration: ${application.name}/${file}`);
      if (typeof config.config.main === "string") {
        entrypoints.add(
          path
            .relative(rootDir, path.resolve(directory, config.config.main))
            .split(path.sep)
            .join("/"),
        );
      }
    }
  }
  return { rest, cliKinds, mcpTools, resources, entrypoints: [...entrypoints] };
}

export function validateArchitectureCoverage({ rootDir, architectureText, coverage, interfaces }) {
  const errors = [];
  const rows = architectureText
    .split("\n")
    .map(splitMarkdownRow)
    .filter((row) => row?.length === 4 && /^D\d{3}$/u.test(row[0]));
  const decisions = new Set(rows.map((row) => row[0]));
  if (rows.length === 0 || decisions.size !== rows.length)
    errors.push("architecture decisions must be present and unique");
  if (
    coverage?.schemaVersion !== 2 ||
    !Array.isArray(coverage.features) ||
    !Array.isArray(coverage.manualBoundaries)
  ) {
    return [...errors, "architecture coverage manifest is invalid"];
  }
  for (const feature of [...coverage.features, ...coverage.manualBoundaries]) {
    if (
      !Array.isArray(feature.decisions) ||
      feature.decisions.length === 0 ||
      new Set(feature.decisions).size !== feature.decisions.length ||
      feature.decisions.some((id) => !decisions.has(id))
    )
      errors.push("coverage refers to missing or duplicate decision IDs");
  }
  for (const kind of ARCHITECTURE_INTERFACE_KINDS) {
    const actual = interfaces[kind];
    const mapped = coverage.features.flatMap((feature) => feature[kind] ?? []);
    if (
      !Array.isArray(actual) ||
      actual.length === 0 ||
      new Set(actual).size !== actual.length ||
      mapped.some((name) => typeof name !== "string") ||
      new Set(mapped).size !== mapped.length
    ) {
      errors.push(`${kind} inventory contains invalid or duplicate names`);
      continue;
    }
    const expected = new Set(actual),
      recorded = new Set(mapped);
    for (const name of expected) if (!recorded.has(name)) errors.push(`unmapped ${kind}: ${name}`);
    for (const name of recorded) if (!expected.has(name)) errors.push(`obsolete ${kind}: ${name}`);
  }
  const sourceCache = new Map();
  const checkLine = (ref, file, line, label) => {
    if (
      (!/^[a-f0-9]{40}$/u.test(ref) && ref !== "main") ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      typeof file !== "string" ||
      path.isAbsolute(file) ||
      file.split("/").some((part) => part === ".." || part === "") ||
      file.includes("\\")
    ) {
      errors.push(`invalid architecture code reference: ${label}`);
      return;
    }
    try {
      const key = `${ref}:${file}`;
      if (!sourceCache.has(key))
        sourceCache.set(
          key,
          (ref === "main"
            ? readFileSync(path.join(rootDir, file), "utf8")
            : execFileSync("git", ["show", key], {
                cwd: rootDir,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                maxBuffer: 16 * 1024 * 1024,
              })
          ).split("\n"),
        );
      const lines = sourceCache.get(key);
      if (line > lines.length || !lines[line - 1].trim())
        errors.push(`missing architecture code line: ${label}`);
    } catch {
      errors.push(`unavailable architecture code reference: ${label}`);
    }
  };
  for (const [id, state, , links] of rows) {
    const matches = [
      ...links.matchAll(
        /https:\/\/github\.com\/amerged-org\/(?:ohmyhost|ohmyho)\/blob\/([^/]+)\/([^\s)]+)#L(\d+)/gu,
      ),
    ];
    if (
      matches.length === 0 &&
      (state.startsWith("Implemented") ||
        !/(?:docs\/plan\/|\.\.\/\.\.\/plan\/|PLAN\.md#)/u.test(links) ||
        !/implementation does not exist|no implementation/iu.test(links))
    )
      errors.push(`${id} has no code link or explicit unimplemented decision source`);
    for (const [, ref, file, line] of matches) checkLine(ref, file, Number(line), id);
  }
  const manualNames = new Set();
  for (const boundary of coverage.manualBoundaries) {
    if (typeof boundary.name !== "string" || !boundary.name || manualNames.has(boundary.name))
      errors.push("manual boundary names must be present and unique");
    manualNames.add(boundary.name);
    checkLine("main", boundary.file, boundary.line, boundary.name);
  }
  return errors;
}

export function currentArchitectureErrors(rootDir) {
  const architectureText = readDecisionDocuments(rootDir);
  if (!architectureText.trim()) return ["architecture decision records must remain non-empty"];
  return validateArchitectureCoverage({
    rootDir,
    architectureText,
    coverage: JSON.parse(
      readFileSync(path.join(rootDir, "docs/architecture/coverage.json"), "utf8"),
    ),
    interfaces: inspectArchitectureInterfaces(rootDir),
  });
}

export function runPlanStructureCheck(rootDir = process.cwd()) {
  const planText = readPlanDocuments(rootDir);
  const architectureText = readDecisionDocuments(rootDir);
  const errors = [
    ...validatePlanStructure({ rootDir, planText, architectureText }),
    ...currentArchitectureErrors(rootDir),
  ];
  if (errors.length > 0) {
    throw new Error(`Documentation structure validation failed:\n- ${errors.join("\n- ")}`);
  }
  return {
    tasks: parsePlanTasks(planText).length,
    gates: parsePlanGates(planText).length,
    open: parsePlanTasks(planText).filter(({ state }) => state === "OPEN").length,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = runPlanStructureCheck();
  process.stdout.write(
    `Documentation structure valid: ${result.tasks} delivery tasks, ${result.gates} gates, ${result.open} OPEN tasks.\n`,
  );
}
