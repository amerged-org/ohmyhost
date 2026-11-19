import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHttpRequest, HttpClient } from "isomorphic-git";
export type { GitHttpRequest } from "isomorphic-git";
import type { ManagedArtifactsBinding, ManagedArtifactsRepository } from "../../src/managed-git.js";

export const accountId = "a".repeat(32);
export const namespace = "test-us";

export function gitCommand(
  root: string,
  args: readonly string[],
  input?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const result = spawnSync("git", args, {
    cwd: root,
    input,
    maxBuffer: 40 * 1024 * 1024,
    env: { PATH: process.env["PATH"], GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.status !== 0) throw new Error("Test Git command failed");
  return new Uint8Array(result.stdout);
}

/** Real Git objects and smart HTTP; the binding shape is the only deterministic test adapter. */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ohmyhost-managed-git-"));
  const repos = new Map<string, ManagedArtifactsRepository>();
  const requests: GitHttpRequest[] = [];
  const transfers: { requestBytes: number; responseBytes: number }[] = [];
  const tokens: { scope: string; ttl: number }[] = [];
  const decoder = new TextDecoder();
  const text = (repo: string, ...args: string[]) =>
    decoder.decode(gitCommand(root, [`--git-dir=${join(root, `${repo}.git`)}`, ...args]));
  const resolve = (repo: string, ref: string): string | null => {
    try {
      return text(repo, "rev-parse", "--verify", ref).trim();
    } catch {
      return null;
    }
  };
  const binding: ManagedArtifactsBinding = {
    async delete(repo) {
      const existed = repos.delete(repo);
      rmSync(join(root, `${repo}.git`), { recursive: true, force: true });
      return existed;
    },
    async get(repo) {
      const handle = repos.get(repo);
      if (handle === undefined) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      return handle;
    },
    async create(repo, options) {
      if (repos.has(repo)) throw new Error("ALREADY_EXISTS");
      gitCommand(root, [
        "init",
        "--bare",
        `--initial-branch=${options.setDefaultBranch}`,
        join(root, `${repo}.git`),
      ]);
      gitCommand(root, [
        `--git-dir=${join(root, `${repo}.git`)}`,
        "config",
        "http.receivepack",
        "true",
      ]);
      const info = {
        name: repo,
        remote: `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`,
        defaultBranch: options.setDefaultBranch,
      };
      const readCommit = async (sha: string) => {
        if (resolve(repo, `${sha}^{commit}`) === null) return null;
        const value = text(repo, "show", "-s", "--format=%H%n%T%n%P%n%an%n%ae%n%at%n%B", sha).split(
          "\n",
        );
        return {
          hash: value[0],
          treeHash: value[1],
          parents: value[2] ? value[2].split(" ") : [],
          author: { name: value[3], email: value[4] },
          authoredAt: Number(value[5]),
          message: value.slice(6).join("\n").trimEnd(),
        };
      };
      const handle: ManagedArtifactsRepository = {
        async info() {
          return info;
        },
        async createToken(scope, ttl) {
          tokens.push({ scope, ttl });
          return { plaintext: `opaque2_${"b".repeat(40)}?expires=9000000000` };
        },
        readCommit,
        async readTree(sha) {
          return text(repo, "ls-tree", sha)
            .trimEnd()
            .split("\n")
            .filter(Boolean)
            .map((entry) => {
              const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/u.exec(entry);
              if (match === null) throw new Error("Test tree entry invalid");
              return { mode: match[1], type: match[2], hash: match[3], name: match[4] };
            });
        },
        async readBlob(sha) {
          return new Blob([
            gitCommand(root, [`--git-dir=${join(root, `${repo}.git`)}`, "cat-file", "blob", sha]),
          ]);
        },
        async log({ ref, limit, offset }) {
          if (resolve(repo, ref) === null) return [];
          const shas = text(
            repo,
            "rev-list",
            "--first-parent",
            `--max-count=${limit}`,
            `--skip=${offset}`,
            ref,
          )
            .trim()
            .split("\n")
            .filter(Boolean);
          return Promise.all(shas.map(readCommit));
        },
        [Symbol.dispose]() {},
      };
      repos.set(repo, handle);
      return info;
    },
  };

  async function request(input: GitHttpRequest) {
    requests.push(input);
    const url = new URL(input.url);
    const remote = /\/git\/test-us\/([^/]+\.git)(\/.*)$/u.exec(url.pathname);
    if (remote === null) throw new Error("Unexpected test remote");
    const chunks: Uint8Array[] = [];
    if (input.body !== undefined) for await (const chunk of input.body) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const result = spawnSync("git", ["http-backend"], {
      cwd: root,
      input: body,
      maxBuffer: 40 * 1024 * 1024,
      env: {
        PATH: process.env["PATH"],
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${remote[1]}${remote[2]}`,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: input.method ?? "GET",
        CONTENT_TYPE: input.headers?.["Content-Type"] ?? input.headers?.["content-type"] ?? "",
        CONTENT_LENGTH: String(body.byteLength),
        REMOTE_USER: "test-user",
      },
    });
    if (result.status !== 0) throw new Error("Test Git HTTP backend failed");
    const boundary = result.stdout.indexOf("\r\n\r\n");
    if (boundary < 0) throw new Error("Test Git HTTP response invalid");
    const headers: Record<string, string> = {};
    let statusCode = 200;
    for (const line of result.stdout.subarray(0, boundary).toString().split("\r\n")) {
      const split = line.indexOf(":");
      const key = line.slice(0, split).toLowerCase();
      const value = line.slice(split + 1).trim();
      if (key === "status") statusCode = Number(value.split(" ")[0]);
      else headers[key] = value;
    }
    const bytes = new Uint8Array(result.stdout.subarray(boundary + 4));
    transfers.push({ requestBytes: body.byteLength, responseBytes: bytes.byteLength });
    return {
      url: input.url,
      method: input.method ?? "GET",
      statusCode,
      statusMessage: "",
      headers,
      body: (async function* () {
        yield bytes;
      })(),
    };
  }
  const http: HttpClient = { request };
  return {
    root,
    binding,
    http,
    repos,
    requests,
    transfers,
    tokens,
    text,
    resolve,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
