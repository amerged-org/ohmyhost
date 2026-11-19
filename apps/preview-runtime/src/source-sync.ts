import type {
  PreviewSourceOperation,
  PreviewSourcePatch,
  SourceVersion,
} from "@ohmyhost/contracts/previews";
export type SourceOperation = PreviewSourceOperation;
export type PreviewSourceDelta = PreviewSourcePatch;

/** Delivers validated source to the selected VM; guest state and helper results are untrusted. */
export interface SourceWriter {
  apply(operations: readonly SourceOperation[]): Promise<void>;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SHA = /^(?!0{40}$)[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const EXCLUDED = new Set([
  "node_modules",
  ".next",
  ".astro",
  ".wrangler",
  ".vite",
  ".tanstack",
  ".git",
]);
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

export function sameSourceVersion(a: SourceVersion | null, b: SourceVersion | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.sourceConnectionId === b.sourceConnectionId &&
      a.sourceGeneration === b.sourceGeneration &&
      a.sequence === b.sequence &&
      a.commitSha === b.commitSha)
  );
}

function validVersion(value: SourceVersion): boolean {
  return (
    ULID.test(value.sourceConnectionId) &&
    Number.isSafeInteger(value.sourceGeneration) &&
    value.sourceGeneration > 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    SHA.test(value.commitSha)
  );
}

function validPath(path: string): boolean {
  // eslint-disable-next-line no-control-regex -- Source paths must reject ASCII control characters.
  if (path.length === 0 || path.length > 4096 || /[\\\x00-\x1f\x7f]/u.test(path)) return false;
  return path
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part.length <= 255 &&
        part !== "." &&
        part !== ".." &&
        !EXCLUDED.has(part) &&
        !part.startsWith(".ohmyhost-preview-"),
    );
}

/** Validate all source before delivery; acknowledgement is sync status, not code attestation. */
export async function applySourceDelta(
  delta: PreviewSourceDelta,
  applied: SourceVersion | null,
  writer: SourceWriter,
  boundaryVerified: boolean,
): Promise<{ dependenciesChanged: boolean }> {
  if (!boundaryVerified) throw new Error("preview_source_boundary_unavailable");
  if (
    !validVersion(delta.to) ||
    !sameSourceVersion(delta.from, applied) ||
    (delta.from !== null &&
      (!validVersion(delta.from) ||
        delta.to.sequence < delta.from.sequence ||
        (delta.to.sequence === delta.from.sequence &&
          (!sameSourceVersion(delta.from, delta.to) ||
            delta.operations.length !== 0 ||
            delta.dependenciesChanged)) ||
        delta.from.sourceConnectionId !== delta.to.sourceConnectionId ||
        delta.from.sourceGeneration !== delta.to.sourceGeneration)) ||
    delta.operations.length > 20_000
  )
    throw new Error("preview_source_invalid");
  const seen = new Set<string>();
  const validated: SourceOperation[] = [];
  let bytes = 0;
  let dependenciesChanged = delta.dependenciesChanged;
  for (const operation of delta.operations) {
    if (!validPath(operation.path) || seen.has(operation.path))
      throw new Error("preview_source_invalid");
    seen.add(operation.path);
    const name = operation.path.split("/").at(-1) as string;
    if (DEPENDENCY_FILES.has(name)) dependenciesChanged = true;
    if (operation.kind === "write") {
      if (!(operation.bytes instanceof Uint8Array) || typeof operation.executable !== "boolean")
        throw new Error("preview_source_invalid");
      bytes += operation.bytes.byteLength;
      if (bytes > 64 * 1024 * 1024 || !DIGEST.test(operation.sha256))
        throw new Error("preview_source_invalid");
      const owned = new Uint8Array(operation.bytes);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== operation.sha256) throw new Error("preview_source_invalid");
      validated.push({
        kind: "write",
        path: operation.path,
        bytes: owned,
        sha256: operation.sha256,
        executable: operation.executable,
      });
    } else if (operation.kind === "delete")
      validated.push({ kind: "delete", path: operation.path });
    else throw new Error("preview_source_invalid");
  }
  await writer.apply(validated);
  return { dependenciesChanged };
}
