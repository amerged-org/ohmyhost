// Test-only configuration builder. Input must come from verified Development readbacks.
// It does not discover projects, obtain credentials, deploy, or mutate provider state.
export const QA_FIXTURES = Object.freeze([
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
]);

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u;
const FIELDS = [
  "fixture",
  "organizationId",
  "projectId",
  "environmentId",
  "physicalEnvironmentId",
  "registrationVersion",
  "region",
  "handle",
  "origin",
  "principalId",
  "devAccessEpoch",
].sort();

function invalid() {
  throw new Error("qa_configuration_invalid");
}
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.join(",")
  );
}
function positive(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

export function validateQaManifest(value) {
  if (
    !exact(value, ["platform", "projects"]) ||
    value.platform !== "development" ||
    !Array.isArray(value.projects) ||
    value.projects.length !== QA_FIXTURES.length
  )
    invalid();
  const seenProjects = new Set();
  const seenEnvironments = new Set();
  const seenPhysical = new Set();
  const projects = value.projects.map((scope, index) => {
    if (
      !exact(scope, FIELDS) ||
      scope.fixture !== QA_FIXTURES[index] ||
      ![
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        scope.physicalEnvironmentId,
      ].every((item) => typeof item === "string" && ULID.test(item)) ||
      !positive(scope.registrationVersion) ||
      scope.region !== "eu" ||
      typeof scope.handle !== "string" ||
      scope.handle.length > 59 ||
      !HANDLE.test(scope.handle) ||
      scope.origin !== `https://dev-${scope.handle}.dev.check.omh.st` ||
      typeof scope.principalId !== "string" ||
      scope.principalId.length < 1 ||
      scope.principalId.length > 256 ||
      scope.principalId !== scope.principalId.trim() ||
      [...scope.principalId].some(
        (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
      ) ||
      !positive(scope.devAccessEpoch) ||
      seenProjects.has(scope.projectId) ||
      seenEnvironments.has(scope.environmentId) ||
      seenPhysical.has(scope.physicalEnvironmentId)
    )
      invalid();
    seenProjects.add(scope.projectId);
    seenEnvironments.add(scope.environmentId);
    seenPhysical.add(scope.physicalEnvironmentId);
    return { ...scope };
  });
  return { platform: "development", projects };
}

// The same manifest must be installed in both trusted Workers. Its shape alone does not verify
// live ownership, assignments or registration; the operator must verify the seven QA projects.
export function buildQaBindings(input) {
  const manifest = validateQaManifest(input);
  return {
    vars: { SPIKE_QA_MANIFEST: JSON.stringify(manifest) },
    services: [
      {
        binding: "QA_DEV_ACCESS",
        service: "ohmyho-control-store-poc-private-fullstack",
        entrypoint: "DevAccessRuntime",
      },
      {
        binding: "QA_CREDIT",
        service: "ohmyho-control-store-poc-private-fullstack",
        entrypoint: "GatewayCreditRuntime",
      },
      {
        binding: "QA_SCOPED_DATABASE",
        service: "ohmyho-project-database-development-eu",
        entrypoint: "ProjectDatabaseQa",
      },
    ],
    databaseRuntime: {
      vars: {
        QA_DATABASE_PLATFORM: "development",
        QA_DATABASE_MANIFEST: JSON.stringify(manifest),
      },
      services: [
        {
          binding: "QA_DATABASE_AUTHORITY",
          service: "ohmyho-control-store-poc-private-fullstack",
          entrypoint: "PreviewQaDatabaseAuthority",
        },
        {
          binding: "QA_DEV_ACCESS",
          service: "ohmyho-control-store-poc-private-fullstack",
          entrypoint: "DevAccessRuntime",
        },
        {
          binding: "QA_CREDIT",
          service: "ohmyho-control-store-poc-private-fullstack",
          entrypoint: "GatewayCreditRuntime",
        },
      ],
    },
    activation: { allowed: false, blocker: "qa_live_scopes_unverified" },
  };
}
