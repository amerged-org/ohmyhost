import { parseVerifiedArtifactBundle, type VerifiedArtifactBundle } from "@ohmyhost/build-broker";

import type { BuildObjectsBinding } from "./bindings.js";

const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;

/**
 * Reads one build bundle from the build objects bucket its provenance names (the bucket of the
 * project's hosting region) and returns it only when the stored object still is the exact
 * version, etag, size and SHA-256 the provenance names. Any other bucket name is refused.
 */
export function createArtifactReader(
  buckets: readonly Readonly<{ bucketName: string; objects: BuildObjectsBinding }>[],
): (provenance: VerifiedArtifactBundle["provenance"]) => Promise<VerifiedArtifactBundle> {
  return async (provenance) => {
    const output = provenance.output;
    const bucket = buckets.find((candidate) => candidate.bucketName === output.bucket);
    if (bucket === undefined || output.byteLength > MAX_BUNDLE_BYTES) {
      throw unavailable();
    }
    try {
      const object = await bucket.objects.get(output.key);
      if (
        object === null ||
        object.version !== output.versionId ||
        object.httpEtag !== output.eTag ||
        object.size !== output.byteLength
      ) {
        throw unavailable();
      }
      // The bundle parser verifies the byte length and the SHA-256 of exactly these bytes.
      return await parseVerifiedArtifactBundle({
        body: new Uint8Array(await object.arrayBuffer()),
        expectedProvenance: provenance,
      });
    } catch {
      throw unavailable();
    }
  };
}

function unavailable(): Error {
  return new Error("wfp_artifact_unavailable");
}
