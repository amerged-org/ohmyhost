import { describe, expect, it, vi } from "vitest";

import { createD1MailManagementJobPersistence } from "../src/d1-job-persistence.js";
import {
  expireUnverifiedWorkspaceMailDomains,
  UNVERIFIED_WORKSPACE_MAIL_TTL_MS,
} from "../src/workspace-mail-expiry.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const DOMAIN_A = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const DOMAIN_B = "01ARZ3NDEKTSV4RRFFQ69G5FAC";

describe("unverified workspace mail reservations", () => {
  it("expires reservations older than seven days through the provider retirement and keeps the rest", async () => {
    expect(UNVERIFIED_WORKSPACE_MAIL_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const listExpiredUnverifiedWorkspaces = vi.fn(async () => [
      { organizationId: ORG, domainId: DOMAIN_A, expectedRevision: 1 },
      { organizationId: ORG, domainId: DOMAIN_B, expectedRevision: 2 },
    ]);
    const retire = vi.fn(async (scope: { domainId: string }) => {
      if (scope.domainId === DOMAIN_B) throw new Error("mail_retirement_unverified");
      return { status: "retired" };
    });
    const result = await expireUnverifiedWorkspaceMailDomains({
      persistence: { listExpiredUnverifiedWorkspaces },
      now: () => NOW,
      retire,
    });
    expect(listExpiredUnverifiedWorkspaces).toHaveBeenCalledWith("2026-11-06T12:00:00.000Z", 20);
    expect(retire).toHaveBeenCalledWith({
      organizationId: ORG,
      domainId: DOMAIN_A,
      expectedRevision: 1,
    });
    // A failed retirement stays due: the next tick lists it again.
    expect(result).toEqual({ attempted: 2, retired: 1, failed: 1 });
  });

  it("reads the expired reservations through the job binding with their exact cutoff and limit", async () => {
    const seen: unknown[] = [];
    const binding = Object.fromEntries(
      [
        "listPendingLegacy",
        "claimLegacy",
        "claimDueIdentity",
        "suspendExpiredBindings",
        "listPendingWorkspaces",
        "claimWorkspace",
      ].map((name) => [name, async () => (name === "listPendingLegacy" ? [] : null)]),
    ) as Record<string, unknown>;
    binding["listExpiredUnverifiedWorkspaces"] = async (input: unknown) => {
      seen.push(input);
      return [{ organizationId: ORG, domainId: DOMAIN_A, expectedRevision: 3 }];
    };
    const persistence = await createD1MailManagementJobPersistence(binding);
    await expect(
      persistence.listExpiredUnverifiedWorkspaces("2026-11-06T12:00:00.000Z", 20),
    ).resolves.toEqual([{ organizationId: ORG, domainId: DOMAIN_A, expectedRevision: 3 }]);
    expect(seen).toEqual([{ cutoff: "2026-11-06T12:00:00.000Z", limit: 20 }]);
  });
});
