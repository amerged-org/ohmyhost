// OpenNext's request-scoped cache adapters for the optional path revalidation mode. The binding is
// scoped by the platform; customer input never selects a project, environment or deployment.
const CACHE_NAME = "ohmyhost-next-cache";
const OBSERVED = "ohmyhost-next-cache:observed";
const ENTRY_GENERATIONS = "ohmyhost-next-cache:entry-generations";
const PENDING_INVALIDATIONS = "ohmyhost-next-cache:pending-invalidations";

function requestMap(name) {
  const requestCache = globalThis.__openNextAls?.getStore()?.requestCache;
  if (!requestCache || typeof requestCache.getOrCreate !== "function")
    throw new Error("Next cache request generation is unavailable");
  return requestCache.getOrCreate(name);
}

function binding(getContext) {
  const result = getContext()?.env?.OHMYHOST_NEXT_CACHE;
  if (!result) throw new Error("Next cache binding is unavailable");
  return result;
}

function validGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function observedKey(key, cacheType) {
  return `${cacheType}:${key}`;
}

function observedGeneration(key, cacheType) {
  const generation = requestMap(OBSERVED).get(observedKey(key, cacheType));
  if (!validGeneration(generation)) throw new Error("Next cache request generation is unavailable");
  return generation;
}

function entryGeneration(lastModified) {
  const generation = requestMap(ENTRY_GENERATIONS).get(lastModified);
  if (!validGeneration(generation)) throw new Error("Next cache entry generation is unavailable");
  return generation;
}

// Next may catch a rejected detached operation while finishing the response. Retain the original
// request-local promise until the outer response boundary observes it.
function trackMutation(work) {
  const writes = requestMap(PENDING_INVALIDATIONS);
  const pending = Promise.resolve().then(work);
  writes.set(Symbol(), pending);
  return pending;
}

/** Creates the OpenNext incremental-cache and next-mode tag-cache overrides. */
export function createWritableNextCaches({ getContext, staticAssets }) {
  const incrementalCache = {
    name: CACHE_NAME,
    async get(key, cacheType = "cache") {
      // Keep the existing Cache Components contract: request-time composable values are never
      // persisted. This feature changes page/fetch path invalidation only.
      if (cacheType === "composable") return null;
      const result = await binding(getContext).get({ key, cacheType });
      if (!result || !validGeneration(result.generation))
        throw new Error("Next cache result is invalid");
      requestMap(OBSERVED).set(observedKey(key, cacheType), result.generation);
      if (result.kind === "tombstone") return null;
      if (result.kind === "missing") {
        // Static build output is a private seed, not an authoritative cache: never consult it
        // after a deletion, and never turn an asset-service failure into a cache miss.
        const assets = getContext()?.env?.ASSETS;
        if (!assets) throw new Error("Next cache asset binding is unavailable");
        const response = await assets.fetch(staticAssets.getAssetUrl(key, cacheType));
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("Next cache asset lookup failed");
        const value = await response.json();
        requestMap(ENTRY_GENERATIONS).set(1, 0);
        return { value, lastModified: 1 };
      }
      if (
        result.kind !== "value" ||
        typeof result.valueJson !== "string" ||
        !validGeneration(result.entryGeneration) ||
        result.entryGeneration > result.generation ||
        !Number.isSafeInteger(result.lastModified) ||
        result.lastModified <= 1
      )
        throw new Error("Next cache result is invalid");
      const value = JSON.parse(result.valueJson);
      requestMap(ENTRY_GENERATIONS).set(result.lastModified, result.entryGeneration);
      return { value, lastModified: result.lastModified };
    },
    async set(key, value, cacheType = "cache") {
      if (cacheType === "composable") return;
      await trackMutation(async () => {
        const expectedGeneration = observedGeneration(key, cacheType);
        const result = await binding(getContext).put({
          key,
          cacheType,
          valueJson: JSON.stringify(value),
          expectedGeneration,
        });
        if (
          result?.kind !== "stored" ||
          result.generation !== expectedGeneration ||
          !Number.isSafeInteger(result.lastModified) ||
          result.lastModified <= 1
        )
          throw new Error("Next cache write result is invalid");
        requestMap(ENTRY_GENERATIONS).set(result.lastModified, expectedGeneration);
      });
    },
    async delete(key) {
      await trackMutation(async () => {
        const expectedGeneration = observedGeneration(key, "cache");
        const result = await binding(getContext).delete({ key, expectedGeneration });
        if (result?.kind !== "deleted" || !validGeneration(result.generation))
          throw new Error("Next cache delete result is invalid");
        requestMap(OBSERVED).set(observedKey(key, "cache"), result.generation);
      });
    },
  };

  async function readTags(tags) {
    const names = [...new Set(tags)];
    if (names.length === 0) return [];
    const result = await binding(getContext).readTags({ tags: names });
    if (
      !validGeneration(result?.generation) ||
      !Array.isArray(result.tags) ||
      result.tags.length !== names.length
    )
      throw new Error("Next cache tags are invalid");
    for (const [index, row] of result.tags.entries()) {
      if (row === null) continue;
      if (
        typeof row !== "object" ||
        row.tag !== names[index] ||
        !validGeneration(row.generation) ||
        row.generation > result.generation ||
        !Number.isSafeInteger(row.revalidatedAt) ||
        ![row.stale, row.expire].every((value) => value === null || Number.isSafeInteger(value))
      )
        throw new Error("Next cache tags are invalid");
    }
    return result.tags;
  }

  const tagCache = {
    name: "ohmyhost-next-tag-cache",
    mode: "nextMode",
    async getLastRevalidated(tags) {
      return Math.max(0, ...(await readTags(tags)).map((row) => row?.revalidatedAt ?? 0));
    },
    async hasBeenRevalidated(tags, lastModified) {
      if (tags.length === 0) return false;
      const generation = entryGeneration(lastModified);
      const now = Date.now();
      return (await readTags(tags)).some(
        (row) =>
          row !== null && row.generation > generation && (row.expire === null || row.expire <= now),
      );
    },
    async isStale(tags, lastModified) {
      if (tags.length === 0) return false;
      const generation = entryGeneration(lastModified);
      const now = Date.now();
      return (await readTags(tags)).some(
        (row) =>
          row !== null &&
          row.generation > generation &&
          row.stale !== null &&
          row.stale >= lastModified &&
          (row.expire === null || row.expire > now),
      );
    },
    async writeTags(tags) {
      if (tags.length === 0) return;
      const normalized = tags.map((tag) => (typeof tag === "string" ? { tag } : tag));
      await trackMutation(async () => {
        const result = await binding(getContext).writeTags({ tags: normalized });
        if (!validGeneration(result?.generation) || !Number.isSafeInteger(result.revalidatedAt))
          throw new Error("Next cache tag write result is invalid");
      });
    },
  };
  return { incrementalCache, tagCache };
}
