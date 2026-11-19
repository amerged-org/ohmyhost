import { describe, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { BUILD_METER, BUILD_PRICE_VERSION } from "@ohmyhost/platform/shared";

import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createCreditCommands,
  runChargeOrg,
  runReserve,
  runSettleReservation,
  type BindCreditCommand,
} from "../../control-store/src/catalog/credit/index.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProject, ulidOf } from "../../control-store/test/support/platform-fixtures.js";
import { readUsage as readCreditLog } from "../../credit-service/src/report.js";
import type { CreditCore, Dependencies } from "../../credit-service/src/port.js";
import { createD1CreditManagement, groupUsageDays } from "../src/d1-credits.js";

const NOW = "2026-10-29T10:30:00.000Z";
const CARD = "usage-2026-10-v1";
const line = (
  projectId: string,
  environmentId: string,
  meter: string,
  quantity: string,
  charge: number,
) => ({
  projectId,
  environmentId,
  meter,
  quantity,
  unit: meter === "wfp.cpu" ? "ms" : "request",
  rateCardId: CARD,
  chargeMicros: charge,
});

it("serves the public credit port from the Core: reads at one instant, one idempotent budget write and strict responses", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      project = await seedProject(control),
      organizationId = project.organizationId,
      at = (iso: string) => ({ now: () => new Date(iso) }),
      ids = { next: () => parseUlid(newUlid()) },
      port = (iso: string, runtime: object = store.publicCredits) =>
        createD1CreditManagement({ runtime: runtime as never, clock: at(iso), ids }),
      context = {
        organizationId: parseUlid(organizationId),
        projectId: parseUlid(project.projectId),
        principalId: "user:fixture",
        requestId: "req_credits",
      };

    const reading = port("2026-10-29T10:00:00.000Z");
    expect(await reading.readAccount(organizationId)).toMatchObject({
      organization_id: organizationId,
      plan: "free",
      available_micros: "200000000",
      as_of: "2026-10-29T10:00:00.000Z",
    });
    const organization = await reading.readOrganization(organizationId);
    expect(organization).toMatchObject({
      organization_id: organizationId,
      unit: "microcredits",
      as_of: "2026-10-29T10:00:00.000Z",
    });
    expect(Object.keys(organization).sort()).toEqual([
      "as_of",
      "available_micros",
      "grace_expires_at",
      "grace_started_at",
      "organization_id",
      "reserved_micros",
      "unit",
    ]);

    // The budget is absent until set; setting it is idempotent by key and digest, and a replay keeps its original instant.
    expect(await reading.readBudget(context)).toMatchObject({
      status: 200,
      body: { project_id: project.projectId, amount_micros: null, mode: "continue" },
    });
    const set = {
      ...context,
      principalId: "user:fixture",
      requestId: "req_budget",
      idempotencyKey: "budget-1",
      canonicalRequestDigest: new Uint8Array(32).fill(5),
      amountMicros: "5000000",
      mode: "stop" as const,
    };
    const first = await port("2026-10-29T10:01:00.000Z").setBudget(set);
    expect(first?.body).toMatchObject({
      amount_micros: "5000000",
      mode: "stop",
      as_of: "2026-10-29T10:01:00.000Z",
    });
    expect(await port("2026-10-29T10:02:00.000Z").setBudget(set)).toEqual(first);
    expect((await reading.readBudget(context)).body).toMatchObject({
      amount_micros: "5000000",
      mode: "stop",
    });
    // The Core's refusal arrives over the service binding as a plain error; the port makes it the key conflict the API answers.
    await expect(
      port("2026-10-29T10:03:00.000Z").setBudget({
        ...set,
        canonicalRequestDigest: new Uint8Array(32).fill(6),
      }),
    ).rejects.toMatchObject({ name: "OrganizationCreditError", code: "credit_request_conflict" });
    await expect(
      port("2026-10-29T10:03:00.000Z", {
        ...store.publicCredits,
        configureProjectCreditBudget: async () => {
          throw new Error("store_busy");
        },
      }).setBudget(set),
    ).rejects.toThrow("store_busy");

    // The port refuses a Core that lacks a capability, and a response that answers for another organization.
    expect(() => port("2026-10-29T10:00:00.000Z", {})).toThrow("credit_core_binding_required");
    const foreign = port("2026-10-29T10:00:00.000Z", {
      ...store.publicCredits,
      readCreditAccount: async (input: unknown) => ({
        ...((await store.publicCredits.readCreditAccount(input)) as object),
        organization_id: newUlid(),
      }),
    });
    await expect(foreign.readAccount(organizationId)).rejects.toThrow(
      "credit_core_response_invalid",
    );
  } finally {
    await control.dispose();
  }
}, 60_000);

it("answers a budget write on a project that is leaving as no project, not as a store failure", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      project = await seedProject(control),
      port = createD1CreditManagement({
        runtime: store.publicCredits as never,
        clock: { now: () => new Date("2026-10-29T10:01:00.000Z") },
        ids: { next: () => parseUlid(newUlid()) },
      });
    for (const state of ["deleting", "deleted"] as const) {
      await control.core
        .prepare(
          "UPDATE projects SET lifecycle_state=?3 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(project.organizationId, project.projectId, state)
        .run();
      expect(
        await port.setBudget({
          organizationId: parseUlid(project.organizationId),
          projectId: parseUlid(project.projectId),
          principalId: "user:fixture",
          requestId: "req_budget_leaving",
          idempotencyKey: `budget-${state}`,
          canonicalRequestDigest: new Uint8Array(32).fill(8),
          amountMicros: "5000000",
          mode: "stop",
        }),
      ).toBeNull();
    }
  } finally {
    await control.dispose();
  }
}, 60_000);

it("reports the credit log of the last days by day, project and meter next to the month's use, from the real Core and credit service", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control),
      other = ulidOf("report-second-project", 1),
      organizationId = project.organizationId,
      context = { directory: control.core, router: new SharedCoreRouter(control.core) },
      bind: BindCreditCommand = (command) => async (input) => command(context, input),
      clockAt = `${NOW.slice(0, 19)}.000000Z`,
      credit = createCreditCommands(bind, () => clockAt),
      store = createControlStore(control.bindings);

    await credit.postUsage({
      organizationId,
      source: "wfp",
      window: "2026-10-29T09:00:00.000Z",
      lines: [
        line(project.projectId, project.devEnvironmentId, "wfp.requests", "1000", 120),
        line(project.projectId, project.devEnvironmentId, "wfp.cpu", "250.5", 40),
        line(other, project.devEnvironmentId, "wfp.requests", "10", 3),
      ],
    });
    await credit.postUsage({
      organizationId,
      source: "wfp",
      window: "2026-10-29T10:00:00.000Z",
      lines: [line(project.projectId, project.devEnvironmentId, "wfp.requests", "500", 60)],
    });
    // A build settled the same day, charged to the project of its reservation.
    await runReserve(control.core, {
      organizationId,
      reservationId: ulidOf("report-reservation", 1),
      projectId: project.projectId,
      amountMicros: 9_000,
      now: "2026-10-29T10:10:00.000Z",
    });
    await runSettleReservation(control.core, {
      organizationId,
      reservationId: ulidOf("report-reservation", 1),
      chargedMicros: 7_000,
      now: "2026-10-29T10:20:00.000Z",
      detail: {
        operationId: ulidOf("report-reservation", 1),
        meter: BUILD_METER,
        seconds: "120",
        rateCardId: BUILD_PRICE_VERSION,
      },
    });
    // A charge of an earlier day that was rotated away is not in the Core any more: the archive bucket holds nothing here.
    const service = {
      readUsage: (input: unknown) =>
        readCreditLog(
          {
            core: credit as unknown as CreditCore,
            creditLog: { get: async () => null },
            now: () => Date.parse(NOW),
          } as unknown as Dependencies,
          input,
        ),
    };
    const port = (runtime: object = store.publicCredits, binding: object | null = service) =>
      createD1CreditManagement({
        runtime: runtime as never,
        service: (binding ?? undefined) as never,
        clock: { now: () => new Date(NOW) },
        ids: { next: () => parseUlid(newUlid()) },
      });

    const report = await port().readUsage(organizationId);
    expect(report).toEqual({
      organization_id: organizationId,
      as_of: NOW,
      unit: "microcredits",
      period: "2026-10",
      from: "2026-10-16T00:00:00.000Z",
      projects: [
        { project_id: project.projectId, used_micros: "7220" },
        { project_id: other, used_micros: "3" },
      ].sort((a, b) => (a.project_id < b.project_id ? -1 : 1)),
      days: [
        {
          day: "2026-10-29",
          projects: [
            {
              project_id: project.projectId,
              meters: [
                {
                  environment_id: null,
                  meter: BUILD_METER,
                  unit: "second",
                  rate_card_id: BUILD_PRICE_VERSION,
                  quantity: "120",
                  charged_micros: "7000",
                },
                {
                  environment_id: project.devEnvironmentId,
                  meter: "wfp.cpu",
                  unit: "ms",
                  rate_card_id: CARD,
                  quantity: "250.5",
                  charged_micros: "40",
                },
                {
                  environment_id: project.devEnvironmentId,
                  meter: "wfp.requests",
                  unit: "request",
                  rate_card_id: CARD,
                  quantity: "1500",
                  charged_micros: "180",
                },
              ],
            },
            {
              project_id: other,
              meters: [
                {
                  environment_id: project.devEnvironmentId,
                  meter: "wfp.requests",
                  unit: "request",
                  rate_card_id: CARD,
                  quantity: "10",
                  charged_micros: "3",
                },
              ],
            },
          ].sort((a, b) => (a.project_id < b.project_id ? -1 : 1)),
        },
      ],
    });

    // One project's context sees only its own use and lines.
    const own = await port().readUsage(organizationId, project.projectId);
    expect(own.projects).toEqual([{ project_id: project.projectId, used_micros: "7220" }]);
    expect(own.days.flatMap((day) => day.projects.map((row) => row.project_id))).toEqual([
      project.projectId,
    ]);

    // Without the credit service only the usage report is unavailable; a service or Core answering for another organization is refused.
    await expect(port(store.publicCredits, null).readUsage(organizationId)).rejects.toThrow(
      "credit_service_binding_required",
    );
    await expect(
      port(store.publicCredits, { readUsage: async () => ({ not: "rows" }) }).readUsage(
        organizationId,
      ),
    ).rejects.toThrow("credit_core_response_invalid");
    await expect(
      port(store.publicCredits, {
        readUsage: async () => [
          { organizationId: newUlid(), at: NOW, kind: "usage", deltaMicros: 0 },
        ],
      }).readUsage(organizationId),
    ).rejects.toThrow("credit_core_response_invalid");
    await expect(
      port({
        ...store.publicCredits,
        readCreditUsage: async (input: unknown) => ({
          ...((await store.publicCredits.readCreditUsage(input)) as object),
          organization_id: newUlid(),
        }),
      }).readUsage(organizationId),
    ).rejects.toThrow("credit_core_response_invalid");
    await expect(
      port({
        ...store.publicCredits,
        readCreditUsage: async (input: unknown) => ({
          ...((await store.publicCredits.readCreditUsage(input)) as object),
          projects: [{ project_id: other, used_micros: "1" }],
        }),
      }).readUsage(organizationId, project.projectId),
    ).rejects.toThrow("credit_core_response_invalid");

    // The charges are the credit log's: the account balance fell by exactly what the report adds up to.
    const account = await runChargeOrg(control.core, {
      organizationId,
      key: "report-balance-probe",
      amountMicros: 0,
      now: NOW,
    });
    expect(account.balanceMicros).toBe(200_000_000 - 120 - 40 - 3 - 60 - 7_000);
  } finally {
    await control.dispose();
  }
});

describe("grouping the credit log into the usage report", () => {
  const P = ulidOf("group-project", 1),
    Q = ulidOf("group-project", 2),
    E = ulidOf("group-environment", 1);
  const row = (at: string, kind: string, detail: unknown) => ({
    organizationId: ulidOf("group-organization", 1),
    at,
    kind,
    deltaMicros: -1,
    detail,
  });

  it("adds exact decimal quantities and charges per day, project, environment, meter, unit and price", () => {
    const days = groupUsageDays([
      row("2026-10-29T09:00:00.000000Z", "usage", {
        lines: [
          line(P, E, "wfp.cpu", "0.1", 1),
          line(P, E, "wfp.cpu", "0.2", 2),
          line(P, E, "wfp.cpu", "1", 4),
        ],
      }),
      row("2026-10-30T00:00:00.000000Z", "usage", { lines: [line(Q, E, "wfp.cpu", "7", 9)] }),
      row("2026-10-29T23:59:59.999999Z", "usage", {
        lines: [{ ...line(P, E, "wfp.cpu", "2", 5), rateCardId: "usage-2026-11-v1" }],
      }),
    ]);
    expect(days.map((day) => day.day)).toEqual(["2026-10-29", "2026-10-30"]);
    expect(days[0]?.projects[0]?.meters).toEqual([
      {
        environment_id: E,
        meter: "wfp.cpu",
        unit: "ms",
        rate_card_id: "usage-2026-10-v1",
        quantity: "1.3",
        charged_micros: "7",
      },
      {
        environment_id: E,
        meter: "wfp.cpu",
        unit: "ms",
        rate_card_id: "usage-2026-11-v1",
        quantity: "2",
        charged_micros: "5",
      },
    ]);
  });

  it("counts only usage lines and settled builds, never grants, renewals, reservations or an unattributed settlement", () => {
    expect(
      groupUsageDays([
        row("2026-10-29T09:00:00.000000Z", "grant", { grantKey: "topup:x" }),
        row("2026-10-29T09:00:00.000000Z", "renew", { endsAt: "2026-11-01" }),
        row("2026-10-29T09:00:00.000000Z", "reserve", { projectId: P, reservedMicros: 5 }),
        row("2026-10-29T09:00:00.000000Z", "usage", { source: "mail" }),
        row("2026-10-29T09:00:00.000000Z", "usage", null),
        row("2026-10-29T09:00:00.000000Z", "settle", { projectId: null, chargedMicros: 5 }),
      ]),
    ).toEqual([]);
    expect(
      groupUsageDays([
        row("2026-10-29T09:00:00.000000Z", "settle", { projectId: P, chargedMicros: 5 }),
      ]),
    ).toEqual([
      {
        day: "2026-10-29",
        projects: [
          {
            project_id: P,
            meters: [
              {
                environment_id: null,
                meter: BUILD_METER,
                unit: "second",
                rate_card_id: BUILD_PRICE_VERSION,
                quantity: "0",
                charged_micros: "5",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("reports an AI settlement in its own unit and quantity, and a build settlement in seconds", () => {
    const AI_CARD = "ai-card-1390895";
    expect(
      groupUsageDays([
        row("2026-10-29T09:00:00.000000Z", "settle", {
          projectId: P,
          environmentId: E,
          chargedMicros: 501,
          meter: "ai.cost",
          unit: "usd_micro",
          rateCardId: AI_CARD,
          quantity: "3.6",
          seconds: "9",
        }),
        row("2026-10-29T10:00:00.000000Z", "settle", {
          projectId: P,
          chargedMicros: 5,
          seconds: "2.5",
        }),
      ]),
    ).toEqual([
      {
        day: "2026-10-29",
        projects: [
          {
            project_id: P,
            meters: [
              {
                environment_id: null,
                meter: BUILD_METER,
                unit: "second",
                rate_card_id: BUILD_PRICE_VERSION,
                quantity: "2.5",
                charged_micros: "5",
              },
              {
                environment_id: E,
                meter: "ai.cost",
                unit: "usd_micro",
                rate_card_id: AI_CARD,
                quantity: "3.6",
                charged_micros: "501",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps one project and refuses a row or a line that is not a credit-log charge", () => {
    const usage = row("2026-10-29T09:00:00.000000Z", "usage", {
      lines: [line(P, E, "wfp.requests", "1", 1), line(Q, E, "wfp.requests", "2", 2)],
    });
    expect(groupUsageDays([usage], Q)[0]?.projects.map((project) => project.project_id)).toEqual([
      Q,
    ]);
    expect(() => groupUsageDays([{ kind: "usage" }])).toThrow();
    expect(() =>
      groupUsageDays([row("2026-10-29T09:00:00.000000Z", "usage", { lines: [{ projectId: P }] })]),
    ).toThrow();
    expect(() =>
      groupUsageDays([
        row("2026-10-29T09:00:00.000000Z", "usage", {
          lines: [line(P, E, "wfp.requests", "not-a-number", 1)],
        }),
      ]),
    ).toThrow("credit_core_response_invalid");
  });

  it("reports a mail charge posted with its flat detail, and leaves the refund of a send out of the day", () => {
    const mail = {
      source: "mail",
      requestId: ulidOf("group-mail", 1),
      projectId: P,
      environmentId: E,
      meter: "mail.sent",
      quantity: "1",
      unit: "recipient",
      rateCardId: CARD,
      chargeMicros: 180000,
    };
    expect(
      groupUsageDays([
        row("2026-10-29T09:00:00.000000Z", "usage", mail),
        row("2026-10-29T09:05:00.000000Z", "refund", { ...mail, reason: "refused" }),
      ]),
    ).toEqual([
      {
        day: "2026-10-29",
        projects: [
          {
            project_id: P,
            meters: [
              {
                environment_id: E,
                meter: "mail.sent",
                unit: "recipient",
                rate_card_id: CARD,
                quantity: "1",
                charged_micros: "180000",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("skips a stored flat charge it cannot read, logs the skip, and still reports the other charges", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mail = {
      source: "mail",
      requestId: ulidOf("group-mail", 2),
      projectId: P,
      environmentId: E,
      meter: "mail.sent",
      quantity: "1",
      unit: "recipient",
      rateCardId: CARD,
      chargeMicros: 180000,
    };
    try {
      expect(
        groupUsageDays([
          row("2026-10-29T09:00:00.000000Z", "usage", { ...mail, chargeMicros: 1.5 }),
          row("2026-10-29T09:05:00.000000Z", "usage", mail),
        ]),
      ).toEqual([
        {
          day: "2026-10-29",
          projects: [
            {
              project_id: P,
              meters: [
                {
                  environment_id: E,
                  meter: "mail.sent",
                  unit: "recipient",
                  rate_card_id: CARD,
                  quantity: "1",
                  charged_micros: "180000",
                },
              ],
            },
          ],
        },
      ]);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('"event":"credit_usage_row_skipped"'),
      );
    } finally {
      log.mockRestore();
    }
  });
});
