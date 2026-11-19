import { describe, expect, it } from "vitest";
import { OrganizationCreditError, ProjectDatabaseWriteError } from "@ohmyhost/database";
import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import { parseUlid } from "@ohmyhost/platform";
import { IdempotencyKeyReusedError } from "../src/contracts.js";
import { createProjectDatabaseWritePort } from "../src/project-database-write.js";

const operationId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const request = {
  organizationId: parseUlid("01K2F3G4H5J6K7M8N9P0QRSTVX"),
  projectId: parseUlid("01K2F3G4H5J6K7M8N9P0QRSTVY"),
  principalId: "user:user_writer",
  requestId: "req_write",
  idempotencyKey: "write-once",
  canonicalRequestDigest: Uint8Array.from({ length: 32 }, (_, index) => index),
  environment: "dev" as const,
  statement: "UPDATE accounts SET name = $1 WHERE id = $2",
  parameters: ["Ada", 7],
};
const succeeded = {
  operation_id: operationId,
  environment: "dev",
  state: "succeeded",
  command: "UPDATE",
  affected_rows: 1,
  error: null,
};

function fixture(reply: unknown) {
  const sent: unknown[] = [];
  const write = createProjectDatabaseWritePort({
    async writeProject(input) {
      sent.push(input);
      return reply;
    },
  });
  return { write, sent };
}

describe("project database write port", () => {
  it("sends the exact private write request and answers a finished write with 200", async () => {
    const { write, sent } = fixture(succeeded);
    expect(await write(request)).toEqual({
      status: 200,
      location: `/v1/operations/${operationId}`,
      body: succeeded,
    });
    expect(sent).toEqual([
      {
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: "user:user_writer",
        requestId: "req_write",
        idempotencyKey: "write-once",
        canonicalRequestSha256: Buffer.from(request.canonicalRequestDigest).toString("hex"),
        environment: "dev",
        statement: request.statement,
        parameters: ["Ada", 7],
      },
    ]);
  });

  it("answers a write that is still running with 202 and a failed one with its public failure", async () => {
    const running = { ...succeeded, state: "running", command: null, affected_rows: null };
    expect(await fixture(running).write(request)).toMatchObject({
      status: 202,
      body: { state: "running" },
    });
    const failed = {
      ...running,
      state: "failed",
      error: publicOperationFailure("database_write_rejected"),
    };
    expect(await fixture(failed).write(request)).toMatchObject({
      status: 200,
      body: { state: "failed", error: { code: "database_write_rejected" } },
    });
  });

  it("maps the rejection codes to a missing scope or the reviewed typed errors", async () => {
    const rejected = (code: string) => ({ status: "rejected", code });
    expect(await fixture(rejected("scope")).write(request)).toBeNull();
    await expect(fixture(rejected("idempotency")).write(request)).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    await expect(fixture(rejected("pending")).write(request)).rejects.toMatchObject({
      name: "ProjectDatabaseWriteError",
      code: "pending",
    });
    await expect(fixture(rejected("pending")).write(request)).rejects.toBeInstanceOf(
      ProjectDatabaseWriteError,
    );
    for (const code of ["insufficient_organization_credits", "project_budget_exceeded"] as const) {
      const error = await fixture(rejected(code))
        .write(request)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OrganizationCreditError);
      expect(error).toMatchObject({ code });
    }
    // A database suspended for lack of Paid coverage answers its Paid requirement, not a retryable outage.
    const suspended = await fixture(rejected("paid_plan_required"))
      .write(request)
      .catch((caught: unknown) => caught);
    expect(suspended).toBeInstanceOf(ProjectDatabaseWriteError);
    expect(suspended).toMatchObject({ code: "paid_plan_required" });
  });

  it("refuses an unknown rejection, a malformed receipt and a receipt for another environment", async () => {
    await expect(fixture({ status: "rejected", code: "other" }).write(request)).rejects.toThrow(
      "Invalid database write receipt",
    );
    await expect(fixture(null).write(request)).rejects.toThrow("Invalid database write receipt");
    await expect(fixture({ ...succeeded, extra: 1 }).write(request)).rejects.toThrow(
      "Invalid database write receipt",
    );
    await expect(fixture({ ...succeeded, environment: "prod" }).write(request)).rejects.toThrow(
      "Database write environment mismatch",
    );
  });
});
