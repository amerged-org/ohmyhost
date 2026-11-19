import { expect, it } from "vitest";
import { parseProductCliCommand } from "../src/command.js";

it("selects exact fixed RAM through the CLI and rejects ambiguous or unsupported sizes", () => {
  const command = [
    "database",
    "compute",
    "set",
    "--project",
    "01J00000000000000000000002",
    "--environment",
    "dev",
    "--idempotency-key",
    "size-choice",
    "--yes",
  ];
  expect(parseProductCliCommand([...command, "--memory-mib", "512"])).toMatchObject({
    kind: "database-compute-set",
    memoryMiB: 512,
    environment: "dev",
  });
  expect(parseProductCliCommand([...command, "--profile", "standard"])).toMatchObject({
    profile: "standard",
  });
  for (const options of [
    [],
    ["--memory-mib", "768"],
    ["--memory-mib", "0512"],
    ["--memory-mib", "512", "--profile", "standard"],
  ])
    expect(() => parseProductCliCommand([...command, ...options])).toThrow();
});
