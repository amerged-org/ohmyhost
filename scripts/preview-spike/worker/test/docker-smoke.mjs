/* global process, console */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const image = "ohmyho-preview-spike-local";
const script = `set -eu
mkdir -p /workspace/app
chown 10001:10001 /workspace/app
su -s /bin/sh preview -c 'HOME=/home/preview COREPACK_HOME=/opt/corepack CI=1 node /opt/preview-spike/driver.mjs prepare astro-edge unused seeded' >/dev/null
su -s /bin/sh preview -c 'HOME=/home/preview COREPACK_HOME=/opt/corepack CI=1 node /opt/preview-spike/driver.mjs serve astro-edge fixture.preview.dev.omh.st' >/tmp/spike-server.log 2>&1 &
driver=$!
ok=0
for i in $(seq 1 90); do
  if node -e "fetch('http://127.0.0.1:3001/',{headers:{host:'fixture.preview.dev.omh.st'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then ok=1; break; fi
  sleep 1
done
kill "$driver" 2>/dev/null || true
wait "$driver" 2>/dev/null || true
[ "$ok" = 1 ]
`;
const helperOnly = process.env.SPIKE_SMOKE_MODE === "helper";
if (!helperOnly) {
  const astro = spawnSync(
    "docker",
    ["run", "--rm", "--platform", "linux/amd64", "--entrypoint", "sh", image, "-c", script],
    { encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(astro.status, 0, `Astro failed: ${astro.stderr?.slice(-3000)}`);
}

const symlink = `set -eu
mkdir -p /workspace/app/src/app
chown -R 10001:10001 /workspace/app
su -s /bin/sh preview -c 'printf original >/workspace/app/src/app/page.tsx; printf revised | /usr/local/bin/spike-write src/app/page.tsx'
[ "$(cat /workspace/app/src/app/page.tsx)" = revised ]
rm -rf /workspace/app
mkdir -p /tmp/escape/src
printf original >/tmp/escape/src/page.tsx
ln -s /tmp/escape /workspace/app
if printf changed | /usr/local/bin/spike-write src/page.tsx; then exit 1; fi
[ "$(cat /tmp/escape/src/page.tsx)" = original ]
rm /workspace/app
mkdir /workspace/app
ln -s /tmp/escape/src /workspace/app/src
if printf changed | /usr/local/bin/spike-write src/page.tsx; then exit 1; fi
[ "$(cat /tmp/escape/src/page.tsx)" = original ]
`;
const refusal = spawnSync(
  "docker",
  ["run", "--rm", "--platform", "linux/amd64", "--entrypoint", "sh", image, "-c", symlink],
  { encoding: "utf8", timeout: 30_000 },
);
assert.equal(refusal.status, 0, `Symlink-root refusal failed: ${refusal.stderr}`);
console.log(
  helperOnly
    ? "Docker smoke passed: real file write and symlink refusals"
    : "Docker smoke passed: real Astro fixture, file write, and symlink refusals",
);
