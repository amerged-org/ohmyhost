import { adjectives, nouns, verbs } from "human-id";
import { parseUlid, type Ulid } from "@ohmyhost/platform";

export const PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION = "project-handle-words-v1" as const;
export const PROJECT_HANDLE_PROHIBITED_WORDS = Object.freeze([
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "cloudflare",
  "dev",
  "mail",
  "ohmyho",
  "ohmyhost",
  "prod",
  "root",
  "support",
  "system",
  "www",
] as const);
export const PROJECT_HANDLE_VERSION = "human-id-4.2.0-sha256-project-handle-words-v1" as const;
/** Provenance of a handle the customer chose instead of one the platform generated. */
export const PROJECT_HANDLE_CHOSEN_VERSION = "customer-chosen-v1" as const;
export const PROJECT_HANDLE_MAX_COLLISION_ATTEMPT = 31;
export const PROJECT_HANDLE_MAX_LENGTH = 59;

declare const projectHandleBrand: unique symbol;
export type ProjectHandle = string & { readonly [projectHandleBrand]: true };

export interface ProjectHandleGenerationInput {
  readonly projectId: Ulid;
  readonly collisionAttempt: number;
}

export interface ProjectHandleReceipt extends ProjectHandleGenerationInput {
  readonly handle: ProjectHandle;
  readonly version: typeof PROJECT_HANDLE_VERSION;
  readonly prohibitedWordPolicyVersion: typeof PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION;
}

export interface ProjectHandleGenerator {
  generate(input: unknown): Promise<ProjectHandleReceipt>;
}

/** The shape a generated handle has: exactly three lowercase words. */
const GENERATED_HANDLE_PATTERN = /^[a-z]+-[a-z]+-[a-z]+$/u;
/** The shape any handle may have: one to five lowercase words of letters and digits. */
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u;
const prohibitedWords = new Set<string>(PROJECT_HANDLE_PROHIBITED_WORDS);
const encoder = new TextEncoder();
const vocabulary = Object.freeze({
  adjectives: validatedWords(adjectives, "adjectives"),
  nouns: validatedWords(nouns, "nouns"),
  verbs: validatedWords(verbs, "verbs"),
});

export function parseProjectHandle(value: unknown): ProjectHandle {
  if (!isValidProjectHandle(value)) {
    throw new TypeError("Project handle is invalid");
  }
  return value as ProjectHandle;
}

export function projectEnvironmentAddress(input: {
  readonly projectId: string;
  readonly handle: string;
  readonly environmentName: "dev" | "prod";
  readonly platform: "development" | "production";
}): Readonly<{ hostname: string; origin: string; gatewayScriptName: string }> {
  const projectId = parseUlid(input.projectId);
  const handle = parseProjectHandle(input.handle);
  if (
    (input.platform !== "development" && input.platform !== "production") ||
    (input.environmentName !== "dev" && input.environmentName !== "prod")
  )
    throw new TypeError("Project environment address is invalid");
  const label = input.environmentName === "dev" ? `dev-${handle}` : handle;
  const root = input.platform === "development" ? "dev.check.omh.st" : "check.omh.st";
  const hostname = `${label}.${root}`;
  return Object.freeze({
    hostname,
    origin: `https://${hostname}`,
    gatewayScriptName:
      input.platform === "development"
        ? label
        : `g-p-${projectId.toLowerCase()}-${input.environmentName}`,
  });
}

export function parseProjectHandleGenerationInput(value: unknown): ProjectHandleGenerationInput {
  if (!isRecord(value) || !hasExactKeys(value, ["collisionAttempt", "projectId"])) {
    throw new TypeError("Project handle generation input is invalid");
  }
  const collisionAttempt = value["collisionAttempt"];
  const projectId = value["projectId"];
  if (
    typeof collisionAttempt !== "number" ||
    !Number.isSafeInteger(collisionAttempt) ||
    collisionAttempt < 0 ||
    collisionAttempt > PROJECT_HANDLE_MAX_COLLISION_ATTEMPT ||
    typeof projectId !== "string"
  ) {
    throw new TypeError("Project handle generation input is invalid");
  }
  try {
    return Object.freeze({
      projectId: parseUlid(projectId),
      collisionAttempt,
    });
  } catch {
    throw new TypeError("Project handle generation input is invalid");
  }
}

export function parseProjectHandleReceipt(
  value: unknown,
  expected: ProjectHandleGenerationInput,
): ProjectHandleReceipt {
  const normalizedExpected = parseProjectHandleGenerationInput(expected);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "collisionAttempt",
      "handle",
      "prohibitedWordPolicyVersion",
      "projectId",
      "version",
    ]) ||
    value["projectId"] !== normalizedExpected.projectId ||
    value["collisionAttempt"] !== normalizedExpected.collisionAttempt ||
    value["version"] !== PROJECT_HANDLE_VERSION ||
    value["prohibitedWordPolicyVersion"] !== PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION ||
    !isValidProjectHandle(value["handle"])
  ) {
    throw new TypeError("Project handle receipt is invalid");
  }
  return Object.freeze({
    projectId: normalizedExpected.projectId,
    collisionAttempt: normalizedExpected.collisionAttempt,
    handle: value["handle"] as ProjectHandle,
    version: PROJECT_HANDLE_VERSION,
    prohibitedWordPolicyVersion: PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION,
  });
}

export function createProjectHandleGenerator(
  cryptoProvider: Pick<Crypto, "subtle">,
): ProjectHandleGenerator {
  if (
    typeof cryptoProvider !== "object" ||
    cryptoProvider === null ||
    typeof cryptoProvider.subtle?.digest !== "function"
  ) {
    throw new TypeError("Project handle crypto provider is invalid");
  }
  return Object.freeze({
    async generate(value: unknown): Promise<ProjectHandleReceipt> {
      const input = parseProjectHandleGenerationInput(value);
      const digest = new Uint8Array(
        await cryptoProvider.subtle.digest(
          "SHA-256",
          encoder.encode(
            `${PROJECT_HANDLE_VERSION}\n${input.projectId}\n${String(input.collisionAttempt)}`,
          ),
        ),
      );
      const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
      const handle = parseProjectHandle(
        `${wordAt(vocabulary.adjectives, view.getUint32(0))}-${wordAt(
          vocabulary.nouns,
          view.getUint32(4),
        )}-${wordAt(vocabulary.verbs, view.getUint32(8))}`,
      );
      return Object.freeze({
        projectId: input.projectId,
        collisionAttempt: input.collisionAttempt,
        handle,
        version: PROJECT_HANDLE_VERSION,
        prohibitedWordPolicyVersion: PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION,
      });
    },
  });
}

function isValidProjectHandle(value: unknown): value is ProjectHandle {
  return projectHandleProblem(value) === null;
}

/** True only for a handle this platform generated: exactly three words from the vocabulary. */
export function isGeneratedProjectHandle(value: unknown): value is ProjectHandle {
  return (
    typeof value === "string" &&
    value.length <= PROJECT_HANDLE_MAX_LENGTH &&
    GENERATED_HANDLE_PATTERN.test(value) &&
    value.split("-").every((word) => !prohibitedWords.has(word))
  );
}

function wordAt(words: readonly string[], value: number): string {
  const word = words[value % words.length];
  if (word === undefined) throw new Error("Project handle vocabulary is empty");
  return word;
}

function validatedWords(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value) => value.toLowerCase());
  const permitted = normalized.filter((value) => !prohibitedWords.has(value));
  if (
    permitted.length < 1 ||
    new Set(normalized).size !== normalized.length ||
    normalized.some((value) => !/^[a-z]{2,10}$/u.test(value))
  ) {
    throw new Error(`Project handle ${label} vocabulary is invalid`);
  }
  return Object.freeze(permitted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

/** Shortest and longest a customer-chosen handle may be; the generated ones sit inside this. */
export const PROJECT_HANDLE_MIN_LENGTH = 3;
/** One to five lowercase words of letters and digits, separated by single hyphens. */

/** Why a customer-chosen handle cannot be used, or `null` when it is usable. */
export type ProjectHandleProblem = "too_short" | "too_long" | "invalid_shape" | "prohibited_word";

/**
 * Checks a handle a customer picked. Availability against other projects is a separate question
 * the caller answers; this decides only whether the name is one we allow at all.
 */
export function projectHandleProblem(candidate: unknown): ProjectHandleProblem | null {
  if (typeof candidate !== "string") return "invalid_shape";
  if (candidate.length < PROJECT_HANDLE_MIN_LENGTH) return "too_short";
  if (candidate.length > PROJECT_HANDLE_MAX_LENGTH) return "too_long";
  if (!HANDLE_PATTERN.test(candidate)) return "invalid_shape";
  for (const word of candidate.split("-")) if (prohibitedWords.has(word)) return "prohibited_word";
  return null;
}

/** Trims a candidate to the longest usable prefix, so a suffix can still fit the length limit. */
function truncateHandle(base: string, room: number): string {
  return base.slice(0, Math.max(PROJECT_HANDLE_MIN_LENGTH, room)).replace(/-+$/u, "");
}

/**
 * Free alternatives for a taken or unusable handle, in the order a customer would try them.
 * `isFree` decides availability; nothing is suggested when the candidate itself is already free.
 */
export function suggestProjectHandles(
  candidate: unknown,
  isFree: (handle: string) => boolean,
  limit: number,
): string[] {
  const raw = typeof candidate === "string" ? candidate : "";
  const base =
    raw
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/-+/gu, "-")
      .replace(/^-/u, "")
      .replace(/-$/u, "")
      .split("-")
      .filter((word) => word.length > 0 && !prohibitedWords.has(word))
      .slice(0, 4)
      .join("-") || "project";
  if (projectHandleProblem(raw) === null && isFree(raw)) return [];
  const suggestions: string[] = [];
  const add = (handle: string) => {
    if (suggestions.length >= limit) return;
    if (projectHandleProblem(handle) !== null || suggestions.includes(handle)) return;
    if (!isFree(handle)) return;
    suggestions.push(handle);
  };
  add(base);
  for (let suffix = 2; suffix <= 99 && suggestions.length < limit; suffix += 1) {
    const tail = `-${suffix}`;
    add(`${truncateHandle(base, PROJECT_HANDLE_MAX_LENGTH - tail.length)}${tail}`);
  }
  for (const word of vocabulary.nouns) {
    if (suggestions.length >= limit) break;
    const tail = `-${word}`;
    if (tail.length + PROJECT_HANDLE_MIN_LENGTH > PROJECT_HANDLE_MAX_LENGTH) continue;
    add(`${truncateHandle(base, PROJECT_HANDLE_MAX_LENGTH - tail.length)}${tail}`);
  }
  return suggestions;
}
