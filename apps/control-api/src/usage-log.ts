import { bounded } from "./growth-deadline.js";
import { PROBLEM_POLICY } from "@ohmyhost/contracts/problem-policy";
import type { UsageLogRecord } from "@ohmyhost/contracts/usage-log";
import { USAGE_OPERATIONS } from "./usage-operation-map.js";

export type UsageReporter = (record: UsageLogRecord) => void;
export interface UsageScope {
  accountId: string | null;
  organizationId: string | null;
  projectId: string | null;
}
export interface UsageParent {
  invocation: string;
  scope: UsageScope;
  ambiguous: boolean;
  accepted: boolean;
  operationId?: string;
  operationStatus?: UsageLogRecord["operation_status"];
}
const parents = new WeakMap<Request, UsageParent>();
const responses = new WeakMap<
  Response,
  { code?: string; operationId?: string; operationStatus?: UsageLogRecord["operation_status"] }
>();
export function setUsageParent(request: Request, parent: UsageParent): void {
  parents.set(request, parent);
}
export function usageParent(request: Request): string | null {
  return parents.get(request)?.invocation ?? null;
}
export function usageParentContext(request: Request): UsageParent | undefined {
  return parents.get(request);
}
export function usageState(value: unknown): UsageLogRecord["operation_status"] {
  return value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : null;
}
export function setUsageResponse(
  response: Response,
  value: {
    code?: string;
    operationId?: string;
    operationStatus?: UsageLogRecord["operation_status"];
  },
): Response {
  responses.set(response, value);
  return response;
}
export function usageResponse(response: Response) {
  return responses.get(response);
}
const matchers = USAGE_OPERATIONS.map(([method, path, operation]) => ({
  method,
  operation,
  specificity: path.replace(/\{[^}]+\}/gu, "").length,
  pattern: new RegExp(
    `^${path
      .split(/(\{[^}]+\})/u)
      .map((s) => (s.startsWith("{") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
      .join("")}$`,
    "u",
  ),
})).sort((a, b) => b.specificity - a.specificity);
export function usageOperation(method: string, path: string): string | null {
  return (
    matchers.find((entry) => entry.method === method && entry.pattern.test(path))?.operation ?? null
  );
}
export function usageError(code: unknown): UsageLogRecord["error_code"] {
  return typeof code === "string" && Object.hasOwn(PROBLEM_POLICY, code)
    ? (code as UsageLogRecord["error_code"])
    : null;
}
export function validUsageOperationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)
    ? value
    : undefined;
}
export function usageAccount(value: unknown): string | null {
  return typeof value === "string" && /^user_[A-Za-z0-9_]{1,123}$/u.test(value) ? value : null;
}
export function startUsage(
  report: UsageReporter | undefined,
  input: {
    environment: "development" | "production";
    version: string | null;
    transport: "rest" | "remote_mcp";
    operation: string;
    parent: string | null;
    scope: UsageScope;
    startedAt?: string;
    startedMonotonic?: number;
  },
) {
  if (!report) return null;
  try {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const start = input.startedMonotonic ?? performance.now();
    const invocation = crypto.randomUUID();
    const base = {
      schema_version: 1 as const,
      invocation_id: invocation,
      parent_invocation_id: input.parent,
      started_at: startedAt,
      platform_environment: input.environment,
      transport: input.transport,
      operation: input.operation,
      platform_version: input.version,
    };
    const write = (record: UsageLogRecord) => {
      try {
        report(record);
      } catch {
        /* never affect product */
      }
    };
    write({
      ...base,
      record_id: crypto.randomUUID(),
      phase: "started",
      occurred_at: startedAt,
      account_id: input.scope.accountId,
      organization_id: input.scope.organizationId,
      project_id: input.scope.projectId,
      operation_id: null,
      operation_status: null,
      outcome: "started",
      duration_ms: null,
      http_status: null,
      error_code: null,
    });
    return {
      invocation,
      finish(
        scope: UsageScope,
        outcome: "succeeded" | "accepted" | "failed" | "cancelled",
        status: number | null,
        code: unknown,
        operationId?: string,
        operationStatus?: UsageLogRecord["operation_status"],
      ) {
        try {
          write({
            ...base,
            record_id: crypto.randomUUID(),
            phase: "finished",
            occurred_at: new Date().toISOString(),
            account_id: scope.accountId,
            organization_id: scope.organizationId,
            project_id: scope.projectId,
            operation_id: operationId ?? null,
            operation_status: operationStatus ?? null,
            outcome,
            duration_ms: Math.min(604800000, Math.max(0, Math.round(performance.now() - start))),
            http_status: status,
            error_code: usageError(code),
          });
        } catch {
          /* never affect product */
        }
      },
    };
  } catch {
    return null;
  }
}

/** The private usage publisher shares the existing two-second telemetry deadline. */
export function createUsageReporter(
  collector: { collectUsage?(record: UsageLogRecord): Promise<{ accepted: boolean }> } | undefined,
  context: { waitUntil(work: Promise<unknown>): void },
  counter?: {
    record(input: {
      producer: "control_api";
      event_id: string;
      outcome: "offered" | "gap";
      occurred_at: string;
    }): Promise<void>;
  },
): UsageReporter {
  return (record) => {
    try {
      const count = async (outcome: "offered" | "gap") => {
        try {
          if (counter)
            await bounded(
              counter.record({
                producer: "control_api",
                event_id: record.record_id,
                outcome,
                occurred_at: record.occurred_at,
              }),
            );
        } catch {
          /* Independent delivery counts may themselves be unavailable. */
        }
      };
      context.waitUntil(count("offered"));
      context.waitUntil(
        Promise.resolve().then(async () => {
          try {
            if (!collector?.collectUsage) throw new Error("usage unavailable");
            const result = await bounded(
              Promise.resolve().then(() => collector.collectUsage?.(record)),
            );
            if (!result?.accepted) throw new Error("usage unconfirmed");
          } catch {
            await count("gap");
          }
        }),
      );
    } catch {
      /* Telemetry cannot affect product response handling. */
    }
  };
}
