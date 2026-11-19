import { createHash } from "node:crypto";
import ts from "typescript";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const DISPOSITIONS = new Set(["named", "protected-handoff", "equivalent-workflow", "excluded"]);
const HEADER_NAMES = {
  "Idempotency-Key": "idempotency_key",
  "If-Match": "if_match",
  "X-Confirmation-Token": "confirmation_token",
};
// Keep model-supplied guards byte-safe for HTTP and unchanged by Headers whitespace trimming.
const HEADER_VALUE_PATTERN = "^[!-~](?:[ -~]*[!-~])?$";
const SCHEMA_KEYS = new Set([
  "$schema",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "oneOf",
  "anyOf",
  "allOf",
  "dependentRequired",
  "description",
  "title",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentEncoding",
  "contentMediaType",
  "not",
]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value;
}

function resolve(document, value, seen = new Set()) {
  if (typeof value === "boolean") return value;
  const source = record(value, "Schema/reference");
  if (source.$ref !== undefined) {
    const reference = source.$ref;
    if (typeof reference !== "string" || !reference.startsWith("#/"))
      throw new TypeError("Only resolved local OpenAPI references are supported");
    if (seen.has(reference))
      throw new TypeError(`Recursive schema requires an explicit adapter: ${reference}`);
    const next = new Set(seen).add(reference);
    let target = document;
    for (const segment of reference.slice(2).split("/")) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw new TypeError(`Unresolved OpenAPI reference: ${reference}`);
      target = target[key];
    }
    const siblings = { ...source };
    delete siblings.$ref;
    const resolved = resolve(document, target, next);
    if (!Object.keys(siblings).length) return resolved;
    if (
      Object.keys(siblings).every((key) =>
        ["description", "title", "examples", "readOnly", "writeOnly"].includes(key),
      )
    )
      return { ...resolved, ...siblings };
    return { allOf: [resolved, resolve(document, siblings, next)] };
  }
  const output = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "properties")
      output[key] = Object.fromEntries(
        Object.entries(record(child, "Schema properties")).map(([name, schema]) => [
          name,
          resolve(document, schema, seen),
        ]),
      );
    else if (key === "content")
      output[key] = Object.fromEntries(
        Object.entries(child).map(([mime, media]) => [
          mime,
          {
            ...media,
            ...(media.schema ? { schema: resolve(document, media.schema, seen) } : {}),
          },
        ]),
      );
    else if (
      ["schema", "items", "additionalProperties", "propertyNames", "not"].includes(key) &&
      typeof child === "object"
    )
      output[key] = resolve(document, child, seen);
    else if (["oneOf", "anyOf", "allOf"].includes(key)) {
      if (!Array.isArray(child)) throw new TypeError(`Invalid ${key}`);
      output[key] = child.map((schema) => resolve(document, schema, seen));
    } else output[key] = child;
  }
  return output;
}

/** Preserve object assertions that a type-less JSON Schema branch would otherwise lose in Zod. */
function executableSchema(value) {
  if (typeof value === "boolean") return value;
  const schema = record(value, "Executable schema");
  for (const key of Object.keys(schema))
    if (!SCHEMA_KEYS.has(key)) throw new TypeError(`Unsupported executable schema keyword: ${key}`);
  const output = { ...schema };
  if (schema.properties)
    output.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [key, executableSchema(child)]),
    );
  for (const key of ["items", "additionalProperties", "propertyNames", "not"])
    if (typeof schema[key] === "object") output[key] = executableSchema(schema[key]);
  for (const key of ["oneOf", "anyOf", "allOf"])
    if (schema[key])
      output[key] = schema[key].map((branch) => {
        const partialObject =
          schema.type === "object" &&
          branch.type === undefined &&
          (branch.required || branch.properties);
        return executableSchema(
          partialObject
            ? {
                ...schema,
                oneOf: undefined,
                anyOf: undefined,
                allOf: undefined,
                dependentRequired: undefined,
                ...branch,
                properties: { ...schema.properties, ...branch.properties },
                required: [...new Set([...(schema.required ?? []), ...(branch.required ?? [])])],
              }
            : branch,
        );
      });
  if (schema.dependentRequired !== undefined) {
    if (schema.type !== "object") throw new TypeError("Dependencies require an object schema");
    const base = { ...output };
    delete base.dependentRequired;
    delete base.oneOf;
    delete base.anyOf;
    delete base.allOf;
    const dependencies = Object.entries(record(schema.dependentRequired, "Schema dependencies"));
    const lowered = dependencies.map(([trigger, required]) => {
      if (
        !Array.isArray(required) ||
        !required.every((key) => typeof key === "string") ||
        !Object.hasOwn(schema.properties ?? {}, trigger)
      )
        throw new TypeError("Invalid schema dependency");
      for (const key of required)
        if (!Object.hasOwn(schema.properties ?? {}, key))
          throw new TypeError("Unknown dependency property");
      return {
        anyOf: [
          { ...base, properties: { ...base.properties, [trigger]: { not: {} } } },
          { ...base, required: [...new Set([...(base.required ?? []), trigger, ...required])] },
        ],
      };
    });
    delete output.dependentRequired;
    output.allOf = [...(output.allOf ?? []), ...lowered];
  }
  return Object.fromEntries(Object.entries(output).filter(([, child]) => child !== undefined));
}

function inputFor(document, pathItem, operation, metadata, executable = true) {
  const properties = {};
  const required = [];
  const bindings = [];
  const aliases = metadata.aliases ?? {};
  function add(raw, schema, needed, location) {
    const name = aliases[raw] ?? HEADER_NAMES[raw] ?? raw;
    if (Object.hasOwn(properties, name))
      throw new TypeError(`Flattened MCP input collision: ${name}`);
    const resolved = resolve(document, schema);
    properties[name] =
      executable && location === "header"
        ? {
            ...resolved,
            type: "string",
            allOf: [...(resolved.allOf ?? []), { type: "string", pattern: HEADER_VALUE_PATTERN }],
          }
        : resolved;
    if (needed) required.push(name);
    bindings.push({ input: name, source: raw, location, required: Boolean(needed) });
  }
  for (const source of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = source.$ref ? resolve(document, source) : source;
    if (parameter.in === "header" && parameter.name === "X-Request-Id") continue;
    if (!["path", "query", "header"].includes(parameter.in))
      throw new TypeError("Unsupported MCP parameter location");
    if (executable && parameter.in === "header" && !Object.hasOwn(HEADER_NAMES, parameter.name))
      throw new TypeError(`Caller-controlled HTTP header is not exposed: ${parameter.name}`);
    add(
      parameter.name,
      {
        ...parameter.schema,
        ...(parameter.description ? { description: parameter.description } : {}),
      },
      parameter.required,
      parameter.in,
    );
  }
  const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  let body = null;
  if (operation.requestBody && !bodySchema)
    throw new TypeError("Generated MCP requires a JSON request body");
  if (bodySchema) {
    body = resolve(document, bodySchema);
    if (body.type !== "object")
      throw new TypeError(
        `A non-object JSON body requires an explicit adapter: ${operation.operationId}`,
      );
    for (const [name, schema] of Object.entries(body.properties ?? {}))
      add(name, schema, body.required?.includes(name), "body");
  }
  for (const [name, schema] of Object.entries(metadata.extra_inputs ?? {})) {
    if (Object.hasOwn(properties, name)) throw new TypeError(`Extra MCP input collision: ${name}`);
    if (schema.type !== "boolean" || schema.const !== true)
      throw new TypeError("Synthetic MCP inputs must be explicit true confirmations");
    properties[name] = schema;
    required.push(name);
  }
  const inputSchema = {
    ...body,
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  // Aliases also apply inside object required-branch/dependency assertions.
  const renameAssertions = (value) => {
    if (Array.isArray(value)) return value.map(renameAssertions);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "required"
          ? child.map((name) => aliases[name] ?? name)
          : key === "dependentRequired"
            ? Object.fromEntries(
                Object.entries(child).map(([name, names]) => [
                  aliases[name] ?? name,
                  names.map((entry) => aliases[entry] ?? entry),
                ]),
              )
            : key === "properties"
              ? Object.fromEntries(
                  Object.entries(child).map(([name, entry]) => [
                    aliases[name] ?? name,
                    renameAssertions(entry),
                  ]),
                )
              : renameAssertions(child),
      ]),
    );
  };
  const renamed = renameAssertions(inputSchema);
  return { inputSchema: executable ? executableSchema(renamed) : renamed, bindings };
}

function responseFor(document, operation) {
  const schemas = [];
  for (const [status, source] of Object.entries(operation.responses ?? {})) {
    if (!/^2\d\d$/u.test(status)) continue;
    const response = source.$ref ? resolve(document, source) : source;
    const schema = response.content?.["application/json"]?.schema;
    if (schema) schemas.push(resolve(document, schema));
  }
  const unique = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
  return unique.length === 1 ? unique[0] : unique.length ? { anyOf: unique } : undefined;
}

function containsPrivateResult(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (
    Object.keys(schema.properties ?? {}).some((name) =>
      [
        "secret",
        "signing_secret",
        "password",
        "connection_uri",
        "api_key",
        "clientSecret",
      ].includes(name),
    )
  )
    return true;
  return (
    containsPrivateResult(schema.items) ||
    Object.values(schema.properties ?? {}).some(containsPrivateResult) ||
    ["oneOf", "anyOf", "allOf"].some((key) => (schema[key] ?? []).some(containsPrivateResult))
  );
}

/** Build the reviewed static catalog; this never executes or authorizes an API operation. */
export function projectRemoteMcpContract(document, contractSource = JSON.stringify(document)) {
  record(document, "OpenAPI document");
  const operations = [];
  const tools = [];
  const names = new Set();
  const operationIds = new Set();
  const existingNames = new Set(
    Object.values(document.paths ?? {}).flatMap((pathItem) =>
      Object.values(pathItem).flatMap((operation) =>
        operation?.["x-ohmyhost-mcp"]?.adapter === "generated"
          ? []
          : (operation?.["x-ohmyhost-mcp"]?.tool_names ?? []),
      ),
    ),
  );
  const workflowTools = document["x-ohmyhost-mcp-workflows"] ?? [];
  for (const workflow of workflowTools) {
    if (!workflow.name || names.has(workflow.name))
      throw new TypeError("Duplicate or invalid MCP workflow name");
    names.add(workflow.name);
  }
  for (const [path, pathItem] of Object.entries(document.paths ?? {}))
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!METHODS.has(method)) continue;
      const metadata = operation["x-ohmyhost-mcp"];
      if (!operation.operationId || !metadata || !DISPOSITIONS.has(metadata.disposition))
        throw new TypeError(`Operation requires an explicit MCP disposition: ${method} ${path}`);
      if (operationIds.has(operation.operationId))
        throw new TypeError(`Duplicate API operation identifier: ${operation.operationId}`);
      operationIds.add(operation.operationId);
      const toolNames = metadata.tool_names ?? [];
      if (!Array.isArray(toolNames) || (!toolNames.length && !metadata.reason))
        throw new TypeError(
          `MCP disposition needs tool names or a reason: ${operation.operationId}`,
        );
      if (
        metadata.disposition === "named" &&
        (!toolNames.length || !["existing", "generated"].includes(metadata.adapter))
      )
        throw new TypeError(
          `Named MCP coverage requires an existing or generated binding: ${operation.operationId}`,
        );
      if (metadata.disposition === "excluded" && toolNames.length)
        throw new TypeError(
          `Excluded operation must not claim an exposed tool: ${operation.operationId}`,
        );
      const documentedInput = inputFor(document, pathItem, operation, metadata, false).inputSchema;
      const definition = {
        inputSchema: documentedInput,
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? operation.operationId,
        description: operation.description ?? operation.summary ?? operation.operationId,
        disposition: metadata.disposition,
        toolNames,
        ...(metadata.reason ? { reason: metadata.reason } : {}),
        ...(operation.requestBody ? { requestBody: resolve(document, operation.requestBody) } : {}),
        ...(operation.parameters
          ? { parameters: operation.parameters.map((parameter) => resolve(document, parameter)) }
          : {}),
        ...(responseFor(document, operation)
          ? { outputSchema: responseFor(document, operation) }
          : {}),
      };
      operations.push(definition);
      if (!metadata.tool) continue;
      if (metadata.disposition !== "named" || metadata.adapter !== "generated")
        throw new TypeError(
          `Only a named operation can generate an executor binding: ${operation.operationId}`,
        );
      const tool = metadata.tool;
      if (!toolNames.includes(tool.name) || names.has(tool.name) || existingNames.has(tool.name))
        throw new TypeError(`Duplicate or unlisted MCP tool: ${tool.name}`);
      if (
        !tool.title ||
        !tool.description ||
        !tool.annotations ||
        ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].some(
          (key) => typeof tool.annotations[key] !== "boolean",
        )
      )
        throw new TypeError(`MCP effects/title/description must be explicit: ${tool.name}`);
      if (containsPrivateResult(definition.outputSchema))
        throw new TypeError(
          `Secret-bearing result requires protected custody: ${operation.operationId}`,
        );
      names.add(tool.name);
      const { inputSchema, bindings } = inputFor(document, pathItem, operation, metadata);
      definition.inputSchema = inputSchema;
      tools.push({
        ...tool,
        operationId: operation.operationId,
        inputSchema,
        ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
        bindings,
      });
    }
  return {
    contractSha256: createHash("sha256").update(contractSource).digest("hex"),
    contractVersion: document.info?.version ?? "unknown",
    operations,
    tools,
    workflowTools,
  };
}

function sdkBodyKeys(source) {
  const tree = ts.createSourceFile("sdk.gen.ts", source, ts.ScriptTarget.Latest, true);
  const result = new Map();
  for (const statement of tree.statements)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !declaration.initializer ||
          !ts.isArrowFunction(declaration.initializer)
        )
          continue;
        let bodyKey;
        const flatBody = new Set();
        const visit = (node) => {
          if (ts.isObjectLiteralExpression(node)) {
            const fields = new Map(
              node.properties
                .filter(ts.isPropertyAssignment)
                .map((property) => [
                  property.name.getText(tree).replaceAll('"', ""),
                  property.initializer,
                ]),
            );
            const location = fields.get("in");
            const argumentKey = fields.get("key");
            if (
              location &&
              ts.isStringLiteral(location) &&
              location.text === "body" &&
              argumentKey &&
              ts.isStringLiteral(argumentKey)
            )
              flatBody.add(argumentKey.text);
            const mapping = fields.get("map");
            if (mapping && ts.isStringLiteral(mapping) && mapping.text === "body") {
              const key = fields.get("key");
              if (key && ts.isStringLiteral(key)) bodyKey = key.text;
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(declaration.initializer.body);
        result.set(declaration.name.text, { bodyKey, flatBody });
      }
  return result;
}

/** Emit typed bindings into the existing standalone SDK output and drift-check tree. */
export function renderRemoteMcpModule(projection, sdkSource, releaseVersion) {
  const bodyKeys = sdkBodyKeys(sdkSource);
  const ids = projection.tools.map((tool) => tool.operationId);
  const imports = [...new Set(ids)].sort();
  const inputs = [];
  const cases = [];
  for (const tool of projection.tools) {
    const id = tool.operationId;
    if (!bodyKeys.has(id)) throw new TypeError(`Generated SDK operation is missing: ${id}`);
    const { bodyKey, flatBody } = bodyKeys.get(id);
    const bodyBindings = tool.bindings.filter((binding) => binding.location === "body");
    if (
      bodyBindings.length &&
      !bodyKey &&
      bodyBindings.some((binding) => !flatBody.has(binding.source))
    )
      throw new TypeError(`Generated SDK body binding is missing: ${id}`);
    const sdkType = `NonNullable<Parameters<typeof ${id}>[0]>`;
    const fields = tool.bindings.map((binding) => {
      const valueType =
        binding.location === "body" && bodyKey
          ? `NonNullable<${sdkType}[${JSON.stringify(bodyKey)}]>[${JSON.stringify(binding.source)}]`
          : `${sdkType}[${JSON.stringify(binding.source)}]`;
      return `${JSON.stringify(binding.input)}${binding.required ? "" : "?"}: ${valueType};`;
    });
    for (const name of Object.keys(tool.inputSchema.properties))
      if (!tool.bindings.some((binding) => binding.input === name))
        fields.push(`${JSON.stringify(name)}: true;`);
    inputs.push(`${JSON.stringify(id)}: { ${fields.join(" ")} };`);
    const assignment = (binding) => {
      const name = JSON.stringify(binding.source),
        value = `value[${JSON.stringify(binding.input)}]`;
      return binding.required
        ? `${name}: ${value}`
        : `...(${value} === undefined ? {} : { ${name}: ${value} })`;
    };
    const parameters = tool.bindings
      .filter((binding) => binding.location !== "body" || !bodyKey)
      .map(assignment);
    if (bodyKey)
      parameters.push(`${JSON.stringify(bodyKey)}: { ${bodyBindings.map(assignment).join(", ")} }`);
    cases.push(
      `case ${JSON.stringify(id)}: { const value = input as RemoteOperationInputs[${JSON.stringify(id)}]; const parameters: ${sdkType} = { ${parameters.join(", ")} }; return ${id}(parameters, { client }); }`,
    );
  }
  const descriptors = projection.tools.map((tool) => {
    const descriptor = { ...tool };
    delete descriptor.bindings;
    return descriptor;
  });
  return [
    "// Generated by scripts/generate-sdk-ts.mjs from the reviewed OpenAPI Master Tool Contract.",
    'import type { Client as OhMyHostClient } from "./client/index.js";',
    `import { ${imports.join(", ")} } from "./sdk.gen.js";`,
    `export const remoteMcpContractSha256 = ${JSON.stringify(projection.contractSha256)};`,
    `export const remoteMcpContractVersion = ${JSON.stringify(projection.contractVersion)};`,
    `export const remoteMcpReleaseVersion = ${JSON.stringify(releaseVersion)};`,
    `export interface RemoteMcpOperation { operationId: string; method: string; path: string; summary: string; description: string; disposition: "named" | "protected-handoff" | "equivalent-workflow" | "excluded"; toolNames: readonly string[]; reason?: string; inputSchema?: Record<string, unknown>; outputSchema?: unknown; requestBody?: unknown; parameters?: readonly unknown[]; }`,
    `export interface RemoteMcpEffects { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean; }`,
    `export interface RemoteMcpWorkflowTool { name: string; title: string; description: string; annotations: RemoteMcpEffects; }`,
    `export interface RemoteMcpToolDefinition extends RemoteMcpWorkflowTool { operationId: RemoteOperationId; inputSchema: Record<string, unknown>; outputSchema?: unknown; }`,
    `export const remoteMcpOperations: readonly RemoteMcpOperation[] = ${JSON.stringify(projection.operations)};`,
    `export const remoteMcpWorkflowTools: readonly RemoteMcpWorkflowTool[] = ${JSON.stringify(projection.workflowTools)};`,
    `export const remoteMcpToolDefinitions: readonly RemoteMcpToolDefinition[] = ${JSON.stringify(descriptors)};`,
    `export interface RemoteOperationInputs { ${inputs.join("\n")} }`,
    "export type RemoteOperationId = keyof RemoteOperationInputs;",
    "export async function executeRemoteOperation<K extends RemoteOperationId>(operationId: K, client: OhMyHostClient, input: RemoteOperationInputs[K]): Promise<unknown> {",
    `switch (operationId) { ${cases.join("\n")} default: throw new TypeError("Unknown named remote operation"); }`,
    "}",
    "",
  ].join("\n");
}
