import { readMakeGrantTokens, type CatalogCore } from "./management.js";
import { listMakeOrganizations, listMakeTeams } from "./providers/make-catalog.js";
import { executeMakeEndpoint, runMakeScenario } from "./providers/make-execution.js";

type MakeAction =
  | { kind: "endpoint"; appName: string; appVersion: number; endpointName: string }
  | {
      kind: "scenario";
      scenarioId: number;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      pathPrefix: string;
    };

interface BindingAuthority {
  organizationId: string;
  bindingId: string;
  capabilityDigest: string;
}

interface Binding {
  organizationId: string;
  principalId: string;
  grantId: string;
  providerOrganizationId: number;
  teamId: number;
  connectionId: number;
  action: MakeAction;
}

type Admission = "admitted" | "conflict" | "completed" | "uncertain" | "denied" | "running";
type Terminal = "completed" | "uncertain" | "denied";

export interface ExecutionCore extends CatalogCore {
  readMakeActionBinding(input: BindingAuthority): Promise<Binding | null>;
  admitMakeActionExecution(
    input: BindingAuthority & { executionId: string; inputDigest: string; grantGeneration: number },
  ): Promise<Admission>;
  finishMakeActionExecution(input: {
    organizationId: string;
    bindingId: string;
    executionId: string;
    state: Terminal;
  }): Promise<unknown>;
}

export interface MakeActionRequest {
  key: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
}

export type MakeActionResult =
  | { state: "completed"; output: unknown }
  | {
      state:
        | "already_completed"
        | "denied"
        | "reconnect_required"
        | "conflict"
        | "uncertain"
        | "running";
    };

const actionKey =
  /^omh_make_v1\.([0-7][0-9A-HJKMNP-TV-Z]{25})\.([0-7][0-9A-HJKMNP-TV-Z]{25})\.[A-Za-z0-9_-]{43}$/u;
const idempotencyKey = /^[A-Za-z0-9._:-]{1,128}$/u;
const text = new TextEncoder();

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Resolve the app capability before any provider call and claim the intent just before dispatch. */
export async function runMakeAction(
  request: MakeActionRequest,
  dependencies: {
    environment: "development" | "production";
    key: Uint8Array;
    registration: string;
    core: ExecutionCore;
    refresh?: NonNullable<Parameters<typeof readMakeGrantTokens>[1]["refresh"]>;
    fetcher?: typeof fetch;
  },
): Promise<MakeActionResult> {
  const deadline = AbortSignal.timeout(30_000);
  const send = dependencies.fetcher ?? fetch;
  const fetcher: typeof fetch = (request, options) =>
    send(request, {
      ...options,
      signal: options?.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
    });
  const parsed = actionKey.exec(request.key);
  if (!parsed?.[1] || !parsed[2] || !idempotencyKey.test(request.idempotencyKey))
    return { state: "denied" };
  const authority = {
    organizationId: parsed[1],
    bindingId: parsed[2],
    capabilityDigest: await digest(request.key),
  };
  const binding = await dependencies.core.readMakeActionBinding(authority);
  if (!binding || binding.organizationId !== authority.organizationId) return { state: "denied" };

  const { grant, tokens } = await readMakeGrantTokens(
    {
      organizationId: binding.organizationId,
      principalId: binding.principalId,
      grantId: binding.grantId,
    },
    dependencies,
  );
  const scopes =
    binding.action.kind === "endpoint"
      ? ["apps:read", "endpoints:read", "endpoints:run"]
      : ["scenarios:read", "scenarios:write", "scenarios:run"];
  if (!scopes.every((scope) => tokens.scopes?.includes(scope)))
    return { state: "reconnect_required" };

  const organizations = await listMakeOrganizations(
    { zone: "eu1", accessToken: tokens.accessToken },
    fetcher,
  );
  const matching = organizations.filter(
    (organization) => organization.id === binding.providerOrganizationId,
  );
  const [organization] = matching;
  if (!organization || matching.length !== 1) return { state: "denied" };
  const teams = await listMakeTeams(
    { zone: organization.zone, accessToken: tokens.accessToken, organizationId: organization.id },
    fetcher,
  );
  if (!teams.some((team) => team.id === binding.teamId)) return { state: "denied" };

  const executionId = await digest(
    JSON.stringify(["make-action-v1", authority.bindingId, request.idempotencyKey]),
  );
  const inputDigest = await digest(JSON.stringify(request.input));
  const admission: { state: Admission } = { state: "denied" };
  const provider = {
    zone: organization.zone,
    teamId: binding.teamId,
    accessToken: tokens.accessToken,
    authorizeDispatch: async () => {
      if (deadline.aborted) return false;
      admission.state = await dependencies.core.admitMakeActionExecution({
        ...authority,
        executionId,
        inputDigest,
        grantGeneration: grant.generation,
      });
      return admission.state === "admitted";
    },
  };
  const outcome =
    binding.action.kind === "endpoint"
      ? await executeMakeEndpoint(
          {
            ...provider,
            ...binding.action,
            input: request.input,
            connectionId: binding.connectionId,
            idempotencyKey: executionId,
          },
          fetcher,
        )
      : await runMakeScenario(
          {
            ...provider,
            scenarioId: binding.action.scenarioId,
            connectionId: binding.connectionId,
            method: binding.action.method,
            pathPrefix: binding.action.pathPrefix,
            inputs: request.input,
          },
          fetcher,
        );
  if (admission.state !== "admitted")
    return { state: admission.state === "completed" ? "already_completed" : admission.state };

  const terminal = outcome.ok ? "completed" : outcome.kind;
  try {
    await dependencies.core.finishMakeActionExecution({
      organizationId: authority.organizationId,
      bindingId: authority.bindingId,
      executionId,
      state: terminal,
    });
  } catch {
    return { state: "uncertain" };
  }
  return outcome.ok ? { state: "completed", output: outcome.output } : { state: outcome.kind };
}
