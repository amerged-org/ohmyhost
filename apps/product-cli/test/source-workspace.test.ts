import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSourceSnapshot,
  inspectSourceWorkspace,
  SOURCE_SNAPSHOT_LIMITS,
} from "../src/source-workspace.js";

const roots: string[] = [];
const HEAD = "0123456789abcdef0123456789abcdef01234567";

async function workspace(files: Record<string, string | Uint8Array> = {}): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omh-source-workspace-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(dirname(join(root, path)), { recursive: true });
    await fs.writeFile(join(root, path), content);
  }
  return root;
}

async function repository(root: string, config: string): Promise<void> {
  await fs.mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
  await fs.writeFile(join(root, ".git", "config"), config);
  await fs.writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(join(root, ".git", "refs", "heads", "main"), `${HEAD}\n`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local source workspace", () => {
  it("keeps filesystem, Git, monorepo and sanitized GitHub evidence separate, including worktrees", async () => {
    const plain = await workspace({ "src/main.ts": "export {};\n" });
    expect(await inspectSourceWorkspace(plain)).toMatchObject({
      repositoryRoot: null,
      applicationRoot: ".",
      git: null,
    });

    const root = await workspace({ "apps/site/src/main.ts": "local changes\n" });
    await repository(
      root,
      [
        "[core]\nrepositoryformatversion = 0",
        '[remote "origin"]\nurl = https://private-user:private-password@github.com/owner/site.git?token=private-query#private-fragment',
        '[remote "upstream"]\nurl = git@github.com:upstream/site.git',
        '[remote "local"]\nurl = /private/token-containing/path',
        '[branch "main"]\nremote = upstream\nmerge = refs/heads/main',
        "[remote]\npushDefault = origin",
        "",
      ].join("\n"),
    );
    const inspected = await inspectSourceWorkspace(join(root, "apps", "site"));
    expect(inspected).toMatchObject({
      repositoryRoot: root,
      applicationRoot: "apps/site",
      git: {
        head: HEAD,
        branch: "main",
        upstreamRemote: "upstream",
        pushRemote: "origin",
        remotes: [
          { name: "local", url: null, githubRepository: null },
          { name: "origin", url: "https://github.com/owner/site", githubRepository: "owner/site" },
          {
            name: "upstream",
            url: "https://github.com/upstream/site",
            githubRepository: "upstream/site",
          },
        ],
      },
    });
    expect(JSON.stringify(inspected)).not.toMatch(
      /private-user|private-password|private-query|private-fragment|token-containing/u,
    );

    const tree = await workspace({ "src/main.ts": "worktree edits\n" });
    const gitdir = join(root, ".git", "worktrees", "second");
    await fs.mkdir(gitdir, { recursive: true });
    await fs.writeFile(join(tree, ".git"), `gitdir: ${gitdir}\n`);
    await fs.writeFile(join(gitdir, "commondir"), "../..\n");
    await fs.writeFile(join(gitdir, "HEAD"), `${HEAD}\n`);
    const worktreeContext = await inspectSourceWorkspace(tree);
    expect(worktreeContext).toMatchObject({
      repositoryRoot: tree,
      applicationRoot: ".",
      git: { head: HEAD, branch: null, upstreamRemote: null, pushRemote: "origin" },
    });
    await fs.appendFile(join(root, ".git", "config"), "[extensions]\nworktreeConfig = true\n");
    await fs.writeFile(
      join(gitdir, "config.worktree"),
      '[remote "origin"]\nurl = ssh://git:never-expose@github.com/different/repo.git\n',
    );
    await fs.writeFile(join(gitdir, "HEAD"), "ref: refs/heads/main\n");
    const configuredWorktree = await inspectSourceWorkspace(tree);
    expect(configuredWorktree).toMatchObject({
      git: {
        head: HEAD,
        branch: "main",
        remotes: expect.arrayContaining([
          {
            name: "origin",
            url: "https://github.com/different/repo",
            githubRepository: "different/repo",
          },
        ]),
      },
    });
    expect(
      configuredWorktree.git?.remotes.filter((remote) => remote.name === "origin"),
    ).toHaveLength(1);
    await fs.rm(join(root, ".git", "refs", "heads", "main"));
    expect(await inspectSourceWorkspace(root)).toMatchObject({
      git: { head: null, branch: "main" },
    });

    const malformed = await workspace({ ".git": "gitdir: malformed\nprivate-secret\n" });
    await expect(inspectSourceWorkspace(malformed)).rejects.toMatchObject({
      code: "source_git_invalid",
    });
  });

  it("captures current binary and executable files with ancestor/nested ignore precedence and fixed secret exclusions", async () => {
    const root = await workspace({
      ".gitignore": "*.txt\n/skip/\n/apps/site/ancestor-ignored.ts\n",
      "apps/site/.gitignore": "!keep.txt\n/nested/root-only.ts\nignored/\n",
      "apps/site/keep.txt": "new untracked file\n",
      "apps/site/drop.txt": "ignored\n",
      "apps/site/ancestor-ignored.ts": "ignored by repository root\n",
      "apps/site/main.ts": "uncommitted working-tree contents\n",
      "apps/site/assets/icon.bin": new Uint8Array([0, 255, 128, 1]),
      "apps/site/run.sh": "#!/bin/sh\nexit 0\n",
      "apps/site/nested/.gitignore": "!/root-only.ts\n*.tmp\n",
      "apps/site/nested/root-only.ts": "re-included by nearer gitignore\n",
      "apps/site/nested/drop.tmp": "ignored\n",
      "apps/site/nested/deeper/root-only.ts": "not root anchored\n",
      "apps/site/ignored/.gitignore": "!secret.ts\n",
      "apps/site/ignored/secret.ts": "cannot re-include an ignored parent\n",
      "apps/site/.env": "secret-value\n",
      "apps/site/.env.production": "secret-value\n",
      "apps/site/.env.example": "API_TOKEN=replace-me\n",
      "apps/site/.dev.vars": "secret-value\n",
      "apps/site/.npmrc": "//registry.test/:_authToken=secret-value\n",
      "apps/site/private.pem": "secret-value\n",
      "apps/site/credentials.json": "secret-value\n",
      "apps/site/.ohmyhost/link.json": "secret-value\n",
      "apps/site/node_modules/package/index.js": "generated\n",
      "apps/site/.next/server/index.js": "generated\n",
      "apps/site/dist/index.js": "generated\n",
    });
    await repository(root, "[core]\nrepositoryformatversion = 0\n");
    const site = join(root, "apps", "site");
    await fs.chmod(join(site, "run.sh"), 0o755);
    // Excluded provider output and credentials are never followed or read.
    await fs.symlink(tmpdir(), join(site, "node_modules", "external"));
    await fs.symlink(tmpdir(), join(site, ".env.local"));
    const snapshot = await createSourceSnapshot({ directory: site });
    expect(snapshot.files.map((file) => file.path)).toEqual([
      ".env.example",
      ".gitignore",
      "assets/icon.bin",
      "keep.txt",
      "main.ts",
      "nested/.gitignore",
      "nested/deeper/root-only.ts",
      "nested/root-only.ts",
      "run.sh",
    ]);
    expect(
      Buffer.from(
        snapshot.files.find((file) => file.path === "main.ts")?.contentBase64 ?? "",
        "base64",
      ).toString(),
    ).toBe("uncommitted working-tree contents\n");
    expect(
      Buffer.from(
        snapshot.files.find((file) => file.path === "assets/icon.bin")?.contentBase64 ?? "",
        "base64",
      ),
    ).toEqual(Buffer.from([0, 255, 128, 1]));
    expect(snapshot.files.find((file) => file.path === "run.sh")?.executable).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("secret-value");
    expect(await createSourceSnapshot({ directory: site })).toEqual(snapshot);
    await fs.writeFile(join(site, "main.ts"), "another edit\n");
    expect((await createSourceSnapshot({ directory: site })).sha256).not.toBe(snapshot.sha256);
    const noGit = await workspace({ "main.ts": "no Git required\n" });
    expect(
      (await createSourceSnapshot({ directory: noGit })).files.map((file) => file.path),
    ).toEqual(["main.ts"]);
    const prefixPath = `${"a".repeat(121)}/file.ts`;
    const prefixTree = await workspace({ [prefixPath]: "valid USTAR prefix\n" });
    expect(
      (await createSourceSnapshot({ directory: prefixTree })).files.map((file) => file.path),
    ).toEqual([prefixPath]);
    expect(await createSourceSnapshot({ directory: await workspace() })).toMatchObject({
      files: [],
      totalBytes: 0,
    });
  });

  it("rejects symlink escapes, bounded-size/count violations and files or selections changing during capture", async () => {
    const root = await workspace({ "main.ts": "before\n" });
    await fs.symlink(tmpdir(), join(root, "external"));
    await expect(createSourceSnapshot({ directory: root })).rejects.toMatchObject({
      code: "source_symlink_forbidden",
    });
    await fs.rm(join(root, "external"));
    const alias = join(root, "alias");
    await fs.symlink(root, alias);
    await expect(inspectSourceWorkspace(alias)).rejects.toMatchObject({
      code: "source_symlink_forbidden",
    });
    await fs.rm(alias);
    await expect(createSourceSnapshot({ directory: join(root, "main.ts") })).rejects.toMatchObject({
      code: "source_directory_invalid",
    });

    await fs.writeFile(join(root, "large.bin"), Buffer.alloc(SOURCE_SNAPSHOT_LIMITS.fileBytes + 1));
    await expect(createSourceSnapshot({ directory: root })).rejects.toMatchObject({
      code: "source_file_too_large",
    });
    await fs.rm(join(root, "large.bin"));
    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(
        join(root, `size-${index}.bin`),
        Buffer.alloc(SOURCE_SNAPSHOT_LIMITS.fileBytes),
      );
    }
    await expect(createSourceSnapshot({ directory: root })).rejects.toMatchObject({
      code: "source_snapshot_too_large",
    });
    for (let index = 0; index < 5; index += 1) await fs.rm(join(root, `size-${index}.bin`));

    const many = await workspace();
    for (let index = 0; index <= SOURCE_SNAPSHOT_LIMITS.files; index += 50) {
      await Promise.all(
        Array.from(
          { length: Math.min(50, SOURCE_SNAPSHOT_LIMITS.files + 1 - index) },
          (_, offset) => fs.writeFile(join(many, `file-${index + offset}.ts`), ""),
        ),
      );
    }
    await expect(createSourceSnapshot({ directory: many })).rejects.toMatchObject({
      code: "source_too_many_files",
    });

    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path === join(root, "main.ts")) await fs.writeFile(path, "changed while reading\n");
      return handle;
    });
    await expect(createSourceSnapshot({ directory: root })).rejects.toMatchObject({
      code: "source_snapshot_changed",
    });
    vi.restoreAllMocks();
    await fs.writeFile(join(root, "z-last.ts"), "last\n");
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path === join(root, "z-last.ts"))
        await fs.writeFile(join(root, "new.ts"), "added during capture\n");
      return handle;
    });
    await expect(createSourceSnapshot({ directory: root })).rejects.toMatchObject({
      code: "source_snapshot_changed",
    });
  });
});
