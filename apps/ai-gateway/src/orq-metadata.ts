import { isEuOnlyLocations } from "@ohmyhost/platform";
import {
  MemoryCapacityError,
  checkJsonStructure,
  holdMemory,
  isRecord,
  parseJson,
} from "./request.js";
import { AiFailure } from "./responses.js";
import type { OrqEndpoint } from "./orq-cost.js";

/** One bounded metadata lookup, including its response body; no lookup is cached or persisted. */
export const METADATA_TIMEOUT_MS = 5_000;
export const MODEL_METADATA_BYTES = 64 * 1024;
export const EU_CATALOG_BYTES = 4 * 1024 * 1024;
export const ENABLED_MODELS_BYTES = 1024 * 1024;
const MODEL_ID_MAX = 200;

interface ModelMetadata {
  readonly id: string;
  readonly location: readonly string[];
}

function metadataUnavailable(): AiFailure {
  return new AiFailure("ai_unavailable", "The model's jurisdiction cannot be verified right now.");
}

/** Reads a capped upstream JSON body under one deadline for both headers and bytes. */
export async function withOrqJson<T>(
  orq: OrqEndpoint,
  url: string,
  limit: number,
  consume: (value: unknown) => T | Promise<T>,
): Promise<T> {
  // Reserve before fetch: response producers may enqueue bytes before the reader gets its first chunk.
  const memory = holdMemory(limit * 6);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(metadataUnavailable());
    }, METADATA_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      orq.fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { authorization: `Bearer ${orq.apiKey}` },
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok || response.body === null) throw metadataUnavailable();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw metadataUnavailable();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    clearTimeout(timer);
    memory.resize(size * 6);
    checkJsonStructure(bytes);
    return await consume(parseJson(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof MemoryCapacityError) throw error;
    throw metadataUnavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
    // A broken or unresponsive body must not turn cleanup into another unbounded wait.
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
    memory.release();
  }
}

function metadataOf(value: unknown): ModelMetadata | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const location = value["location"];
  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= MODEL_ID_MAX &&
    Array.isArray(location) &&
    location.every((entry) => typeof entry === "string")
    ? { id, location: location as string[] }
    : null;
}

function catalogUrl(orq: OrqEndpoint): string {
  return `${new URL(orq.baseUrl).origin}/v2/model-catalog`;
}

/** Exact upstream metadata for one requested model; a mismatch or unavailable entry never falls back to its name. */
export async function fetchModelLocations(
  orq: OrqEndpoint,
  model: string,
): Promise<readonly string[]> {
  if (model === "" || model.length > MODEL_ID_MAX) throw metadataUnavailable();
  const segments = model.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw metadataUnavailable();
  let encoded: string;
  try {
    encoded = segments.map(encodeURIComponent).join("/");
  } catch {
    throw metadataUnavailable();
  }
  return withOrqJson(orq, `${catalogUrl(orq)}/${encoded}`, MODEL_METADATA_BYTES, (raw) => {
    const metadata = metadataOf(isRecord(raw) ? raw["model"] : undefined);
    if (metadata === null || metadata.id !== model) throw metadataUnavailable();
    return metadata.location;
  });
}

/**
 * EU-only ids from the complete upstream EU metadata listing. The provider's EU filter may also include mixed-location
 * entries; only exclusively EU entries survive. This is one request's lookup result, never our own model catalog.
 */
export async function fetchEuModelIds(orq: OrqEndpoint): Promise<ReadonlySet<string>> {
  return withOrqJson(orq, `${catalogUrl(orq)}?location=eu`, EU_CATALOG_BYTES, (raw) => {
    if (!isRecord(raw) || raw["has_more"] !== false || !Array.isArray(raw["data"]))
      throw metadataUnavailable();
    const seen = new Set<string>();
    const allowed = new Set<string>();
    for (const entry of raw["data"]) {
      const metadata = metadataOf(entry);
      if (metadata === null || seen.has(metadata.id)) throw metadataUnavailable();
      seen.add(metadata.id);
      if (isEuOnlyLocations(metadata.location)) allowed.add(metadata.id);
    }
    return allowed;
  });
}
