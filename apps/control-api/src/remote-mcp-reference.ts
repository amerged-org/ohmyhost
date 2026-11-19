import {
  remoteMcpContractSha256,
  remoteMcpContractVersion,
  remoteMcpOperations,
  remoteMcpReleaseVersion,
  remoteMcpToolDefinitions,
} from "@ohmyhost/sdk-ts";
import { z } from "zod";

const operations = [...remoteMcpOperations].sort((a, b) =>
  a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0,
);
const operationIds = operations.map((operation) => operation.operationId);
const generatedOperationIds = new Set<string>(
  remoteMcpToolDefinitions.map((tool) => tool.operationId),
);
const MAX_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export const apiReferenceInputSchema = z
  .object({
    query: z.string().trim().max(120).optional(),
    operation_id: z.enum(operationIds as [string, ...string[]]).optional(),
    cursor: z
      .string()
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export class ApiReferenceInputError extends Error {
  constructor() {
    super("Start a fresh API reference lookup with either operation_id or query and cursor.");
  }
}

interface ApiReferenceOperation {
  operation_id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  mcp: { disposition: string; tool_names: readonly string[]; reason: string | null };
  input_schema?: unknown;
  output_schema?: unknown;
  rest_input_schema?: unknown;
  rest_output_schema?: unknown;
  schema_note?: string;
}

export interface ApiReferencePage {
  master_tool_contract: {
    sha256: string;
    api_version: string;
    release_version: string;
    url: string;
    release_url: string;
  };
  availability: string;
  operations: ApiReferenceOperation[];
  next_cursor: string | null;
  schema_omitted?: "Use the complete contract link; this operation exceeds the response limit.";
}

function cursorFor(query: string, offset: number): string {
  const bytes = encoder.encode(JSON.stringify({ hash: remoteMcpContractSha256, query, offset }));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function cursorOffset(cursor: string | undefined, query: string): number {
  if (cursor === undefined) return 0;
  try {
    const raw = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(raw, (character) => character.charCodeAt(0)),
      ),
    );
    return z
      .object({
        hash: z.literal(remoteMcpContractSha256),
        query: z.literal(query),
        offset: z.number().int().min(0).max(operations.length),
      })
      .strict()
      .parse(decoded).offset;
  } catch {
    throw new ApiReferenceInputError();
  }
}

/** Read compiled public documentation only; this module has no execution or fetch dependency. */
export function readApiReference(input: z.input<typeof apiReferenceInputSchema>): ApiReferencePage {
  const parsed = apiReferenceInputSchema.parse(input);
  if (
    parsed.operation_id !== undefined &&
    (parsed.query !== undefined || parsed.cursor !== undefined)
  )
    throw new ApiReferenceInputError();
  const query = (parsed.query ?? "").toLowerCase();
  const offset = cursorOffset(parsed.cursor, query);
  const selected = operations.filter((operation) =>
    parsed.operation_id !== undefined
      ? operation.operationId === parsed.operation_id
      : [
          operation.operationId,
          operation.path,
          operation.summary,
          operation.description,
          ...operation.toolNames,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query),
  );
  if (offset > selected.length) throw new ApiReferenceInputError();
  const page: ApiReferencePage = {
    master_tool_contract: {
      sha256: remoteMcpContractSha256,
      api_version: remoteMcpContractVersion,
      release_version: remoteMcpReleaseVersion,
      url: "https://ohmyho.st/api",
      release_url: `https://ohmyho.st/releases/${remoteMcpReleaseVersion}/openapi.json`,
    },
    availability:
      "This is server contract coverage. Use only tools actually exposed by your current host; documented API operations are not automatically callable MCP tools. " +
      "See https://github.com/amerged-org/ohmyhost for the ohmyho.st hosting platform (OMH) and https://github.com/amerged-org/cloudflare-postgres for its PostgreSQL infrastructure (PGCF).",
    operations: [],
    next_cursor: null,
  };
  const limit = parsed.operation_id === undefined ? (parsed.limit ?? 10) : 1;
  for (const operation of selected.slice(offset, offset + limit)) {
    const detail: ApiReferenceOperation = {
      operation_id: operation.operationId,
      method: operation.method,
      path: operation.path,
      summary: operation.summary,
      description: operation.description,
      mcp: {
        disposition: operation.disposition,
        tool_names: operation.toolNames,
        reason: operation.reason ?? null,
      },
      ...(parsed.operation_id === undefined
        ? {}
        : generatedOperationIds.has(operation.operationId)
          ? {
              input_schema: operation.inputSchema,
              output_schema: operation.outputSchema,
              schema_note:
                "The generated MCP tool uses this input schema. The named tool must also be exposed by your current host.",
            }
          : {
              rest_input_schema: operation.inputSchema,
              rest_output_schema: operation.outputSchema,
              schema_note:
                "These are REST API schemas. Follow the current tool's tools/list contract: legacy adapters may rename fields or require confirmation, and protected secret values belong only in the protected human form, never tool arguments.",
            }),
    };
    page.operations.push(detail);
    if (encoder.encode(JSON.stringify(page)).byteLength > MAX_BYTES - 2048) {
      page.operations.pop();
      if (page.operations.length === 0) {
        const compact = { ...detail, description: "See the complete contract link." };
        delete compact.input_schema;
        delete compact.output_schema;
        delete compact.rest_input_schema;
        delete compact.rest_output_schema;
        page.operations.push(compact);
        page.schema_omitted =
          "Use the complete contract link; this operation exceeds the response limit.";
      }
      break;
    }
  }
  const nextOffset = offset + page.operations.length;
  if (parsed.operation_id === undefined && nextOffset < selected.length)
    page.next_cursor = cursorFor(query, nextOffset);
  return page;
}
