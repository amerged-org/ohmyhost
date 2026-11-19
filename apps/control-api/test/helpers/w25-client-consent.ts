import { expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  parseProductCliCommand,
  recognizedCommandLabel,
} from "../../../product-cli/src/command.js";
import {
  createLocalOhmyhostMcpHandler,
  type LocalMcpProductClient,
} from "../../../mcp/src/local-server.js";
import { GeneratedSdkLocalMcpClient } from "../../../mcp/src/local-client.js";
import { ProductCli, type ProductCliDependencies } from "../../../product-cli/src/cli.js";
import { GeneratedSdkProductApi } from "../../../product-cli/src/product-api.js";

const id = (n: number) => String(n).padStart(26, "0");
const fixed = {
  organization: id(82501),
  project: id(82502),
  environment: id(82503),
  domain: id(82504),
};
const now = "2026-10-21T12:00:00.000Z";
type Scope = { organization: string; project: string; environment: string; domain?: string };

export function sharedMailMcpCases(scope: Scope = fixed): Record<string, Record<string, unknown>> {
  const org = { organization_id: scope.organization },
    target = { ...org, mail_domain_id: scope.domain ?? id(82504) },
    project = { project_id: scope.project },
    binding = { ...project, environment_id: scope.environment },
    mutation = { expected_revision: 1, idempotency_key: "w25-client-key" };
  return {
    workspace_mail_domains_list: org,
    workspace_mail_domain_create: {
      ...org,
      domain: "mail.example.com",
      sending: true,
      idempotency_key: "w25-client-key",
    },
    workspace_mail_domain_get: target,
    workspace_mail_domain_retire: { ...target, ...mutation, confirmed: true },
    workspace_mail_domain_dns_authorize: { ...target, ...mutation, zone: "example.com" },
    workspace_mail_domain_dns_status: target,
    workspace_mail_domain_dns_revoke: { ...target, ...mutation, confirmed: true },
    mail_binding_get: binding,
    mail_binding_set: {
      ...binding,
      ...mutation,
      mail_domain_id: target.mail_domain_id,
      sending: true,
      sender_addresses: ["contracts@mail.example.com", "contact@mail.example.com"],
      default_from: "contracts@mail.example.com",
      default_reply_to: "owner@other.example",
    },
    mail_binding_detach: { ...binding, ...mutation, confirmed: true },
    application_domain_identity_get: project,
    application_domain_identity_declare: {
      ...project,
      hostname: "sign.example.com",
      idempotency_key: "w25-client-key",
    },
    application_domain_identity_verify: { ...project, ...mutation },
    application_domain_identity_revoke: { ...project, ...mutation, confirmed: true },
    application_domain_identity_authorize: { ...project, ...mutation, zone: "example.com" },
    application_domain_identity_authorization_status: project,
    application_domain_identity_authorization_revoke: { ...project, ...mutation, confirmed: true },
  };
}
export const sharedMailReadTools = [
  "workspace_mail_domains_list",
  "workspace_mail_domain_get",
  "workspace_mail_domain_dns_status",
  "mail_binding_get",
  "application_domain_identity_get",
  "application_domain_identity_authorization_status",
];
export const sharedMailWriteTools = Object.keys(sharedMailMcpCases()).filter(
  (name) => !sharedMailReadTools.includes(name),
);

export function sharedMailTestReply(request: Request, scope: Scope = fixed): Response | null {
  const path = new URL(request.url).pathname;
  const domainId = scope.domain ?? id(82504);
  const authorization = {
    authorization_id: id(82505),
    authorization_url: "https://dash.cloudflare.com/oauth2/auth?state=private-fixture",
    expires_at: "2026-10-21T12:10:00.000Z",
  };
  if (/\/(?:mail-domains\/[^/]+|application-domain-identity)\/dns-authorization$/u.test(path))
    return Response.json(
      request.method === "POST"
        ? authorization
        : {
            status: "authorized",
            zone: "example.com",
            scopes: ["dns.write", "zone.read"],
            expires_at: "2026-10-21T13:00:00.000Z",
          },
    );
  const domain = {
    domain_id: domainId,
    organization_id: scope.organization,
    domain: "mail.example.com",
    registrable_domain: "example.com",
    revision: 1,
    status: request.method === "DELETE" ? "retired" : "active",
    sending: "ready",
    receiving: "disabled",
    configured_at: now,
    observed_at: null,
    dns_records: [],
    bindings_count: 1,
  };
  if (path.endsWith("/mail-domains"))
    return Response.json(request.method === "GET" ? { items: [domain] } : domain);
  if (path.endsWith(`/mail-domains/${domainId}`)) return Response.json(domain);
  if (path.endsWith("/mail-domain-binding"))
    return Response.json({
      mail_domain_id: domainId,
      organization_id: scope.organization,
      project_id: scope.project,
      environment_id: scope.environment,
      revision: 1,
      sending: true,
      sender_addresses: ["contracts@mail.example.com", "contact@mail.example.com"],
      default_from: "contracts@mail.example.com",
      default_reply_to: "owner@other.example",
      legacy: false,
      status: request.method === "DELETE" ? "detached" : "active",
      application_domain_identity: {
        hostname: "sign.example.com",
        registrable_domain: "example.com",
        revision: 1,
        status: "verified",
      },
    });
  if (/\/application-domain-identity(?:\/verify)?$/u.test(path))
    return Response.json({
      organization_id: scope.organization,
      project_id: scope.project,
      hostname: "sign.example.com",
      registrable_domain: "example.com",
      status: request.method === "DELETE" ? "revoked" : "verified",
      revision: 1,
      challenge: { type: "TXT", name: "_omh-project.sign.example.com", value: "a".repeat(43) },
      verified_at: now,
      expires_at: "2026-10-22T12:00:00.000Z",
    });
  return null;
}
async function mcpCall(
  handler: { fetch(request: Request): Promise<Response | null> },
  name: string,
  args: Record<string, unknown>,
  transport?: { endpoint: string; token: string },
) {
  const response = await handler.fetch(
    new Request(transport?.endpoint ?? "http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(transport === undefined ? {} : { authorization: `Bearer ${transport.token}` }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  if (response === null) throw new Error("Expected an MCP response at the selected endpoint");
  const bytes = await response.text();
  const raw = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? bytes
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : bytes;
  return JSON.parse(raw ?? "{}").result;
}

/** Invoked by the single W25 contract/auth/parity pack; no independent top-level test. */
export async function assertW25ClientConsentPack() {
  const canonicalCodec = await readFile(
    new URL("../../../../packages/contracts/src/shared-mail.ts", import.meta.url),
    "utf8",
  );
  const generatedCodec = await readFile(
    new URL("../../../../packages/sdk-ts/src/generated/shared-mail-response.ts", import.meta.url),
    "utf8",
  );
  const codecHash = createHash("sha256").update(canonicalCodec).digest("hex");
  expect(generatedCodec).toBe(
    `// Generated from packages/contracts/src/shared-mail.ts by scripts/generate-sdk-ts.mjs.\n// Canonical SHA-256: ${codecHash}\n${canonicalCodec}`,
  );
  const captured: unknown[] = [];
  const handler = createLocalOhmyhostMcpHandler({
    authenticatedClient: async () =>
      ({
        sharedMail: async (input: unknown) => {
          captured.push(input);
          return { accepted: true };
        },
      }) as unknown as LocalMcpProductClient,
  });
  try {
    for (const [name, args] of Object.entries(sharedMailMcpCases())) {
      expect((await mcpCall(handler, name, args))?.isError, name).not.toBe(true);
    }
    expect(
      (
        await mcpCall(handler, "workspace_mail_domain_create", {
          ...sharedMailMcpCases()["workspace_mail_domain_create"],
          sending: false,
        })
      )?.isError,
    ).toBe(true);
    expect(captured).toHaveLength(17);
    const from = captured.find(
      (candidate): candidate is Record<string, unknown> =>
        !!candidate &&
        typeof candidate === "object" &&
        "action" in candidate &&
        candidate.action === "binding_set",
    );
    expect(from).toMatchObject({
      defaultFrom: "contracts@mail.example.com",
      defaultReplyTo: "owner@other.example",
      senderAddresses: ["contracts@mail.example.com", "contact@mail.example.com"],
    });
    for (const name of [
      "workspace_mail_domain_retire",
      "mail_binding_detach",
      "application_domain_identity_revoke",
    ]) {
      const args = { ...sharedMailMcpCases()[name] };
      delete args["confirmed"];
      expect((await mcpCall(handler, name, args))?.isError).toBe(true);
    }
  } finally {
    await handler.close();
  }
  const argsFor = (label: string) => {
    const args = label.split(" ");
    if (label.includes(" workspace ")) args.push("--organization", fixed.organization);
    else args.push("--project", fixed.project);
    if (label.includes(" binding ")) args.push("--environment", fixed.environment);
    if (
      (label.includes("workspace") && !label.endsWith("list") && !label.endsWith("create")) ||
      label.endsWith("binding set")
    )
      args.push("--mail-domain", fixed.domain);
    if (label.endsWith("workspace create"))
      args.push("--domain", "mail.example.com", "--sending", "true");
    if (label.endsWith("binding set"))
      args.push(
        "--sending",
        "true",
        "--sender-addresses",
        "contracts@mail.example.com,contact@mail.example.com",
        "--default-from",
        "contracts@mail.example.com",
        "--reply-to",
        "owner@other.example",
      );
    if (label.endsWith("declare")) args.push("--hostname", "sign.example.com");
    if (label.endsWith("authorize")) args.push("--zone", "example.com");
    const writes =
      /(?:create|retire|dns-authorize|set|detach|declare|verify|revoke|authorize)$/u.test(label);
    if (writes) args.push("--idempotency-key", "w25-client-key");
    if (writes && !/(?:create|declare)$/u.test(label)) args.push("--expected-revision", "1");
    if (/(?:retire|detach|revoke|dns-revoke|authorization-revoke)$/u.test(label))
      args.push("--yes");
    return [...args, "--json"];
  };
  const labels = [
    ...["list", "create", "status", "retire", "dns-authorize", "dns-status", "dns-revoke"].map(
      (x) => `mail workspace ${x}`,
    ),
    ...["get", "set", "detach"].map((x) => `mail binding ${x}`),
    ...[
      "get",
      "declare",
      "verify",
      "revoke",
      "authorize",
      "authorization-status",
      "authorization-revoke",
    ].map((x) => `mail identity ${x}`),
  ];
  const fetcher: typeof fetch = async (input, init) =>
    sharedMailTestReply(new Request(input, init)) ?? new Response(null, { status: 404 });
  const product = new GeneratedSdkProductApi("https://app.ohmyho.st", "test-token", fetcher);
  const local = new GeneratedSdkLocalMcpClient("https://app.ohmyho.st", "test-token", fetcher);
  const cli = new ProductCli({
    apiToken: "test-token",
    commandPrefix: "ohmyhost",
    productApi: () => product,
  } as unknown as ProductCliDependencies);
  for (const label of labels) {
    const argv = argsFor(label);
    expect(recognizedCommandLabel(argv)).toBe(label);
    const command = parseProductCliCommand(argv);
    expect(command.kind).toBe("shared-mail");
    if (command.kind !== "shared-mail") throw new Error("Wrong command");
    await product.sharedMail(command.request);
    await local.sharedMail(command.request);
    const result = await cli.run(argv);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).command).toBe(label);
  }
  expect(() =>
    parseProductCliCommand(argsFor("mail binding detach").filter((x) => x !== "--yes")),
  ).toThrow();
  expect(() =>
    parseProductCliCommand(argsFor("mail binding set").map((x) => (x === "1" ? "-1" : x))),
  ).toThrow();
  expect(() =>
    parseProductCliCommand(argsFor("mail binding set").map((x) => (x === "true" ? "maybe" : x))),
  ).toThrow();
  expect(() =>
    parseProductCliCommand(
      argsFor("mail binding set").map((x) =>
        x.includes(",contact@") ? "contracts@mail.example.com,contracts@mail.example.com" : x,
      ),
    ),
  ).toThrow();
  expect(() =>
    parseProductCliCommand([...argsFor("mail workspace list"), "--project", fixed.project]),
  ).toThrow();
  expect(() =>
    parseProductCliCommand(
      argsFor("mail binding set").map((x) =>
        x.includes(",contact@")
          ? Array.from({ length: 33 }, (_, n) => `sender${n}@mail.example.com`).join(",")
          : x,
      ),
    ),
  ).toThrow();
  expect(() =>
    parseProductCliCommand(
      argsFor("mail workspace create").map((x) => (x === "true" ? "false" : x)),
    ),
  ).toThrow();
}
