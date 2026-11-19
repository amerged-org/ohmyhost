import {
  DEPLOYMENT_DIAGNOSTIC_CATALOG,
  type DeploymentDiagnosticCode,
  type DiagnosticSource,
} from "@ohmyhost/database";
const markerKeys = [
  "code",
  "deploymentId",
  "diagnosticId",
  "environmentId",
  "occurredAt",
  "organizationId",
  "projectId",
  "schemaVersion",
  "source",
];
const signedMarkerKeys = [...markerKeys, "markerSignature"].sort();
export interface DiagnosticPayload {
  readonly schemaVersion: "ohmyhost.diagnostic/v1";
  readonly diagnosticId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly source: DiagnosticSource;
  readonly code: string;
  readonly catalogMessage: string;
  readonly occurredAt: string;
}
export interface QueueEnvelope {
  readonly schemaVersion: "ohmyhost.diagnostic-queue/v1";
  readonly producerId: string;
  readonly payload: DiagnosticPayload;
  readonly signature: string;
}
export function parseMarker(value: unknown): DiagnosticPayload | null {
  const parsed = value;
  if (
    !record(parsed) ||
    Object.keys(parsed).sort().join() !== markerKeys.join() ||
    parsed["schemaVersion"] !== "ohmyhost.diagnostic-marker/v1"
  )
    return null;
  const code = parsed["code"] as DeploymentDiagnosticCode;
  const catalogMessage = DEPLOYMENT_DIAGNOSTIC_CATALOG[code];
  if (catalogMessage === undefined) return null;
  const payload = {
    ...parsed,
    catalogMessage,
    schemaVersion: "ohmyhost.diagnostic/v1",
  } as unknown as DiagnosticPayload;
  try {
    for (const id of [
      payload.diagnosticId,
      payload.organizationId,
      payload.projectId,
      payload.environmentId,
      payload.deploymentId,
    ])
      asUlid(id);
    if (
      !["build", "control", "runtime", "function"].includes(payload.source) ||
      new Date(payload.occurredAt).toISOString() !== payload.occurredAt
    )
      return null;
  } catch {
    return null;
  }
  return payload;
}
export async function verifyMarker(
  value: unknown,
  keyBase64: string,
): Promise<DiagnosticPayload | null> {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== signedMarkerKeys.join() ||
    typeof value["markerSignature"] !== "string"
  )
    return null;
  const unsigned = {
    schemaVersion: value["schemaVersion"],
    diagnosticId: value["diagnosticId"],
    organizationId: value["organizationId"],
    projectId: value["projectId"],
    environmentId: value["environmentId"],
    deploymentId: value["deploymentId"],
    source: value["source"],
    code: value["code"],
    occurredAt: value["occurredAt"],
  };
  const payload = parseMarker(unsigned);
  if (payload === null) return null;
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(value["markerSignature"], "base64url"));
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(keyBase64, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBytes = new Uint8Array(signature.byteLength);
  signatureBytes.set(signature);
  return (await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(JSON.stringify(unsigned)),
  ))
    ? payload
    : null;
}
export async function signEnvelope(
  payload: DiagnosticPayload,
  producerId: string,
  keyBase64: string,
): Promise<QueueEnvelope> {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(keyBase64, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(payload))),
  ).toString("base64url");
  return { schemaVersion: "ohmyhost.diagnostic-queue/v1", producerId, payload, signature };
}
export async function verifyEnvelope(
  value: unknown,
  producerId: string,
  keyBase64: string,
): Promise<DiagnosticPayload | null> {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "payload,producerId,schemaVersion,signature" ||
    value["schemaVersion"] !== "ohmyhost.diagnostic-queue/v1" ||
    value["producerId"] !== producerId ||
    typeof value["signature"] !== "string"
  )
    return null;
  const payload = validatePayload(value["payload"]);
  if (payload === null) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(keyBase64, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let signature: Buffer;
  try {
    signature = Buffer.from(value["signature"], "base64url");
  } catch {
    return null;
  }
  return (await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature),
    new TextEncoder().encode(JSON.stringify(payload)),
  ))
    ? payload
    : null;
}
export interface DiagnosticPersistence {
  recordDiagnostic(input: {
    id: string;
    organizationId: string;
    projectId: string;
    environmentId: string;
    deploymentId: string;
    source: DiagnosticSource;
    code: string;
    catalogMessage: string;
    occurredAt: string;
    recordedAt: string;
  }): Promise<unknown>;
}
export function createConsumer(
  persistence: DiagnosticPersistence,
  producerId: string,
  keyBase64: string,
) {
  return async (batch: { messages: readonly { body: unknown; ack(): void; retry(): void }[] }) => {
    for (const message of batch.messages) {
      try {
        const value = typeof message.body === "string" ? JSON.parse(message.body) : message.body;
        const payload = await verifyEnvelope(value, producerId, keyBase64);
        if (payload === null) {
          message.ack();
          continue;
        }
        const input = {
          id: asUlid(payload.diagnosticId),
          organizationId: asUlid(payload.organizationId),
          projectId: asUlid(payload.projectId),
          environmentId: asUlid(payload.environmentId),
          deploymentId: asUlid(payload.deploymentId),
          source: payload.source,
          code: payload.code,
          catalogMessage: payload.catalogMessage,
          occurredAt: payload.occurredAt,
        };
        await persistence.recordDiagnostic({ ...input, recordedAt: new Date().toISOString() });
        message.ack();
      } catch {
        message.retry();
      }
    }
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validatePayload(value: unknown): DiagnosticPayload | null {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !==
      "catalogMessage,code,deploymentId,diagnosticId,environmentId,occurredAt,organizationId,projectId,schemaVersion,source" ||
    value["schemaVersion"] !== "ohmyhost.diagnostic/v1"
  )
    return null;
  const code = value["code"] as DeploymentDiagnosticCode;
  if (DEPLOYMENT_DIAGNOSTIC_CATALOG[code] !== value["catalogMessage"]) return null;
  try {
    for (const key of [
      "diagnosticId",
      "organizationId",
      "projectId",
      "environmentId",
      "deploymentId",
    ] as const)
      asUlid(String(value[key]));
    if (
      !["build", "control", "runtime", "function"].includes(String(value["source"])) ||
      typeof value["occurredAt"] !== "string" ||
      new Date(value["occurredAt"]).toISOString() !== value["occurredAt"]
    )
      return null;
  } catch {
    return null;
  }
  return value as unknown as DiagnosticPayload;
}
function asUlid(value: string): never {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) throw new TypeError("Invalid diagnostic ULID");
  return value as never;
}
