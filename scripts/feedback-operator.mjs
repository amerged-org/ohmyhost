/* Private provider-bound operator: input and credentials stay in process memory. */
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { controlCorePlatformProxy } from "./control-core-remote-target.mjs";
import { inspectSession } from "./native-auth-restore-operator.mjs";

const ACCOUNT = "00000000000000000000000000000001";
const profiles = {
  development: {
    core: "ohmyho-control-store-poc-private-fullstack",
    origin: "https://dev.app.ohmyho.st",
    client: "client_00000000000000000000000017",
  },
  production: {
    core: "ohmyho-control-store-production",
    origin: "https://app.ohmyho.st",
    client: "client_00000000000000000000000018",
  },
};
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/u;
const STATES = ["in_review", "planned", "in_progress", "resolved", "closed"];
const fail = (code = "FEEDBACK_OPERATOR_UNVERIFIED") => {
  throw new Error(code);
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, required, optional = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    object(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");

function validReceipt(value) {
  return (
    exact(value, ["id", "organization_id", "submitted_at"]) &&
    ULID.test(value.id ?? "") &&
    ULID.test(value.organization_id ?? "") &&
    typeof value.submitted_at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.submitted_at) &&
    Number.isFinite(Date.parse(value.submitted_at)) &&
    new Date(value.submitted_at).toISOString() === value.submitted_at
  );
}
function validUpdate(value) {
  return (
    STATES.includes(value.status) &&
    (value.status === "resolved"
      ? typeof value.release === "string" && RELEASE.test(value.release)
      : value.release === undefined) &&
    (value.reply === undefined ||
      (typeof value.reply === "string" &&
        value.reply === value.reply.trim() &&
        Array.from(value.reply).length >= 1 &&
        Array.from(value.reply).length <= 2000 &&
        !/\p{Cs}/u.test(value.reply) &&
        !Array.from(value.reply).some((character) => {
          const code = character.charCodeAt(0);
          return (
            (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)
          );
        }))) &&
    (!["resolved", "closed"].includes(value.status) ||
      (typeof value.reply === "string" && Array.from(value.reply).length >= 20))
  );
}
function validateRequest(value) {
  if (
    !exact(value, ["feedbackId", "status"], ["release", "reply"]) ||
    !ULID.test(value.feedbackId ?? "") ||
    !validUpdate(value)
  )
    fail();
}
function validateSnapshot(value, environment, actor) {
  if (
    !exact(
      value,
      [
        "receipt",
        "expectedEnvironment",
        "expectedStatus",
        "expectedLastEventId",
        "eventId",
        "actorId",
        "status",
      ],
      ["release", "reply"],
    ) ||
    !validReceipt(value.receipt) ||
    value.expectedEnvironment !== environment ||
    value.actorId !== actor ||
    !["received", ...STATES].includes(value.expectedStatus) ||
    !(value.expectedLastEventId === null || ULID.test(value.expectedLastEventId ?? "")) ||
    !ULID.test(value.eventId ?? "") ||
    !validUpdate(value)
  )
    fail();
}

/** These options never accept an account, identity, token, report body or SQL. */
export function parseOptions(args) {
  if (
    args.length !== 3 ||
    !["preview", "apply"].includes(args[0]) ||
    args[1] !== "--environment" ||
    !Object.hasOwn(profiles, args[2])
  )
    fail();
  return { command: args[0], environment: args[2] };
}
function makeEventId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now(),
    head = "",
    tail = "",
    random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  for (let n = 0; n < 10; n++) {
    head = alphabet[time % 32] + head;
    time = Math.floor(time / 32);
  }
  for (let n = 0; n < 16; n++) {
    tail = alphabet[Number(random & 31n)] + tail;
    random >>= 5n;
  }
  return head + tail;
}

/** No credentials or provider bodies are returned; only the approved receipt and update are reviewable. */
export async function perform(
  options,
  input,
  {
    fetcher = globalThis.fetch,
    openProxy = controlCorePlatformProxy,
    root = process.cwd(),
    token = process.env.CLOUDFLARE_API_TOKEN,
    makeEventId: newEvent = makeEventId,
  } = {},
) {
  const profile = profiles[options.environment];
  if (
    !profile ||
    !["preview", "apply"].includes(options.command) ||
    !token ||
    (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT) ||
    !exact(input, ["session", options.command === "preview" ? "request" : "review"])
  )
    fail();
  if (options.command === "preview") validateRequest(input.request);
  const actor = `user:${inspectSession(input.session, profile)}`;
  const meResponse = await fetcher(`${profile.origin}/v1/me`, {
    headers: { authorization: `Bearer ${input.session}` },
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10000),
  });
  if (!meResponse.ok || (await meResponse.json())?.actor_id !== actor) fail();
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
  async function provider(path) {
    const response = await fetcher(base + path, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(10000),
    });
    if (!response.ok) fail();
    const body = await response.json();
    if (body?.success !== true) fail();
    return body.result;
  }
  const settings = await provider(`/workers/scripts/${profile.core}/settings`);
  const deployments = await provider(`/workers/scripts/${profile.core}/deployments`);
  const bindings = settings?.bindings;
  if (
    !Array.isArray(bindings) ||
    new Set(bindings.map((binding) => binding?.name)).size !== bindings.length
  )
    fail();
  const bound = (type, name) =>
    bindings.find((binding) => binding?.type === type && binding?.name === name);
  const databaseId = bound("d1", "CONTROL_CORE")?.id;
  if (
    !UUID.test(databaseId ?? "") ||
    bound("plain_text", "CONTROL_CORE_DATABASE_ID")?.text !== databaseId ||
    bound("plain_text", "CONTROL_PLATFORM_ENVIRONMENT")?.text !== options.environment ||
    !Array.isArray(deployments?.deployments?.[0]?.versions) ||
    deployments.deployments[0].versions.length !== 1 ||
    deployments.deployments[0].versions[0].percentage !== 100
  )
    fail();
  const database = await provider(`/d1/database/${databaseId}`);
  const fixedName = `ohmyho-control-core-${options.environment}`;
  if (
    database?.uuid !== databaseId ||
    !(
      database.name === fixedName ||
      (database.name?.startsWith(`${fixedName}-`) &&
        UUID.test(database.name.slice(fixedName.length + 1)))
    ) ||
    database.jurisdiction !== "eu" ||
    database.read_replication?.mode !== "disabled"
  )
    fail();
  let review;
  if (options.command === "apply") {
    review = input.review;
    if (
      !exact(review, ["snapshot", "sha256"]) ||
      !/^[a-f0-9]{64}$/u.test(review.sha256 ?? "") ||
      digest(review.snapshot) !== review.sha256
    )
      fail();
    validateSnapshot(review.snapshot, options.environment, actor);
  }
  const directory = await mkdtemp(join(tmpdir(), "omh-feedback-operator-"));
  let proxy;
  try {
    const configPath = join(directory, "wrangler.jsonc");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "ohmyho-feedback-operator",
        account_id: ACCOUNT,
        compatibility_date: "2026-09-14",
        workers_dev: false,
        preview_urls: false,
        services: [
          {
            binding: "FEEDBACK",
            service: profile.core,
            entrypoint: "FeedbackOperatorRuntime",
            remote: true,
          },
        ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    proxy = await openProxy(root, {
      configPath,
      envFiles: [],
      persist: false,
      remoteBindings: true,
    });
    const service = proxy.env.FEEDBACK;
    if (options.command === "preview") {
      const current = await service.preview({ feedbackId: input.request.feedbackId });
      if (current === null) fail("FEEDBACK_RECEIPT_NOT_FOUND");
      if (
        !exact(current, ["environment", "receipt", "currentStatus", "lastEventId"]) ||
        current.environment !== options.environment ||
        !validReceipt(current.receipt) ||
        current.receipt.id !== input.request.feedbackId ||
        !["received", ...STATES].includes(current.currentStatus) ||
        !(current.lastEventId === null || ULID.test(current.lastEventId ?? ""))
      )
        fail();
      const snapshot = {
        receipt: current.receipt,
        expectedEnvironment: options.environment,
        expectedStatus: current.currentStatus,
        expectedLastEventId: current.lastEventId,
        eventId: newEvent(),
        actorId: actor,
        status: input.request.status,
        ...(input.request.release === undefined ? {} : { release: input.request.release }),
        ...(input.request.reply === undefined ? {} : { reply: input.request.reply }),
      };
      validateSnapshot(snapshot, options.environment, actor);
      return { snapshot, sha256: digest(snapshot) };
    }
    const result = await service.apply(review.snapshot);
    if (
      !exact(result, ["outcome", "receipt", "eventId", "status", "recordedAt"]) ||
      result.outcome !== "recorded" ||
      canonical(result.receipt) !== canonical(review.snapshot.receipt) ||
      result.eventId !== review.snapshot.eventId ||
      result.status !== review.snapshot.status ||
      typeof result.recordedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.recordedAt) ||
      !Number.isFinite(Date.parse(result.recordedAt)) ||
      new Date(result.recordedAt).toISOString() !== result.recordedAt
    )
      fail();
    // Materialise the validated RPC acknowledgement while its proxy is still alive.
    return {
      outcome: result.outcome,
      receipt: {
        id: result.receipt.id,
        organization_id: result.receipt.organization_id,
        submitted_at: result.receipt.submitted_at,
      },
      eventId: result.eventId,
      status: result.status,
      recordedAt: result.recordedAt,
    };
  } finally {
    if (proxy) await proxy.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readInput(stream, command) {
  const chunks = [];
  let length = 0,
    joined;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      length += bytes.byteLength;
      if (length > 20000) fail();
    }
    joined = Buffer.concat(chunks, length);
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    if (!exact(input, ["session", command === "preview" ? "request" : "review"])) fail();
    return input;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    joined?.fill(0);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await perform(options, await readInput(process.stdin, options.command));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = [
      "FEEDBACK_RECEIPT_NOT_FOUND",
      "feedback_state_changed",
      "idempotency_conflict",
      "feedback_event_id_conflict",
    ].includes(error?.code ?? error?.message)
      ? (error.code ?? error.message)
      : "FEEDBACK_OPERATOR_UNCONFIRMED";
    // An unconfirmed apply can have committed. Only the same reviewed event may be retried.
    process.stderr.write(
      `${JSON.stringify({ reason_code: code, instruction: "For an unconfirmed apply, retain and retry the same review." })}\n`,
    );
    process.exitCode = 1;
  }
}
