import { describe, expect, it } from "vitest";

import { isCronDue, normalizeCrons } from "../src/functions.js";

describe("function cron schedules", () => {
  it("sorts and freezes valid crons and rejects duplicates, empty or oversized sets", () => {
    const crons = normalizeCrons(["15 * * * *", "*/5 * * * *"]);
    expect(crons).toEqual(["*/5 * * * *", "15 * * * *"]);
    expect(Object.isFrozen(crons)).toBe(true);
    expect(() => normalizeCrons([])).toThrow("one to eight schedules");
    expect(() => normalizeCrons(["0 * * * *", "0 * * * *"])).toThrow("must be unique");
    expect(() => normalizeCrons(Array.from({ length: 9 }, (_, i) => `${i} * * * *`))).toThrow();
    expect(() => normalizeCrons(["*/4 * * * *"])).toThrow("cron is invalid");
    expect(() => normalizeCrons([5])).toThrow("cron is invalid");
  });

  it("evaluates due minutes in UTC for steps, fixed fields and wildcards", () => {
    const at = new Date("2026-09-15T03:15:00.000Z"); // Tuesday
    expect(isCronDue("*/5 * * * *", at)).toBe(true);
    expect(isCronDue("*/10 * * * *", at)).toBe(false);
    expect(isCronDue("15 3 * * *", at)).toBe(true);
    expect(isCronDue("15 4 * * *", at)).toBe(false);
    expect(isCronDue("15 3 15 9 2", at)).toBe(true);
    expect(isCronDue("15 3 16 9 2", at)).toBe(false);
    expect(isCronDue("15 3 * * 3", at)).toBe(false);
    expect(isCronDue("0 3 * * *", new Date("2026-09-15T03:00:59.000Z"))).toBe(true);
    expect(() => isCronDue("* * * * *", at)).toThrow("cron is invalid");
  });
});
