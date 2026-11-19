import { describe, expect, it, vi } from "vitest";
import {
  FeedbackPersistenceError,
  PoweredByFlagIdempotencyConflictError,
  PoweredByFlagRequiredError,
  ProjectNotesConflict,
} from "@ohmyhost/database";
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import { createD1FeedbackPersistence } from "../src/d1-feedback.js";
import {
  createD1ProjectMetadataPorts,
  isD1ProjectMetadataRuntime,
} from "../src/d1-project-metadata.js";
import { readD1RuntimeCreditDecision } from "../src/d1-runtime-credit.js";

const ORGANIZATION = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const FEEDBACK = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const NOW = "2026-10-29T10:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const ids = { next: (): Ulid => ENVIRONMENT };

describe("D1 gateway credit decision", () => {
  const scope = { organizationId: ORGANIZATION, projectId: PROJECT, environmentId: ENVIRONMENT };
  const decision = (override: Record<string, unknown> = {}) => ({
    ...scope,
    allowed: true,
    paidAllowed: true,
    reason: null,
    checkedAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + 900_000).toISOString(),
    ...override,
  });
  const read = (reply: unknown) =>
    readD1RuntimeCreditDecision(
      { GATEWAY_CREDIT_RUNTIME: { read: async () => reply } },
      scope,
      NOW,
    );

  it("returns the validated decision and asks the Core with the exact scope and instant", async () => {
    const runtime = { read: vi.fn(async () => decision()) };
    await expect(
      readD1RuntimeCreditDecision({ GATEWAY_CREDIT_RUNTIME: runtime }, scope, NOW),
    ).resolves.toEqual(decision());
    expect(runtime.read).toHaveBeenCalledWith({ ...scope, now: NOW });
    await expect(
      read(decision({ allowed: false, paidAllowed: false, reason: "project_budget_exceeded" })),
    ).resolves.toMatchObject({ allowed: false, reason: "project_budget_exceeded" });
  });

  it("refuses a missing binding and every reply that does not match the request", async () => {
    await expect(readD1RuntimeCreditDecision({}, scope, NOW)).rejects.toThrow(
      "gateway_credit_binding_required",
    );
    for (const reply of [
      decision({ projectId: ORGANIZATION }),
      decision({ checkedAt: "2026-10-29T10:00:01.000Z" }),
      decision({ expiresAt: NOW }),
      decision({ allowed: false }),
      decision({ allowed: false, reason: "insufficient_organization_credits" }),
      { ...decision(), extra: true },
    ])
      await expect(read(reply)).rejects.toThrow();
  });
});

describe("D1 customer feedback persistence", () => {
  const report = {
    organization_id: ORGANIZATION,
    project_id: null,
    environment_id: null,
    operation_id: null,
  };
  const request = {
    report,
    actorId: "user:user_feedback",
    idempotencyKey: "feedback-key",
    requestSha256: new Uint8Array(32).fill(0xab),
  } as never;
  const build = (overrides: Record<string, unknown>) =>
    createD1FeedbackPersistence({
      runtime: {
        submitCustomerFeedback: async () => ({ outcome: "resource_not_found" }),
        readCustomerFeedbackStatus: async () => null,
        ...overrides,
      },
      clock,
      ids,
    });

  it("refuses an incomplete binding", () => {
    expect(() => createD1FeedbackPersistence({ runtime: {} as never, clock, ids })).toThrow(
      "feedback_binding_required",
    );
  });

  it("sends the hex request digest with the local id and instant and returns the stored receipt", async () => {
    const submitCustomerFeedback = vi.fn(async () => ({
      outcome: "stored",
      receipt: { id: FEEDBACK, organization_id: ORGANIZATION, submitted_at: NOW },
    }));
    const persistence = build({ submitCustomerFeedback });
    await expect(persistence.submitFeedback(request)).resolves.toEqual({
      id: FEEDBACK,
      organization_id: ORGANIZATION,
      submitted_at: NOW,
    });
    expect(submitCustomerFeedback).toHaveBeenCalledWith({
      report,
      actorId: "user:user_feedback",
      idempotencyKey: "feedback-key",
      requestSha256: "ab".repeat(32),
      feedbackId: ENVIRONMENT,
      submittedAt: NOW,
    });
  });

  it("maps refused outcomes to the persistence error and refuses a receipt of another organization", async () => {
    for (const outcome of ["resource_not_found", "idempotency_key_reused"] as const)
      await expect(
        build({ submitCustomerFeedback: async () => ({ outcome }) }).submitFeedback(request),
      ).rejects.toThrow(FeedbackPersistenceError);
    await expect(
      build({
        submitCustomerFeedback: async () => ({
          outcome: "stored",
          receipt: { id: FEEDBACK, organization_id: PROJECT, submitted_at: NOW },
        }),
      }).submitFeedback(request),
    ).rejects.toThrow("feedback_response_scope_invalid");
  });

  it("reads a status inside the caller's organizations and refuses a foreign or mismatched one", async () => {
    const status = (override: Record<string, unknown> = {}) => ({
      id: FEEDBACK,
      organization_id: ORGANIZATION,
      status: "received",
      submitted_at: NOW,
      updated_at: NOW,
      history: [],
      next_cursor: null,
      ...override,
    });
    const record = (value: unknown, organizationId: string = ORGANIZATION) => ({
      organizationId,
      projectId: null,
      environmentId: null,
      status: value,
    });
    const read = (reply: unknown) =>
      build({ readCustomerFeedbackStatus: async () => reply }).readFeedbackStatus({
        feedbackId: FEEDBACK,
        organizationIds: [ORGANIZATION],
      } as never);
    await expect(read(null)).resolves.toBeNull();
    await expect(read(record(null))).resolves.toMatchObject({ status: null });
    await expect(read(record(status()))).resolves.toMatchObject({
      status: { id: FEEDBACK, status: "received" },
    });
    await expect(read(record(status({ id: ORGANIZATION })))).rejects.toThrow(
      "feedback_response_scope_invalid",
    );
    await expect(read(record(status(), PROJECT))).rejects.toThrow(
      "feedback_response_scope_invalid",
    );
  });
});

describe("D1 project notes and Powered-by flag", () => {
  const context = {
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    principalId: "user:user_metadata",
    requestId: "req_metadata",
    idempotencyKey: "metadata-key",
    canonicalRequestDigest: new Uint8Array(32).fill(0x0f),
  } as never;
  const runtime = (overrides: Record<string, unknown> = {}) => ({
    readProjectNotes: vi.fn(async () => ({ version: 1, markdown: "# Notes", updatedAt: NOW })),
    writeProjectNotes: vi.fn(async () => ({ version: 2, updatedAt: NOW })),
    readProjectStorageJurisdiction: vi.fn(async () => "eu" as const),
    readPoweredByFlag: vi.fn(async () => null),
    setPoweredByFlag: vi.fn(async () => null),
    ...overrides,
  });
  const ports = (overrides: Record<string, unknown> = {}) => {
    const core = runtime(overrides);
    return { core, ...createD1ProjectMetadataPorts({ runtime: core as never, clock, ids }) };
  };

  it("recognises a complete runtime only", () => {
    expect(isD1ProjectMetadataRuntime(runtime())).toBe(true);
    expect(isD1ProjectMetadataRuntime({ readProjectNotes() {} })).toBe(false);
    expect(isD1ProjectMetadataRuntime(null)).toBe(false);
  });

  it("forwards exactly the scoped reads and the typed writes with the local instant and ids", async () => {
    const { core, projectNotes, poweredByFlag } = ports();
    const scope = { organizationId: ORGANIZATION, projectId: PROJECT };
    await expect(projectNotes.get(context)).resolves.toMatchObject({ version: 1 });
    await expect(projectNotes.storageJurisdiction(context)).resolves.toBe("eu");
    await expect(poweredByFlag.get(context)).resolves.toBeNull();
    expect(core.readProjectNotes).toHaveBeenCalledWith(scope);
    expect(core.readProjectStorageJurisdiction).toHaveBeenCalledWith(scope);
    expect(core.readPoweredByFlag).toHaveBeenCalledWith(scope);

    await projectNotes.set({
      ...(context as object),
      expectedVersion: 1,
      markdown: "# New",
    } as never);
    expect(core.writeProjectNotes).toHaveBeenCalledWith({
      ...scope,
      principalId: "user:user_metadata",
      idempotencyKey: "metadata-key",
      canonicalRequestDigest: "0f".repeat(32),
      expectedVersion: 1,
      markdown: "# New",
      now: NOW,
      eventId: ENVIRONMENT,
    });
    await poweredByFlag.set({ ...(context as object), enabled: true } as never);
    expect(core.setPoweredByFlag).toHaveBeenCalledWith({
      ...scope,
      principalId: "user:user_metadata",
      idempotencyKey: "metadata-key",
      canonicalRequestDigest: "0f".repeat(32),
      enabled: true,
      now: NOW,
      periodId: ENVIRONMENT,
      eventId: ENVIRONMENT,
    });
  });

  it("maps the Core's coded refusals to the product errors and rethrows anything else", async () => {
    const reject = (code: string) => async () => {
      throw Object.assign(new Error("core refused"), { code });
    };
    const note = { ...(context as object), expectedVersion: 1, markdown: "x" } as never;
    for (const kind of ["scope", "version", "idempotency"])
      await expect(
        ports({ writeProjectNotes: reject(`project_notes_${kind}`) }).projectNotes.set(note),
      ).rejects.toThrow(ProjectNotesConflict);
    await expect(
      ports({
        writeProjectNotes: async () => {
          throw new Error("project_notes_version");
        },
      }).projectNotes.set(note),
    ).rejects.toThrow(ProjectNotesConflict);
    const flag = { ...(context as object), enabled: false } as never;
    await expect(
      ports({ setPoweredByFlag: reject("powered_by_flag_required") }).poweredByFlag.set(flag),
    ).rejects.toThrow(PoweredByFlagRequiredError);
    await expect(
      ports({ setPoweredByFlag: reject("powered_by_flag_idempotency") }).poweredByFlag.set(flag),
    ).rejects.toThrow(PoweredByFlagIdempotencyConflictError);
    await expect(
      ports({ setPoweredByFlag: reject("something_else") }).poweredByFlag.set(flag),
    ).rejects.toThrow("core refused");
  });
});
