import { CORE_BINDING, CORE_LAYOUT, verifyCoreLayout } from "./core.js";
import type { D1Database } from "./d1-types.js";
import { fenceDatabase } from "./fence.js";

export const BUCKET_COUNT = 1024;

/**
 * `uint32_be(sha256(organization_id)[0..4]) mod 1024`, computed once at organization creation. In the shared core the
 * bucket is routing METADATA (the identity of a future derived fact shard); it never selects an authority database.
 */
export async function bucketOf(organizationId: string): Promise<number> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(organizationId)),
  );
  const word =
    ((digest[0] as number) << 24) |
    ((digest[1] as number) << 16) |
    ((digest[2] as number) << 8) |
    (digest[3] as number);
  return (word >>> 0) % BUCKET_COUNT;
}

/** The authority database of one command: always the shared core, never one of several organization shards. */
export interface SharedCoreRoute {
  readonly layout: typeof CORE_LAYOUT;
  /** The one logical partition of the core; doorbells and sweepers address work by `(kind, shardId)`. */
  readonly shardId: 0;
  readonly binding: typeof CORE_BINDING;
  /**
   * The core as seen by the bucket's organizations: every batch carries the authoritative bucket fence of the core
   * itself (an operator quarantine of one bucket's organizations). A partition-wide route (`routeShard`) is the raw
   * database and has no bucket.
   */
  readonly db: D1Database;
  readonly bucket: number | null;
}

/** The only way a command reaches an authority database. Implemented by one shared-core router. */
export interface AuthorityRouter {
  routeOrganization(organizationId: string): Promise<SharedCoreRoute>;
  routeBucket(bucket: number): Promise<SharedCoreRoute>;
  /** A sweeper drains the partition, not one organization. Only partition 0 (the core) exists. */
  routeShard(shardId: number): Promise<SharedCoreRoute>;
  /** Proves, once per isolate, that the bound database is the shared-core-v1 schema; refuses it otherwise. */
  assertLayout(): Promise<void>;
  /** Kept for the route-refresh protocol: the core has no bucket map to re-read, so this changes nothing. */
  invalidate(): void;
}

/** Routes every organization, bucket and partition to the one `CONTROL_CORE` database. */
export class SharedCoreRouter implements AuthorityRouter {
  #verified: Promise<void> | null = null;

  constructor(private readonly core: D1Database) {}

  assertLayout(): Promise<void> {
    if (this.#verified === null) {
      const verification = verifyCoreLayout(this.core);
      // A failure is not cached: a lost connection must not turn a healthy core into a permanently refused one.
      verification.catch(() => {
        this.#verified = null;
      });
      this.#verified = verification;
    }
    return this.#verified;
  }

  async routeBucket(bucket: number): Promise<SharedCoreRoute> {
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= BUCKET_COUNT) {
      throw new Error(`bucket ${bucket} has no shard`);
    }
    await this.assertLayout();
    return {
      layout: CORE_LAYOUT,
      shardId: 0,
      binding: CORE_BINDING,
      db: fenceDatabase(this.core, bucket),
      bucket,
    };
  }

  async routeOrganization(organizationId: string): Promise<SharedCoreRoute> {
    return this.routeBucket(await bucketOf(organizationId));
  }

  async routeShard(shardId: number): Promise<SharedCoreRoute> {
    if (shardId !== 0) throw new Error(`shard ${shardId} does not exist`);
    await this.assertLayout();
    return { layout: CORE_LAYOUT, shardId: 0, binding: CORE_BINDING, db: this.core, bucket: null };
  }

  invalidate(): void {}
}
