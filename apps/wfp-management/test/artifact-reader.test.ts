import { describe, expect, it, vi } from "vitest";

import { createArtifactReader } from "../src/artifact-reader.js";
import type { BuildObjectBody } from "../src/bindings.js";
import {
  BUILD_OBJECTS_BUCKET,
  BUILD_OBJECTS_BUCKET_EU,
  buildBundle,
  storedObject,
} from "./worker-fixtures.js";

const UNAVAILABLE = "wfp_artifact_unavailable";

function bucket(object: BuildObjectBody | null) {
  return { get: vi.fn(async () => object) };
}

/** The US bucket holds `object`; the EU bucket is empty unless `eu` names its object. */
function createArtifactReaderOver(
  objects: ReturnType<typeof bucket>,
  eu: ReturnType<typeof bucket> = bucket(null),
) {
  return createArtifactReader([
    { bucketName: BUILD_OBJECTS_BUCKET, objects },
    { bucketName: BUILD_OBJECTS_BUCKET_EU, objects: eu },
  ]);
}

describe("build artifact reader", () => {
  it("returns the verified bundle of the exact stored object", async () => {
    const bundle = await buildBundle();
    const objects = bucket(storedObject(bundle.body, bundle.provenance.output));
    const eu = bucket(null);

    const artifact = await createArtifactReaderOver(objects, eu)(bundle.provenance as never);

    expect(objects.get).toHaveBeenCalledExactlyOnceWith(bundle.provenance.output.key);
    expect(eu.get).not.toHaveBeenCalled();
    expect(artifact.provenance).toEqual(bundle.provenance);
    expect(artifact.files.map((file) => file.path)).toEqual(["/index.html"]);
  });

  it("reads an EU project's bundle from the EU bucket its provenance names", async () => {
    const bundle = await buildBundle();
    const provenance = {
      ...bundle.provenance,
      output: { ...bundle.provenance.output, bucket: BUILD_OBJECTS_BUCKET_EU },
    };
    const us = bucket(storedObject(bundle.body, provenance.output));
    const eu = bucket(storedObject(bundle.body, provenance.output));

    const artifact = await createArtifactReaderOver(us, eu)(provenance as never);

    expect(eu.get).toHaveBeenCalledExactlyOnceWith(provenance.output.key);
    expect(us.get).not.toHaveBeenCalled();
    expect(artifact.provenance.output.bucket).toBe(BUILD_OBJECTS_BUCKET_EU);
  });

  it("refuses an unbound bucket or an oversized artifact before any bucket read", async () => {
    const bundle = await buildBundle();
    const objects = bucket(storedObject(bundle.body, bundle.provenance.output));
    const eu = bucket(storedObject(bundle.body, bundle.provenance.output));
    const read = createArtifactReaderOver(objects, eu);

    for (const other of ["ohmyho-builds-production", "ohmyho-builds-production-eu"]) {
      await expect(
        read({
          ...bundle.provenance,
          output: { ...bundle.provenance.output, bucket: other },
        } as never),
      ).rejects.toThrow(UNAVAILABLE);
    }
    await expect(
      read({
        ...bundle.provenance,
        output: { ...bundle.provenance.output, byteLength: 30 * 1024 * 1024 + 1 },
      } as never),
    ).rejects.toThrow(UNAVAILABLE);
    expect(objects.get).not.toHaveBeenCalled();
    expect(eu.get).not.toHaveBeenCalled();
  });

  it.each([
    ["version", { version: "fedcba9876543210fedcba9876543210" }],
    ["etag", { httpEtag: '"replaced"' }],
    ["size", { size: 1 }],
  ])("refuses a stored object with another %s without reading its body", async (_name, change) => {
    const bundle = await buildBundle();
    const arrayBuffer = vi.fn(async () => bundle.body.slice().buffer as ArrayBuffer);
    const objects = bucket(
      storedObject(bundle.body, bundle.provenance.output, { ...change, arrayBuffer }),
    );

    await expect(createArtifactReaderOver(objects)(bundle.provenance as never)).rejects.toThrow(
      UNAVAILABLE,
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("refuses bytes whose SHA-256 or length differs from the provenance", async () => {
    const bundle = await buildBundle();
    const tampered = bundle.body.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const truncated = bundle.body.slice(0, bundle.body.byteLength - 1);

    for (const body of [tampered, truncated]) {
      const objects = bucket(
        storedObject(bundle.body, bundle.provenance.output, {
          arrayBuffer: async () => body.slice().buffer as ArrayBuffer,
        }),
      );
      await expect(createArtifactReaderOver(objects)(bundle.provenance as never)).rejects.toThrow(
        UNAVAILABLE,
      );
    }
  });

  it("refuses a small stored object that unpacks above 30 MiB", async () => {
    const bundle = await buildBundle(
      [1, 2, 3, 4].map((fill) => ({
        path: `/assets/fill-${fill}.bin`,
        body: new Uint8Array(8 * 1024 * 1024).fill(fill),
      })),
    );
    expect(bundle.body.byteLength).toBeLessThan(1024 * 1024);
    const objects = bucket(storedObject(bundle.body, bundle.provenance.output));

    await expect(createArtifactReaderOver(objects)(bundle.provenance as never)).rejects.toThrow(
      UNAVAILABLE,
    );
  });

  it("refuses a missing object, an unreadable body and a failing bucket with one redacted error", async () => {
    const bundle = await buildBundle();
    const unreadable = storedObject(bundle.body, bundle.provenance.output, {
      arrayBuffer: async () => {
        throw new Error("stream interrupted");
      },
    });
    const failing = {
      get: vi.fn(async () => {
        throw new Error("bucket detail");
      }),
    };

    for (const objects of [bucket(null), bucket(unreadable), failing]) {
      const error = await createArtifactReaderOver(objects)(bundle.provenance as never).catch(
        (caught: unknown) => caught,
      );
      expect(String(error)).toBe(`Error: ${UNAVAILABLE}`);
    }
  });
});
