import fs from "node:fs";
import path from "node:path";
import { nativeFrameworkCommands, writeFrameworkConfiguration } from "./drivers.mjs";

// The Worker invokes preparation after installation and before framework startup.
// Package managers may already have executed customer-controlled configuration.
const bytes = fs.readFileSync(0);
if (bytes.length > 1024 * 1024) throw new Error("preview_configuration_invalid");
const input = JSON.parse(bytes.toString("utf8"));
if (
  !input ||
  !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(input.sessionId) ||
  !["vite-static", "functions", "nextjs", "tanstack-start", "astro"].includes(input.adapter) ||
  !["static", "edge", "functions"].includes(input.runtime)
)
  throw new Error("preview_configuration_invalid");
const root =
  input.applicationRoot === "."
    ? "/workspace/app"
    : path.resolve("/workspace/app", input.applicationRoot);
if (root !== "/workspace/app" && !root.startsWith("/workspace/app/"))
  throw new Error("preview_configuration_invalid");
const config = writeFrameworkConfiguration(input, root, {
  runtimeConfigRoot: "/workspace/runtime",
  repositoryRoot: "/workspace/app",
});
const commands = nativeFrameworkCommands(input, root, config);
fs.writeFileSync("/workspace/runtime/commands.json", JSON.stringify({ root, commands }), {
  flag: "wx",
  mode: 0o644,
});
// Set ownership so the framework can read mode-0600 loader files. All files in
// this VM remain untrusted and are not evidence of the code being executed.
for (const file of ["/workspace/runtime", ...config.privateFiles]) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (file !== "/workspace/runtime" && !file.startsWith("/workspace/runtime/"))
  )
    throw new Error("preview_configuration_invalid");
  fs.chownSync(file, 10001, 10001);
}
