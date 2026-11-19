import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MailDeliveryRuntime, MailWarningRuntime } from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { ensureAccount } from "../../control-store/src/catalog/credit/index.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import { seedReadyMailDomain } from "../../control-store/test/support/mail-domain.js";
import { seam } from "../../control-store/test/support/wire.js";
import { createD1WarningPersistence } from "../src/d1-warning-persistence.js";
import { createD1ReceivingAdmissionPersistence } from "../src/receiving-admission-persistence.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 60_000);
afterAll(async () => control.dispose());

const NOW = "2026-10-29T10:00:00.000Z";
const warningRuntime = (bindings: object = control.bindings) =>
  new MailWarningRuntime({} as never, bindings as never);

it("runs the credit-warning period cycle through the actual Core: lease, retry, finish, lost response and corrupt replies", async () => {
  const project = await seedProject(control),
    organizationId = project.organizationId,
    exhaustedAt = "2026-10-28T10:00:00.000Z";
  await control.core
    .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
    .bind(organizationId, STORED_NOW)
    .run();
  await control.core.batch(ensureAccount(control.core, { organizationId, now: NOW }).statements);
  await control.core
    .prepare(
      "UPDATE credit_account SET monthly_micros=0,monthly_ends_at='2026-11-01T00:00:00.000000Z',exhausted_at='2026-10-28T10:00:00.000000Z' WHERE organization_id=?",
    )
    .bind(organizationId)
    .run();
  const wire = seam(warningRuntime()),
    port = await createD1WarningPersistence(wire.binding);
  const account = () =>
    control.core
      .prepare(
        "SELECT warned_for_exhausted_at w,warning_next_attempt_at n FROM credit_account WHERE organization_id=?",
      )
      .bind(organizationId)
      .first<{ w: string | null; n: string | null }>();

  const [period] = await port.claimPeriods(() => NOW);
  expect(period).toMatchObject({ organizationId, exhaustedAt });
  expect(await port.claimPeriods(() => NOW)).toEqual([]);
  // A warning nobody accepted is offered again after the five minute interval.
  expect(
    await port.finishPeriod(() => ({
      ...(period as NonNullable<typeof period>),
      now: NOW,
      delivered: false,
    })),
  ).toBe(true);
  expect(await port.claimPeriods(() => "2026-10-29T10:02:00.000Z")).toEqual([]);
  const [retry] = await port.claimPeriods(() => "2026-10-29T10:06:00.000Z");
  expect(retry).toMatchObject({ organizationId, exhaustedAt });
  expect(
    await port.finishPeriod(() => ({
      ...(retry as NonNullable<typeof retry>),
      now: "2026-10-29T10:06:00.000Z",
      delivered: true,
    })),
  ).toBe(true);
  expect(await account()).toEqual({ w: "2026-10-28T10:00:00.000000Z", n: null });
  // A lease that is no longer ours changes nothing.
  expect(
    await port.finishPeriod(() => ({
      ...(retry as NonNullable<typeof retry>),
      now: NOW,
      delivered: false,
    })),
  ).toBe(false);

  // A committed write whose answer is lost is reported as unknown, never replayed.
  let lose = false;
  const lossyCore = {
    prepare: (sql: string) => control.core.prepare(sql),
    batch: async (statements: Parameters<typeof control.core.batch>[0]) => {
      const result = await control.core.batch(statements);
      if (lose && result.some((item) => Number(item.meta?.changes ?? 0) > 0)) {
        lose = false;
        throw new Error("Network connection lost");
      }
      return result;
    },
  };
  const lossy = await createD1WarningPersistence(warningRuntime({ CONTROL_CORE: lossyCore }));
  await control.core
    .prepare("UPDATE credit_account SET warned_for_exhausted_at=NULL WHERE organization_id=?")
    .bind(organizationId)
    .run();
  lose = true;
  await expect(lossy.claimPeriods(() => "2026-10-29T12:00:00.000Z")).rejects.toMatchObject({
    code: "store_outcome_unknown",
  });
  // A refusal outside the closed set never leaks its text.
  wire.refuse("claimPeriods", "SQLITE_ERROR: private detail");
  await expect(port.claimPeriods(() => NOW)).rejects.toThrow("mail_warning_core_unavailable");
  wire.restore();

  // Corrupt answers are refused: a foreign probe at construction, a malformed list afterwards.
  const foreign = seam(warningRuntime());
  foreign.reply("finishPeriod", true);
  await expect(createD1WarningPersistence(foreign.binding)).rejects.toThrow(
    "mail_warning_core_response_invalid",
  );
  wire.reply("claimPeriods", [{ organizationId: "x" }]);
  await expect(port.claimPeriods(() => NOW)).rejects.toThrow("mail_warning_core_response_invalid");
  await expect(createD1WarningPersistence({})).rejects.toThrow(
    "mail_warning_core_binding_required",
  );
});

it("reads the receiving cohort and applies the original admission and domain phases through the actual Core", async () => {
  const project = await seedProject(control),
    domain = await seedReadyMailDomain(control, project),
    wire = seam(new MailDeliveryRuntime({} as never, control.bindings as never)),
    port = await createD1ReceivingAdmissionPersistence(wire.binding);

  expect(await port.list()).toContainEqual(
    expect.objectContaining({
      domain_id: domain.domainId,
      organization_id: project.organizationId,
      receiving_status: "ready",
      receiving_suspended: false,
      sending: true,
    }),
  );
  expect(await port.admit(() => ({ ...domain.scope, grantId: newUlid(), now: NOW }))).toEqual({
    allowed: true,
    paidAllowed: false,
  });

  const state = async () =>
    control.core
      .prepare(
        "SELECT receiving_suspended s,receiving_status r,last_entitlement_check_at c FROM resend_mail_domains WHERE domain_id=?",
      )
      .bind(domain.domainId)
      .first<{ s: number; r: string; c: string | null }>();
  await port.change({ domainId: domain.domainId, phase: "suspend" });
  expect((await state())?.s).toBe(1);
  await port.change({ domainId: domain.domainId, phase: "resume" });
  expect((await state())?.s).toBe(0);
  await port.change({ domainId: domain.domainId, phase: "observed", now: NOW, ready: false });
  expect((await state())?.r).toBe("pending");
  await port.change({ domainId: domain.domainId, phase: "checked", now: NOW });
  expect((await state())?.c).toBe("2026-10-29T10:00:00.000000Z");
  await port.change({ domainId: domain.domainId, phase: "disable" });
  expect((await state())?.r).toBe("disabled");

  wire.refuse("changeAdmission", "mail.changeReceivingAdmission: store_outcome_unknown");
  await expect(port.change({ domainId: domain.domainId, phase: "resume" })).rejects.toMatchObject({
    code: "store_outcome_unknown",
  });
  wire.refuse("readAdmission", "SQLITE_ERROR: private detail");
  await expect(
    port.admit(() => ({ ...domain.scope, grantId: newUlid(), now: NOW })),
  ).rejects.toThrow("mail_receiving_admission_unavailable");
  wire.reply("listAdmission", [{ domain_id: "not a row" }]);
  await expect(port.list()).rejects.toThrow("mail_receiving_admission_response_invalid");
  await expect(createD1ReceivingAdmissionPersistence({})).rejects.toThrow(
    "mail_receiving_admission_binding_required",
  );
});
