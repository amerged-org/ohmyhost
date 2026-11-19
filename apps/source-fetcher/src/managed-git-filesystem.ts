const encoder = new TextEncoder();
const decoder = new TextDecoder();

class MemoryFileStat {
  public readonly dev = 0;
  public readonly ino = 0;
  public readonly uid = 0;
  public readonly gid = 0;
  public readonly mtimeMs = 0;
  public readonly ctimeMs = 0;
  public readonly mtime = new Date(0);
  public readonly ctime = new Date(0);
  public constructor(
    public readonly size: number,
    public readonly mode: number,
  ) {}
  public isFile(): boolean {
    return (this.mode & 0o170000) === 0o100000;
  }
  public isDirectory(): boolean {
    return (this.mode & 0o170000) === 0o040000;
  }
  public isSymbolicLink(): boolean {
    return false;
  }
}

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error("Managed Git filesystem operation failed"), { code });
}

function normalize(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw failure("EINVAL");
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw failure("EINVAL");
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parent(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/** Request-local storage only; no credentials or customer processes enter this filesystem. */
export class ManagedGitMemoryFileSystem {
  private readonly files = new Map<string, { bytes: Uint8Array; mode: number }>();
  private readonly directories = new Set(["/"]);
  private byteLength = 0;
  public constructor(private readonly maximumBytes = 32 * 1024 * 1024) {}

  public get promises(): ManagedGitMemoryFileSystem {
    return this;
  }

  public async readFile(path: string, options?: unknown): Promise<Uint8Array | string> {
    const normalized = normalize(path);
    const file = this.files.get(normalized);
    if (file === undefined) throw failure(this.directories.has(normalized) ? "EISDIR" : "ENOENT");
    const encoding =
      typeof options === "string"
        ? options
        : typeof options === "object" && options !== null && "encoding" in options
          ? options.encoding
          : undefined;
    return encoding ? decoder.decode(file.bytes) : file.bytes.slice();
  }

  public async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const normalized = normalize(path);
    if (this.directories.has(normalized)) throw failure("EISDIR");
    if (!this.directories.has(parent(normalized))) throw failure("ENOENT");
    const bytes = typeof content === "string" ? encoder.encode(content) : content.slice();
    const total =
      this.byteLength - (this.files.get(normalized)?.bytes.byteLength ?? 0) + bytes.byteLength;
    if (total > this.maximumBytes) throw failure("ENOSPC");
    const mode = this.files.get(normalized)?.mode ?? 0o100644;
    this.files.set(normalized, { bytes, mode });
    this.byteLength = total;
  }

  public async unlink(path: string): Promise<void> {
    const normalized = normalize(path);
    const file = this.files.get(normalized);
    if (file === undefined) throw failure("ENOENT");
    this.byteLength -= file.bytes.byteLength;
    this.files.delete(normalized);
  }

  public async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = normalize(path);
    if (this.files.has(normalized)) throw failure("EEXIST");
    if (this.directories.has(normalized)) {
      if (options?.recursive) return;
      throw failure("EEXIST");
    }
    const ancestor = parent(normalized);
    if (!this.directories.has(ancestor)) {
      if (!options?.recursive) throw failure("ENOENT");
      await this.mkdir(ancestor, options);
    }
    this.directories.add(normalized);
  }

  public async rmdir(path: string): Promise<void> {
    const normalized = normalize(path);
    if (!this.directories.has(normalized)) throw failure("ENOENT");
    if ((await this.readdir(normalized)).length !== 0 || normalized === "/")
      throw failure("ENOTEMPTY");
    this.directories.delete(normalized);
  }

  public async readdir(path: string): Promise<string[]> {
    const normalized = normalize(path);
    if (!this.directories.has(normalized)) throw failure("ENOENT");
    const names = new Set<string>();
    for (const candidate of [...this.directories, ...this.files.keys()]) {
      if (candidate !== normalized && parent(candidate) === normalized) {
        names.add(candidate.slice(candidate.lastIndexOf("/") + 1));
      }
    }
    return [...names].sort();
  }

  public async stat(path: string): Promise<MemoryFileStat> {
    const normalized = normalize(path);
    const file = this.files.get(normalized);
    if (file !== undefined) return new MemoryFileStat(file.bytes.byteLength, file.mode);
    if (this.directories.has(normalized)) return new MemoryFileStat(0, 0o040755);
    throw failure("ENOENT");
  }

  public async lstat(path: string): Promise<MemoryFileStat> {
    return this.stat(path);
  }

  public async chmod(path: string, mode: number): Promise<void> {
    const file = this.files.get(normalize(path));
    if (file === undefined) throw failure("ENOENT");
    file.mode = 0o100000 | (mode & 0o777);
  }

  public async readlink(): Promise<never> {
    throw failure("EINVAL");
  }

  public async symlink(): Promise<never> {
    throw failure("EPERM");
  }
}
