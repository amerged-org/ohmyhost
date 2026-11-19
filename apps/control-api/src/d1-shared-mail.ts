import type { Clock, UlidFactory } from "@ohmyhost/platform";

import type { SharedMailMutation, SharedMailPort, SharedMailScope } from "./shared-mail.js";
import type { WorkspaceMailProviderBinding } from "./shared-mail-persistence.js";

/** The Core's shared-mail admission capability: decisions and receipts only; provider phases stay with Mail. */
export interface D1SharedMailRuntime {
  listDomains(input: unknown): Promise<unknown>;
  readDomain(input: unknown): Promise<unknown>;
  createDomain(input: unknown): Promise<{ domainId: string; response: unknown }>;
  beginRetire(input: unknown): Promise<{ response: unknown }>;
  completeCommand(input: unknown): Promise<unknown>;
  readBinding(input: unknown): Promise<{ mail_domain_id: string } | null>;
  bindProject(input: unknown): Promise<{ mail_domain_id: string }>;
  detachProject(input: unknown): Promise<{ mail_domain_id: string }>;
}
const METHODS = [
  "listDomains",
  "readDomain",
  "createDomain",
  "beginRetire",
  "completeCommand",
  "readBinding",
  "bindProject",
  "detachProject",
] as const;
export function isD1SharedMailRuntime(value: unknown): value is D1SharedMailRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    METHODS.every((method) => typeof Reflect.get(value, method) === "function")
  );
}

const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The original shared-mail persistence semantics on the Core; every call rechecks durable tenant ownership there. */
export function createD1SharedMailPort(input: {
  runtime: D1SharedMailRuntime;
  provider: WorkspaceMailProviderBinding;
  clock: Clock;
  ids: UlidFactory;
}): SharedMailPort {
  const { runtime, provider } = input;
  const now = () => input.clock.now().toISOString();
  const receipt = (scope: SharedMailScope & SharedMailMutation) => ({
    organizationId: scope.organizationId,
    idempotencyKey: scope.idempotencyKey,
    principalId: scope.principalId,
    requestSha256: hex(scope.canonicalRequestDigest),
    now: now(),
  });
  const project = (scope: { projectId: string; environmentId: string }) => ({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  });
  const complete = (scope: SharedMailScope & SharedMailMutation, response: unknown) =>
    runtime.completeCommand({
      organizationId: scope.organizationId,
      idempotencyKey: scope.idempotencyKey,
      response,
      now: now(),
    });
  const port: SharedMailPort = {
    async listWorkspaceMailDomains(scope) {
      return { items: await runtime.listDomains({ organizationId: scope.organizationId }) };
    },
    readWorkspaceMailDomain(scope) {
      return runtime.readDomain({
        organizationId: scope.organizationId,
        domainId: scope.mailDomainId,
      });
    },
    async createWorkspaceMailDomain(scope) {
      const started = await runtime.createDomain({
        ...receipt(scope),
        domainId: input.ids.next(),
        domain: scope.domain,
      });
      if (started.response !== null) return started.response;
      const result = await provider.ensureWorkspaceMailDomain({
        ...scope,
        domainId: started.domainId,
        commandOperation: "create",
      });
      return complete(scope, result);
    },
    async retireWorkspaceMailDomain(scope) {
      const started = await runtime.beginRetire({
        ...receipt(scope),
        domainId: scope.mailDomainId,
        expectedRevision: scope.expectedRevision,
      });
      if (started.response !== null) return started.response;
      const result = await provider.retireWorkspaceMailDomain({
        ...scope,
        domainId: scope.mailDomainId,
        commandOperation: "retire",
      });
      return complete(scope, result);
    },
    async readProjectMailDomainBinding(scope) {
      const row = await runtime.readBinding({
        organizationId: scope.organizationId,
        ...project(scope),
        now: now(),
      });
      if (row === null) throw new Error("mail_scope_unavailable");
      return row;
    },
    async putProjectMailDomainBinding(scope) {
      const row = await runtime.bindProject({
        ...receipt(scope),
        ...project(scope),
        domainId: scope.mailDomainId,
        sending: scope.sending,
        senderAddresses: scope.senderAddresses,
        defaultFrom: scope.defaultFrom,
        defaultReplyTo: scope.defaultReplyTo,
        expectedRevision: scope.expectedRevision,
      });
      await provider.syncWorkspaceMailDomain({
        ...scope,
        domainId: row.mail_domain_id,
        commandOperation: "bind",
      });
      return row;
    },
    async detachProjectMailDomainBinding(scope) {
      const row = await runtime.detachProject({
        ...receipt(scope),
        ...project(scope),
        expectedRevision: scope.expectedRevision,
      });
      await provider.syncWorkspaceMailDomain({
        ...scope,
        domainId: row.mail_domain_id,
        commandOperation: "detach",
      });
      return row;
    },
  };
  return Object.freeze(port);
}
