import { expect, test } from "vitest";

import {
  DeterministicEntropy,
  FixedClock,
  SystemClock,
  cancelOperation,
  createOperation,
  createProject,
  createUlidFactory,
  creditMicros,
  failOperation,
  startOperation,
  succeedOperation,
  usdMicros,
} from "./index.js";

test("exports the public Phase 0 platform surface", () => {
  const clock = new FixedClock("2026-01-01T00:00:00.000Z");

  expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(SystemClock).toBeTypeOf("function");
  expect(createUlidFactory).toBeTypeOf("function");
  expect(usdMicros(1n)).toBe(1n);
  expect(creditMicros(1n)).toBe(1n);
  expect(createProject).toBeTypeOf("function");
  expect(createOperation).toBeTypeOf("function");
  expect(startOperation).toBeTypeOf("function");
  expect(succeedOperation).toBeTypeOf("function");
  expect(failOperation).toBeTypeOf("function");
  expect(cancelOperation).toBeTypeOf("function");
  expect(DeterministicEntropy).toBeTypeOf("function");
});
