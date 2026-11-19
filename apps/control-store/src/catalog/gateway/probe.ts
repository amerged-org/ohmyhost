import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import { publicTimestamp, routeOrganization, type CatalogContext } from "../common.js";
import { probeInput, SharedGatewayConflictError } from "./contracts.js";

const DB_NOW = "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')";
const BEFORE = "(strftime('%Y-%m-%dT%H:%M:%f','now','-30 seconds') || '000Z')";
const EXPIRES = "(strftime('%Y-%m-%dT%H:%M:%f','now','+180 seconds') || '000Z')";
const CANDIDATE = `SELECT candidate.candidate_receipt_id FROM wfp_candidate_receipts candidate
 JOIN projects project ON project.organization_id=candidate.organization_id AND project.project_id=candidate.project_id
 WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3 AND candidate.product_deployment_id=?4
 AND candidate.staged_at<=${DB_NOW} AND project.owner_state='active' AND project.lifecycle_state='active'`;
interface Window {
  candidate_receipt_id: string;
  expires_at: string;
}
interface Snapshot {
  readonly candidates: { candidate_receipt_id: string }[];
  readonly existing: Window | null;
}

/** Original beginWorkerProbe: exact current candidate, fixed −30/+180-second accounting interval, SQL time at INSERT.
 * The caller supplies a stable window identity, never a clock or a duration. A lost reply reads the same receipt. */
export async function beginRuntimeProbe(
  context: CatalogContext,
  raw: unknown,
): Promise<{ expiresAt: string }> {
  const input = probeInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    params = [input.organizationId, input.projectId, input.environmentId, input.deploymentId];
  const read = async (reader: typeof db): Promise<Snapshot> => {
    const [candidate, window] = await reader.batch([
      reader.prepare(CANDIDATE).bind(...params),
      reader
        .prepare(
          "SELECT candidate_receipt_id,expires_at FROM runtime_probe_windows WHERE window_id=?",
        )
        .bind(input.windowId),
    ]);
    return {
      candidates: (candidate?.results ?? []) as { candidate_receipt_id: string }[],
      existing: (window?.results[0] ?? null) as Window | null,
    };
  };
  const result = (snapshot: Snapshot) => {
    if (snapshot.candidates.length !== 1) throw new SharedGatewayConflictError();
    const candidate = snapshot.candidates[0];
    if (candidate === undefined) throw new SharedGatewayConflictError();
    if (
      snapshot.existing !== null &&
      snapshot.existing.candidate_receipt_id !== candidate.candidate_receipt_id
    )
      throw new SharedGatewayConflictError();
    return snapshot.existing === null
      ? null
      : { expiresAt: publicTimestamp(snapshot.existing.expires_at) };
  };
  const command: Command<Snapshot, true> = {
    name: "gateway.beginRuntimeProbe",
    input,
    read,
    decide: (snapshot) => {
      if (result(snapshot) !== null) return { replay: true };
      return {
        statements: [
          guard(db, "precondition_changed", `(SELECT count(*) FROM(${CANDIDATE}))<>1`, params),
          db
            .prepare(
              `INSERT INTO runtime_probe_windows(window_id,candidate_receipt_id,starts_at,expires_at)
          SELECT ?5,candidate_receipt_id,${BEFORE},${EXPIRES} FROM(${CANDIDATE})`,
            )
            .bind(...params, input.windowId),
          guard(db, "precondition_changed", "changes()<>1"),
        ],
        result: () => true,
      };
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["runtime_probe_windows"],
    lookup: async (reader) => (result(await read(reader)) === null ? undefined : true),
  };
  await runCommand(db, command);
  const stored = result(await read(db));
  if (stored === null) throw new SharedGatewayConflictError();
  return stored;
}
