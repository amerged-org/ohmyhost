import {
  parseWorkosManagementRpcRequest,
  parseWorkosOrganizationSnapshot,
  type WorkosManagementRpcResponse,
} from "@ohmyhost/workos-auth-contracts";

import type {
  CandidateClock,
  InternalRpcAuthenticator,
  WorkloadIdentitySecretResolver,
  WorkosManagementTransport,
} from "./ports.js";
import { WorkosTransportFailure } from "./ports.js";

export type RpcDispatchResult =
  | { readonly status: 200; readonly body: WorkosManagementRpcResponse }
  | {
      readonly status: 400 | 401;
      readonly body: { readonly ok: false; readonly error: { readonly code: "invalid_request" } };
    }
  | {
      readonly status: 503;
      readonly body: { readonly ok: false; readonly error: { readonly code: "unavailable" } };
    };

export interface WorkosManagementRpc {
  dispatch(input: unknown, authentication: unknown): Promise<RpcDispatchResult>;
}

export function createWorkosManagementRpc(input: {
  readonly authenticator: InternalRpcAuthenticator;
  readonly clock: CandidateClock;
  readonly resolver: WorkloadIdentitySecretResolver;
  readonly transport: WorkosManagementTransport;
  readonly candidateFgaEnabled: boolean;
}): WorkosManagementRpc {
  return {
    async dispatch(rawRequest, authentication) {
      let request: ReturnType<typeof parseWorkosManagementRpcRequest>;
      try {
        request = parseWorkosManagementRpcRequest(rawRequest);
      } catch {
        return { status: 400, body: { ok: false, error: { code: "invalid_request" } } };
      }
      if (
        !(await input.authenticator.authenticate({ authentication, requestId: request.requestId }))
      ) {
        return { status: 401, body: { ok: false, error: { code: "invalid_request" } } };
      }
      if (request.method === "fga.check_candidate" && !input.candidateFgaEnabled) {
        return {
          status: 200,
          body: {
            method: request.method,
            requestId: request.requestId,
            ok: false,
            error: { code: "not_found" },
          },
        };
      }
      try {
        if (request.method === "organizations.get_current_snapshot") {
          const rawSnapshot = await input.resolver.withWorkosManagementCredential((credential) =>
            input.transport.fetchCurrentOrganizationSnapshot(
              credential,
              request.payload.workosOrganizationId,
            ),
          );
          return {
            status: 200,
            body: {
              method: request.method,
              requestId: request.requestId,
              ok: true,
              result: { snapshot: parseWorkosOrganizationSnapshot(rawSnapshot, input.clock.now()) },
            },
          };
        }
        if (request.method === "capabilities.probe_read_only") {
          const observations = await input.resolver.withWorkosManagementCredential((credential) =>
            input.transport.probeReadOnlyCapabilities(credential),
          );
          return {
            status: 200,
            body: {
              method: request.method,
              requestId: request.requestId,
              ok: true,
              result: { observations },
            },
          };
        }
        const decision = await input.resolver.withWorkosManagementCredential((credential) =>
          input.transport.checkCandidateFga(credential, request.payload),
        );
        return {
          status: 200,
          body: {
            method: request.method,
            requestId: request.requestId,
            ok: true,
            result: { decision },
          },
        };
      } catch (error) {
        if (error instanceof WorkosTransportFailure && error.code === "not_found") {
          return {
            status: 200,
            body: {
              method: request.method,
              requestId: request.requestId,
              ok: false,
              error: { code: "not_found" },
            },
          };
        }
        return { status: 503, body: { ok: false, error: { code: "unavailable" } } };
      }
    },
  };
}
