const BLOCK = 512;

export interface TarFixtureEntry {
  readonly path: string;
  readonly content?: Uint8Array | string;
  readonly type?: number;
  readonly declaredSize?: number;
  readonly executable?: boolean;
}

function bytes(value: string | Uint8Array | undefined): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : (value ?? new Uint8Array());
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function ustarPath(path: string): Readonly<{ name: string; prefix: string }> {
  if (new TextEncoder().encode(path).byteLength <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      new TextEncoder().encode(prefix).byteLength <= 155 &&
      new TextEncoder().encode(name).byteLength <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new TypeError("Fixture path exceeds the USTAR name/prefix envelope");
}

export function tar(entries: readonly TarFixtureEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = bytes(entry.content);
    const size = entry.declaredSize ?? content.byteLength;
    const header = new Uint8Array(BLOCK);
    const path = ustarPath(entry.path);
    writeAscii(header, 0, 100, path.name);
    writeAscii(header, 100, 8, entry.executable ? "0000755\0" : "0000644\0");
    writeAscii(header, 108, 8, "0000000\0");
    writeAscii(header, 116, 8, "0000000\0");
    writeAscii(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
    writeAscii(header, 136, 12, "00000000000\0");
    header.fill(32, 148, 156);
    header[156] = entry.type ?? 48;
    writeAscii(header, 257, 6, "ustar\0");
    writeAscii(header, 263, 2, "00");
    writeAscii(header, 345, 155, path.prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, content, new Uint8Array((BLOCK - (content.byteLength % BLOCK)) % BLOCK));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function gzipTar(entries: readonly TarFixtureEntry[]): Promise<Uint8Array> {
  const archive = tar(entries);
  const body = new Response(new Uint8Array(archive).buffer).body;
  if (body === null) throw new Error("fixture response body is unavailable");
  const stream = body.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A commit given by repository-relative paths whose application sits at the root, placed under
 * `applicationRoot`: ohmyhost.yaml stays at the root and names it, every other file moves below it.
 */
export function sourceEntries(
  files: Readonly<Record<string, string | Uint8Array>>,
  applicationRoot = ".",
): readonly TarFixtureEntry[] {
  const segments = applicationRoot === "." ? [] : applicationRoot.split("/");
  const prefix = segments.map((segment) => `${segment}/`).join("");
  return [
    { path: "fixture/", type: 53 },
    ...segments.map((_, index) => ({
      path: `fixture/${segments.slice(0, index + 1).join("/")}/`,
      type: 53,
    })),
    ...Object.entries(files).map(([path, content]) =>
      path !== "ohmyhost.yaml"
        ? { path: `fixture/${prefix}${path}`, content }
        : {
            path: "fixture/ohmyhost.yaml",
            content:
              prefix === "" || typeof content !== "string"
                ? content
                : content.replace(
                    "version: 1\n",
                    `version: 1\napplicationRoot: ${applicationRoot}\n`,
                  ),
          },
    ),
  ];
}

export function nestedApplicationEntries(
  entries: readonly TarFixtureEntry[],
  extra: readonly TarFixtureEntry[] = [],
): readonly TarFixtureEntry[] {
  const nested = entries.map((entry) => {
    if (entry.path === "fixture/" || entry.path === "fixture/ohmyhost.yaml") return entry;
    return { ...entry, path: entry.path.replace(/^fixture\//u, "fixture/site/") };
  });
  return [
    ...nested.map((entry) =>
      entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
        ? {
            ...entry,
            content: entry.content.replace("version: 1\n", "version: 1\napplicationRoot: site\n"),
          }
        : entry,
    ),
    { path: "fixture/site/", type: 53 },
    ...extra,
  ];
}

export function viteEntries(extra: readonly TarFixtureEntry[] = []): readonly TarFixtureEntry[] {
  return [
    { path: "fixture/", type: 53 },
    {
      path: "fixture/ohmyhost.yaml",
      content:
        "version: 1\nproject: vite-app\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: static\n",
    },
    {
      path: "fixture/package.json",
      content: JSON.stringify({
        packageManager: "pnpm@10.28.2",
        scripts: { build: "vite build" },
        devDependencies: { vite: "7.3.6" },
      }),
    },
    { path: "fixture/pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
    { path: "fixture/index.html", content: '<div id="root"></div>' },
    ...extra,
  ];
}

export function viteCompanionEntries(
  extra: readonly TarFixtureEntry[] = [],
): readonly TarFixtureEntry[] {
  return viteEntries([
    {
      path: "fixture/ohmyhost.yaml",
      content:
        "version: 1\nproject: vite-companion\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: edge\n  healthcheck: /api/health\ndatabase:\n  enabled: true\n  migrations: migrations\nauth:\n  provider: better-auth\nmail:\n  enabled: true\nstorage:\n  provider: r2\n  jurisdiction: us\n  public: false\n",
    },
    {
      path: "fixture/package.json",
      content: JSON.stringify({
        packageManager: "pnpm@10.28.2",
        scripts: { build: "vite build" },
        dependencies: { "better-auth": "1.7.7" },
        devDependencies: { vite: "8.2.2", wrangler: "4.125.0" },
      }),
    },
    {
      path: "fixture/src/ohmyhost/companion.ts",
      content:
        "export default { async fetch(request: Request) { return new Response(request.url); } };\n",
    },
    {
      path: "fixture/vite.config.ts",
      content:
        'import { defineConfig } from "vite"; export default defineConfig({ plugins: [] });\n',
    },
    ...extra,
  ]).filter(
    (entry, index, entries) =>
      entries.findLastIndex((candidate) => candidate.path === entry.path) === index,
  );
}

export function tanStackEntries(
  extra: readonly TarFixtureEntry[] = [],
): readonly TarFixtureEntry[] {
  return [
    { path: "fixture/", type: 53 },
    {
      path: "fixture/ohmyhost.yaml",
      content:
        "version: 1\nproject: tanstack-app\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist/client\nruntime:\n  mode: static\n",
    },
    {
      path: "fixture/package.json",
      content: JSON.stringify({
        packageManager: "pnpm@10.28.2",
        scripts: { build: "vite build && tsc --noEmit" },
        dependencies: {
          "@tanstack/react-router": "1.170.31",
          "@tanstack/react-start": "1.168.60",
          react: "19.2.0",
          "react-dom": "19.2.0",
        },
        devDependencies: { "@vitejs/plugin-react": "6.0.1", vite: "8.0.14" },
      }),
    },
    { path: "fixture/pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
    {
      path: "fixture/vite.config.ts",
      content:
        "import { tanstackStart } from '@tanstack/react-start/plugin/vite'; import { defineConfig } from 'vite'; export default defineConfig({ plugins: [tanstackStart({ prerender: { enabled: true, failOnError: true } })] });\n",
    },
    { path: "fixture/src/routes/__root.tsx", content: "export {};\n" },
    { path: "fixture/src/routes/index.tsx", content: "export {};\n" },
    ...extra,
  ];
}

export function tanStackEdgeEntries(
  extra: readonly TarFixtureEntry[] = [],
): readonly TarFixtureEntry[] {
  return tanStackEntries([
    {
      path: "fixture/ohmyhost.yaml",
      content:
        "version: 1\nproject: tanstack-edge\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist/client\nruntime:\n  mode: edge\n",
    },
    {
      path: "fixture/package.json",
      content: JSON.stringify({
        packageManager: "pnpm@10.28.2",
        scripts: { build: "vite build && tsc --noEmit" },
        dependencies: {
          "@tanstack/react-router": "1.170.31",
          "@tanstack/react-start": "1.168.60",
          react: "19.2.0",
          "react-dom": "19.2.0",
        },
        devDependencies: {
          "@cloudflare/vite-plugin": "1.53.1",
          "@vitejs/plugin-react": "6.0.1",
          vite: "8.2.2",
          wrangler: "4.125.0",
        },
      }),
    },
    {
      path: "fixture/vite.config.ts",
      content:
        "import { cloudflare } from '@cloudflare/vite-plugin'; import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart()] };\n",
    },
    {
      path: "fixture/wrangler.jsonc",
      content: JSON.stringify({
        name: "tanstack-edge",
        compatibility_date: "2026-08-21",
        compatibility_flags: ["nodejs_compat"],
        main: "@tanstack/react-start/server-entry",
      }),
    },
    ...extra,
  ]).filter(
    (entry, index, entries) =>
      entries.findLastIndex((candidate) => candidate.path === entry.path) === index,
  );
}

export function nextEdgeEntries(
  extra: readonly TarFixtureEntry[] = [],
): readonly TarFixtureEntry[] {
  return [
    { path: "fixture/", type: 53 },
    {
      path: "fixture/ohmyhost.yaml",
      content:
        "version: 1\nproject: next-edge\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: .next\nruntime:\n  mode: edge\n",
    },
    {
      path: "fixture/package.json",
      content: JSON.stringify({
        packageManager: "pnpm@10.28.2",
        scripts: { build: "next build" },
        dependencies: {
          next: "16.4.5",
          react: "19.2.4",
          "react-dom": "19.2.4",
        },
        devDependencies: {},
      }),
    },
    { path: "fixture/pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
    {
      path: "fixture/next.config.ts",
      content:
        'import type { NextConfig } from "next"; const nextConfig: NextConfig = { reactStrictMode: true }; export default nextConfig;\n',
    },
    {
      path: "fixture/src/app/page.tsx",
      content: "export default function Page() { return null; }\n",
    },
    ...extra,
  ].filter(
    (entry, index, entries) =>
      entries.findLastIndex((candidate) => candidate.path === entry.path) === index,
  );
}
