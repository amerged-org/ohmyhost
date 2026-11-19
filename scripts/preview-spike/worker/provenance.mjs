export const FIXTURE_NAMES = Object.freeze([
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const VERSION = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

export function parseFixtureManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "fixtureArchiveSha256,fixtureSourceRevision,fixtureTrees,hmrOverlays" ||
    !REVISION.test(value.fixtureSourceRevision ?? "") ||
    !SHA256.test(value.fixtureArchiveSha256 ?? "") ||
    !value.fixtureTrees ||
    typeof value.fixtureTrees !== "object" ||
    Array.isArray(value.fixtureTrees) ||
    Object.keys(value.fixtureTrees).sort().join(",") !== [...FIXTURE_NAMES].sort().join(",") ||
    !Object.values(value.fixtureTrees).every(
      (item) => typeof item === "string" && SHA256.test(item),
    ) ||
    !value.hmrOverlays ||
    typeof value.hmrOverlays !== "object" ||
    Array.isArray(value.hmrOverlays) ||
    Object.keys(value.hmrOverlays).sort().join(",") !== "astro-edge,react-vite,vanilla-vite" ||
    !Object.values(value.hmrOverlays).every((item) => typeof item === "string" && SHA256.test(item))
  )
    throw new Error("fixture_provenance_invalid");
  return value;
}

/** These source fields are operator/build-context claims, not a cryptographic build attestation. */
export function runtimeProvenance(env, manifest, fixture) {
  return {
    workerVersionId: VERSION.test(env.CF_VERSION_METADATA?.id ?? "")
      ? env.CF_VERSION_METADATA.id
      : null,
    sourceRevision: REVISION.test(env.SPIKE_SOURCE_REVISION ?? "")
      ? env.SPIKE_SOURCE_REVISION
      : null,
    fixtureSourceRevision: manifest?.fixtureSourceRevision ?? null,
    fixtureArchiveSha256: manifest?.fixtureArchiveSha256 ?? null,
    fixtureTreeSha256: manifest?.fixtureTrees?.[fixture] ?? null,
    hmrOverlaySha256: manifest?.hmrOverlays?.[fixture] ?? null,
  };
}
