import process from "node:process";

import {
  createContainerRecoveryRuntime,
  parseContainerRecoveryConfiguration,
  type RecoveryNamespace,
} from "./container-runtime.js";
import { createRecoveryAgentServer } from "./container-agent.js";

const namespace = process.env["RESOURCE_NAMESPACE"] as RecoveryNamespace;
const configuration = parseContainerRecoveryConfiguration(
  process.env["RECOVERY_CONFIGURATION"],
  namespace,
);
const token = process.env["RECOVERY_AGENT_TOKEN"];
if (typeof token !== "string") throw new Error("RECOVERY_CONFIGURATION_INVALID");
// The ephemeral job token for the Worker-mediated Control port. It is the only Control credential the process holds.
const controlToken = process.env["RECOVERY_CONTROL_TOKEN"];
const handler = createContainerRecoveryRuntime(configuration, namespace, controlToken);
const server = createRecoveryAgentServer(token, handler);
server.listen(8080, "0.0.0.0");
process.on("SIGTERM", () => server.close());
