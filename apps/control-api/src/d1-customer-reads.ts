import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { DeploymentDiagnosticsPort, FunctionRunsPort } from "./contracts.js";

/** Two bounded, tenant-scoped reads of the Control runtime; neither carries SQL, a clock callback or write authority. */
export interface D1CustomerReadsRuntime {
  readEnvironmentFunctionRuns(input: unknown): Promise<unknown>;
  readDeploymentDiagnostics(input: unknown): Promise<unknown>;
}
const instant = z.string().refine((value) => new Date(value).toISOString() === value),
  runs = z.array(
    z.strictObject({
      runId: z.string().transform(parseUlid),
      deploymentId: z.string().transform(parseUlid),
      cron: z.string(),
      scheduledAt: instant,
      state: z.enum(["due", "running", "retry", "succeeded", "failed", "skipped"]),
      attempt: z.number().int().nonnegative(),
      statusCode: z.number().int().nullable(),
      startedAt: instant.nullable(),
      finishedAt: instant.nullable(),
    }),
  ),
  nullableString = z.string().nullable(),
  nullableNumber = z.number().int().nullable(),
  diagnostics = z.strictObject({
    items: z.array(
      z.strictObject({
        id: z.string().transform(parseUlid),
        source: z.enum(["build", "control", "runtime", "function"]),
        code: z.string(),
        catalogMessage: z.string(),
        exceptionClass: nullableString,
        sourceFile: nullableString,
        sourceLine: nullableNumber,
        sourceColumn: nullableNumber,
        routeTemplate: nullableString,
        requestId: nullableString,
        traceId: nullableString,
        durationMs: nullableNumber,
        excerpt: nullableString,
        excerptTruncated: z.boolean().nullable(),
        statusCode: nullableNumber,
        occurredAt: instant,
      }),
    ),
    nextBefore: z.strictObject({ occurredAt: instant, id: z.string() }).nullable(),
  });

export function isD1CustomerReadsRuntime(value: unknown): value is D1CustomerReadsRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    ["readEnvironmentFunctionRuns", "readDeploymentDiagnostics"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

export function createD1FunctionRunsPort(runtime: D1CustomerReadsRuntime): FunctionRunsPort {
  const port: FunctionRunsPort = {
    async list(value) {
      const items = runs.parse(
        await runtime.readEnvironmentFunctionRuns({
          organizationId: value.organizationId,
          projectId: value.projectId,
          environmentId: value.environmentId,
          limit: value.limit,
        }),
      );
      return Object.freeze({
        items: items.map((run) =>
          Object.freeze({
            id: run.runId,
            deployment_id: run.deploymentId,
            cron: run.cron,
            scheduled_at: run.scheduledAt,
            state: run.state,
            attempt: run.attempt,
            status_code: run.statusCode,
            started_at: run.startedAt,
            finished_at: run.finishedAt,
          }),
        ),
      });
    },
  };
  return Object.freeze(port);
}

/** The cursor keeps its original public form: base64url JSON of the last item's instant and id. */
export function createD1DeploymentDiagnosticsPort(
  runtime: D1CustomerReadsRuntime,
  now: () => Date,
): DeploymentDiagnosticsPort {
  return {
    async list(value) {
      let before: { occurredAt: string; id: string } | undefined;
      if (value.cursor !== undefined) {
        if (value.cursor.length > 2048) throw new TypeError("Invalid diagnostic cursor");
        try {
          const parsed = JSON.parse(Buffer.from(value.cursor, "base64url").toString()) as {
            occurredAt: string;
            id: string;
          };
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Object.keys(parsed).sort().join() !== "id,occurredAt" ||
            typeof parsed.occurredAt !== "string" ||
            new Date(parsed.occurredAt).toISOString() !== parsed.occurredAt
          )
            throw new Error("invalid");
          before = { occurredAt: parsed.occurredAt, id: parseUlid(parsed.id) };
        } catch {
          throw new TypeError("Invalid diagnostic cursor");
        }
      }
      const page = diagnostics.parse(
        await runtime.readDeploymentDiagnostics({
          organizationId: value.organizationId,
          projectId: value.projectId,
          deploymentId: value.deploymentId,
          now: now().toISOString(),
          limit: value.limit,
          ...(before === undefined ? {} : { before }),
        }),
      );
      return {
        items: page.items.map((item) => ({
          id: item.id,
          source: item.source,
          code: item.code,
          message: item.catalogMessage,
          ...(item.exceptionClass === null ? {} : { exception_class: item.exceptionClass }),
          ...(item.sourceFile === null
            ? {}
            : { file: item.sourceFile, line: item.sourceLine, column: item.sourceColumn }),
          ...(item.routeTemplate === null ? {} : { route: item.routeTemplate }),
          ...(item.requestId === null ? {} : { request_id: item.requestId }),
          ...(item.traceId === null ? {} : { trace_id: item.traceId }),
          ...(item.durationMs === null ? {} : { duration_ms: item.durationMs }),
          ...(item.excerpt === null
            ? {}
            : { excerpt: item.excerpt, excerpt_truncated: item.excerptTruncated }),
          ...(item.statusCode === null ? {} : { status_code: item.statusCode }),
          occurred_at: item.occurredAt,
        })),
        nextCursor:
          page.nextBefore === null
            ? null
            : Buffer.from(JSON.stringify(page.nextBefore)).toString("base64url"),
      };
    },
  };
}
