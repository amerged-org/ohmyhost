import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import { operationStates } from "../packages/platform/src/modules/operations/operation.js";

test("the bundled OpenAPI operation-state enum matches the platform domain", async () => {
  const document = JSON.parse(
    await readFile(
      new URL("../packages/contracts/generated/openapi.json", import.meta.url),
      "utf8",
    ),
  ) as {
    components?: { schemas?: { Operation?: { properties?: { state?: { enum?: unknown } } } } };
  };

  expect(document.components?.schemas?.Operation?.properties?.state?.enum).toEqual(operationStates);
});
