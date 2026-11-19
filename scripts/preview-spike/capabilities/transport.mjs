/* global fetch */
import { decodeValue, encodeValue } from "./wire.mjs";

// Return the existing SDK SQLSTATE envelope. Throwing an Error through a Workers RPC would
// lose its fields and become the SDK's retryable database_unavailable instead.
const unknownOutcome = () => ({ type: "ohmyhost.database-error/v1", sqlstate: "08007" });

export async function callDatabase(operation, input, fetcher = fetch) {
  if (!["query", "transaction"].includes(operation))
    throw new Error("project_database_unavailable");
  const body = encodeValue(input);
  let response;
  try {
    response = await fetcher(`http://preview.capabilities/database/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    return unknownOutcome();
  }
  if (response.status === 409) return unknownOutcome();
  if (!response.ok) {
    let failure;
    try {
      failure = await response.json();
    } catch {
      return unknownOutcome();
    }
    // Only this exact bridge denial is emitted before its backend dispatch. Unexpected proxy
    // failures have no such guarantee, and are conservatively non-retryable unknown outcomes.
    if (
      [400, 403, 404, 503].includes(response.status) &&
      failure !== null &&
      typeof failure === "object" &&
      Object.keys(failure).join(",") === "error" &&
      failure.error === "qa_capability_unavailable"
    )
      throw new Error("project_database_unavailable");
    return unknownOutcome();
  }
  try {
    return decodeValue(await response.text());
  } catch {
    return unknownOutcome();
  }
}
