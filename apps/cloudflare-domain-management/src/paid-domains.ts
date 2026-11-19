import { randomBytes } from "node:crypto";
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import {
  CloudflareWorkerRouteConflictError,
  type CloudflareCustomHostnameReceipt,
  type CloudflareCustomerDnsRecord,
  type CloudflareDesiredDnsRecord,
  type CloudflareWorkerRouteReceipt,
  type createCloudflareCustomHostnameProvider,
  type createCloudflareWorkerRouteProvider,
} from "@ohmyhost/provider-cloudflare";
import { OrganizationCreditError } from "@ohmyhost/database";
import { isSaasCnameTarget, type SaasCnameTarget } from "@ohmyhost/contracts/platform-origins";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** The key already belongs to another request or to a connection that was replaced since. */
export class PaidDomainKeyConflictError extends Error {}
/** This project already holds another live connection, of another hostname or another member's. */
export class PaidDomainAlreadyConfiguredError extends Error {}
/** The connection is being deleted; a fresh apply or delete waits until that deletion finishes. */
export class PaidDomainDeletingError extends Error {}
/** Another project's live connection holds the hostname. */
export class PaidDomainHostnameTakenError extends Error {}
export class PaidDomainProductionDeploymentRequiredError extends Error {}
/** The hostname has no verified project-bound proof yet; the reservation alone creates no provider object. */
export class PaidDomainHostnameUnprovenError extends Error {}

type CustomHostnames = Pick<
  ReturnType<typeof createCloudflareCustomHostnameProvider>,
  "createHostname" | "observeHostname" | "deleteHostname"
>;
type Routes = Pick<
  ReturnType<typeof createCloudflareWorkerRouteProvider>,
  "createRoute" | "retargetRoute" | "observeRoute" | "deleteRoute"
>;

interface PaidDomainTarget {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly hostname: string;
  readonly gatewayScriptName: string;
}

interface PaidDomainDeclaration extends Omit<PaidDomainTarget, "gatewayScriptName"> {
  readonly gatewayScriptName: string | null;
}

/** A Paid hostname's ownership proof: its challenge, and once verified, the instant the proof stops counting. */
export interface PaidHostnameProof {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly hostname: string;
  readonly state: "pending" | "verified";
  readonly challengeName: string;
  readonly challengeValue: string;
  readonly declaredAt: string;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
}

/** A verified proof is taken again after this window, with its challenge still published. */
const PROOF_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function isLive(proof: PaidHostnameProof, nowIso: string): boolean {
  return proof.expiresAt !== null && Date.parse(proof.expiresAt) > Date.parse(nowIso);
}

export interface PaidDomainRecord extends PaidDomainDeclaration {
  readonly state:
    | "awaiting_deployment"
    | "pending"
    | "active"
    | "deleting"
    | "deleted"
    | "displaced";
  readonly customHostnameReceipt: CloudflareCustomHostnameReceipt | null;
  readonly workerRouteReceipt: CloudflareWorkerRouteReceipt | null;
  /** True once the project's verified `_omh-project` proof of this hostname was recorded at its claim. */
  readonly hostnameProven: boolean;
}

export interface PaidDomainPersistence {
  accessReason(input: {
    organizationId: Ulid;
    projectId: Ulid;
    now: string;
  }): Promise<
    "paid_plan_required" | "insufficient_organization_credits" | "project_budget_exceeded" | null
  >;
  readTarget(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  }): Promise<Readonly<{ gatewayScriptName: string }> | "production_deployment_required" | null>;
  /**
   * `gatewayRetarget` marks a request that only moves an active domain off its legacy gateway. `sameConnection` marks
   * the same member's live connection of this hostname, asked under a fresh key: the claim wrote nothing for it.
   */
  claimApply(
    input: PaidDomainDeclaration & {
      readonly principalId: string;
      readonly idempotencyKeySha256: string;
      readonly requestSha256: string;
      readonly now: string;
    },
  ): Promise<
    PaidDomainRecord & { readonly gatewayRetarget: boolean; readonly sameConnection: boolean }
  >;
  putActive(
    input: PaidDomainTarget & {
      readonly idempotencyKeySha256: string;
      readonly requestSha256: string;
      readonly customHostnameReceipt: CloudflareCustomHostnameReceipt;
      readonly workerRouteReceipt: CloudflareWorkerRouteReceipt;
      readonly now: string;
    },
  ): Promise<PaidDomainRecord>;
  read(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  }): Promise<PaidDomainRecord | null>;
  /** The hostname's proof; with `hostname: null`, the project's latest pending challenge within the seven-day hold. */
  readProof(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly hostname: string | null;
    readonly now: string;
  }): Promise<PaidHostnameProof | null>;
  /** Issues the hostname's pending challenge once; a repeat returns the challenge already issued. */
  ensureProof(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly hostname: string;
    readonly challengeValue: string;
    readonly now: string;
  }): Promise<PaidHostnameProof | null>;
  /** Verifies the pending challenge, or a verified one whose window ended, with its exact value. */
  verifyProof(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly hostname: string;
    readonly challengeValue: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<PaidHostnameProof | null>;
  claimDelete(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly hostname: string;
    readonly principalId: string;
    readonly delegation?: unknown;
    readonly idempotencyKeySha256: string;
    readonly requestSha256: string;
    readonly now: string;
  }): Promise<PaidDomainRecord | null>;
  markDeleted(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly hostname: string;
    readonly idempotencyKeySha256?: string;
    readonly now: string;
  }): Promise<void>;
  /** Only the project's running deletion takes over its live connection, in any live state. */
  claimProjectDeletion(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly now: string;
  }): Promise<PaidDomainRecord | null>;
}

export interface CustomerDomainDns {
  loadAccess(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly hostname: string;
  }): Promise<
    | Readonly<{ status: "absent" }>
    | Readonly<{ status: "expired" }>
    | Readonly<{ status: "reauthorization_required" }>
    /** The grant may still write the zone, but it cannot be used now (a closed claim): nothing is written or removed. */
    | Readonly<{ status: "reconciliation_required" }>
    | Readonly<{
        status: "ready";
        accessToken: string;
        zoneId: string;
        zoneName: string;
      }>
  >;
  reconcileRecords(
    accessToken: string,
    input: {
      readonly zoneId: string;
      readonly zoneName: string;
      readonly records: readonly CloudflareDesiredDnsRecord[];
    },
    options?: Readonly<{ replaceTrafficHostname: string } | { observeOnly: true }>,
  ): Promise<Readonly<{ records: readonly CloudflareCustomerDnsRecord[] }>>;
  deleteRecords(
    accessToken: string,
    input: {
      readonly zoneId: string;
      readonly zoneName: string;
      readonly records: readonly CloudflareCustomerDnsRecord[];
    },
  ): Promise<unknown>;
}

export function createPaidDomainRuntime(input: {
  readonly cnameTarget: SaasCnameTarget;
  readonly clock: { now(): Date };
  readonly persistence: PaidDomainPersistence;
  readonly customHostnames: CustomHostnames;
  readonly routes: Routes;
  /** The TXT observer of the application identity, reused for the Paid ownership challenge. */
  readonly observeTxt: (name: string, value: string) => Promise<boolean>;
  readonly synchronizeNativePolicy?: (input: {
    organizationId: Ulid;
    projectId: Ulid;
    idempotencyKeySha256: string;
  }) => Promise<void>;
  readonly recoverNativePolicy?: (input: {
    organizationId: Ulid;
    projectId: Ulid;
    hostname: string;
    principalId: string;
    delegation?: unknown;
    idempotencyKeySha256: string;
    requestSha256: string;
  }) => Promise<void>;
  readonly customerDns?: CustomerDomainDns;
  /** The project deletion's own DNS access; ordinary grant access never serves a deletion. */
  readonly projectDeletionDns?: (scope: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
  }) => CustomerDomainDns;
}) {
  const cnameTarget = input.cnameTarget;
  if (!isSaasCnameTarget(cnameTarget)) throw new TypeError("Paid domain SaaS target is invalid");
  const synchronize = input.synchronizeNativePolicy;
  const recover = input.recoverNativePolicy;
  if (
    (synchronize !== undefined || recover !== undefined) &&
    (typeof synchronize !== "function" || typeof recover !== "function")
  )
    throw new TypeError("Native domain policy capability is incomplete");
  const native =
    typeof synchronize === "function" && typeof recover === "function"
      ? { synchronize, recover }
      : null;
  /**
   * A failed legacy retarget can leave the live route on the new gateway script while the stored receipt still names
   * the old one. The route under the stored id is then observed on the new script and deleted with that observation;
   * a route still on the old script, or none, is deleted with the stored receipt. No other route id is ever deleted.
   */
  const deleteStoredRoute = async (
    stored: PaidDomainRecord,
    receipt: CloudflareWorkerRouteReceipt,
  ) => {
    if (stored.gatewayScriptName === null || receipt.scriptName === stored.gatewayScriptName)
      return input.routes.deleteRoute(receipt);
    let observed;
    try {
      observed = await input.routes.observeRoute({
        hostname: stored.hostname,
        scriptName: stored.gatewayScriptName,
      });
    } catch (error) {
      if (!(error instanceof CloudflareWorkerRouteConflictError)) throw error;
      return input.routes.deleteRoute(receipt);
    }
    if (
      observed.state === "found" &&
      observed.routeId === receipt.routeId &&
      observed.pattern === receipt.pattern
    )
      return input.routes.deleteRoute(observed);
    return input.routes.deleteRoute(receipt);
  };
  const removeConnection = async (
    stored: PaidDomainRecord,
    customerDns: CustomerDomainDns | undefined,
    idempotencyKeySha256?: string,
  ): Promise<"removed" | "reconciliation_required"> => {
    if (stored.gatewayScriptName === null || !stored.hostnameProven) {
      // This declaration never crossed the provider boundary, including a replayed cancellation. An unproven
      // reservation never made a provider object either, so a route or custom hostname found under its name belongs
      // to another project and is left alone.
      await input.persistence.markDeleted({
        ...stored,
        ...(idempotencyKeySha256 === undefined ? {} : { idempotencyKeySha256 }),
        now: now(input.clock),
      });
      return "removed";
    }
    if (stored.customHostnameReceipt === null || stored.workerRouteReceipt === null) {
      // Its apply stopped before storing receipts (and before any customer DNS), but may have
      // created the route or custom hostname; this project alone holds the hostname, so what
      // exists for it is removed.
      const route = await input.routes.observeRoute({
        hostname: stored.hostname,
        scriptName: stored.gatewayScriptName,
      });
      if (route.state === "found") await input.routes.deleteRoute(route);
      const custom = await input.customHostnames.observeHostname({
        hostname: stored.hostname,
        customerCnameTarget: cnameTarget,
      });
      if (custom.state === "found") await input.customHostnames.deleteHostname(custom);
    } else {
      // The customer's records stay while the owner's DNS authority is missing: the route and hostname wait with them.
      if ((await reconcileCustomerDns(customerDns, stored, true)) === "reconciliation_required")
        return "reconciliation_required";
      await deleteStoredRoute(stored, stored.workerRouteReceipt);
      await input.customHostnames.deleteHostname(stored.customHostnameReceipt);
    }
    await input.persistence.markDeleted({
      organizationId: stored.organizationId,
      projectId: stored.projectId,
      hostname: stored.hostname,
      ...(idempotencyKeySha256 === undefined ? {} : { idempotencyKeySha256 }),
      now: now(input.clock),
    });
    return "removed";
  };
  /** The connection as the Paid status shows it, before the ownership challenge is overlaid. */
  const connection = async (
    request: ReturnType<typeof parseScope>,
    stored: PaidDomainRecord | null,
  ) => {
    if (stored === null) return emptyView(cnameTarget);
    if (stored.state === "deleted") return emptyView(cnameTarget, "deleted");
    // A displaced connection was taken over by a proven owner; it shows no connection of its own.
    if (stored.state === "displaced") return emptyView(cnameTarget);
    requireCurrentSaasTarget(stored, cnameTarget);
    const denied = await input.persistence.accessReason({ ...request, now: now(input.clock) });
    if (denied) return view(stored, "suspended", cnameTarget, denied);
    if (stored.state === "awaiting_deployment")
      return view(stored, "awaiting_deployment", cnameTarget);
    if (stored.state === "deleting" && stored.gatewayScriptName === null)
      return view(stored, "pending", cnameTarget);
    if (stored.gatewayScriptName === null) throw new Error("Paid domain target is unavailable");
    if (stored.customHostnameReceipt === null || stored.workerRouteReceipt === null) {
      return view(stored, "pending", cnameTarget);
    }
    const [custom, route] = await Promise.all([
      input.customHostnames.observeHostname({
        hostname: stored.hostname,
        customerCnameTarget: cnameTarget,
      }),
      input.routes.observeRoute({
        hostname: stored.hostname,
        scriptName: stored.gatewayScriptName,
      }),
    ]);
    if (custom.state === "absent" || route.state === "absent") {
      return view(stored, "reconciliation_required", cnameTarget);
    }
    if (
      custom.customHostnameId !== stored.customHostnameReceipt.customHostnameId ||
      route.routeId !== stored.workerRouteReceipt.routeId
    ) {
      throw new Error("Paid domain provider identity changed");
    }
    return view(
      { ...stored, customHostnameReceipt: custom, workerRouteReceipt: route },
      custom.ready ? "active" : "pending",
      cnameTarget,
    );
  };
  /**
   * Makes the hostname's ownership proof live, reusing a live one. An unpublished challenge leaves the proof pending:
   * the claim that follows then reserves the hostname without a route or custom hostname.
   */
  const proveHostname = async (
    target: { readonly organizationId: Ulid; readonly projectId: Ulid; readonly hostname: string },
    nowIso: string,
  ): Promise<void> => {
    const proof = await input.persistence.ensureProof({
      ...target,
      challengeValue: `omh-domain-v1=${randomBytes(32).toString("base64url")}`,
      now: nowIso,
    });
    if (proof === null || (proof.state === "verified" && isLive(proof, nowIso))) return;
    let observed: boolean;
    try {
      observed = await input.observeTxt(proof.challengeName, proof.challengeValue);
    } catch {
      observed = false;
    }
    if (!observed) return;
    await input.persistence.verifyProof({
      ...target,
      challengeValue: proof.challengeValue,
      now: nowIso,
      expiresAt: new Date(Date.parse(nowIso) + PROOF_WINDOW_MS).toISOString(),
    });
  };
  return Object.freeze({
    async planPaidDomain(raw: unknown) {
      const request = parsePlan(raw);
      if ((await input.persistence.readTarget(request)) === null)
        throw new Error("Paid domain target is unavailable");
      return Object.freeze({
        status: "planned" as const,
        hostname: request.hostname,
        environment: "prod" as const,
        cnameTarget,
        effects: Object.freeze([
          `Record the requested hostname ${request.hostname} for this project.`,
          "After a healthy Prod deployment, repeat the same apply to create HTTPS and route the hostname; customer DNS changes only with the scoped DNS authorization.",
        ]),
        risks: Object.freeze([
          "Traffic becomes public after the customer CNAME and certificate are active.",
        ]),
      });
    },
    async applyPaidDomain(raw: unknown) {
      const request = parseMutation(raw);
      const denied = await input.persistence.accessReason({
        organizationId: request.organizationId,
        projectId: request.projectId,
        now: now(input.clock),
      });
      if (denied) throw new OrganizationCreditError(denied);
      const current = await input.persistence.readTarget(request);
      if (current === null) throw new Error("Paid domain target is unavailable");
      const target = Object.freeze({
        organizationId: request.organizationId,
        projectId: request.projectId,
        hostname: request.hostname,
        gatewayScriptName:
          current === "production_deployment_required" ? null : current.gatewayScriptName,
      });
      // A connection already proven for this hostname needs no lookup or challenge: a replay of its apply makes none.
      const connected = await input.persistence.read(request);
      const alreadyProven =
        connected !== null &&
        connected.hostnameProven &&
        connected.hostname === request.hostname &&
        ["awaiting_deployment", "pending", "active"].includes(connected.state);
      // The hostname's own ownership proof comes first; the claim then reads the proof the store holds.
      if (!alreadyProven)
        await proveHostname(
          {
            organizationId: request.organizationId,
            projectId: request.projectId,
            hostname: request.hostname,
          },
          now(input.clock),
        );
      const claimed = await input.persistence.claimApply({
        ...request,
        ...target,
        now: now(input.clock),
      });
      // The reservation is recorded, but no route, custom hostname or customer DNS record is made before the proof.
      if (!claimed.hostnameProven)
        throw new PaidDomainHostnameUnprovenError(
          "Paid domain hostname needs a verified project ownership proof",
        );
      // The same member's connection asked again under a fresh key is answered as it stands: nothing is provisioned,
      // because its receipts belong to the key that created it.
      if (claimed.sameConnection) return connection(request, claimed);
      if (target.gatewayScriptName === null)
        return view(claimed, "awaiting_deployment", cnameTarget);
      const provisionedTarget = { ...target, gatewayScriptName: target.gatewayScriptName };
      requireCurrentSaasTarget(claimed, cnameTarget);
      // An active domain whose route still names its legacy gateway moves in place, keeping its
      // custom hostname, certificate and customer DNS records.
      const route =
        claimed.workerRouteReceipt !== null &&
        claimed.workerRouteReceipt.scriptName !== target.gatewayScriptName
          ? await input.routes.retargetRoute(claimed.workerRouteReceipt, target.gatewayScriptName)
          : await input.routes.createRoute({
              hostname: target.hostname,
              scriptName: target.gatewayScriptName,
            });
      const custom = await input.customHostnames.createHostname({
        hostname: target.hostname,
        customerCnameTarget: cnameTarget,
      });
      const stored = await input.persistence.putActive({
        ...provisionedTarget,
        idempotencyKeySha256: request.idempotencyKeySha256,
        requestSha256: request.requestSha256,
        customHostnameReceipt: custom.receipt,
        workerRouteReceipt: route.receipt,
        now: now(input.clock),
      });
      // A gateway move changes no customer DNS record, so it neither reads nor refreshes the grant;
      // setup and its replays still reconcile the customer's records.
      if (
        !claimed.gatewayRetarget &&
        (await reconcileCustomerDns(input.customerDns, stored, false)) === "reconciliation_required"
      )
        return view(stored, "reconciliation_required", cnameTarget);
      return view(stored, custom.receipt.ready ? "active" : "pending", cnameTarget);
    },
    async getPaidDomain(raw: unknown) {
      const request = parseScope(raw);
      const stored = await input.persistence.read(request);
      const shown = await connection(request, stored);
      // An unproven hostname shows its ownership challenge: the connection's own, or the project's latest pending one.
      if (
        stored?.hostnameProven === true ||
        stored?.state === "active" ||
        stored?.state === "deleting"
      )
        return shown;
      const hostname =
        stored === null || stored.state === "deleted" || stored.state === "displaced"
          ? null
          : stored.hostname;
      const nowIso = now(input.clock);
      const proof = await input.persistence.readProof({ ...request, hostname, now: nowIso });
      if (proof === null || (proof.state === "verified" && isLive(proof, nowIso))) return shown;
      return Object.freeze({
        ...shown,
        validationRecords: Object.freeze([
          Object.freeze({
            type: "TXT" as const,
            name: proof.challengeName,
            content: proof.challengeValue,
            purpose: "ownership" as const,
          }),
        ]),
      });
    },
    async deletePaidDomain(raw: unknown) {
      const request = parseMutation(raw, native !== null);
      const previous = await input.persistence.read(request);
      if (previous !== null && previous.state !== "deleted")
        requireCurrentSaasTarget(previous, cnameTarget);
      if (native !== null) await native.recover(request);
      const stored = await input.persistence.claimDelete({ ...request, now: now(input.clock) });
      if (stored === null || stored.state === "deleted") return emptyView(cnameTarget, "deleted");
      requireCurrentSaasTarget(stored, cnameTarget);
      if (native !== null) await native.synchronize(request);
      const removal = await removeConnection(
        stored,
        input.customerDns,
        native === null ? undefined : request.idempotencyKeySha256,
      );
      return view(
        stored,
        removal === "removed" ? "deleted" : "reconciliation_required",
        cnameTarget,
      );
    },
    /**
     * The project's deletion removes its live connection before the project's DNS grant is
     * revoked, so the route, custom hostname and hostname never outlive the project.
     */
    async deleteProjectPaidDomain(raw: unknown): Promise<void> {
      const request = parseProjectDeletion(raw);
      if (input.projectDeletionDns === undefined)
        throw new TypeError("Paid domain project deletion DNS access is unavailable");
      const stored = await input.persistence.claimProjectDeletion({
        ...request,
        now: now(input.clock),
      });
      if (stored === null) return;
      requireCurrentSaasTarget(stored, cnameTarget);
      // A project deletion never completes over customer records it cannot remove, as with an expired authorization.
      if (
        (await removeConnection(stored, input.projectDeletionDns(request))) ===
        "reconciliation_required"
      )
        throw new Error("Paid domain customer DNS authorization requires reauthorization");
    },
  });
}

function requireCurrentSaasTarget(record: PaidDomainRecord, target: SaasCnameTarget): void {
  if (
    record.customHostnameReceipt !== null &&
    record.customHostnameReceipt.customerCnameTarget !== target
  ) {
    throw new Error("Paid domain receipt requires the current SaaS target");
  }
}

async function reconcileCustomerDns(
  customerDns: CustomerDomainDns | undefined,
  record: PaidDomainRecord,
  remove: boolean,
): Promise<"reconciled" | "reconciliation_required"> {
  if (customerDns === undefined || record.customHostnameReceipt === null) return "reconciled";
  const access = await customerDns.loadAccess(record);
  if (access.status === "absent") return "reconciled";
  // The consenting owner lost write authority over the zone, or the grant is closed for now: nothing is written or
  // removed, and the caller says so.
  if (access.status === "reauthorization_required" || access.status === "reconciliation_required")
    return "reconciliation_required";
  // An expired grant can no longer write the zone; removal proceeds without its records, as the owner revoked them.
  if (access.status === "expired") return "reconciled";
  if (!hostnameBelongsToZone(record.hostname, access.zoneName)) {
    throw new Error("Paid domain customer DNS zone does not match the hostname");
  }
  const desired = desiredCustomerDns(record);
  const reconciled = await customerDns.reconcileRecords(
    access.accessToken,
    { zoneId: access.zoneId, zoneName: access.zoneName, records: desired },
    // The apply already owns the durable hostname claim and this zone-scoped grant.
    // Deletion must never replace a customer's subsequent web configuration.
    remove ? { observeOnly: true } : { replaceTrafficHostname: record.hostname },
  );
  if (!remove && reconciled.records.length !== desired.length) {
    throw new Error("Paid domain customer DNS readback is incomplete");
  }
  if (remove && reconciled.records.length > 0) {
    await customerDns.deleteRecords(access.accessToken, {
      zoneId: access.zoneId,
      zoneName: access.zoneName,
      records: reconciled.records,
    });
  }
  return "reconciled";
}

function desiredCustomerDns(record: PaidDomainRecord): readonly CloudflareDesiredDnsRecord[] {
  const source = record.customHostnameReceipt?.dnsRecords ?? [];
  const unique = new Map<string, CloudflareDesiredDnsRecord>();
  for (const item of source) {
    const desired = Object.freeze({
      type: item.type,
      name: item.name,
      content: item.content,
      ttl: 300,
      proxied: false,
      comment: `ohmyhost:${record.projectId}:paid-${item.purpose}:v1`,
    });
    unique.set(`${desired.type}\t${desired.name}\t${desired.content}`, desired);
  }
  if (unique.size === 0 || unique.size > 16) {
    throw new Error("Paid domain customer DNS requirements are invalid");
  }
  return Object.freeze([...unique.values()]);
}

function hostnameBelongsToZone(hostname: string, zoneName: string): boolean {
  return hostname === zoneName || hostname.endsWith(`.${zoneName}`);
}

function view(
  record: PaidDomainRecord,
  status:
    | "awaiting_deployment"
    | "pending"
    | "active"
    | "reconciliation_required"
    | "deleted"
    | "suspended",
  cnameTarget: SaasCnameTarget,
  suspensionReason:
    | "paid_plan_required"
    | "insufficient_organization_credits"
    | "project_budget_exceeded"
    | null = null,
) {
  const custom = record.customHostnameReceipt;
  return Object.freeze({
    status,
    suspensionReason,
    hostname: record.hostname,
    environment: "prod" as const,
    cnameTarget,
    customHostnameStatus: custom?.status ?? null,
    sslStatus: custom?.ssl.status ?? null,
    validationRecords: Object.freeze(
      (custom?.dnsRecords ?? []).map(({ type, name, content, purpose }) =>
        Object.freeze({ type, name, content, purpose }),
      ),
    ),
    url: status === "active" ? `https://${record.hostname}` : null,
  });
}

function emptyView(
  cnameTarget: SaasCnameTarget,
  status: "not_configured" | "deleted" = "not_configured",
) {
  return Object.freeze({
    status,
    suspensionReason: null,
    hostname: null,
    environment: "prod" as const,
    cnameTarget,
    customHostnameStatus: null,
    sslStatus: null,
    validationRecords: Object.freeze([]),
    url: null,
  });
}

function parsePlan(value: unknown) {
  const record = exactRecord(value, ["actorId", "hostname", "organizationId", "projectId"]);
  const result = { ...parseIds(record), hostname: String(record["hostname"]) };
  validateHostname(result.hostname);
  return Object.freeze(result);
}

function parseMutation(value: unknown, allowDelegation = false) {
  const record = exactRecord(value, [
    "actorId",
    "hostname",
    "idempotencyKeySha256",
    "organizationId",
    "projectId",
    "requestSha256",
    ...(allowDelegation && isRecord(value) && "delegation" in value ? ["delegation"] : []),
  ]);
  const result = {
    ...parseIds(record),
    principalId: String(record["actorId"]),
    hostname: String(record["hostname"]),
    idempotencyKeySha256: String(record["idempotencyKeySha256"]),
    requestSha256: String(record["requestSha256"]),
    ...("delegation" in record ? { delegation: record["delegation"] } : {}),
  };
  validateHostname(result.hostname);
  validateMutation(result);
  return Object.freeze(result);
}

function parseProjectDeletion(value: unknown) {
  const record = exactRecord(value, ["operationId", "organizationId", "projectId"]);
  return Object.freeze({
    ...parseIds(record),
    operationId: parseUlid(String(record["operationId"])),
  });
}

function parseScope(value: unknown) {
  const record = exactRecord(value, ["actorId", "organizationId", "projectId"]);
  return parseIds(record);
}

function parseIds(record: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    organizationId: parseUlid(String(record["organizationId"])),
    projectId: parseUlid(String(record["projectId"])),
  });
}

function validateHostname(hostname: string) {
  if (
    !HOSTNAME.test(hostname) ||
    hostname.endsWith(".poc.aixyte.com") ||
    hostname === "omh.st" ||
    hostname.endsWith(".omh.st") ||
    hostname === "ohmyho.st" ||
    hostname.endsWith(".ohmyho.st")
  ) {
    throw new TypeError("Paid domain hostname is invalid");
  }
}

function validateMutation(value: {
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
}) {
  if (!DIGEST.test(value.idempotencyKeySha256) || !DIGEST.test(value.requestSha256)) {
    throw new TypeError("Paid domain mutation digest is invalid");
  }
}

function now(clock: { now(): Date }) {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Paid domain clock is invalid");
  }
  return value.toISOString();
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError("Paid domain input is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
