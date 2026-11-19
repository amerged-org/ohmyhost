import type { BoundMakeAction, MakeActionBinding } from "./make-action-execution.js";
/** The selected WorkOS session workspace is context; only current memberships may expand it. */
export async function integrationSessionMemberships(
  principal: AuthenticatedPrincipal,
  accountProfile:
    | { read(principal: AuthenticatedPrincipal): Promise<{ organization_ids: readonly string[] }> }
    | undefined,
): Promise<AuthenticatedPrincipal> {
  if (
    !principal.session ||
    principal.userApiKey ||
    principal.connectUser ||
    principal.authorizationPrincipal.kind !== "user"
  )
    return principal;
  if (principal.actorId !== `user:${principal.session.userId}`)
    throw new Error("integration_origin_denied");
  if (!accountProfile) return principal;
  const profile = await accountProfile.read(principal);
  if (!Array.isArray(profile.organization_ids))
    throw new Error("integration_memberships_unavailable");
  const ids = [...new Set(profile.organization_ids.map((id) => parseUlid(id)))];
  const permitted = principal.authorizationRestriction?.organizationIds;
  return {
    ...principal,
    organizationIds: permitted ? ids.filter((id) => permitted.includes(id)) : ids,
  };
}

import { parseUlid, restrictionAllows } from "@ohmyhost/platform";
interface ProjectScope {
  projectId?: string;
  environmentId?: string;
}

interface IntegrationMutationRequest {
  organizationId: string;
  principal: AuthenticatedPrincipal;
  idempotencyKey: string;
}
interface ConnectionSelection {
  providerOrganizationId: number;
  teamId: number;
  connectionId: number;
}
export interface ConnectionImport {
  id: string;
  grant_id: string;
  project_id: string;
  environment_id: string;
  provider_organization_id: number;
  team_id: number;
  connection_id: number;
}

function mutationAuthority(request: {
  principal: AuthenticatedPrincipal;
  delegation?: McpHandoffAuthority;
}): unknown {
  const p = request.principal;
  const restriction = intersectAuthorizationRestriction(
    p.authorizationRestriction,
    p.authorizationScopeConstraint,
  );
  const ceiling = restriction ? { authorizationRestriction: restriction } : {};
  if (p.userApiKey)
    return {
      kind: "api_key",
      keyId: p.userApiKey.id,
      userId: p.userApiKey.userId,
      workosOrganizationId: p.userApiKey.organizationId,
      ...ceiling,
    };
  if (p.connectUser && request.delegation) return { ...request.delegation, kind: "mcp" };
  if (p.session)
    return {
      kind: "session",
      sessionId: p.session.sessionId,
      userId: p.session.userId,
      workosOrganizationId: p.session.organizationId,
      tokenExpiresAt: p.session.tokenExpiresAt,
      ...ceiling,
    };
  throw new Error("integration_origin_denied");
}

/** Private Control composition; callers never receive provider credentials. */
export interface IntegrationManagementPort {
  availability(): Promise<{ readonly available: boolean; readonly catalogAvailable?: boolean }>;
  disconnect?(input: {
    organizationId: string;
    principal: AuthenticatedPrincipal;
    grantId: string;
    idempotencyKey: string;
  }): Promise<{ state: "disconnected" | "revocation_pending" }>;
  catalog?(
    input: ProjectScope & {
      organizationId: string;
      principalId: string;
      grantId: string;
      providerOrganizationId?: number;
      teamId?: number;
    },
  ): Promise<unknown>;
  importConnection?(
    input: IntegrationMutationRequest &
      ConnectionSelection & { grantId: string; projectId: string; environmentId: string },
  ): Promise<ConnectionImport | null>;
  bindMakeAction?(
    input: IntegrationMutationRequest & {
      projectId: string;
      environmentId: string;
      importId: string;
      action: BoundMakeAction;
    },
  ): Promise<MakeActionBinding | null>;
  list?(input: {
    readonly organizationId: string;
    readonly principal: AuthenticatedPrincipal;
    readonly workspaceOnly?: boolean;
  }): Promise<{
    readonly connections: readonly {
      id: string;
      provider: "make";
      state: string;
      created_at: string;
    }[];
  }>;
  status(input: {
    readonly organizationId: string;
    readonly requestId: string;
    readonly principal: AuthenticatedPrincipal;
  }): Promise<{
    readonly state: "pending" | "consumed" | "expired";
    readonly expires_at: string;
  } | null>;
  begin(
    input: IntegrationMutationRequest & ProjectScope,
  ): Promise<{ readonly request_id: string; readonly url: string; readonly expires_at: string }>;
}

export interface IntegrationPortalStore {
  createConnectionImport?(input: unknown): Promise<{ importId: string } | null>;
  createMakeActionBinding?(input: unknown): Promise<{ bindingId: string } | null>;
  listConnectionGrantMetadata?(input: unknown): Promise<unknown>;
  createIntegrationPortalHandoff(input: unknown): Promise<"created" | "replay" | "conflict">;
  readIntegrationPortalHandoff(
    input: unknown,
  ): Promise<
    (import("./connections-portal.js").ConnectionPortalHandoff & { expiresAt: string }) | null
  >;
  consumeIntegrationPortalHandoff(
    input: unknown,
  ): Promise<import("./connections-portal.js").ConnectionPortalHandoff | null>;
  readIntegrationPortalStatus(input: unknown): Promise<unknown>;
}

import { createHash, createHmac } from "node:crypto";
import { intersectAuthorizationRestriction } from "@ohmyhost/platform";
import type { AuthenticatedPrincipal } from "./contracts.js";
import type { McpHandoffAuthority } from "@ohmyhost/database";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** Compose a feature handoff using the original credential and a deterministic, scoped opaque link. */
export function createIntegrationManagement(input: {
  readonly origin: string;
  readonly secret: string;
  readonly registration: string;
  readonly resolveOrganization: (workosOrganizationId: string) => Promise<string | null>;
  readonly store: IntegrationPortalStore;
  readonly broker?: {
    listConnectionCatalog(input: unknown): Promise<unknown>;
    disconnectConnectionGrant(
      input: unknown,
    ): Promise<{ state: "disconnected" | "revocation_pending" }>;
  };
  readonly readiness: () => Promise<boolean>;
  readonly catalogReadiness?: () => Promise<boolean>;
  readonly delegation: (
    principal: AuthenticatedPrincipal,
    organizationId: string,
  ) => Promise<McpHandoffAuthority | null>;
}): IntegrationManagementPort {
  if (input.secret.length < 32 || new URL(input.origin).origin !== input.origin)
    throw new TypeError("Invalid integration portal configuration");
  return {
    async availability() {
      return {
        available: await input.readiness(),
        catalogAvailable: input.catalogReadiness ? await input.catalogReadiness() : false,
      };
    },
    async disconnect(request) {
      if (!input.broker) throw new Error("connection_provider_unavailable");
      const delegation = request.principal.connectUser
        ? await input.delegation(request.principal, request.organizationId)
        : null;
      if (request.principal.connectUser && !delegation)
        throw new Error("integration_origin_denied");
      const result = await input.broker.disconnectConnectionGrant({
        organizationId: request.organizationId,
        principalId: request.principal.actorId,
        grantId: request.grantId,
        idempotencyKey: request.idempotencyKey,
        mutationAuthority: mutationAuthority({
          principal: request.principal,
          ...(delegation ? { delegation } : {}),
        }),
      });
      if (result.state !== "disconnected" && result.state !== "revocation_pending")
        throw new Error("integration_response_invalid");
      return { state: result.state };
    },
    async catalog(request) {
      if (!input.broker) throw new Error("connection_provider_unavailable");
      const raw = await input.broker.listConnectionCatalog(request);
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("integration_response_invalid");
      const value = raw as Record<string, unknown>;
      const named = (rows: unknown) => {
        if (!Array.isArray(rows) || rows.length > 10000)
          throw new Error("integration_response_invalid");
        return rows.map((row: unknown) => {
          if (!row || typeof row !== "object" || Array.isArray(row))
            throw new Error("integration_response_invalid");
          const item = row as Record<string, unknown>;
          if (
            !Number.isSafeInteger(item["id"]) ||
            Number(item["id"]) < 1 ||
            typeof item["name"] !== "string" ||
            item["name"].length > 1024
          )
            throw new Error("integration_response_invalid");
          return { id: Number(item["id"]), name: item["name"] };
        });
      };
      return {
        organizations: named(value["organizations"]),
        teams: named(value["teams"]),
        connections: named(value["connections"]),
      };
    },
    async bindMakeAction(request) {
      if (!input.store.createMakeActionBinding || !input.broker)
        throw new Error("connection_provider_unavailable");
      const {
        organizationId,
        principal,
        projectId,
        environmentId,
        importId,
        action,
        idempotencyKey,
      } = request;
      const delegation = principal.connectUser
        ? await input.delegation(principal, organizationId)
        : null;
      if (principal.connectUser && !delegation) throw new Error("integration_origin_denied");
      const authority = mutationAuthority({ principal, ...(delegation ? { delegation } : {}) });
      const identity = JSON.stringify([
        "make-action-binding-v1",
        organizationId,
        principal.actorId,
        projectId,
        environmentId,
        importId,
        idempotencyKey,
      ]);
      let value = BigInt(`0x${sha256(identity).slice(0, 32)}`);
      let bindingId = "";
      for (let index = 0; index < 26; index += 1) {
        bindingId = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".charAt(Number(value & 31n)) + bindingId;
        value >>= 5n;
      }
      const secret = createHmac("sha256", input.secret)
        .update(
          `ohmyhost:make-action-key:v1
${identity}`,
        )
        .digest("base64url");
      const key = `omh_make_v1.${organizationId}.${bindingId}.${secret}`;
      const saved = await input.store.createMakeActionBinding({
        organizationId,
        principalId: principal.actorId,
        projectId,
        environmentId,
        importId,
        bindingId,
        capabilityDigest: sha256(key),
        idempotencyKey,
        mutationAuthority: authority,
        action,
      });
      if (!saved || saved.bindingId !== bindingId) return null;
      return { binding_id: bindingId, execution_key: key };
    },
    async importConnection(request) {
      if (!input.store.createConnectionImport || !input.broker)
        throw new Error("connection_provider_unavailable");
      const { organizationId, principal, grantId, providerOrganizationId, teamId, connectionId } =
        request;
      const delegation = principal.connectUser
        ? await input.delegation(principal, organizationId)
        : null;
      if (principal.connectUser && !delegation) throw new Error("integration_origin_denied");
      const authority = mutationAuthority({ principal, ...(delegation ? { delegation } : {}) });
      // A workspace catalog read proves the selected connection belongs to this grant and team.
      const result = await input.broker.listConnectionCatalog({
        organizationId,
        principalId: principal.actorId,
        grantId,
        providerOrganizationId,
        teamId,
      });
      if (
        !result ||
        typeof result !== "object" ||
        !("connections" in result) ||
        !Array.isArray(result.connections)
      )
        throw new Error("integration_response_invalid");
      if (!result.connections.some((row) => row && row.id === connectionId)) return null;
      const saved = await input.store.createConnectionImport({
        organizationId,
        principalId: principal.actorId,
        grantId,
        projectId: request.projectId,
        environmentId: request.environmentId,
        providerOrganizationId,
        teamId,
        connectionId,
        idempotencyKey: request.idempotencyKey,
        mutationAuthority: authority,
      });
      if (!saved) return null;
      return {
        id: parseUlid(saved.importId),
        grant_id: grantId,
        project_id: request.projectId,
        environment_id: request.environmentId,
        provider_organization_id: providerOrganizationId,
        team_id: teamId,
        connection_id: connectionId,
      };
    },
    async list(request) {
      if (!input.store.listConnectionGrantMetadata)
        throw new Error("integration_metadata_unavailable");
      const raw = await input.store.listConnectionGrantMetadata({
        organizationId: request.organizationId,
        principalId: request.principal.actorId,
        ...(request.workspaceOnly ? { workspaceOnly: true } : {}),
      });
      if (!Array.isArray(raw)) throw new Error("integration_metadata_unavailable");
      const connections = raw.map((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("integration_metadata_unavailable");
        const row = value as Record<string, unknown>;
        if (
          typeof row["grantId"] !== "string" ||
          !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(row["grantId"]) ||
          row["provider"] !== "make" ||
          !["active", "refreshing", "reconnect_required", "disconnecting", "disconnected"].includes(
            String(row["state"]),
          ) ||
          typeof row["createdAt"] !== "string" ||
          !Number.isFinite(Date.parse(row["createdAt"]))
        )
          throw new Error("integration_metadata_unavailable");
        return {
          id: row["grantId"],
          provider: "make" as const,
          state: String(row["state"]),
          created_at: row["createdAt"],
        };
      });
      return { connections };
    },
    async status(request) {
      const p = request.principal;
      const credentialId = p.userApiKey?.id ?? p.connectUser?.clientId ?? p.session?.sessionId;
      if (!credentialId || !/^[a-f0-9]{64}$/u.test(request.requestId)) return null;
      const raw = await input.store.readIntegrationPortalStatus({
        handoffHash: request.requestId,
        principalId: p.actorId,
        credentialId,
      });
      if (!raw || typeof raw !== "object") return null;
      const record = raw as Record<string, unknown>;
      if (
        record["organizationId"] !== request.organizationId ||
        record["userId"] !== p.actorId.slice(5) ||
        !["pending", "consumed", "expired"].includes(String(record["state"])) ||
        typeof record["expiresAt"] !== "string" ||
        !Number.isFinite(Date.parse(record["expiresAt"]))
      )
        return null;
      return {
        state: record["state"] as "pending" | "consumed" | "expired",
        expires_at: record["expiresAt"],
      };
    },
    async begin(request) {
      if (!(await input.readiness())) throw new Error("connection_provider_unavailable");
      const p = request.principal;
      if (p.authorizationPrincipal.kind !== "user" || !p.actorId.startsWith("user:user_"))
        throw new Error("integration_origin_denied");
      const restriction = intersectAuthorizationRestriction(
        p.authorizationRestriction,
        p.authorizationScopeConstraint,
      );
      if (
        !restrictionAllows(
          restriction,
          { kind: "organization", organizationId: parseUlid(request.organizationId) },
          "integrations:manage",
        )
      )
        throw new Error("integration_origin_denied");
      let originatingCredential: unknown, originatingDelegation: McpHandoffAuthority | undefined;
      if (p.userApiKey) {
        const key = p.userApiKey;
        if (
          p.actorId !== `user:${key.userId}` ||
          !key.permissions.includes("integrations:manage") ||
          (await input.resolveOrganization(key.organizationId)) !== request.organizationId
        )
          throw new Error("integration_origin_denied");
        originatingCredential = {
          kind: "api_key",
          keyId: key.id,
          userId: key.userId,
          workosOrganizationId: key.organizationId,
          ...(restriction ? { authorizationRestriction: restriction } : {}),
        };
      } else if (p.connectUser) {
        originatingDelegation = (await input.delegation(p, request.organizationId)) ?? undefined;
        if (!originatingDelegation || originatingDelegation.action !== "integrations:manage")
          throw new Error("integration_origin_denied");
      } else if (p.session) {
        const session = p.session;
        if (
          p.actorId !== `user:${session.userId}` ||
          !session.sessionId ||
          !Number.isSafeInteger(session.tokenExpiresAt) ||
          session.tokenExpiresAt <= 0
        )
          throw new Error("integration_origin_denied");
        originatingCredential = {
          kind: "session",
          sessionId: session.sessionId,
          userId: session.userId,
          workosOrganizationId: session.organizationId,
          tokenExpiresAt: session.tokenExpiresAt,
          ...(restriction ? { authorizationRestriction: restriction } : {}),
        };
      } else throw new Error("integration_origin_denied");
      const credentialId =
        p.userApiKey?.id ?? originatingDelegation?.clientId ?? p.session?.sessionId;
      if (!credentialId) throw new Error("integration_origin_denied");
      const scope = JSON.stringify([
        request.organizationId,
        request.projectId,
        request.environmentId,
        p.actorId,
        credentialId,
        request.idempotencyKey,
        input.registration,
      ]);
      const legacy = request.projectId !== undefined;
      const token = createHmac("sha256", input.secret)
        .update(`ohmyhost:integration-portal:${legacy ? "v1" : "workspace:v1"}\n${scope}`)
        .digest("base64url");
      const handoffHash = sha256(token);
      const result = await input.store.createIntegrationPortalHandoff({
        handoffHash,
        organizationId: request.organizationId,
        ...(legacy ? { projectId: request.projectId, environmentId: request.environmentId } : {}),
        principalId: p.actorId,
        registration: input.registration,
        credentialId,
        idempotencyKeyHash: sha256(request.idempotencyKey),
        requestDigest: sha256(scope),
        ...(originatingCredential === undefined ? {} : { originatingCredential }),
        ...(originatingDelegation === undefined ? {} : { originatingDelegation }),
      });
      if (result === "conflict") throw new Error("integration_idempotency_conflict");
      if (result !== "created" && result !== "replay")
        throw new Error("integration_handoff_unavailable");
      const stored = await input.store.readIntegrationPortalHandoff({
        handoffHash,
        principalId: p.actorId,
      });
      if (
        !stored ||
        stored.userId !== p.actorId.slice(5) ||
        stored.organizationId !== request.organizationId ||
        stored.projectId !== request.projectId ||
        stored.environmentId !== request.environmentId ||
        stored.registration !== input.registration ||
        !Number.isFinite(Date.parse(stored.expiresAt))
      )
        throw new Error("integration_handoff_unavailable");
      return {
        request_id: handoffHash,
        url: `${input.origin}/connections/authorize?request=${token}`,
        expires_at: stored.expiresAt,
      };
    },
  };
}
