import { parseUlid } from "@ohmyhost/platform";

import type { ProjectDatabaseDiagnosticsPort } from "./contracts.js";

export interface ProjectDatabaseDiagnosticsBinding {
  queryProject(input: unknown): Promise<unknown>;
}

export class ProjectDatabaseQueryRejectedError extends Error {
  public constructor() {
    super("Project database query was rejected");
    this.name = "ProjectDatabaseQueryRejectedError";
  }
}

export function createProjectDatabaseDiagnosticsPort(
  binding: ProjectDatabaseDiagnosticsBinding,
): ProjectDatabaseDiagnosticsPort {
  if (!isRecord(binding) || typeof binding.queryProject !== "function") {
    throw new TypeError("Project database diagnostics binding is invalid");
  }
  return Object.freeze({
    async query(input: Parameters<ProjectDatabaseDiagnosticsPort["query"]>[0]) {
      parseUlid(input.organizationId);
      parseUlid(input.projectId);
      const raw = await binding.queryProject({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environment: input.environment,
        statement: input.statement,
        parameters: input.parameters,
      });
      if (isRecord(raw) && hasExactKeys(raw, ["status"]) && raw["status"] === "absent") return null;
      if (isRecord(raw) && hasExactKeys(raw, ["status"]) && raw["status"] === "rejected") {
        throw new ProjectDatabaseQueryRejectedError();
      }
      if (
        !isRecord(raw) ||
        !hasExactKeys(raw, ["environment", "rowCount", "rows", "truncated"]) ||
        raw["environment"] !== input.environment ||
        !Array.isArray(raw["rows"]) ||
        raw["rows"].length > 100 ||
        !raw["rows"].every(isRecord) ||
        !Number.isSafeInteger(raw["rowCount"]) ||
        raw["rowCount"] !== raw["rows"].length ||
        typeof raw["truncated"] !== "boolean"
      ) {
        throw new TypeError("Project database diagnostics result is invalid");
      }
      const encoded = JSON.stringify(raw);
      if (new TextEncoder().encode(encoded).byteLength > 256 * 1_024) {
        throw new TypeError("Project database diagnostics result is invalid");
      }
      return Object.freeze({
        environment: input.environment,
        rows: Object.freeze(raw["rows"].map((row) => Object.freeze({ ...row }))),
        rowCount: raw["rowCount"] as number,
        truncated: raw["truncated"],
      });
    },
  });
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
