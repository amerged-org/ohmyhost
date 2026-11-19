import type { ProductWorkflowContext } from "@ohmyhost/database/provisioning-persistence";
import type { ProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import type { DeploymentPersistenceReaderPort } from "./deployment-persistence-port.js";

/** Original exact command/stale-promotion gate, shared by standalone reads and closed compound transactions. */
export function requireWorkflowCommandContext(
  value: ProductWorkflowContext | null,
  command: ProductCommandMessageV1,
  allowStalePromotion = false,
): ProductWorkflowContext {
  if (
    value === null ||
    value.intent.eventType !== command.eventType ||
    (value.promotionStale !== undefined && !allowStalePromotion)
  )
    throw new Error("Product Workflow has no exact persisted command context");
  return value;
}
/** The actual parent asks for one accepted scope; it never passes SQL, a query client or inferred identity. */
export function createWorkflowContextReader(
  readers: Pick<DeploymentPersistenceReaderPort, "readContext">,
) {
  return async (command: ProductCommandMessageV1, allowStalePromotion = false) =>
    requireWorkflowCommandContext(await readers.readContext(command), command, allowStalePromotion);
}
