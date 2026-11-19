/* global process */
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

// This preload runs in each Node subprocess of the release build. Only Wrangler entrypoints
// receive an argument; pnpm, TypeScript and all other programs keep their normal arguments.
const entry = (process.argv[1] ?? "").replaceAll("\\", "/");
if (/\/wrangler\/(?:bin\/wrangler\.js|wrangler-dist\/cli\.js)$/u.test(entry)) {
  const path = process.env.OHMYHO_G1_EMPTY_ENV_FILE;
  let valid = typeof path === "string" && isAbsolute(path);
  try {
    const file = lstatSync(path);
    valid &&=
      file.isFile() &&
      file.nlink === 1 &&
      file.size === 0 &&
      (file.mode & 0o777) === 0o600 &&
      (typeof process.getuid !== "function" || file.uid === process.getuid());
  } catch {
    valid = false;
  }
  const args = process.argv.slice(2);
  const matches = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env-file") matches.push({ value: args[index + 1], index, length: 2 });
    else if (args[index].startsWith("--env-file="))
      matches.push({ value: args[index].slice(11), index, length: 1 });
  }
  if (!valid || matches.length > 1 || (matches.length === 1 && matches[0].value !== path)) {
    process.stderr.write("development_wrangler_env_guard_failed\n");
    process.exit(1);
  }
  // Wrangler parses this as a greedy array option. Before the command it consumes the
  // command name as another file, so normalize even an existing flag to the safe tail.
  if (matches.length === 1) process.argv.splice(matches[0].index + 2, matches[0].length);
  const separator = process.argv.indexOf("--", 2);
  process.argv.splice(separator === -1 ? process.argv.length : separator, 0, "--env-file", path);
}
