import { createHash, timingSafeEqual } from "node:crypto";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import {
  parseNativeAuthRecoveryManifest,
  RecoveryArchiveError,
  validateRecoveryPassphrase,
} from "./index.js";

/** Open only the exact ready export bytes and Core-bound manifest, never an operator-supplied SQL file. */
export async function readNativeRestoreArchive(input: {
  readonly archive: Uint8Array;
  readonly archiveSha256: string;
  readonly nativeManifest: string;
  readonly nativeManifestSha256: string;
  readonly passphrase: string;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly sql: Uint8Array;
  readonly manifest: ReturnType<typeof parseNativeAuthRecoveryManifest>;
}> {
  const fail = (): never => {
    throw new RecoveryArchiveError("recovery_archive_invalid");
  };
  validateRecoveryPassphrase(input.passphrase);
  input.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > 536870912 ||
    input.archive.byteLength > input.maximumBytes + 1048576 ||
    !/^[a-f0-9]{64}$/u.test(input.archiveSha256) ||
    !/^[a-f0-9]{64}$/u.test(input.nativeManifestSha256)
  )
    return fail();
  const equalDigest = (bytes: Uint8Array, expected: string) =>
    timingSafeEqual(createHash("sha256").update(bytes).digest(), Buffer.from(expected, "hex"));
  if (
    !equalDigest(input.archive, input.archiveSha256) ||
    !equalDigest(Buffer.from(input.nativeManifest), input.nativeManifestSha256)
  )
    return fail();
  const manifest = parseNativeAuthRecoveryManifest(JSON.parse(input.nativeManifest));
  if (JSON.stringify(manifest) !== input.nativeManifest) return fail();
  const reader = new ZipReader(new Uint8ArrayReader(input.archive), {
    useWebWorkers: false,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  try {
    const entries = await reader.getEntries();
    const names = entries.map((entry) => entry.filename);
    if (
      new Set(names).size !== names.length ||
      names.some(
        (name) =>
          !["manifest.json", "auth.sql", "dev.sql", "prod.sql", "shared.sql"].includes(name),
      ) ||
      !names.includes("manifest.json") ||
      !names.includes("auth.sql") ||
      (names.includes("shared.sql") && (names.includes("dev.sql") || names.includes("prod.sql"))) ||
      entries.some(
        (entry) =>
          entry.directory ||
          entry.symlink ||
          !entry.encrypted ||
          entry.zipCrypto ||
          entry.extraFieldAES?.strength !== 3 ||
          entry.extraFieldAES?.vendorVersion !== 2 ||
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 1 ||
          entry.uncompressedSize > input.maximumBytes,
      ) ||
      entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > input.maximumBytes
    )
      return fail();
    const auth = entries.find((entry) => entry.filename === "auth.sql");
    const metadata = entries.find((entry) => entry.filename === "manifest.json");
    if (
      !auth ||
      !metadata ||
      !("getData" in auth) ||
      !("getData" in metadata) ||
      !auth.getData ||
      !metadata.getData ||
      metadata.uncompressedSize > 16384
    )
      return fail();
    const recorded = await metadata.getData(new Uint8ArrayWriter(), {
      password: input.passphrase,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const expected = Buffer.from(input.nativeManifest);
    if (recorded.length !== expected.length || !timingSafeEqual(recorded, expected)) return fail();
    const sql = await auth.getData(new Uint8ArrayWriter(), {
      password: input.passphrase,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (sql.length !== auth.uncompressedSize) return fail();
    return { sql, manifest };
  } catch {
    return fail();
  } finally {
    await reader.close();
  }
}
