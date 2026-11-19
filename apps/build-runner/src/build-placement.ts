import { BuildBrokerInputError } from "@ohmyhost/build-broker";

import type { R2BucketBinding } from "./r2-object-store.js";
import type { BuildSandboxNamespace } from "./sandbox-executor.js";

/** The hosting regions a project can choose; the build objects bucket of a build names one. */
export type BuildRegion = "us" | "eu";

/** The build objects bucket of one region: its name and its R2 binding. */
export interface BuildObjectsBucket {
  readonly region: BuildRegion;
  readonly bucketName: string;
  readonly bucket: R2BucketBinding;
}

/**
 * One region of the build path: its build objects bucket, the Durable Object namespace whose
 * container application is constrained to the region, and the location hint that places a new
 * sandbox object there (`enam` for North America, `weur` for the EU jurisdiction).
 */
export interface BuildPlacement extends BuildObjectsBucket {
  readonly namespace: BuildSandboxNamespace;
  readonly locationHint: "enam" | "weur";
}

export interface BuildObjectsBindings {
  readonly BUILD_OBJECTS_US: R2BucketBinding;
  readonly BUILD_OBJECTS_EU: R2BucketBinding;
  readonly BUILD_OBJECTS_BUCKET_US: string;
  readonly BUILD_OBJECTS_BUCKET_EU: string;
}

export interface BuildPlacementBindings extends BuildObjectsBindings {
  readonly BUILD_SANDBOX: BuildSandboxNamespace;
  readonly BUILD_SANDBOX_EU: BuildSandboxNamespace;
}

const BUCKET_NAME_PATTERN = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u;

/** The build objects buckets by region; the two names must differ. */
export function buildObjectsBuckets(bindings: BuildObjectsBindings): readonly BuildObjectsBucket[] {
  const buckets: readonly BuildObjectsBucket[] = Object.freeze([
    Object.freeze({
      region: "us" as const,
      bucketName: bindings.BUILD_OBJECTS_BUCKET_US,
      bucket: bindings.BUILD_OBJECTS_US,
    }),
    Object.freeze({
      region: "eu" as const,
      bucketName: bindings.BUILD_OBJECTS_BUCKET_EU,
      bucket: bindings.BUILD_OBJECTS_EU,
    }),
  ]);
  if (
    buckets.some(
      ({ bucketName, bucket }) =>
        typeof bucketName !== "string" ||
        !BUCKET_NAME_PATTERN.test(bucketName) ||
        typeof bucket?.head !== "function" ||
        typeof bucket.get !== "function" ||
        typeof bucket.put !== "function" ||
        typeof bucket.createMultipartUpload !== "function",
    ) ||
    bindings.BUILD_OBJECTS_BUCKET_US === bindings.BUILD_OBJECTS_BUCKET_EU
  ) {
    throw new Error("build_runner_configuration_invalid");
  }
  return buckets;
}

/** The one mapping bucket -> region -> sandbox namespace and location hint of this Worker. */
export function buildPlacements(bindings: BuildPlacementBindings): readonly BuildPlacement[] {
  const namespaces = {
    us: Object.freeze({ namespace: bindings.BUILD_SANDBOX, locationHint: "enam" as const }),
    eu: Object.freeze({ namespace: bindings.BUILD_SANDBOX_EU, locationHint: "weur" as const }),
  };
  const placements = buildObjectsBuckets(bindings).map((bucket) =>
    Object.freeze({ ...bucket, ...namespaces[bucket.region] }),
  );
  if (
    placements.some(
      ({ namespace }) =>
        typeof namespace?.idFromName !== "function" || typeof namespace.get !== "function",
    )
  ) {
    throw new Error("build_runner_configuration_invalid");
  }
  return Object.freeze(placements);
}

/** The entry of the bucket a command or receipt names; an unknown bucket is refused. */
export function ofBucket<T extends BuildObjectsBucket>(
  entries: readonly T[],
  bucketName: unknown,
): T {
  const entry = entries.find((candidate) => candidate.bucketName === bucketName);
  if (entry === undefined) throw new BuildBrokerInputError();
  return entry;
}
