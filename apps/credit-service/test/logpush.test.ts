import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  SizeLimitError,
  bytesOf,
  gunzip,
  gzip,
  sha256Hex,
  streamOf,
  textOf,
} from "../src/bytes.js";
import {
  InvalidUsageObject,
  isBillableEvent,
  listWindowObjects,
  objectTime,
  readUsageObject,
} from "../src/logpush.js";
import { DAY_MS, dayOf, floorDay, floorHour, isoOf, parseBoundary } from "../src/time.js";
import {
  MemoryBucket,
  NOW,
  SCRIPT_A,
  SCRIPT_B,
  logLine,
  logObject,
  objectKey,
  type TestEvent,
} from "./doubles.js";

const read = (bytes: Uint8Array, size = bytes.byteLength) =>
  readUsageObject({ size, body: streamOf(bytes) }, "ohmyho-test");

describe("time and bytes helpers", () => {
  it("floors to hours and days and formats UTC days", () => {
    expect(isoOf(floorHour(NOW))).toBe("2026-10-30T09:00:00.000Z");
    expect(isoOf(floorDay(NOW))).toBe("2026-10-30T00:00:00.000Z");
    expect(dayOf(NOW)).toBe("2026-10-30");
  });

  it("accepts only canonical aligned boundaries", () => {
    expect(parseBoundary("2026-10-30T09:00:00.000Z", 3_600_000)).toBe(floorHour(NOW));
    for (const bad of ["2026-10-30T09:00:00Z", "2026-10-30T09:30:00.000Z", "nonsense"])
      expect(() => parseBoundary(bad, 3_600_000)).toThrow("credit_service_boundary_invalid");
    expect(() => parseBoundary("2026-10-30T09:00:00.000Z", DAY_MS)).toThrow();
  });

  it("round-trips gzip, hashes and enforces the decompression limit", async () => {
    const text = "x".repeat(1000);
    const packed = await gzip(bytesOf(text));
    expect(textOf(await gunzip(streamOf(packed), 5000))).toBe(text);
    await expect(gunzip(streamOf(packed), 999)).rejects.toBeInstanceOf(SizeLimitError);
    await expect(gunzip(streamOf(bytesOf("not gzip")), 100)).rejects.toThrow();
    expect(await sha256Hex(bytesOf("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(() => textOf(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});

describe("Logpush object names", () => {
  it("takes the batch start of the file name as the object time", () => {
    expect(objectTime(objectKey(8, 15, 0, "aa"), new Date(0))).toBe(
      Date.UTC(2026, 9, 30, 8, 15, 0),
    );
  });

  it("falls back to the upload time for names without a timestamp", () => {
    const uploaded = new Date(Date.UTC(2026, 9, 30, 7, 5, 0));
    expect(objectTime("usage/20261030/plain.log.gz", uploaded)).toBe(uploaded.getTime());
    expect(objectTime("usage/20261030/plain.log.gz", new Date(Number.NaN))).toBeNull();
  });

  it("ignores keys outside usage/YYYYMMDD/*.log.gz", () => {
    for (const key of [
      "other/20261030/x.log.gz",
      "usage/20261030/x.txt",
      "usage/20261030/sub/x.log.gz",
      "usage/x.log.gz",
    ])
      expect(objectTime(key, new Date(NOW))).toBeNull();
  });

  it("lists exactly the objects of one hour across pages and the next day's folder", async () => {
    const bucket = new MemoryBucket();
    bucket.seed(objectKey(8, 59, 40, "before"), "x");
    bucket.seed(objectKey(9, 0, 0, "first"), "x");
    bucket.seed(objectKey(9, 59, 50, "last"), "x");
    bucket.seed(objectKey(10, 0, 0, "after"), "x");
    bucket.seed("usage/20261030/plain.log.gz", "x", new Date(Date.UTC(2026, 9, 30, 9, 30)));
    bucket.seed("elsewhere/20261030/x.log.gz", "x");
    const nine = await listWindowObjects(bucket, Date.UTC(2026, 9, 30, 9));
    expect(nine.map((object) => object.key)).toEqual([
      objectKey(9, 0, 0, "first"),
      objectKey(9, 59, 50, "last"),
      "usage/20261030/plain.log.gz",
    ]);

    // The last hour of a day: a batch that starts before midnight but sits in the next day's folder.
    const midnight = new MemoryBucket();
    midnight.seed(objectKey(23, 59, 40, "late"), "x");
    midnight.seed(objectKey(23, 59, 40, "folder-next", "20261031"), "x");
    midnight.seed(objectKey(24, 0, 10, "tomorrow", "20261031"), "x");
    const window = await listWindowObjects(midnight, Date.UTC(2026, 9, 30, 23));
    expect(window.map((object) => object.key)).toEqual([
      objectKey(23, 59, 40, "late"),
      objectKey(23, 59, 40, "folder-next", "20261031"),
    ]);

    const many = new MemoryBucket();
    for (let index = 0; index < 1203; index++)
      many.seed(objectKey(9, 10, 0, String(index).padStart(5, "0")), "x");
    expect(await listWindowObjects(many, Date.UTC(2026, 9, 30, 9))).toHaveLength(1203);
  });
});

describe("billable events", () => {
  it("bills every fetch invocation that ran a script, including canceled and CPU-limited ones", () => {
    for (const outcome of ["ok", "exception", "exceededCpu", "canceled", "unknown"])
      expect(isBillableEvent("fetch", outcome)).toBe(true);
    expect(isBillableEvent("fetch", "scriptNotFound")).toBe(false);
    for (const type of [
      "scheduled",
      "alarm",
      "queue",
      "email",
      "worker_rpc",
      "hibernatable_web_socket",
    ])
      expect(isBillableEvent(type, "ok")).toBe(false);
  });
});

describe("readUsageObject", () => {
  it("aggregates requests and CPU per script and counts only billable events", async () => {
    const events: TestEvent[] = [
      { cpu: 3 },
      { cpu: 4, outcome: "exception" },
      { cpu: 100, outcome: "exceededCpu" },
      { cpu: 6, outcome: "canceled" },
      { cpu: 50, type: "scheduled" },
      { cpu: 2, outcome: "scriptNotFound" },
      { script: SCRIPT_B, cpu: 9 },
      { script: "platform-gateway", cpu: 1 },
    ];
    const usage = await read(logObject(events));
    expect(usage.scripts.get(SCRIPT_A)).toEqual({ requests: 4, cpuMs: 113 });
    expect(usage.scripts.get(SCRIPT_B)).toEqual({ requests: 1, cpuMs: 9 });
    expect(usage.scripts.size).toBe(2);
    expect(usage.foreign).toBe(1);
    expect(usage.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("gives the same digest to the same batch and a different one to other content", async () => {
    const first = await read(logObject([{ cpu: 1 }]));
    const again = await read(logObject([{ cpu: 1 }]));
    const other = await read(logObject([{ cpu: 2 }]));
    expect(again.digest).toBe(first.digest);
    expect(other.digest).not.toBe(first.digest);
    expect((await read(logObject([]))).scripts.size).toBe(0);
  });

  const rejected = async (bytes: Uint8Array, reason: string, size?: number) => {
    const failure = await read(bytes, size).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InvalidUsageObject);
    expect((failure as InvalidUsageObject).reason).toBe(reason);
  };

  it("rejects objects that can never be read as usage", async () => {
    await rejected(logObject([{}]), "compressed_limit", 5 * 1024 * 1024);
    await rejected(bytesOf("plain text"), "gzip");
    await rejected(gzipSync(Buffer.from([0xff, 0xfe, 0x0a])), "utf8");
    await rejected(gzipSync("{not json}\n"), "json");
    await rejected(gzipSync("[1]\n"), "fields");
    await rejected(gzipSync("null\n"), "fields");
    await rejected(gzipSync(JSON.stringify({ ScriptName: SCRIPT_A }) + "\n"), "fields");
    await rejected(logObject([{ namespace: "someone-else" }]), "values");
    await rejected(logObject([{ cpu: -1 }]), "values");
    await rejected(logObject([{ cpu: 1.5 }]), "values");
    const withObjectScript = JSON.parse(logLine()) as Record<string, unknown>;
    withObjectScript["ScriptName"] = { name: SCRIPT_A };
    await rejected(gzipSync(JSON.stringify(withObjectScript) + "\n"), "values");
    await rejected(gzipSync("x".repeat(9 * 1024 * 1024)), "plain_limit");
    await rejected(gzipSync("\n".repeat(5001).replaceAll("\n", `${logLine()}\n`)), "record_limit");
  });
});
