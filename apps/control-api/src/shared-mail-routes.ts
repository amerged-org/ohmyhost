import type { Context, Hono } from "hono";
import type { AuthorizationAction } from "@ohmyhost/platform";
import type {
  SharedMailPort,
  SharedMailIdentityPort,
  SharedMailScope,
  SharedMailMutation,
} from "./shared-mail.js";
import { sharedMailError } from "./shared-mail.js";

type Resource = "organization" | "mail_domain" | "project";
export interface SharedMailRequestOptions {
  readonly scope: Resource;
  readonly responseAction: string;
  readonly action: AuthorizationAction;
  readonly mutation: boolean;
  readonly body: Readonly<Record<string, unknown>>;
  readonly invoke: (
    input: SharedMailScope &
      Partial<SharedMailMutation> & {
        projectId?: string;
        environmentId?: string;
        mailDomainId?: string;
      },
    authorizeDomain: (
      domainId: string,
      action: "mail-domains:read" | "mail-domains:use",
    ) => Promise<boolean>,
    selectedDomainIds: readonly string[] | undefined,
  ) => Promise<unknown>;
}
export type SharedMailRequestHandler = (
  context: Context,
  options: SharedMailRequestOptions,
) => Promise<Response>;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const MAIL = /^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9.-]+\.[a-z]{2,63}$/u;
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** REST owns the exact resource operations; all customer surfaces call their generated adapters. */
export function registerSharedMailRoutes(
  app: Hono,
  handle: SharedMailRequestHandler,
  mail: SharedMailPort | undefined,
  identity: SharedMailIdentityPort | undefined,
  invalidRequest: (context: Context) => Response,
): void {
  const org = "/v1/organizations/:organization_id/mail-domains";
  const domain = `${org}/:mail_domain_id`;
  const binding = "/v1/projects/:project_id/environments/:environment_id/mail-domain-binding";
  const application = "/v1/projects/:project_id/application-domain-identity";
  const responseActions = {
    listWorkspaceMailDomains: "domains_list",
    createWorkspaceMailDomain: "domain_create",
    readWorkspaceMailDomain: "domain_get",
    retireWorkspaceMailDomain: "domain_retire",
    readProjectMailDomainBinding: "binding_get",
    putProjectMailDomainBinding: "binding_set",
    detachProjectMailDomainBinding: "binding_detach",
    readApplicationDomainIdentity: "identity_get",
    declareApplicationDomainIdentity: "identity_declare",
    verifyApplicationDomainIdentity: "identity_verify",
    revokeApplicationDomainIdentity: "identity_revoke",
    beginApplicationIdentityAuthorization: "identity_authorize",
    getApplicationIdentityAuthorizationStatus: "identity_authorization_status",
    revokeApplicationIdentityAuthorization: "identity_authorization_revoke",
    beginWorkspaceMailAuthorization: "domain_dns_authorize",
    getWorkspaceMailAuthorizationStatus: "domain_dns_status",
    revokeWorkspaceMailAuthorization: "domain_dns_revoke",
  } as const;
  const descriptors = [
    [
      domain + "/dns-authorization",
      "DELETE",
      "mail_domain",
      "mail-domains:admin",
      "revokeWorkspaceMailAuthorization",
      "revision",
    ],
    [
      application + "/dns-authorization",
      "DELETE",
      "project",
      "projects:write",
      "revokeApplicationIdentityAuthorization",
      "revision",
    ],
    [org, "GET", "organization", "mail-domains:read", "listWorkspaceMailDomains", "none"],
    [org, "POST", "organization", "mail-domains:admin", "createWorkspaceMailDomain", "create"],
    [domain, "GET", "mail_domain", "mail-domains:read", "readWorkspaceMailDomain", "none"],
    [
      domain,
      "DELETE",
      "mail_domain",
      "mail-domains:admin",
      "retireWorkspaceMailDomain",
      "revision",
    ],
    [binding, "GET", "project", "projects:read", "readProjectMailDomainBinding", "none"],
    [binding, "PUT", "project", "projects:write", "putProjectMailDomainBinding", "binding"],
    [binding, "DELETE", "project", "projects:write", "detachProjectMailDomainBinding", "revision"],
    [
      domain + "/dns-authorization",
      "GET",
      "mail_domain",
      "mail-domains:admin",
      "getWorkspaceMailAuthorizationStatus",
      "none",
    ],
    [
      domain + "/dns-authorization",
      "POST",
      "mail_domain",
      "mail-domains:admin",
      "beginWorkspaceMailAuthorization",
      "dns",
    ],
    [application, "GET", "project", "projects:read", "readApplicationDomainIdentity", "none"],
    [
      application,
      "PUT",
      "project",
      "projects:write",
      "declareApplicationDomainIdentity",
      "identity",
    ],
    [
      application,
      "DELETE",
      "project",
      "projects:write",
      "revokeApplicationDomainIdentity",
      "revision",
    ],
    [
      application + "/verify",
      "POST",
      "project",
      "projects:write",
      "verifyApplicationDomainIdentity",
      "revision",
    ],
    [
      application + "/dns-authorization",
      "GET",
      "project",
      "projects:read",
      "getApplicationIdentityAuthorizationStatus",
      "none",
    ],
    [
      application + "/dns-authorization",
      "POST",
      "project",
      "projects:write",
      "beginApplicationIdentityAuthorization",
      "dns",
    ],
  ] as const;
  for (const [path, method, scope, action, operation, bodyType] of descriptors) {
    app.on(method, path, async (context) => {
      let body: Readonly<Record<string, unknown>> = {};
      if (bodyType !== "none") {
        if (
          !/^application\/json(?:\s*;|$)/iu.test(context.req.header("content-type") ?? "") ||
          context.req.header("content-encoding")
        )
          return invalidRequest(context);
        let text = "";
        try {
          const reader = context.req.raw.body?.getReader();
          if (!reader) return invalidRequest(context);
          const chunks: Uint8Array[] = [];
          let length = 0;
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 16_384) {
              await reader.cancel();
              return invalidRequest(context);
            }
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

          const value: unknown = JSON.parse(text);
          if (!validBody(value, bodyType)) return invalidRequest(context);
          body = value;
        } catch {
          return invalidRequest(context);
        }
      }
      return handle(context, {
        scope,
        responseAction: responseActions[operation],
        action,
        mutation: method !== "GET",
        body,
        invoke: async (base, authorizeDomain, selectedDomainIds) => {
          const values = { ...base, ...publicInput(body) };
          try {
            if (operation === "listWorkspaceMailDomains") {
              if (!mail) throw new Error("unavailable");
              const result = await mail.listWorkspaceMailDomains(base);
              if (selectedDomainIds === undefined) return result;
              if (
                result === null ||
                typeof result !== "object" ||
                !("items" in result) ||
                !Array.isArray(result.items)
              )
                throw new Error("Invalid private result");
              return {
                items: result.items.filter(
                  (item: unknown) =>
                    item !== null &&
                    typeof item === "object" &&
                    "domain_id" in item &&
                    typeof item.domain_id === "string" &&
                    selectedDomainIds.includes(item.domain_id),
                ),
              };
            }
            if (operation === "putProjectMailDomainBinding") {
              if (!(await authorizeDomain(String(body["mail_domain_id"]), "mail-domains:use")))
                return null;
            }
            if (
              operation === "readProjectMailDomainBinding" ||
              operation === "detachProjectMailDomainBinding"
            ) {
              if (!mail) throw new Error("unavailable");
              const found = await mail.readProjectMailDomainBinding(
                values as Parameters<SharedMailPort["readProjectMailDomainBinding"]>[0],
              );
              if (found === null) return null;
              if (
                typeof found !== "object" ||
                !("mail_domain_id" in found) ||
                typeof found.mail_domain_id !== "string"
              )
                throw new Error("Invalid private result");
              if (
                !(await authorizeDomain(
                  found.mail_domain_id,
                  operation === "readProjectMailDomainBinding"
                    ? "mail-domains:read"
                    : "mail-domains:use",
                ))
              )
                return null;
              if (operation === "readProjectMailDomainBinding") return found;
            }
            switch (operation) {
              case "createWorkspaceMailDomain":
                if (!mail) throw new Error("unavailable");
                return await mail.createWorkspaceMailDomain(
                  values as Parameters<SharedMailPort[typeof operation]>[0],
                );
              case "readWorkspaceMailDomain":
                if (!mail) throw new Error("unavailable");
                return await mail.readWorkspaceMailDomain(
                  values as Parameters<SharedMailPort[typeof operation]>[0],
                );
              case "retireWorkspaceMailDomain":
                if (!mail) throw new Error("unavailable");
                return await mail.retireWorkspaceMailDomain(
                  values as Parameters<SharedMailPort[typeof operation]>[0],
                );
              case "putProjectMailDomainBinding":
                if (!mail) throw new Error("unavailable");
                return await mail.putProjectMailDomainBinding(
                  values as Parameters<SharedMailPort[typeof operation]>[0],
                );
              case "detachProjectMailDomainBinding":
                if (!mail) throw new Error("unavailable");
                return await mail.detachProjectMailDomainBinding(
                  values as Parameters<SharedMailPort[typeof operation]>[0],
                );
              case "readApplicationDomainIdentity":
                if (!identity) throw new Error("unavailable");
                return await identity.readApplicationDomainIdentity(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "declareApplicationDomainIdentity":
                if (!identity) throw new Error("unavailable");
                return await identity.declareApplicationDomainIdentity(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "verifyApplicationDomainIdentity":
                if (!identity) throw new Error("unavailable");
                return await identity.verifyApplicationDomainIdentity(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "revokeApplicationDomainIdentity":
                if (!identity) throw new Error("unavailable");
                return await identity.revokeApplicationDomainIdentity(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "revokeApplicationIdentityAuthorization":
                if (!identity) throw new Error("unavailable");
                return await identity.revokeApplicationIdentityAuthorization(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "revokeWorkspaceMailAuthorization":
                if (!identity) throw new Error("unavailable");
                return await identity.revokeWorkspaceMailAuthorization(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "beginApplicationIdentityAuthorization":
                if (!identity) throw new Error("unavailable");
                return await identity.beginApplicationIdentityAuthorization(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "getApplicationIdentityAuthorizationStatus":
                if (!identity) throw new Error("unavailable");
                return await identity.getApplicationIdentityAuthorizationStatus(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "beginWorkspaceMailAuthorization":
                if (!identity) throw new Error("unavailable");
                return await identity.beginWorkspaceMailAuthorization(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
              case "getWorkspaceMailAuthorizationStatus":
                if (!identity) throw new Error("unavailable");
                return await identity.getWorkspaceMailAuthorizationStatus(
                  values as Parameters<SharedMailIdentityPort[typeof operation]>[0],
                );
            }
          } catch (error) {
            throw sharedMailError(error);
          }
        },
      });
    });
  }
}
function publicInput(v: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const keys: Readonly<Record<string, string>> = {
    domain: "domain",
    sending: "sending",
    hostname: "hostname",
    zone: "zone",
    mail_domain_id: "mailDomainId",
    expected_revision: "expectedRevision",
    sender_addresses: "senderAddresses",
    default_from: "defaultFrom",
    default_reply_to: "defaultReplyTo",
  };
  return Object.fromEntries(Object.entries(v).map(([k, value]) => [keys[k] ?? k, value]));
}
function validBody(v: unknown, type: string): v is Readonly<Record<string, unknown>> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys: Readonly<Record<string, readonly string[]>> = {
    create: ["domain", "sending"],
    identity: ["hostname"],
    revision: ["expected_revision"],
    dns: ["expected_revision", "zone"],
    binding: [
      "mail_domain_id",
      "sending",
      "sender_addresses",
      "default_from",
      "default_reply_to",
      "expected_revision",
    ],
  };
  const required = keys[type];
  if (!required || Object.keys(r).length !== required.length || required.some((k) => !(k in r)))
    return false;
  for (const k of ["domain", "hostname", "zone"])
    if (k in r && (typeof r[k] !== "string" || !HOST.test(r[k]))) return false;
  if (
    "expected_revision" in r &&
    (!Number.isSafeInteger(r["expected_revision"]) || Number(r["expected_revision"]) < 0)
  )
    return false;
  if (type === "dns" && Number(r["expected_revision"]) < 1) return false;
  if (type === "create" && r["sending"] !== true) return false;
  if ("sending" in r && typeof r["sending"] !== "boolean") return false;
  if (type === "binding") {
    const a = r["sender_addresses"];
    if (
      typeof r["mail_domain_id"] !== "string" ||
      !ID.test(r["mail_domain_id"]) ||
      !Array.isArray(a) ||
      a.length < 1 ||
      a.length > 32 ||
      new Set(a).size !== a.length ||
      a.some((x) => !validMailbox(x)) ||
      !validMailbox(r["default_from"]) ||
      !a.includes(r["default_from"]) ||
      (r["default_reply_to"] !== null && !validMailbox(r["default_reply_to"]))
    )
      return false;
  }
  return true;
}
function validMailbox(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 254 &&
    MAIL.test(v) &&
    !v.startsWith(".") &&
    !v.includes("..") &&
    !v.includes(".@")
  );
}
