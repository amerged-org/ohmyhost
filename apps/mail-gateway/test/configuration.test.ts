import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("keeps the default Mail profile private without committed credentials", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const configuration = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as Record<
    string,
    unknown
  >;
  expect(configuration).toMatchObject({
    name: "ohmyho-mail-gateway",
    main: "src/resend-worker.ts",
    workers_dev: false,
    preview_urls: false,
    compatibility_flags: ["nodejs_compat", "enable_request_signal"],
  });
  expect(configuration).not.toHaveProperty("routes");
  expect(JSON.stringify(configuration)).not.toMatch(/AWS_/u);
});

it("keeps sandbox Mail private with cancellation and without credential values", async () => {
  const source = await readFile(new URL("../wrangler.sandbox.jsonc", import.meta.url), "utf8");
  const configuration = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as Record<
    string,
    unknown
  >;
  expect(configuration).toMatchObject({
    name: "ohmyho-mail-gateway-sandbox",
    workers_dev: false,
    compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    preview_urls: false,
    vars: {
      RUNTIME_CONFIGURATION_STATE: "configured",
    },
  });
  expect(JSON.stringify(configuration)).not.toMatch(/AWS_/u);
});

it("lets Mail and Storage stream locally with request cancellation and no database placement", async () => {
  for (const app of ["mail-gateway", "storage-gateway"])
    for (const environment of ["development", "production"]) {
      const source = await readFile(
        new URL(`../../${app}/wrangler.${environment}.jsonc`, import.meta.url),
        "utf8",
      );
      const configuration = JSON.parse(
        source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"),
      ) as { compatibility_flags?: string[] };
      // Control is a private service binding on D1: nothing pins these Workers next to a database host.
      expect(configuration).not.toHaveProperty("placement");
      expect(configuration.compatibility_flags).toEqual(["nodejs_compat", "enable_request_signal"]);
    }
  const storage = JSON.parse(
    (await readFile(new URL("../../storage-gateway/wrangler.jsonc", import.meta.url), "utf8"))
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/,\s*([}\]])/gu, "$1"),
  ) as { compatibility_flags?: string[] };
  expect(storage.compatibility_flags).toEqual(["nodejs_compat", "enable_request_signal"]);
});
