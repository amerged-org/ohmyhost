import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import zlib from "node:zlib";

import {
  ViteArchiveInspectionError,
  inspectFrameworkArchive,
} from "../../../source-fetcher/dist/vite-archive-inspector.js";
import { validateSourceArchiveBytes } from "../build-runtime.mjs";

function tarEntry(entryPath, type, content = "") {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(entryPath, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = type;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function archive(paxContent) {
  const entries = [
    ...(paxContent === undefined ? [] : [tarEntry("pax_global_header", 103, paxContent)]),
    tarEntry("repository/", 53),
    tarEntry(
      "repository/ohmyhost.yaml",
      48,
      "version: 1\nproject: fixture\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: static\n",
    ),
    tarEntry(
      "repository/package.json",
      48,
      '{"name":"fixture","packageManager":"pnpm@10.28.2","scripts":{"build":"vite build"},"devDependencies":{"vite":"7.1.3"}}\n',
    ),
    tarEntry("repository/pnpm-lock.yaml", 48, "lockfileVersion: '9.0'\n"),
    tarEntry("repository/vite.config.ts", 48, "export default {}\n"),
    Buffer.alloc(1024),
  ];
  return zlib.gzipSync(Buffer.concat(entries));
}

test("SourceFetcher and the build sandbox accept only the same GitHub global PAX comment", async () => {
  const valid = archive(`52 comment=${"a".repeat(40)}\n`);
  await assert.doesNotReject(inspectFrameworkArchive(valid));
  assert.doesNotThrow(() => validateSourceArchiveBytes(valid));

  for (const content of [
    `51 path=${"a".repeat(40)}\n`,
    `52 comment=${"z".repeat(40)}\n`,
    `53 comment=${"a".repeat(40)}\n`,
  ]) {
    const invalid = archive(content);
    await assert.rejects(inspectFrameworkArchive(invalid), ViteArchiveInspectionError);
    assert.throws(() => validateSourceArchiveBytes(invalid));
  }
});
