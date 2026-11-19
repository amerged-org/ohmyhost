import type {
  CandidateClock,
  CandidateIdFactory,
  InternalRpcAuthenticator,
  WorkloadIdentitySecretResolver,
  WorkosManagementDatabase,
  WorkosManagementTransport,
} from "./ports.js";
import { createWorkosSnapshotPoller, type WorkosSnapshotPoller } from "./poller.js";
import { createWorkosManagementRpc, type WorkosManagementRpc } from "./rpc.js";

export type CandidateDeployment =
  | "local"
  | "test"
  | "sandbox"
  | "development"
  | "staging"
  | "production";

export interface WorkosManagementCandidate {
  readonly deployment: CandidateDeployment;
  readonly candidateFgaEnabled: boolean;
  readonly rpc: WorkosManagementRpc;
  readonly poller: WorkosSnapshotPoller;
}

export function composeWorkosManagementCandidate(input: {
  readonly deployment: CandidateDeployment;
  readonly candidateFgaEnabled: boolean;
  readonly authenticator: InternalRpcAuthenticator;
  readonly clock: CandidateClock;
  readonly ids: CandidateIdFactory;
  readonly organizationIds: CandidateIdFactory;
  readonly database: WorkosManagementDatabase;
  readonly resolver: WorkloadIdentitySecretResolver;
  readonly transport: WorkosManagementTransport;
}): WorkosManagementCandidate {
  if (input.candidateFgaEnabled && !["local", "test", "sandbox"].includes(input.deployment)) {
    throw new Error("Experimental WorkOS FGA is excluded from deployed product environments");
  }
  return {
    deployment: input.deployment,
    candidateFgaEnabled: input.candidateFgaEnabled,
    rpc: createWorkosManagementRpc(input),
    poller: createWorkosSnapshotPoller({
      ...input,
      leaseMs: 30_000,
      baseRetryMs: 1_000,
      maxRetryMs: 60_000,
    }),
  };
}
