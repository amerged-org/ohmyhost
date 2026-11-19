import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseMigrationFailureDiagnostic,
  publicOperationFailure,
  publicOperationReconciliation,
} from "../src/operation-failure.js";

describe("public operation failure", () => {
  it("preserves only validated migration location metadata and never PostgreSQL messages or SQL", () => {
    const diagnostic = {
      reason: "execution_failed",
      file: "migrations/20260925090000_expand.sql",
      statement_index: 2,
      sqlstate: "42P01",
    };
    expect(publicOperationFailure("DATABASE_MIGRATION_FAILED", diagnostic).migration).toEqual(
      diagnostic,
    );
    expect(publicOperationFailure("BUILD_FAILED", diagnostic)).not.toHaveProperty("migration");
    expect(parseMigrationFailureDiagnostic({ reason: "not_admitted", file: null })).toEqual({
      reason: "not_admitted",
      file: null,
    });
    expect(
      parseMigrationFailureDiagnostic({ reason: "execution_failed", file: diagnostic.file }),
    ).toEqual({ reason: "execution_failed", file: diagnostic.file });
    expect(
      parseMigrationFailureDiagnostic({
        reason: "execution_failed",
        file: "db/20261028110000_expand.sql",
        statement_index: undefined,
      }),
    ).toBeNull();
    expect(
      parseMigrationFailureDiagnostic({
        reason: "execution_failed",
        file: "db/20261028110000_expand.sql",
        sqlstate: undefined,
      }),
    ).toBeNull();
    for (const invalid of [
      null,
      [],
      "execution_failed",
      { ...diagnostic, message: "secret SQL value" },
      { ...diagnostic, sql: "select secret" },
      { ...diagnostic, statement_index: 0 },
      { ...diagnostic, statement_index: undefined },
      { ...diagnostic, reason: "catalog_changed" },
      { ...diagnostic, file: null },
      { ...diagnostic, file: "../secret.sql" },
      { ...diagnostic, sqlstate: "42p01" },
      { ...diagnostic, sqlstate: "secret" },
      { reason: "execution_failed", file: diagnostic.file, statement_index: 2 },
      { reason: "execution_failed", file: diagnostic.file, sqlstate: "42P01" },
      { ...diagnostic, sqlstate: "08007" },
      { ...diagnostic, sqlstate: "57P01" },
      { ...diagnostic, reason: "unknown" },
      { ...diagnostic, statement_index: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(parseMigrationFailureDiagnostic(invalid)).toBeNull();
      const publicFailure = publicOperationFailure("DATABASE_MIGRATION_FAILED", invalid);
      expect(publicFailure).not.toHaveProperty("migration");
      expect(JSON.stringify(publicFailure)).not.toContain("secret");
    }
  });
  it.each([
    ["OPERATION_ABANDONED", "operation_abandoned", /cannot resume.*new idempotency key/u],
    [
      "PROJECT_BUDGET_EXCEEDED",
      "project_budget_exceeded",
      /Stop budget.*no build started.*budget get.*next UTC month/u,
    ],
    ["RUNTIME_CANDIDATE_REJECTED", "runtime_candidate_rejected", /default export/u],
    [
      "STORAGE_JURISDICTION_CONFLICT",
      "storage_jurisdiction_conflict",
      /storage\.jurisdiction.*\(us or eu\).*keep their jurisdiction after a project-region migration.*plan its commit/u,
    ],
    [
      "BUILD_FAILED",
      "build_failed",
      /BUILD_FAILED item.*deployment_id.*deployment logs .*--json' or MCP deployment_logs/u,
    ],
    [
      "AUTO_DEPLOY_PLAN_REJECTED",
      "auto_deploy_plan_rejected",
      /^Read error\.detail.*Without error\.detail, plan the pushed commit explicitly with 'ohmyhost plan --project ULID --commit SHA --json' or MCP deployment_plan/u,
    ],
    [
      "AUTO_DEPLOY_REPOSITORY_RENAMED",
      "auto_deploy_repository_renamed",
      /ohmyhost link --project PROJECT_ULID.*--idempotency-key KEY1 --json.*source auto-deploy set.*--idempotency-key KEY2 --json.*push again.*a new idempotency key for each/u,
    ],
    [
      "PROJECT_HANDLE_TAKEN",
      "project_handle_taken",
      /project handle check --handle NAME --json.*project_handle_check.*new idempotency key/u,
    ],
    [
      "MANAGED_SOURCE_DISPATCH_FAILED",
      "managed_source_dispatch_failed",
      /Read the current source to confirm it did not change.*new idempotency key/u,
    ],
  ] as const)("renders the reviewed text for %s", (internal, code, action) => {
    const failure = publicOperationFailure(internal);
    expect(failure).toMatchObject({ code, retryable: false });
    expect(failure.suggested_action).toMatch(action);
    expect(failure).not.toHaveProperty("detail");
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it("maps unknown internal codes to the generic failure without leaking them", () => {
    const failure = publicOperationFailure("ProviderSecretDetail: token=abc");
    expect(failure.code).toBe("operation_failed");
    expect(JSON.stringify(failure)).not.toContain("token=abc");
  });

  it("carries the catalog detail only for an auto-deploy rejection with a valid diagnostic", () => {
    const diagnostic = {
      code: "framework_version_unsupported",
      path: "package-lock.json",
      package: "next",
      version: "16.4.0",
      minimum: "16.4.1",
    };
    const failure = publicOperationFailure("AUTO_DEPLOY_PLAN_REJECTED", diagnostic);
    expect(Object.keys(failure)).toEqual([
      "code",
      "message",
      "retryable",
      "suggested_action",
      "detail",
    ]);
    expect(failure).toEqual({
      ...publicOperationFailure("AUTO_DEPLOY_PLAN_REJECTED"),
      detail:
        '"package-lock.json" resolves next 16.4.0, which ohmyho.st does not admit; use next 16.4.1 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.',
    });
    expect(Object.isFrozen(failure)).toBe(true);
    for (const stored of [
      null,
      { ...diagnostic, path: "../package-lock.json" },
      { ...diagnostic, secret: "token=abc" },
      "framework_version_unsupported",
    ]) {
      const rejected = publicOperationFailure("AUTO_DEPLOY_PLAN_REJECTED", stored);
      expect(rejected).toEqual(publicOperationFailure("AUTO_DEPLOY_PLAN_REJECTED"));
      expect(JSON.stringify(rejected)).not.toContain("token=abc");
    }
    expect(publicOperationFailure("BUILD_FAILED", diagnostic)).not.toHaveProperty("detail");
    expect(publicOperationFailure("ProviderSecretDetail", diagnostic)).not.toHaveProperty("detail");
  });

  it("gives safe next steps for terminal managed-source and authorization failures", () => {
    for (const code of [
      "BUILD_FAILED",
      "RUNTIME_CANDIDATE_FAILED",
      "SOURCE_COMMIT_CONFLICT",
      "AUTO_DEPLOY_PLAN_REJECTED",
    ])
      expect(publicOperationFailure(code).suggested_action.length).toBeLessThanOrEqual(500);
    for (const [internal, action] of [
      ["AUTHORIZATION_CHANGED", /Reconnect the client.*existing data and deployment/u],
      ["SOURCE_COMMIT_CONFLICT", /Merge both changes.*current commit/u],
      ["SOURCE_SNAPSHOT_INVALID", /stable source snapshot.*complete manifest/u],
      ["SOURCE_UPLOAD_EXPIRED", /current source version.*before expiry/u],
    ] as const) {
      const failure = publicOperationFailure(internal);
      expect(failure.code).toBe(internal.toLowerCase());
      expect(failure.retryable).toBe(false);
      expect(failure.suggested_action).toMatch(action);
      expect(failure.suggested_action.length).toBeLessThanOrEqual(500);
    }
  });

  it("explains a failed database size change with one fixed text", () => {
    const failed = publicOperationFailure("DATABASE_COMPUTE_FAILED");
    expect(publicOperationFailure("database_compute_failed")).toEqual(failed);
    expect(failed).toMatchObject({ code: "database_compute_failed", retryable: false });
    expect(Object.isFrozen(failed)).toBe(true);
    expect(failed.message).toMatch(
      /^The database provider refused the size change or had no room for it\. The database keeps its previous size and keeps running, and no credits are charged for the failed change\.$/u,
    );
    expect(failed.suggested_action).toMatch(
      /database compute get.*database_compute_get.*new idempotency key.*old key only returns this failure.*fails again after a few minutes.*new deployment of the project.*report this operation ID through feedback/su,
    );
    expect(failed.suggested_action).not.toMatch(/redeploy the database/u);
    expect(failed.message.length).toBeLessThanOrEqual(512);
    expect(failed.suggested_action.length).toBeLessThanOrEqual(500);

    const planChanged = publicOperationFailure("DATABASE_COMPUTE_PLAN_CHANGED");
    expect(publicOperationFailure("database_compute_plan_changed")).toEqual(planChanged);
    expect(planChanged).toMatchObject({ code: "database_compute_plan_changed", retryable: false });
    expect(planChanged.message).toMatch(
      /Paid access ended before the database size change started.*not sent to the database provider.*previous size.*no credits are charged/su,
    );
    expect(planChanged.suggested_action).toMatch(
      /credits account.*organization_account_get.*activate Paid.*database compute get.*new idempotency key/su,
    );
    expect(planChanged.suggested_action).not.toMatch(/standard-size/u);
    expect(planChanged.message.length).toBeLessThanOrEqual(512);
    expect(planChanged.suggested_action.length).toBeLessThanOrEqual(500);
  });

  it("gives the build Skill a separate idempotency key for the re-link and the auto-deploy command", async () => {
    const skill = await readFile(
      new URL(
        "../../../skills/ohmyhost-build-portable-app/references/cli-deploy.md",
        import.meta.url,
      ),
      "utf8",
    );
    expect(skill).toMatch(
      /ohmyhost link --project ULID.*--idempotency-key KEY1.*ohmyhost source auto-deploy set --project ULID.*--idempotency-key KEY2.*push again.*a new idempotency key for each/su,
    );
  });

  it("quotes the fixed database size change messages in the manage-database Skill", async () => {
    const skill = await readFile(
      new URL("../../../skills/ohmyhost-manage-database/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skill).toContain(publicOperationFailure("database_compute_failed").message);
    expect(skill).toContain(publicOperationFailure("database_compute_plan_changed").message);
    expect(skill).toContain("new idempotency key");
  });

  it("names the reconcile route for a reconciliation-required operation and data changes in the abandoned advice", () => {
    const reconciliation = publicOperationReconciliation({
      state: "required",
      attempt_id: null,
      observed_at: "2026-10-28T11:00:00.000Z",
    });
    expect(reconciliation.suggested_action).toMatch(
      /POST \/v1\/operations\/\{operation_id\}:reconcile.*Do not submit another deployment or data change/u,
    );
    expect(publicOperationFailure("OPERATION_ABANDONED").suggested_action).toMatch(
      /deployment, promotion, rollback, deletion or data change from a fresh plan/u,
    );
  });
});
