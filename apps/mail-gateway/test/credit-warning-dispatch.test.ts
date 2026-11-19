import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MailWarningRuntime } from "../../control-store/src/worker-main.js";
import { ensureAccount } from "../../control-store/src/catalog/credit/index.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { createD1WarningPersistence } from "../src/d1-warning-persistence.js";
import {
  createCreditWarningDispatcher,
  type CreditWarningPersistence,
  type CreditWarningScope,
} from "../src/credit-warning-dispatch.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

let control: TestControl;
beforeEach(async () => {
  control = await createTestControl();
}, 60_000);
afterEach(async () => control.dispose());

const START = new Date("2026-10-29T12:00:00.000Z");

/** An organization of the beta that exhausted its credit at `exhaustedAt` and whose month runs on. */
async function exhaustedOrganization() {
  const { organizationId } = await seedProject(control);
  await control.core
    .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
    .bind(organizationId, "2026-10-01T00:00:00.000000Z")
    .run();
  await control.core.batch(
    ensureAccount(control.core, { organizationId, now: START.toISOString() }).statements,
  );
  await control.core
    .prepare(
      "UPDATE credit_account SET monthly_micros=0,onetime_micros=0,monthly_ends_at='2026-11-01T00:00:00.000000Z',exhausted_at='2026-10-29T10:00:00.000000Z' WHERE organization_id=?",
    )
    .bind(organizationId)
    .run();
  return organizationId;
}
const warned = async (organizationId: string) =>
  (
    await control.core
      .prepare("SELECT warned_for_exhausted_at w FROM credit_account WHERE organization_id=?")
      .bind(organizationId)
      .first<{ w: string | null }>()
  )?.w ?? null;

type Owner = { userId: string; email: string };
/** Recipients and the provider's answers are scripted per organization; everything else is the real Core. */
function rig(
  persistence?: CreditWarningPersistence,
  options: { response?: unknown; recipients?: (scope: CreditWarningScope) => unknown } = {},
) {
  let now = START;
  const sent: { organizationId: string; userId: string; recipient: string }[] = [],
    owners = new Map<string, Owner[]>(),
    refused = new Set<string>();
  const dispatcher = async () =>
    createCreditWarningDispatcher({
      persistence:
        persistence ??
        (await createD1WarningPersistence(
          new MailWarningRuntime({} as never, control.bindings as never),
        )),
      now: () => now,
      recipients: {
        resolve: async (scope) =>
          options.recipients?.(scope) ?? {
            ...scope,
            required: true,
            recipients: owners.get(scope.organizationId) ?? [],
          },
      },
      sender: {
        send: async (notice) => {
          sent.push({
            organizationId: notice.organizationId,
            userId: notice.userId,
            recipient: notice.recipient,
          });
          if (refused.has(notice.userId)) throw new Error("provider refused");
          return (options.response ?? {
            status: "accepted",
            messageId: `message-${notice.userId}`,
          }) as {
            status: "accepted";
            messageId: string;
          };
        },
      },
    });
  return {
    sent,
    owners,
    refused,
    advance: (milliseconds: number) => (now = new Date(now.getTime() + milliseconds)),
    sync: async () => (await dispatcher()).sync(),
  };
}

it("warns every owner of a leased episode once, isolates a refusal and retries a period nobody accepted", async () => {
  const first = await exhaustedOrganization(),
    second = await exhaustedOrganization(),
    run = rig();
  run.owners.set(first, [{ userId: "user_refused", email: "refused@example.com" }]);
  run.owners.set(second, [{ userId: "user_ok", email: "ok@example.com" }]);
  run.refused.add("user_refused");
  expect(await run.sync()).toEqual({ periods: 2, accepted: 1, unresolved: 1 });
  expect(await warned(second)).toBe("2026-10-29T10:00:00.000000Z");
  expect(await warned(first)).toBeNull();
  // the failed period waits five minutes; the warned one never comes back
  expect(await run.sync()).toEqual({ periods: 0, accepted: 0, unresolved: 0 });
  run.advance(6 * 60_000);
  run.refused.clear();
  expect(await run.sync()).toEqual({ periods: 1, accepted: 1, unresolved: 0 });
  expect(await warned(first)).toBe("2026-10-29T10:00:00.000000Z");
  expect(await run.sync()).toEqual({ periods: 0, accepted: 0, unresolved: 0 });
  expect(run.sent.map((notice) => notice.recipient).sort()).toEqual([
    "ok@example.com",
    "refused@example.com",
    "refused@example.com",
  ]);
});

it("counts a period as warned once one owner accepted it, and when nobody has to be warned", async () => {
  const both = await exhaustedOrganization(),
    nobody = await exhaustedOrganization(),
    run = rig(undefined, {
      recipients: (scope) => ({
        ...scope,
        required: scope.organizationId === both,
        recipients:
          scope.organizationId === both
            ? [
                { userId: "user_a", email: "a@example.com" },
                { userId: "user_b", email: "b@example.com" },
              ]
            : [],
      }),
    });
  run.refused.add("user_a");
  expect(await run.sync()).toEqual({ periods: 2, accepted: 1, unresolved: 0 });
  expect(run.sent.map((notice) => notice.userId).sort()).toEqual(["user_a", "user_b"]);
  expect(await warned(both)).toBe("2026-10-29T10:00:00.000000Z");
  expect(await warned(nobody)).toBe("2026-10-29T10:00:00.000000Z");
});

it("leaves a period for the next try when the recipients are unusable or the provider answer is invalid", async () => {
  const organizationId = await exhaustedOrganization();
  for (const [recipients, response] of [
    [() => "not a recipient list", undefined],
    [
      (scope: CreditWarningScope) => ({
        ...scope,
        required: true,
        recipients: [{ userId: "user_owner", email: "owner@example.com" }],
      }),
      { status: "accepted", messageId: "not a valid id" },
    ],
  ] as const) {
    const run = rig(undefined, { recipients, response });
    expect(await run.sync()).toEqual({ periods: 1, accepted: 0, unresolved: 1 });
    expect(await warned(organizationId)).toBeNull();
    // five minutes later the next run claims it again
    await control.core
      .prepare("UPDATE credit_account SET warning_next_attempt_at=NULL WHERE organization_id=?")
      .bind(organizationId)
      .run();
  }
});

it("reports a period whose outcome the Core could not record as unresolved", async () => {
  const organizationId = await exhaustedOrganization();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const real = await createD1WarningPersistence(
    new MailWarningRuntime({} as never, control.bindings as never),
  );
  const run = rig({
    claimPeriods: real.claimPeriods,
    finishPeriod: async () => {
      throw new Error("core unavailable");
    },
  });
  run.owners.set(organizationId, [{ userId: "user_ok", email: "ok@example.com" }]);
  expect(await run.sync()).toEqual({ periods: 1, accepted: 1, unresolved: 1 });
  expect(error).toHaveBeenCalledWith("credit_warning_progress_unavailable", expect.anything());
  error.mockRestore();
});
