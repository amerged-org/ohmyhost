import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../container/Dockerfile", import.meta.url), "utf8");

/** The final stage installs the pinned system CA bundle as root before dropping to postgres. */
function finalStageTrustsSystemRoots(source: string): boolean {
  const lines = source
    .replace(/\s*\\\n\s*/gu, " ")
    .split("\n")
    .map((line) => line.trim());
  const finalStage = lines.slice(lines.findLastIndex((line) => line.startsWith("FROM ")));
  const install = finalStage.findIndex((line) =>
    /^RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=\S+ && rm -rf \/var\/lib\/apt\/lists\/\*$/u.test(
      line,
    ),
  );
  const user = finalStage.indexOf("USER postgres");
  return (
    install > 0 &&
    user > install &&
    !finalStage.slice(0, install).some((line) => line.startsWith("USER "))
  );
}

it("ships the system CA bundle pg_dump needs for verify-full with system roots", () => {
  expect(finalStageTrustsSystemRoots(dockerfile)).toBe(true);
  expect(
    finalStageTrustsSystemRoots(
      dockerfile.replace(/RUN apt-get update[^\n]*\\\n[^\n]*\\\n[^\n]*\n/u, ""),
    ),
  ).toBe(false);
  expect(
    finalStageTrustsSystemRoots(
      dockerfile.replace("RUN apt-get update", "USER postgres\nRUN apt-get update"),
    ),
  ).toBe(false);
  expect(dockerfile).toContain(
    "node:24.15.0-bookworm-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde",
  );
  expect(dockerfile).toContain(
    "postgres:18.6-bookworm@sha256:9e73daeb439141c2b11eea2463f5f1a3b269fd90d897b41cddb7cb440f21aa5d",
  );
  const instructions = dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  expect(instructions).not.toMatch(/PGSSL|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS/u);
});
