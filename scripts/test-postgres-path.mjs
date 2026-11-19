/* global process */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const KNOWN_BINARIES = [
  "/opt/homebrew/opt/postgresql@18/bin",
  "/usr/local/opt/postgresql@18/bin",
  "/usr/lib/postgresql/18/bin",
  "/usr/local/pgsql/bin",
];

function isPostgres18(directory) {
  try {
    for (const name of ["initdb", "pg_ctl", "psql", "pg_dump", "pg_restore"]) {
      const executable = join(directory, name);
      if (!statSync(executable).isFile()) return false;
      const version = execFileSync(executable, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      if (!/\(PostgreSQL\) 18\.\d+(?:\s|$)/u.test(version)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Keep test clusters on one validated PostgreSQL major without changing the caller's shell. */
export function testPostgresEnvironment({
  environment = process.env,
  candidates = KNOWN_BINARIES,
  verify = isPostgres18,
} = {}) {
  const explicit = environment.OHMYHOST_TEST_POSTGRES_BIN;
  if (explicit !== undefined && (!isAbsolute(explicit) || !existsSync(explicit)))
    throw new Error("OHMYHOST_TEST_POSTGRES_BIN must name an existing absolute directory");
  const choices = explicit === undefined ? candidates : [explicit];
  for (const candidate of choices) {
    if (!existsSync(candidate)) continue;
    const directory = realpathSync(candidate);
    if (!statSync(directory).isDirectory() || !verify(directory)) continue;
    return {
      ...environment,
      OHMYHOST_TEST_POSTGRES_BIN: directory,
      PATH: `${directory}:${environment.PATH ?? ""}`,
    };
  }
  throw new Error("PostgreSQL 18 server and dump/restore tools are required for local tests");
}
