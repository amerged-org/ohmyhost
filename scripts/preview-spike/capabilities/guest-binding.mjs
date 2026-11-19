import { WorkerEntrypoint } from "cloudflare:workers";
import { callDatabase } from "./transport.mjs";

// Runs in the sandbox as a local workerd binding. It carries no platform credential.
export class Database extends WorkerEntrypoint {
  query(input) {
    return callDatabase("query", input);
  }
  transaction(input) {
    return callDatabase("transaction", input);
  }
}
