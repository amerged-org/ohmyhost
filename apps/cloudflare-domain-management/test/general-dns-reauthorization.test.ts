import { describe, expect, it, vi } from "vitest";

import { createD1CustomerDomainDnsAccess } from "../src/d1-general-dns.js";

describe("general project DNS access", () => {
  it("answers reauthorization_required, and opens no token, when Core withholds a grant whose owner lost write authority", async () => {
    const binding = {
      readGrant: vi.fn(async () => ({
        status: "reauthorization_required",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        principalId: "user:user_consent",
        zoneName: "example.test",
      })),
      claimGrantUse: vi.fn(),
      renewGrantUse: vi.fn(),
      releaseGrantUse: vi.fn(),
      finishGrantUse: vi.fn(),
    };
    const tokenCipher = { open: vi.fn(), seal: vi.fn() };
    const access = createD1CustomerDomainDnsAccess({
      binding,
      clock: { now: () => new Date("2026-09-04T20:00:00.000Z") },
      ids: { next: () => "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
      tokenCipher: tokenCipher as never,
      providerForUse: () => ({}) as never,
    });

    await expect(
      access.loadAccess({
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never,
        hostname: "app.example.test",
      }),
    ).resolves.toEqual({ status: "reauthorization_required" });
    expect(binding.claimGrantUse).not.toHaveBeenCalled();
    expect(tokenCipher.open).not.toHaveBeenCalled();
  });
});
