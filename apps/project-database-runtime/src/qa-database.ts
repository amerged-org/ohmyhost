import {
  readDatabaseBindingScope,
  readDatabaseRegistrationReceipt,
  type DatabaseBindingScope,
  type DatabaseRegistrationReceipt,
} from "./registry.js";

const FIXTURES = [
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
] as const;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u;
const SCOPE_FIELDS = [
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
];

type Fixture = (typeof FIXTURES)[number];
export interface QaDatabaseScope extends DatabaseBindingScope {
  readonly fixture: Fixture;
  readonly handle: string;
  readonly origin: string;
  readonly principalId: string;
  readonly devAccessEpoch: number;
}
export interface QaDatabaseBindings {
  readonly DATABASE_REGION: "us" | "eu";
  readonly QA_DATABASE_PLATFORM?: string;
  readonly QA_DATABASE_MANIFEST?: string;
  readonly QA_DATABASE_AUTHORITY?: {
    readRuntimeBinding(input: unknown): Promise<unknown>;
    readApiProjectDataChangeState(input: unknown): Promise<unknown>;
  };
  readonly QA_DEV_ACCESS?: { authorizeDevAccessSession(input: unknown): Promise<unknown> };
  readonly QA_CREDIT?: { read(input: unknown): Promise<unknown> };
}

const unavailable = () => new Error("qa_database_unavailable");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;

/** One trusted absolute budget spans authority, the database transaction and the final check. */
export function qaDatabaseDeadline(milliseconds = 30_000) {
  const at = Date.now() + milliseconds;
  return {
    async run<T>(operation: () => Promise<T>, onTimeout?: () => void): Promise<T> {
      const remaining = at - Date.now();
      if (remaining <= 0) {
        onTimeout?.();
        throw unavailable();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              onTimeout?.();
              reject(unavailable());
            }, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

function readScope(value: unknown, fixture: Fixture): QaDatabaseScope {
  if (!record(value) || !exact(value, SCOPE_FIELDS) || value["fixture"] !== fixture)
    throw unavailable();
  const scope = readDatabaseBindingScope(
    {
      organizationId: value["organizationId"],
      projectId: value["projectId"],
      environmentId: value["environmentId"],
      physicalEnvironmentId: value["physicalEnvironmentId"],
      registrationVersion: value["registrationVersion"],
      region: value["region"],
    },
    "eu",
  );
  const handle = value["handle"],
    principalId = value["principalId"],
    epoch = value["devAccessEpoch"];
  if (
    typeof handle !== "string" ||
    handle.length > 59 ||
    !HANDLE.test(handle) ||
    value["origin"] !== `https://dev-${handle}.dev.check.omh.st` ||
    typeof principalId !== "string" ||
    principalId.length < 1 ||
    principalId.length > 256 ||
    principalId !== principalId.trim() ||
    [...principalId].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    }) ||
    !positive(epoch) ||
    !positive(value["registrationVersion"])
  )
    throw unavailable();
  return {
    ...scope,
    fixture,
    handle,
    origin: value["origin"] as string,
    principalId,
    devAccessEpoch: epoch as number,
  };
}

/** Both caller and database service must carry the same trusted seven-project manifest. */
export function readQaDatabaseCall(
  input: unknown,
  env: QaDatabaseBindings,
): {
  readonly scope: QaDatabaseScope;
  readonly operation: "query" | "transaction";
  readonly input: unknown;
} {
  if (
    env.QA_DATABASE_PLATFORM !== "development" ||
    env.DATABASE_REGION !== "eu" ||
    typeof env.QA_DATABASE_MANIFEST !== "string" ||
    env.QA_DATABASE_MANIFEST.length > 16_384 ||
    !record(input) ||
    !exact(input, ["platform", "scope", "operation", "input"]) ||
    input["platform"] !== "development" ||
    (input["operation"] !== "query" && input["operation"] !== "transaction") ||
    !record(input["scope"])
  )
    throw unavailable();
  const manifest: unknown = JSON.parse(env.QA_DATABASE_MANIFEST);
  if (
    !record(manifest) ||
    !exact(manifest, ["platform", "projects"]) ||
    manifest["platform"] !== "development" ||
    !Array.isArray(manifest["projects"]) ||
    manifest["projects"].length !== FIXTURES.length
  )
    throw unavailable();
  const projects = manifest["projects"];
  const suppliedScope = input["scope"];
  const scopes = FIXTURES.map((fixture, index) => readScope(projects[index], fixture));
  for (const field of ["projectId", "environmentId", "physicalEnvironmentId"] as const) {
    if (new Set(scopes.map((scope) => scope[field])).size !== FIXTURES.length) throw unavailable();
  }
  const expected = scopes.find((scope) => scope.fixture === suppliedScope["fixture"]);
  if (!expected || !exact(suppliedScope, SCOPE_FIELDS)) throw unavailable();
  const supplied = readScope(suppliedScope, expected.fixture);
  if (
    SCOPE_FIELDS.some(
      (field) =>
        expected[field as keyof QaDatabaseScope] !== supplied[field as keyof QaDatabaseScope],
    )
  )
    throw unavailable();
  return { scope: expected, operation: input["operation"], input: input["input"] };
}

/** Sample real Core authority and the exact regional registry at each operation fence. */
export async function authorizeQaDatabase(
  env: QaDatabaseBindings,
  scope: QaDatabaseScope,
  inspect: () => Promise<DatabaseRegistrationReceipt | null>,
  now: () => number = () => Date.now(),
): Promise<void> {
  const authority = env.QA_DATABASE_AUTHORITY,
    dev = env.QA_DEV_ACCESS,
    credit = env.QA_CREDIT;
  if (!authority || !dev || !credit) throw unavailable();
  const state = await authority.readApiProjectDataChangeState({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    principalId: scope.principalId,
  });
  if (!record(state) || !record(state["assignments"])) throw unavailable();
  const assignments = state["assignments"];
  const development = assignments["dev"],
    production = assignments["prod"];
  const generations = state["registrationGenerations"];
  if (
    assignments["dataMode"] !== "isolated" ||
    !record(development) ||
    development["environment"] !== "dev" ||
    development["environmentId"] !== scope.environmentId ||
    development["dataEnvironmentId"] !== scope.physicalEnvironmentId ||
    !record(production) ||
    production["environment"] !== "prod" ||
    typeof production["environmentId"] !== "string" ||
    !ULID.test(production["environmentId"]) ||
    production["environmentId"] === scope.environmentId ||
    typeof production["dataEnvironmentId"] !== "string" ||
    !ULID.test(production["dataEnvironmentId"]) ||
    production["dataEnvironmentId"] === scope.physicalEnvironmentId ||
    !Array.isArray(generations)
  )
    throw unavailable();
  const current = generations.filter(
    (value) => record(value) && value["dataEnvironmentId"] === scope.physicalEnvironmentId,
  );
  if (current.length !== 1 || current[0]?.["registrationVersion"] !== scope.registrationVersion)
    throw unavailable();
  const live = readDatabaseRegistrationReceipt(
    await authority.readRuntimeBinding({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    }),
  );
  if (
    live.provider !== "pgcf" ||
    live.organizationId !== scope.organizationId ||
    live.projectId !== scope.projectId ||
    live.physicalEnvironmentId !== scope.physicalEnvironmentId ||
    live.region !== scope.region ||
    live.registrationVersion !== scope.registrationVersion ||
    live.status !== "active" ||
    live.authorizedEnvironmentIds.length !== 1 ||
    live.authorizedEnvironmentIds[0] !== scope.environmentId
  )
    throw unavailable();
  const local = await inspect();
  if (!local || JSON.stringify(readDatabaseRegistrationReceipt(local)) !== JSON.stringify(live))
    throw unavailable();
  if (
    (await dev.authorizeDevAccessSession({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      handle: scope.handle,
      origin: scope.origin,
      principalId: scope.principalId,
      devAccessEpoch: scope.devAccessEpoch,
    })) !== true
  )
    throw unavailable();
  const instant = now();
  if (!Number.isFinite(instant)) throw unavailable();
  const decision = await credit.read({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    now: new Date(instant).toISOString(),
  });
  if (
    !record(decision) ||
    decision["organizationId"] !== scope.organizationId ||
    decision["projectId"] !== scope.projectId ||
    decision["environmentId"] !== scope.environmentId ||
    decision["allowed"] !== true ||
    decision["paidAllowed"] !== true ||
    decision["reason"] !== null ||
    typeof decision["checkedAt"] !== "string" ||
    typeof decision["expiresAt"] !== "string" ||
    !Number.isFinite(Date.parse(decision["checkedAt"])) ||
    !Number.isFinite(Date.parse(decision["expiresAt"])) ||
    Date.parse(decision["checkedAt"]) > now() ||
    Date.parse(decision["expiresAt"]) <= now()
  )
    throw unavailable();
}
