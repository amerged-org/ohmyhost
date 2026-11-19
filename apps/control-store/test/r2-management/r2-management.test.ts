import { expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import {
  authorizeR2Bucket,
  claimR2Bucket,
  proveR2BucketAbsence,
  putR2Bucket,
  readR2Bucket,
  supersedeR2BucketReservation,
} from "../../src/catalog/r2-management/buckets.js";
import { readR2Confirmed } from "../../src/catalog/r2-management/confirmed-storage.js";
import type { D1PreparedStatement } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import { StoreOutcomeUnknownError } from "../../src/run-command.js";
import { seedAcceptedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject, STORED_NOW, type SeededProject } from "../support/platform-fixtures.js";

const context = (db: TestControl["core"]) => ({ directory: db, router: new SharedCoreRouter(db) });

/**
 * The reply of the first write batch that mentions `table` is lost after the batch committed. The provider
 * authorization check inside a command is a write batch of its own, so counting batches would hit it instead.
 */
function losingReplyOf(db: TestControl["core"], table: string): TestControl["core"] {
  type Wrapped = D1PreparedStatement & { inner: D1PreparedStatement; sql: string };
  let pending = true;
  const wrap = (inner: D1PreparedStatement, sql: string): Wrapped => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: (...args: []) => inner.first(...args),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const wrapped = statements as Wrapped[];
      const results = await db.batch(wrapped.map((statement) => statement.inner));
      if (
        pending &&
        wrapped.some(
          (statement) =>
            statement.sql.includes(table) && /^\s*(INSERT|UPDATE|DELETE)/iu.test(statement.sql),
        )
      ) {
        pending = false;
        throw new Error("Network connection lost");
      }
      return results;
    },
  };
}
const DEADLINE = "2099-01-01T00:00:00.000Z";

/** A project whose dev environment holds the accepted operation's provider mutation claim. */
async function claimed(control: TestControl) {
  const project = await seedProject(control);
  const accepted = await seedAcceptedOperation(project, project.devEnvironmentId);
  const scope = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
  };
  const mutation = { ...scope, operationId: accepted.operationId, claimId: accepted.claimId };
  const target = {
    ...mutation,
    bucketName: `ohmyho-${project.projectId.toLowerCase()}-${project.devEnvironmentId.toLowerCase()}`,
    jurisdiction: "eu" as const,
    storageClass: "Standard" as const,
    publicAccess: false as const,
  };
  const receipt = {
    ...target,
    bucketId: "a1".repeat(16),
    observedAt: "2026-10-28T10:00:05.000Z",
  };
  return { project, scope, mutation, target, receipt };
}

it("claims a project bucket, grants one create authorization, reconciles the receipt and refuses a conflicting target", async () => {
  const c = await createTestControl();
  try {
    const { project, scope, mutation, target, receipt } = await claimed(c);
    const ctx = context(c.core);
    expect(await readR2Bucket(ctx, scope)).toBeNull();
    await expect(claimR2Bucket(ctx, { ...target, bucketName: "ohmyho-other" })).rejects.toThrow();

    expect(await claimR2Bucket(ctx, target)).toEqual({ status: "claimed", mode: "create" });
    expect(
      await c.core.prepare("SELECT create_started_at FROM project_r2_bucket_reservations").first(),
    ).toEqual({ create_started_at: null });
    // the delivery permission is granted exactly once; a second call grants nothing
    expect(await authorizeR2Bucket(ctx, mutation)).toBe(true);
    expect(await authorizeR2Bucket(ctx, mutation)).toBe(false);
    expect(await claimR2Bucket(ctx, target)).toEqual({ status: "claimed", mode: "observe" });
    // a bucket in another jurisdiction than the durable one conflicts
    await expect(claimR2Bucket(ctx, { ...target, jurisdiction: "us" })).rejects.toThrow(
      "conflicts with durable state",
    );
    // a mutation without an accepted claim is not authorized
    await expect(authorizeR2Bucket(ctx, { ...mutation, claimId: newUlid() })).rejects.toThrow(
      "conflicts with durable state",
    );

    expect(await putR2Bucket(ctx, receipt)).toBe("created");
    expect(await putR2Bucket(ctx, receipt)).toBe("existing");
    await expect(putR2Bucket(ctx, { ...receipt, bucketId: "b2".repeat(16) })).rejects.toThrow(
      "conflicts with durable state",
    );
    expect(await readR2Bucket(ctx, scope)).toEqual({
      ...mutation,
      bucketName: target.bucketName,
      bucketId: receipt.bucketId,
      jurisdiction: "eu",
      storageClass: "Standard",
      publicAccess: false,
      observedAt: new Date("2026-10-28T10:00:05.000Z"),
    });
    // the receipt replaced the reservation, and a repeated claim is answered from the receipt
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 0 });
    expect(await claimR2Bucket(ctx, target)).toEqual({
      status: "completed",
      receipt: await readR2Bucket(ctx, scope),
    });
    expect(project.organizationId).toBe(scope.organizationId);
  } finally {
    await c.dispose();
  }
});

const endOperation = (control: TestControl, operationId: string) =>
  control.core
    .prepare("UPDATE operations SET state='failed', lease_expires_at=NULL WHERE operation_id=?")
    .bind(operationId)
    .run();
const claimRows = async (control: TestControl, claimId: string) =>
  (
    await control.core
      .prepare("SELECT count(*) AS n FROM product_provider_mutation_claims WHERE claim_id=?")
      .bind(claimId)
      .first<{ n: number }>()
  )?.n;

it("supersedes an unused reservation only with durable absence evidence and an ended operation, releasing its claim so a new operation may reserve again", async () => {
  const c = await createTestControl();
  try {
    const { project, mutation, target } = await claimed(c);
    const ctx = context(c.core);
    const observed = {
      ...mutation,
      bucketName: target.bucketName,
      observedAt: "2026-10-28T11:00:00.000Z",
    };
    expect(await claimR2Bucket(ctx, target)).toEqual({ status: "claimed", mode: "create" });
    // no absence evidence yet: the reservation cannot be superseded
    await expect(supersedeR2BucketReservation(ctx, observed)).rejects.toThrow(
      "conflicts with durable state",
    );
    expect(await proveR2BucketAbsence(ctx, observed)).toBe("proven");
    // the claim row is released with the reservation, so its operation must have ended first
    expect(await supersedeR2BucketReservation(ctx, observed)).toBe("operation_open");
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 1 });
    await endOperation(c, mutation.operationId);
    expect(await supersedeR2BucketReservation(ctx, observed)).toBe("superseded");
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 0 });
    expect(await claimRows(c, mutation.claimId)).toBe(0);
    // the freed target can be reserved again by a new operation of the project
    const next = await seedAcceptedOperation(project, project.devEnvironmentId);
    expect(
      await claimR2Bucket(ctx, { ...target, operationId: next.operationId, claimId: next.claimId }),
    ).toEqual({ status: "claimed", mode: "create" });
  } finally {
    await c.dispose();
  }
});

it("supersedes a reservation whose create authorization was spent once its bucket is absent after the spend", async () => {
  const c = await createTestControl();
  try {
    const { project, mutation, target } = await claimed(c);
    const ctx = context(c.core);
    expect(await claimR2Bucket(ctx, target)).toEqual({ status: "claimed", mode: "create" });
    expect(await authorizeR2Bucket(ctx, mutation)).toBe(true);
    await endOperation(c, mutation.operationId);
    const observed = {
      ...mutation,
      bucketName: target.bucketName,
      observedAt: new Date().toISOString(),
    };
    expect(await proveR2BucketAbsence(ctx, observed)).toBe("proven");
    expect(await supersedeR2BucketReservation(ctx, observed)).toBe("superseded");
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 0 });
    expect(await claimRows(c, mutation.claimId)).toBe(0);
    const next = await seedAcceptedOperation(project, project.devEnvironmentId);
    expect(
      await claimR2Bucket(ctx, { ...target, operationId: next.operationId, claimId: next.claimId }),
    ).toEqual({ status: "claimed", mode: "create" });
  } finally {
    await c.dispose();
  }
});

it("keeps a spent reservation whose absence was observed before the create authorization was spent", async () => {
  const c = await createTestControl();
  try {
    const { mutation, target } = await claimed(c);
    const ctx = context(c.core);
    const observed = {
      ...mutation,
      bucketName: target.bucketName,
      observedAt: "2026-10-28T11:00:00.000Z",
    };
    expect(await claimR2Bucket(ctx, target)).toEqual({ status: "claimed", mode: "create" });
    expect(await proveR2BucketAbsence(ctx, observed)).toBe("proven");
    expect(await authorizeR2Bucket(ctx, mutation)).toBe(true);
    // an absence observed before the spend says nothing about the bucket the spent create may have made
    await expect(supersedeR2BucketReservation(ctx, observed)).rejects.toThrow(
      "conflicts with durable state",
    );
    await expect(proveR2BucketAbsence(ctx, observed)).rejects.toThrow(
      "conflicts with durable state",
    );
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 1 });
  } finally {
    await c.dispose();
  }
});

it("reports a lost reply of the claim, the create authorization and the receipt as an unknown outcome", async () => {
  const c = await createTestControl();
  try {
    const { scope, mutation, target, receipt } = await claimed(c);
    const lost = () => context(losingReplyOf(c.core, "project_r2_bucket_reservations"));
    await expect(claimR2Bucket(lost(), target)).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
    expect(
      await c.core.prepare("SELECT claim_id FROM project_r2_bucket_reservations").first(),
    ).toEqual({ claim_id: mutation.claimId });
    await expect(authorizeR2Bucket(lost(), mutation)).rejects.toBeInstanceOf(
      StoreOutcomeUnknownError,
    );
    expect(
      (
        await c.core
          .prepare(
            "SELECT create_started_at IS NOT NULL AS started FROM project_r2_bucket_reservations",
          )
          .first<{ started: number }>()
      )?.started,
    ).toBe(1);
    await expect(
      putR2Bucket(context(losingReplyOf(c.core, "project_r2_bucket_receipts")), receipt),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
    // the committed receipt is the answer to the retry
    expect(await putR2Bucket(context(c.core), receipt)).toBe("existing");
    expect((await readR2Bucket(context(c.core), scope))?.bucketId).toBe(receipt.bucketId);
  } finally {
    await c.dispose();
  }
});

it("surfaces a lost absence or supersede reply as an unknown outcome and keeps the committed write for the retry", async () => {
  const c = await createTestControl();
  try {
    const { mutation, target } = await claimed(c);
    const observed = {
      ...mutation,
      bucketName: target.bucketName,
      observedAt: "2026-10-28T11:00:00.000Z",
    };
    expect(await claimR2Bucket(context(c.core), target)).toEqual({
      status: "claimed",
      mode: "create",
    });
    await expect(
      proveR2BucketAbsence(context(losingReplyOf(c.core, "project_r2_bucket_absences")), observed),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_absences").first(),
    ).toEqual({ n: 1 });
    expect(await proveR2BucketAbsence(context(c.core), observed)).toBe("proven");
    await endOperation(c, mutation.operationId);
    await expect(
      supersedeR2BucketReservation(
        context(losingReplyOf(c.core, "project_r2_bucket_reservations")),
        observed,
      ),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
    // the release committed with the lost reply: the reservation and its claim are gone
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 0 });
    expect(await claimRows(c, mutation.claimId)).toBe(0);
    // the retry of the same supersede answers the committed outcome, not a conflict
    expect(await supersedeR2BucketReservation(context(c.core), observed)).toBe("superseded");
    // a reservation that was never superseded is still a conflict for its claim
    await expect(
      supersedeR2BucketReservation(context(c.core), { ...observed, claimId: newUlid() }),
    ).rejects.toThrow("conflicts with durable state");
  } finally {
    await c.dispose();
  }
});

/**
 * The failure path of a deployment, as one batch: the operation fails, its Workflow run completes and its provider
 * mutation claim is deleted (deployment-failure.ts). The claim delete must complete even while the bucket reservation of
 * the operation remains, so the operation can end and the reservation can then be superseded.
 */
const failOperationPath = (control: TestControl, operationId: string) =>
  control.core.batch([
    control.core
      .prepare("UPDATE operations SET state='failed', lease_expires_at=NULL WHERE operation_id=?")
      .bind(operationId),
    control.core
      .prepare(
        "UPDATE product_workflow_runs SET state='completed', terminal_evidence='{}', updated_at='2026-10-29T04:00:00.000000Z', completed_at='2026-10-29T04:00:00.000000Z' WHERE operation_id=? AND state='queued'",
      )
      .bind(operationId),
    control.core
      .prepare("DELETE FROM product_provider_mutation_claims WHERE operation_id=?")
      .bind(operationId),
  ]);

it("completes the failure path of an operation whose unspent bucket reservation remains, and the reservation leaves with its claim", async () => {
  const c = await createTestControl();
  try {
    const { mutation, target } = await claimed(c);
    expect(await claimR2Bucket(context(c.core), target)).toEqual({
      status: "claimed",
      mode: "create",
    });
    await failOperationPath(c, mutation.operationId);
    expect(await claimRows(c, mutation.claimId)).toBe(0);
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 0 });
  } finally {
    await c.dispose();
  }
});

it("keeps the claim and its unspent reservation while the operation is still running", async () => {
  const c = await createTestControl();
  try {
    const { mutation, target } = await claimed(c);
    expect(await claimR2Bucket(context(c.core), target)).toEqual({
      status: "claimed",
      mode: "create",
    });
    await expect(
      c.core
        .prepare("DELETE FROM product_provider_mutation_claims WHERE operation_id=?")
        .bind(mutation.operationId)
        .run(),
    ).rejects.toThrow();
    expect(await claimRows(c, mutation.claimId)).toBe(1);
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 1 });
  } finally {
    await c.dispose();
  }
});

it("completes the failure path once a spent reservation's bucket is proven absent after the spend, and keeps the claim while the spend is unproven", async () => {
  const c = await createTestControl();
  try {
    const { mutation, target } = await claimed(c);
    const ctx = context(c.core);
    expect(await claimR2Bucket(ctx, target)).toEqual({ status: "claimed", mode: "create" });
    expect(await authorizeR2Bucket(ctx, mutation)).toBe(true);
    // the create may have produced the bucket: without absence after the spend, the failure path must not release it
    await expect(failOperationPath(c, mutation.operationId)).rejects.toThrow();
    expect(await claimRows(c, mutation.claimId)).toBe(1);
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 1 });
    await proveR2BucketAbsence(ctx, {
      ...mutation,
      bucketName: target.bucketName,
      observedAt: new Date().toISOString(),
    });
    await failOperationPath(c, mutation.operationId);
    expect(await claimRows(c, mutation.claimId)).toBe(0);
    expect(
      await c.core.prepare("SELECT count(*) AS n FROM project_r2_bucket_reservations").first(),
    ).toEqual({ n: 0 });
  } finally {
    await c.dispose();
  }
});

it("does not answer a supersede of a claim that became a receipt with the superseded outcome", async () => {
  const c = await createTestControl();
  try {
    const { scope, mutation, target, receipt } = await claimed(c);
    const ctx = context(c.core);
    const observed = {
      ...mutation,
      bucketName: target.bucketName,
      observedAt: "2026-10-28T11:00:00.000Z",
    };
    expect(await claimR2Bucket(ctx, target)).toEqual({ status: "claimed", mode: "create" });
    expect(await proveR2BucketAbsence(ctx, observed)).toBe("proven");
    expect(await authorizeR2Bucket(ctx, mutation)).toBe(true);
    // a late create produced the bucket: the receipt replaces the reservation, so no supersede may report a release
    expect(await putR2Bucket(ctx, receipt)).toBe("created");
    await endOperation(c, mutation.operationId);
    await expect(supersedeR2BucketReservation(ctx, observed)).rejects.toThrow(
      "conflicts with durable state",
    );
    expect((await readR2Bucket(ctx, scope))?.bucketId).toBe(receipt.bucketId);
  } finally {
    await c.dispose();
  }
});

/** The bucket receipt, one stored object created on 2026-10-29 and the dev data assignment of the bucket's project. */
async function bucketWithObject(control: TestControl, project: SeededProject, size: number) {
  const dataEnvironmentId = newUlid();
  const transferId = newUlid();
  const physicalKey = `d/${dataEnvironmentId}/object.bin`;
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?,?,?,?)",
      )
      .bind(project.organizationId, project.projectId, dataEnvironmentId, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at) VALUES(?,?,1,?,?,?)",
      )
      .bind(
        project.organizationId,
        project.devEnvironmentId,
        project.projectId,
        dataEnvironmentId,
        STORED_NOW,
      ),
    control.core
      .prepare(
        "INSERT INTO project_r2_upload_reservations(transfer_id,organization_id,project_id,environment_id,idempotency_key,request_sha256,object_key,content_type,expected_bytes,requested_at,expires_at,data_environment_id,physical_object_key,logical_namespace_version) VALUES(?,?,?,?,'k',zeroblob(32),'object.bin','application/octet-stream',?,'2026-10-29T05:59:00.000000Z','2026-10-29T06:01:00.000000Z',?,?,2)",
      )
      .bind(
        transferId,
        project.organizationId,
        project.projectId,
        project.devEnvironmentId,
        size,
        dataEnvironmentId,
        physicalKey,
      ),
    control.core
      .prepare(
        "INSERT INTO project_r2_objects(organization_id,project_id,environment_id,transfer_id,object_key,content_type,size,etag,uploaded_at,created_at,data_environment_id,physical_object_key) VALUES(?,?,?,?,'object.bin','application/octet-stream',?,?,'2026-10-29T06:00:00.000000Z','2026-10-29T06:00:00.000000Z',?,?)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        project.devEnvironmentId,
        transferId,
        size,
        "a".repeat(32),
        dataEnvironmentId,
        physicalKey,
      ),
  ]);
}

it("reads the confirmed storage peak of a complete day from the stored object lifetimes", async () => {
  const c = await createTestControl();
  try {
    const { project, mutation, target, receipt } = await claimed(c);
    const ctx = context(c.core);
    await claimR2Bucket(ctx, target);
    await authorizeR2Bucket(ctx, mutation);
    await putR2Bucket(ctx, receipt);
    await bucketWithObject(c, project, 1000);
    const confirmed = {
      bucketName: target.bucketName,
      jurisdiction: "eu" as const,
      deadline: DEADLINE,
    };
    expect(
      await readR2Confirmed(ctx, {
        ...confirmed,
        from: "2026-10-29T00:00:00.000Z",
        to: "2026-10-30T00:00:00.000Z",
      }),
    ).toEqual([
      {
        meter: "r2.storage.standard",
        unit: "byte_peak_day",
        from: "2026-10-29T00:00:00.000Z",
        to: "2026-10-30T00:00:00.000Z",
        quantity: "1000",
        exact: true,
      },
    ]);
    await expect(
      readR2Confirmed(ctx, {
        ...confirmed,
        from: "2026-10-29T01:00:00.000Z",
        to: "2026-10-30T00:00:00.000Z",
      }),
    ).rejects.toThrow("Invalid R2 storage window");
  } finally {
    await c.dispose();
  }
}, 30_000);
