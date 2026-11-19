import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const modulesDirectory = dirname(fileURLToPath(import.meta.url));

test("domain modules do not import HTTP, database, provider SDK, CLI, or testkit code", () => {
  const sources = [
    resolve(modulesDirectory, "projects/project.ts"),
    resolve(modulesDirectory, "projects/ownership-transfer.ts"),
    resolve(modulesDirectory, "operations/operation.ts"),
  ];

  for (const source of sources) {
    const contents = readFileSync(source, "utf8");
    expect(contents).not.toMatch(
      /from ["'](?:pg|hono|@ohmyhost\/(?:database|testkit)|.*provider)/i,
    );
  }
});

test("authorization contracts remain backend-neutral and outside provider adapters", () => {
  const sources = [
    resolve(modulesDirectory, "../ports/authorization.ts"),
    resolve(modulesDirectory, "identity/principal-mapping.ts"),
    resolve(modulesDirectory, "authorization/authorization.ts"),
  ];

  for (const source of sources) {
    expect(
      () => readFileSync(source, "utf8"),
      `Expected authorization source ${source}`,
    ).not.toThrow();
    const contents = readFileSync(source, "utf8");
    expect(contents).not.toMatch(
      /from ["'](?:pg|hono|@workos-inc\/node|@ohmyhost\/(?:database|testkit)|.*provider)/iu,
    );
  }
});
