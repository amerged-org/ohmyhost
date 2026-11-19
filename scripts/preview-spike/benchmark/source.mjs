import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export function hashFileEntry(hash, relative, executable, bytes) {
  hash.update(JSON.stringify([relative, executable, bytes.length]));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
}

/** Exact public source bytes, paths and executable bits; links/special files fail closed. */
export async function directoryTreeSha256(root) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path, relative);
      else if (stat.isFile())
        hashFileEntry(hash, relative, Boolean(stat.mode & 0o111), await readFile(path));
      else throw new Error("fixture_file_invalid");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

/** Match every file and directory, including modes; never follow links or admit extra paths. */
export async function matchesFileInventory(root, expected) {
  if (!(expected instanceof Map)) return false;
  const directories = new Set();
  for (const [path, value] of expected) {
    const parts = path.split("/");
    if (
      parts.some((part) => !part || part === "." || part === "..") ||
      !Buffer.isBuffer(value?.bytes) ||
      typeof value.executable !== "boolean"
    )
      return false;
    for (let depth = 1; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }
  const seenFiles = new Set();
  const seenDirectories = new Set();
  async function visit(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        if (!directories.has(relative)) return false;
        seenDirectories.add(relative);
        if (!(await visit(path, relative))) return false;
      } else if (stat.isFile()) {
        const item = expected.get(relative);
        if (
          !item ||
          stat.nlink !== 1 ||
          item.executable !== Boolean(stat.mode & 0o111) ||
          !(await readFile(path)).equals(item.bytes)
        )
          return false;
        seenFiles.add(relative);
      } else return false;
    }
    return true;
  }
  try {
    return (
      (await lstat(root)).isDirectory() &&
      (await visit(root)) &&
      seenFiles.size === expected.size &&
      seenDirectories.size === directories.size
    );
  } catch {
    return false;
  }
}
