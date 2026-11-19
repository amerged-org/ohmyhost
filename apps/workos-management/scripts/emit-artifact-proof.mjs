import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

import { createCandidateArtifactProof } from "../dist/artifact.js";

const root = new URL("../dist/", import.meta.url);

const collect = async (directory, prefix = "dist") => {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === "candidate-artifact.json") continue;
    const absolute = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(absolute, relative)));
    else files.push({ path: relative, content: await readFile(absolute) });
  }
  return files;
};

const proof = createCandidateArtifactProof(await collect(root));
await writeFile(new URL("candidate-artifact.json", root), `${JSON.stringify(proof, null, 2)}\n`, {
  mode: 0o600,
});
