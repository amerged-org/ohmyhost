import type { Clock } from "@ohmyhost/platform";

export interface OrganizationMcpConnection {
  connection_id: string;
  client_id: string;
  user_id: string;
  connected_at: string;
}

/** The Owner's view of the MCP clients connected to one workspace, and the workspace-only disconnect. */
export interface OrganizationMcpConnectionsPort {
  list(request: { organizationId: string }): Promise<{
    connections: readonly OrganizationMcpConnection[];
  }>;
  revoke(request: {
    organizationId: string;
    connectionId: string;
  }): Promise<{ state: "pending" | "revoked" } | null>;
}

/** The Core's identity commands for workspace MCP connections; the route checks Owner authority first. */
export interface OrganizationMcpConnectionsRuntime {
  listOrganizationMcpConnections(input: unknown): Promise<unknown>;
  revokeOrganizationMcpConnection(input: unknown): Promise<unknown>;
}

const METHODS = ["listOrganizationMcpConnections", "revokeOrganizationMcpConnection"] as const;

export function isOrganizationMcpConnectionsRuntime(
  value: unknown,
): value is OrganizationMcpConnectionsRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    METHODS.every((method) => typeof Reflect.get(value, method) === "function")
  );
}

type Row = Record<string, unknown>;

const instantOf = (stored: unknown) => new Date(`${String(stored).slice(0, 23)}Z`).toISOString();

export function createOrganizationMcpConnectionsPort(input: {
  readonly runtime: OrganizationMcpConnectionsRuntime;
  readonly clock: Clock;
}): OrganizationMcpConnectionsPort {
  const { runtime, clock } = input;
  return {
    async list({ organizationId }) {
      const rows = await runtime.listOrganizationMcpConnections({ organizationId });
      if (!Array.isArray(rows)) throw new Error("Invalid MCP connection list");
      return {
        connections: (rows as Row[]).map((row) => ({
          connection_id: String(row["connection_id"]),
          client_id: String(row["client_id"]),
          user_id: String(row["user_id"]),
          connected_at: instantOf(row["connected_at"]),
        })),
      };
    },
    async revoke({ organizationId, connectionId }) {
      const result = await runtime.revokeOrganizationMcpConnection({
        organizationId,
        connectionId,
        now: clock.now().toISOString(),
      });
      if (result === null) return null;
      const state = (result as { state?: unknown }).state;
      if (state !== "pending" && state !== "revoked") throw new Error("Invalid MCP revocation");
      return { state };
    },
  };
}
