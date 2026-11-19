import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import {
  createCloudflarePlatformDomainProvider,
  createCloudflareWorkerRouteProvider,
} from "../packages/provider-cloudflare/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const identities = Object.freeze({
  development: {
    configuration: "wrangler.development.jsonc",
    hostname: "*.dev.check.omh.st",
    target: "dev.check.omh.st",
    pattern: "*.dev.check.omh.st/*",
    scriptName: "ohmyho-gateway-poc-private-fullstack",
    previousScriptName: "ohmyho-public-production",
    probeSuffix: "dev.check.omh.st",
  },
  production: {
    configuration: "wrangler.production.jsonc",
    hostname: "*.check.omh.st",
    target: "check.omh.st",
    pattern: "*.check.omh.st/*",
    scriptName: "ohmyho-gateway-production",
    previousScriptName: "ohmyho-public-production",
    probeSuffix: "check.omh.st",
  },
});

/** No token or Connection String appears in a result or error. */
export async function runSharedGatewayWildcard(input) {
  const identity = identities[input.environment];
  if (!identity || !["prepare", "verify", "activate", "restore"].includes(input.mode))
    throw new TypeError("Expected prepare|verify|activate|restore and development|production");
  const source = await readFile(
    join(root, "apps/cloudflare-domain-management", identity.configuration),
    "utf8",
  );
  const zoneId = configuredId(source, "CLOUDFLARE_PLATFORM_ZONE_ID");
  const accountId = configuredId(source, "CLOUDFLARE_ACCOUNT_ID");
  const dnsToken = input.dnsToken;
  if (typeof dnsToken !== "string" || dnsToken.length < 16)
    throw new Error("Platform DNS credential is unavailable");
  const dns = createCloudflarePlatformDomainProvider({
    zoneId,
    zoneName: "omh.st",
    apiToken: dnsToken,
    fetch: input.fetch ?? globalThis.fetch,
  });
  const target = {
    zoneId,
    zoneName: "omh.st",
    hostname: identity.hostname,
    target: identity.target,
  };
  if (input.mode === "prepare") {
    const result = await dns.ensureGatewayWildcard(target);
    return Object.freeze({
      environment: input.environment,
      phase: "dns-prepared",
      outcome: result.outcome,
    });
  }
  await dns.observeGatewayWildcard(target);
  const routeToken = input.routeToken;
  if (typeof routeToken !== "string" || routeToken.length < 16)
    throw new Error("Worker route credential is unavailable");
  const routes = createCloudflareWorkerRouteProvider({
    zoneId,
    apiToken: routeToken,
    fetch: input.fetch ?? globalThis.fetch,
  });
  if (input.mode === "activate" || input.mode === "restore") {
    if (typeof input.routeId !== "string" || !/^[a-f0-9]{32}$/u.test(input.routeId))
      throw new TypeError("Exact wildcard route ID is required");
    const activating = input.mode === "activate";
    let changed;
    try {
      changed = await routes.replacePlatformWildcardRoute({
        routeId: input.routeId,
        pattern: identity.pattern,
        expectedScript: activating ? identity.previousScriptName : identity.scriptName,
        scriptName: activating ? identity.scriptName : identity.previousScriptName,
      });
    } catch {
      if (activating) {
        try {
          await routes.replacePlatformWildcardRoute({
            routeId: input.routeId,
            pattern: identity.pattern,
            expectedScript: identity.scriptName,
            scriptName: identity.previousScriptName,
            forceWrite: true,
          });
        } catch {
          throw new Error("Shared gateway activation and restoration are uncertain");
        }
        throw new Error("Shared gateway activation failed; original route retained or restored");
      }
      throw new Error("Shared gateway restoration is uncertain");
    }
    if (!activating)
      return Object.freeze({
        environment: input.environment,
        phase: "restored",
        routeId: changed.receipt.routeId,
        outcome: changed.outcome,
      });
    try {
      await routes.observePlatformWildcardRoute({
        pattern: identity.pattern,
        scriptName: identity.scriptName,
      });
      await verifyIngress(identity, input.fetch ?? globalThis.fetch);
    } catch {
      if (changed.outcome !== "existing") {
        try {
          await routes.replacePlatformWildcardRoute({
            routeId: input.routeId,
            pattern: identity.pattern,
            expectedScript: identity.scriptName,
            scriptName: identity.previousScriptName,
          });
        } catch {
          throw new Error("Shared gateway activation and restoration are uncertain");
        }
        throw new Error("Shared gateway activation failed; original route restored");
      }
      throw new Error("Shared gateway ingress is unavailable");
    }
    return Object.freeze({
      environment: input.environment,
      phase: "activated",
      routeId: changed.receipt.routeId,
      outcome: changed.outcome,
    });
  }
  await routes.observePlatformWildcardRoute({
    pattern: identity.pattern,
    scriptName: identity.scriptName,
  });
  await verifyIngress(identity, input.fetch ?? globalThis.fetch);
  return Object.freeze({ environment: input.environment, phase: "verified", accountId });
}

async function verifyIngress(identity, fetch) {
  const hostname = `gateway-probe-${randomUUID()}.${identity.probeSuffix}`;
  let response;
  try {
    response = await fetch(`https://${hostname}/`, {
      method: "GET",
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Shared gateway TLS or routing is unavailable");
  }
  const matched =
    response.status === 404 && response.headers.get("x-ohmyhost-gateway") === "shared-v1";
  await response.body?.cancel();
  if (!matched) throw new Error("Shared gateway route did not answer the private preflight");
}

function configuredId(source, name) {
  const matches = [...source.matchAll(new RegExp(`"${name}"\\s*:\\s*"([a-f0-9]{32})"`, "gu"))];
  if (matches.length !== 1) throw new Error("Cloudflare configuration identity is unavailable");
  return matches[0][1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, environment, routeId] = process.argv.slice(2);
  const result = await runSharedGatewayWildcard({
    mode,
    environment,
    dnsToken: process.env.CLOUDFLARE_PLATFORM_DNS_API_TOKEN,
    routeToken: process.env.CLOUDFLARE_WORKERS_API_TOKEN,
    routeId,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
