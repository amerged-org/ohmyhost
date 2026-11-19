import type { DeploymentLifecyclePort } from "./deployment-lifecycle-port.js";
import type { DeploymentInventoryPort } from "./deployment-inventory-port.js";
import type { DeploymentRollbackDataPort } from "./deployment-rollback-data-port.js";
import type { DeploymentHandlePort } from "./deployment-handle-port.js";
import type { DeploymentReconciliationPort } from "./deployment-reconciliation-port.js";
import type { DeploymentCandidatePort } from "./deployment-candidate-port.js";
import type { DeploymentCleanupPort } from "./deployment-cleanup-port.js";
import type { DeploymentFinalizationPort } from "./deployment-finalization-port.js";
/* v8 ignore file -- complete explicit parent persistence groups; no SQL callback crosses a binding */
import type { DeploymentPersistenceReaderPort } from "./deployment-persistence-port.js";
import type { DeploymentTerminalPort } from "./deployment-terminal-port.js";
import type { DeploymentSourceCustodyPort } from "./deployment-source-port.js";
import type { SourceCompletionPort } from "./source-completion-port.js";
import type { DeploymentAuthorizationPort } from "./deployment-authorization-port.js";
export interface DeploymentWorkflowDataPorts {
  readonly lifecycle: DeploymentLifecyclePort;
  readonly inventory: DeploymentInventoryPort;
  readonly rollbackData: DeploymentRollbackDataPort;
  readonly handle: DeploymentHandlePort;
  readonly reconciliation: DeploymentReconciliationPort;
  readonly candidate: DeploymentCandidatePort;
  readonly cleanup: DeploymentCleanupPort;
  readonly finalization: DeploymentFinalizationPort;
  readonly readers: DeploymentPersistenceReaderPort;
  readonly terminals: DeploymentTerminalPort;
  readonly custody: DeploymentSourceCustodyPort;
  readonly sourceCompletion: SourceCompletionPort;
  readonly authorization: DeploymentAuthorizationPort;
}
