import { writeFile } from "node:fs/promises";
import { URL } from "node:url";

const readme = new URL("../dist/worker-bundle/README.md", import.meta.url);

await writeFile(
  readme,
  "Deterministic Wrangler dry-run output for the private ohmyhost WorkOS management Worker.\n",
  { mode: 0o600 },
);
