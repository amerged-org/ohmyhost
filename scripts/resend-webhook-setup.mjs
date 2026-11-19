import { appendFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { createResendProvider } from "../packages/provider-resend/dist/index.js";

export const RESEND_WEBHOOK_EVENTS = Object.freeze([
  "email.received",
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "domain.updated",
  "domain.deleted",
]);
const TARGETS = Object.freeze({
  dev: "https://dev.app.ohmyho.st/webhooks/resend",
  prod: "https://app.ohmyho.st/webhooks/resend",
});
export async function inspectResendWebhook(provider, environment) {
  const endpoint = TARGETS[environment];
  if (!endpoint) throw new TypeError("Invalid Resend environment");
  const matches = [];
  let after;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await provider.listWebhooks(after);
    matches.push(...page.items.filter((item) => item.endpoint === endpoint));
    if (!page.hasMore) break;
    const last = page.items.at(-1);
    if (!last || pageNumber === 19) throw new Error("resend_webhook_inventory_incomplete");
    after = last.id;
  }
  if (matches.length > 1) throw new Error("resend_webhook_duplicate_endpoint");
  const existing = matches[0];
  if (
    existing &&
    (existing.status !== "enabled" ||
      RESEND_WEBHOOK_EVENTS.some((event) => !existing.events.includes(event)))
  )
    throw new Error("resend_webhook_configuration_mismatch");
  return { endpoint, existing: existing ?? null };
}

function readVariable(source, name) {
  const matches = source.split(/\r?\n/u).filter((line) => line.startsWith(`${name}=`));
  if (matches.length !== 1) throw new Error(`local_${name.toLowerCase()}_missing_or_duplicate`);
  return matches[0].slice(name.length + 1);
}
/** Refuses before the provider creates the webhook: a secret it returns is shown once and must never be lost. */
export function requireSecretSlot(source, name) {
  const matches = source.split(/\r?\n/u).filter((line) => line.startsWith(`${name}=`));
  if (matches.length > 1) throw new Error("resend_webhook_secret_duplicate");
  if (matches.length === 1) throw new Error("resend_webhook_secret_already_set");
}

/** Appends the one-time secret to the current file; it never rewrites or truncates existing lines. */
export async function saveVariable(path, name, value) {
  if (!/^whsec_[A-Za-z0-9+/=_-]+$/u.test(value)) throw new Error("resend_webhook_secret_invalid");
  const current = await readFile(path, "utf8");
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${separator}${name}=${value}\n`);
}

async function main() {
  const args = process.argv.slice(2),
    environment = args[0],
    apply = args[1] === "--apply";
  if ((environment !== "dev" && environment !== "prod") || args.length > (apply ? 2 : 1))
    throw new Error("Usage: node scripts/resend-webhook-setup.mjs dev|prod [--apply]");
  const path = resolve(".env.local"),
    file = await stat(path);
  if ((file.mode & 0o077) !== 0) throw new Error("Local environment file must be mode 0600");
  const source = await readFile(path, "utf8"),
    key = readVariable(source, `RESEND_API_KEY_${environment.toUpperCase()}`);
  if (!/^re_[A-Za-z0-9_-]+$/u.test(key)) throw new Error("Resend account key unavailable");
  const secretName = `RESEND_WEBHOOK_SECRET_${environment.toUpperCase()}`;
  const knownSecret =
    source
      .split(/\r?\n/u)
      .find((line) => line.startsWith(`${secretName}=`))
      ?.slice(secretName.length + 1) ?? "";
  const provider = createResendProvider({ apiKey: key });
  const { endpoint, existing } = await inspectResendWebhook(provider, environment);
  if (existing) {
    if (!knownSecret)
      throw new Error(
        "Existing webhook has no locally saved signing secret; rotate it explicitly before activation",
      );
    process.stdout.write(
      `Verified existing ${environment} Resend webhook ${existing.id} at ${endpoint}\n`,
    );
    return;
  }
  if (knownSecret)
    throw new Error("Local signing secret exists but no matching provider webhook was found");
  if (!apply) {
    process.stdout.write(`Would create ${environment} Resend webhook at ${endpoint}\n`);
    return;
  }
  // Every refusal about the slot happens here, on a fresh read, before the one-time secret exists.
  requireSecretSlot(await readFile(path, "utf8"), secretName);
  const created = await provider.createWebhook(endpoint, RESEND_WEBHOOK_EVENTS);
  await saveVariable(path, secretName, created.signingSecret);
  process.stdout.write(
    `Created ${environment} Resend webhook ${created.id}; signing secret saved in ignored .env.local\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "resend_webhook_setup_failed"}\n`,
    );
    process.exitCode = 1;
  });
}
