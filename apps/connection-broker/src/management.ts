import { encodeBytes } from "./encoding.js";
import type { OriginObserver } from "./ports.js";
import { openGrantTokens } from "./grant-vault.js";
import { supportsMakeGrantRegistration } from "./registry.js";
import {
  listMakeOrganizations,
  listMakeTeams,
  listMakeConnections,
} from "./providers/make-catalog.js";
interface ManagementScope {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  principalId: string;
  grantId: string;
}
interface Grant {
  grantId: string;
  organizationId: string;
  principalId: string;
  projectId?: string;
  environmentId?: string;
  registration: string;
  generation: number;
  encryptedTokens: { nonce: string; ciphertext: string; keyVersion: number };
}
export interface CatalogCore {
  readActiveConnectionGrant(input: {
    organizationId: string;
    principalId: string;
    grantId: string;
  }): Promise<Grant | null>;
}
export async function observeMutation(
  observer: OriginObserver,
  input: Parameters<OriginObserver["observeIntegrationMutation"]>[0],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observer.observeIntegrationMutation(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("connection_authority_unavailable")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const b64 = (s: string) => {
  if (!/^(?:[a-f0-9]{2})+$/u.test(s)) throw new Error();
  return encodeBytes(Uint8Array.from(s.match(/../gu) ?? [], (v) => Number.parseInt(v, 16)));
};
const zones = new Set(["eu1", "eu2", "we", "us1", "us2", "eu1-celonis", "us1-celonis"]);
interface MakeGrantDependencies {
  environment: "development" | "production";
  key: Uint8Array;
  registration: string;
  core: CatalogCore;
  refresh?: (grantId: string) => Promise<"refreshed" | "in_progress" | "reconnect_required">;
  fetcher?: typeof fetch;
}

export async function readMakeGrantTokens(input: ManagementScope, deps: MakeGrantDependencies) {
  let grant = await deps.core.readActiveConnectionGrant({
    organizationId: input.organizationId,
    principalId: input.principalId,
    grantId: input.grantId,
  });
  if (
    !grant ||
    grant.grantId !== input.grantId ||
    grant.organizationId !== input.organizationId ||
    grant.principalId !== input.principalId ||
    (input.projectId === undefined) !== (input.environmentId === undefined) ||
    (grant.projectId === undefined) !== (grant.environmentId === undefined) ||
    !supportsMakeGrantRegistration(deps.environment, deps.registration, grant.registration) ||
    grant.projectId !== input.projectId ||
    grant.environmentId !== input.environmentId
  )
    throw new Error("connection_authority_denied");
  const originalRegistration = grant.registration;
  const open = (value: Grant) =>
    openGrantTokens(
      {
        environment: deps.environment,
        workspace: value.organizationId,
        human: value.principalId,
        provider: "make",
        registration: value.registration,
        grantId: value.grantId,
        generation: value.generation,
        keyVersion: String(value.encryptedTokens.keyVersion),
      },
      {
        nonce: b64(value.encryptedTokens.nonce),
        ciphertext: b64(value.encryptedTokens.ciphertext),
      },
      deps.key,
    );
  let tokens = await open(grant);
  if (tokens.expiresAt && Date.parse(tokens.expiresAt) <= Date.now()) {
    if (!deps.refresh) throw new Error("connection_reconnect_required");
    const outcome = await deps.refresh(grant.grantId);
    if (outcome !== "refreshed")
      throw new Error(
        outcome === "in_progress"
          ? "connection_refresh_in_progress"
          : "connection_reconnect_required",
      );
    grant = await deps.core.readActiveConnectionGrant({
      organizationId: input.organizationId,
      principalId: input.principalId,
      grantId: input.grantId,
    });
    if (
      !grant ||
      grant.grantId !== input.grantId ||
      grant.organizationId !== input.organizationId ||
      grant.principalId !== input.principalId ||
      (grant.projectId === undefined) !== (grant.environmentId === undefined) ||
      !supportsMakeGrantRegistration(deps.environment, deps.registration, grant.registration) ||
      grant.registration !== originalRegistration ||
      grant.projectId !== input.projectId ||
      grant.environmentId !== input.environmentId
    )
      throw new Error("connection_authority_denied");
    tokens = await open(grant);
    if (tokens.expiresAt && Date.parse(tokens.expiresAt) <= Date.now())
      throw new Error("connection_reconnect_required");
  }
  return { grant, tokens };
}

export async function listConnectionCatalog(
  input: ManagementScope & { providerOrganizationId?: number; teamId?: number },
  deps: MakeGrantDependencies,
) {
  const { tokens } = await readMakeGrantTokens(input, deps);
  // Make lists the authenticated user's organizations across zones; only the
  // reviewed fixed bootstrap origin is used to discover them.
  const found = await listMakeOrganizations(
    { zone: "eu1", accessToken: tokens.accessToken },
    deps.fetcher,
  );
  const organizations = found.flatMap((org) => {
    return zones.has(org.zone) ? [{ id: org.id, name: org.name, zone: org.zone }] : [];
  });
  if (input.providerOrganizationId === undefined)
    return { organizations, teams: [], connections: [] };
  const matches = organizations.filter((org) => org.id === input.providerOrganizationId);
  if (matches.length !== 1) throw new Error("make_organization_unavailable");
  const selected = matches[0] as NonNullable<(typeof matches)[0]>;
  const teams = await listMakeTeams(
    { zone: selected.zone, accessToken: tokens.accessToken, organizationId: selected.id },
    deps.fetcher,
  );
  if (input.teamId === undefined) return { organizations, teams, connections: [] };
  if (!teams.some((team) => team.id === input.teamId)) throw new Error("make_team_unavailable");
  const connections = await listMakeConnections(
    { zone: selected.zone, accessToken: tokens.accessToken, teamId: input.teamId },
    deps.fetcher,
  );
  return { organizations, teams, connections };
}
