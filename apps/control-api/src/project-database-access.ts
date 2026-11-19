import {
  assertProjectDatabaseAccess,
  assertProjectDatabaseAccessCredential,
  assertProjectDatabaseAccessPage,
  type ProjectDatabaseAccess,
  type ProjectDatabaseAccessCredential,
  type ProjectDatabaseAccessPage,
} from "@ohmyhost/contracts/database-access";
import { OrganizationCreditError, ProjectDatabaseAccessError } from "@ohmyhost/database";
import type { Clock } from "@ohmyhost/platform";

import type {
  ProjectDatabaseAccessIssueInput,
  ProjectDatabaseAccessListInput,
  ProjectDatabaseAccessPort,
  ProjectDatabaseAccessRevokeInput,
} from "./contracts.js";

export interface ProjectDatabaseAccessBinding {
  issueDatabaseAccess(input: unknown): Promise<unknown>;
  revokeDatabaseAccess(input: unknown): Promise<unknown>;
}

export class ProjectDatabaseAccessUnavailableError extends Error {
  public constructor() {
    super("Database access issuance is unavailable");
    this.name = "ProjectDatabaseAccessUnavailableError";
  }
}

/** Product validation and provider boundary, with one closed Core history read. */
export function createD1ProjectDatabaseAccessPort(
  binding: ProjectDatabaseAccessBinding,
  runtime: { readProjectDatabaseAccessHistory(input: unknown): Promise<ProjectDatabaseAccessPage> },
  clock: Clock,
): ProjectDatabaseAccessPort {
  return createAccessPort(
    binding,
    (input) => runtime.readProjectDatabaseAccessHistory(input),
    clock,
  );
}

function createAccessPort(
  binding: ProjectDatabaseAccessBinding,
  history: (input: {
    organizationId: string;
    projectId: string;
    environment?: "dev" | "prod";
    now: string;
  }) => Promise<ProjectDatabaseAccessPage>,
  clock: Clock,
): ProjectDatabaseAccessPort {
  return {
    async issue(
      input: ProjectDatabaseAccessIssueInput,
    ): Promise<ProjectDatabaseAccessCredential | null> {
      const value = await binding.issueDatabaseAccess({
        organizationId: input.organizationId,
        projectId: input.projectId,
        principalId: input.principalId,
        requestId: input.requestId,
        environment: input.environment,
        mode: input.mode,
        ttlSeconds: input.ttl_seconds,
        label: input.label,
      });
      const code = rejectionCode(value);
      if (code === "scope") return null;
      if (code === "limit") throw new ProjectDatabaseAccessError("limit");
      if (code === "paid_plan_required") throw new ProjectDatabaseAccessError("paid_plan_required");
      if (code === "insufficient_organization_credits" || code === "project_budget_exceeded")
        throw new OrganizationCreditError(code);
      if (code !== null) throw new ProjectDatabaseAccessUnavailableError();
      assertProjectDatabaseAccessCredential(value);
      if (value.environment !== input.environment || value.mode !== input.mode)
        throw new TypeError("Database access scope mismatch");
      return value;
    },
    async list(input: ProjectDatabaseAccessListInput): Promise<ProjectDatabaseAccessPage> {
      const now = clock.now().toISOString();
      const page = await history({
        organizationId: input.organizationId,
        projectId: input.projectId,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        now,
      });
      assertProjectDatabaseAccessPage(page);
      return page;
    },
    async revoke(input: ProjectDatabaseAccessRevokeInput): Promise<ProjectDatabaseAccess | null> {
      const value = await binding.revokeDatabaseAccess({
        organizationId: input.organizationId,
        projectId: input.projectId,
        principalId: input.principalId,
        accessId: input.accessId,
      });
      const code = rejectionCode(value);
      if (code === "not_found" || code === "scope") return null;
      if (code !== null) throw new ProjectDatabaseAccessUnavailableError();
      assertProjectDatabaseAccess(value);
      if (value.access_id !== input.accessId) throw new TypeError("Database access scope mismatch");
      return value;
    },
  };
}

function rejectionCode(value: unknown): string | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.get(value, "status") !== "rejected"
  )
    return null;
  const code = Reflect.get(value, "code");
  return typeof code === "string" && code.length > 0 ? code : "unavailable";
}
