import { describe, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { CHECKOUT_LIFETIME_MS, checkoutIdFor, checkoutIdentity } from "../src/checkout-id.js";

const request = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  actorId: "user:owner",
  idempotencyKey: "key-1",
  offer: "topup" as const,
  packs: 7,
  now: new Date("2026-10-30T10:03:21.456Z"),
};

describe("a checkout id", () => {
  it("is a ULID that says when, what and how much, and is the same for the same request in the same window", async () => {
    const id = await checkoutIdFor(request);
    expect(parseUlid(id)).toBe(id);
    expect(checkoutIdentity(id)).toEqual({
      createdAt: "2026-10-30T10:00:00.000Z",
      expiresAt: "2026-10-30T11:00:00.000Z",
      offer: "topup",
      packs: 7,
    });
    expect(CHECKOUT_LIFETIME_MS).toBe(3_600_000);
    expect(await checkoutIdFor({ ...request, now: new Date("2026-10-30T10:09:59.999Z") })).toBe(id);
    expect(await checkoutIdFor({ ...request, now: new Date("2026-10-30T10:10:00.000Z") })).not.toBe(
      id,
    );
    for (const other of [
      { idempotencyKey: "key-2" },
      { actorId: "user:other" },
      { organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
      { packs: 8 },
      { offer: "paid" as const, packs: 1 },
    ])
      expect(await checkoutIdFor({ ...request, ...other })).not.toBe(id);
    expect(
      checkoutIdentity(await checkoutIdFor({ ...request, offer: "paid", packs: 1 })),
    ).toMatchObject({
      offer: "paid",
      packs: 1,
    });
    expect(checkoutIdentity(await checkoutIdFor({ ...request, packs: 100 }))).toMatchObject({
      packs: 100,
    });
  });

  it("is not accepted for an id that no checkout was given", () => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    /** An id with the given window start and first byte of the body, the rest zero. */
    const forge = (time: number, head: number) => {
      let rest = time;
      let chars = "";
      for (let index = 0; index < 10; index += 1) {
        chars = (alphabet[rest % 32] as string) + chars;
        rest = Math.floor(rest / 32);
      }
      let body = BigInt(head) << 72n;
      let tail = "";
      for (let index = 0; index < 16; index += 1) {
        tail = (alphabet[Number(body & 31n)] as string) + tail;
        body >>= 5n;
      }
      return chars + tail;
    };
    const window = Date.parse("2026-10-30T10:00:00.000Z");
    expect(checkoutIdentity(forge(window, 0x07))).toMatchObject({ offer: "topup", packs: 7 });
    expect(checkoutIdentity(forge(window, 0x81))).toMatchObject({ offer: "paid", packs: 1 });
    expect(checkoutIdentity(forge(window, 0x00))).toBe(null);
    expect(checkoutIdentity(forge(window, 0x65))).toBe(null);
    expect(checkoutIdentity(forge(window, 0x82))).toBe(null);
    expect(checkoutIdentity(forge(window + 1, 0x07))).toBe(null);
    expect(checkoutIdentity("not an id")).toBe(null);
    expect(checkoutIdentity("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(null);
  });
});
