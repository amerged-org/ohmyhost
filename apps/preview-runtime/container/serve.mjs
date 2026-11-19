import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

// This supervisor provides best-effort cleanup within the untrusted project VM.
const { root, commands } = JSON.parse(fs.readFileSync("/workspace/runtime/commands.json", "utf8"));
const children = [];
const base = {
  PATH: "/opt/ohmyhost-platform/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/workspace/home",
  COREPACK_HOME: "/workspace/home/.cache/node/corepack",
  CI: "1",
  NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
};
function stop() {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // A child may already have exited.
    }
  }
}
for (const command of [commands.bindings, commands.application, commands.companion]) {
  if (!command) continue;
  const child = spawn(command.file, command.args, {
    cwd: root,
    env: { ...base, ...command.environment },
    stdio: "ignore",
  });
  children.push(child);
  child.once("error", () => {
    stop();
    process.exit(1);
  });
  child.once("exit", () => {
    stop();
    process.exit(1);
  });
}
if (!children.length) process.exit(1);
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
