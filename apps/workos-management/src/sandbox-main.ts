import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkosManagementDatabase } from "./ports.js";
import { createWorkosManagementWorkerRuntime } from "./worker-runtime.js";

const SELF_TEST_SCHEMA = "workos-management-sandbox-self-test-v1";
const FIXED_ULIDS = {
  claim: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
} as const;

const denyDatabaseAccess = async (): Promise<never> => {
  throw new Error("Sandbox self-test must not access the database");
};

// The self-test composes the graph without any Control authority: every database call is refused.
const guardedRuntime = Object.freeze({});

const guardedDatabase: WorkosManagementDatabase = {
  isSessionEligible: denyDatabaseAccess,
  findExpiredFinalClaim: denyDatabaseAccess,
  claim: denyDatabaseAccess,
  applySnapshotAndAcknowledge: denyDatabaseAccess,
  applyDeletionAndAcknowledge: denyDatabaseAccess,
  revokeLocalAuthorizationForUncertainSnapshot: denyDatabaseAccess,
  recordFailure: denyDatabaseAccess,
  recoverExpiredFinalClaim: denyDatabaseAccess,
};

export interface SandboxSelfTestResult {
  readonly schema_version: typeof SELF_TEST_SCHEMA;
  readonly artifact_sha256: string;
  readonly components: {
    readonly resolver: "configured";
    readonly transport: "read_only";
    readonly rpc: "authenticated";
  };
}

export async function runSandboxSelfTest(artifactDigest: string): Promise<SandboxSelfTestResult> {
  if (!/^[a-f0-9]{64}$/u.test(artifactDigest)) {
    throw new TypeError("Sandbox self-test artifact digest is invalid");
  }
  try {
    await guardedDatabase.claim({ claimId: "guard", claimedAt: "guard", leaseExpiresAt: "guard" });
    throw new Error("Sandbox database guard unexpectedly allowed access");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Sandbox self-test must not access the database"
    ) {
      throw error;
    }
  }
  let providerCalls = 0;
  const ids = { next: () => FIXED_ULIDS.claim };
  const organizationIds = { next: () => FIXED_ULIDS.organization };
  if (ids.next() !== FIXED_ULIDS.claim || organizationIds.next() !== FIXED_ULIDS.organization) {
    throw new Error("Sandbox self-test deterministic identifiers are invalid");
  }
  const runtime = createWorkosManagementWorkerRuntime({
    sessionAnswers: new Map(),
    bindings: {
      WORKOS_DEPLOYMENT: "development",
      WORKOS_MANAGEMENT_CREDENTIAL: "sk_fixture_nonprovider_value",
      MANAGEMENT_ARTIFACT_SHA256: artifactDigest,
      CF_VERSION_METADATA: {
        id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
        tag: artifactDigest,
        timestamp: "2026-08-19T10:00:00.000Z",
      },
      WORKOS_AUTHKIT_DOMAIN: "https://fixture.authkit.app",
      WORKOS_CONNECT_APPLICATION_ID: "app_fixture",
      WORKOS_CONNECT_CLIENT_ID: "client_fixture",
      WORKOS_CONNECT_CLIENT_SECRET: "connect_fixture_nonprovider_value",
      CONTROL_RUNTIME: guardedRuntime,
    },
    database: guardedDatabase,
    clock: { now: () => new Date("2026-08-19T10:00:00.000Z") },
    ids,
    organizationIds,
    fetcher: async (request) => {
      providerCalls += 1;
      if (request.url.endsWith("/organizations/org_self_test")) {
        return new Response(
          JSON.stringify({
            id: "org_self_test",
            name: "Self Test",
            created_at: "2026-08-19T08:00:00.000Z",
            updated_at: "2026-08-19T09:00:00.000Z",
          }),
        );
      }
      if (request.url.includes("/user_management/organization_memberships")) {
        return new Response(
          JSON.stringify({ object: "list", data: [], list_metadata: { after: null } }),
        );
      }
      throw new Error("Sandbox self-test attempted a non-allowlisted request");
    },
  });
  const response = await runtime.handler.fetch(
    new Request("https://workos-management.internal/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "organizations.get_current_snapshot",
        requestId: "sandbox-self-test",
        payload: { workosOrganizationId: "org_self_test" },
      }),
    }),
  );
  const body = (await response.json()) as { readonly ok?: unknown };
  if (response.status !== 200 || body.ok !== true || providerCalls !== 2) {
    throw new Error("Sandbox self-test graph did not complete its read-only RPC contract");
  }
  return {
    schema_version: SELF_TEST_SCHEMA,
    artifact_sha256: artifactDigest,
    components: { resolver: "configured", transport: "read_only", rpc: "authenticated" },
  };
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const [mode, digest, extra] = process.argv.slice(2);
  if (mode !== "--self-test" || digest === undefined || extra !== undefined) {
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await runSandboxSelfTest(digest))}\n`);
    } catch {
      process.exitCode = 1;
    }
  }
}
