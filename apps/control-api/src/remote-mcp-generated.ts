import {
  executeRemoteOperation,
  remoteMcpToolDefinitions,
  type OhMyHostClient,
  type RemoteOperationInputs,
} from "@ohmyhost/sdk-ts";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface GeneratedRemoteRegistration {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>, client: OhMyHostClient) => Promise<unknown>;
}

// Schemas contain public contract data only; actor and request state remain in each fresh server.
const definitions = remoteMcpToolDefinitions.map((definition) => ({
  definition,
  schema: z.fromJSONSchema(definition.inputSchema),
}));

/** Each public entry is separately named; only its typed SDK execution is shared. */
export function registerGeneratedRemoteTools(
  register: (definition: GeneratedRemoteRegistration) => void,
): void {
  for (const { definition, schema } of definitions) {
    register({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      schema,
      inputSchema: definition.inputSchema,
      annotations: definition.annotations,
      execute: (input, client) =>
        executeRemoteOperation(
          definition.operationId,
          client,
          input as RemoteOperationInputs[typeof definition.operationId],
        ),
    });
  }
}
