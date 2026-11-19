import { createHash } from "node:crypto";

export interface CandidateArtifactFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface CandidateArtifactProof {
  readonly schemaVersion: 2;
  readonly artifact: "workos-management";
  readonly deploymentPolicy: "service-binding-only";
  readonly entrypoint: "dist/sandbox-main.js";
  readonly runtimeEntrypoint: "dist/worker-bundle/worker-main.js";
  readonly runtimeContract: "dist/runtime/runtime-contract.json";
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly artifactSha256: string;
}

const hash = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export function createCandidateArtifactProof(
  inputFiles: readonly CandidateArtifactFile[],
): CandidateArtifactProof {
  const paths = new Set<string>();
  const files = [...inputFiles]
    .map((file) => {
      if (!file.path.startsWith("dist/") || file.path.includes("..") || paths.has(file.path)) {
        throw new TypeError("Candidate artifact path is invalid or duplicated");
      }
      paths.add(file.path);
      return { path: file.path, bytes: file.content.byteLength, sha256: hash(file.content) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) throw new TypeError("Candidate artifact is empty");
  for (const requiredPath of [
    "dist/sandbox-main.js",
    "dist/worker-bundle/worker-main.js",
    "dist/worker-bundle/metafile.json",
    "dist/runtime/runtime-contract.json",
    "dist/runtime/wrangler.jsonc",
  ]) {
    if (!paths.has(requiredPath)) throw new TypeError("Candidate artifact runtime is incomplete");
  }
  const framed = files
    .map(
      (file) =>
        `${String(file.path.length)}:${file.path}${String(file.sha256.length)}:${file.sha256}`,
    )
    .join("");
  return {
    schemaVersion: 2,
    artifact: "workos-management",
    deploymentPolicy: "service-binding-only",
    entrypoint: "dist/sandbox-main.js",
    runtimeEntrypoint: "dist/worker-bundle/worker-main.js",
    runtimeContract: "dist/runtime/runtime-contract.json",
    files,
    artifactSha256: hash(framed),
  };
}
