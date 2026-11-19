import {
  createOrganizationMcpConnectionsPort,
  isOrganizationMcpConnectionsRuntime,
} from "./organization-mcp-connections.js";
import {
  createD1CreditManagement,
  type CreditServiceBinding,
  type D1CreditRuntime,
} from "./d1-credits.js";
import { createD1FeedbackPersistence, type FeedbackRuntime } from "./d1-feedback.js";
import {
  createD1PublicEntry,
  type PublicEntryRuntime,
  type PublicEntryRetentionRuntime,
} from "./d1-public-entry.js";
import {
  createD1ProductSurfacePort,
  isD1ProductSurfaceRuntime,
  type D1ProductSurfaceRuntime,
} from "./d1-product-surface.js";
import {
  createD1ProjectDataChanges,
  type D1ProjectDataChangeRuntime,
} from "./d1-project-data-changes.js";
import {
  createD1ManagedSourceComposition,
  isD1ManagedSourceRuntime,
} from "./d1-managed-source-store.js";
import {
  createD1ProjectMailDomainsPort,
  type D1MailDomainReadRuntime,
} from "./d1-project-mail-domains.js";
import {
  createD1GithubOrganizationConnection,
  createD1GithubSourceAuthorization,
  isD1GithubRuntime,
} from "./d1-github.js";
import { createD1SharedMailPort, isD1SharedMailRuntime } from "./d1-shared-mail.js";
import {
  createCloudflareDomainManagementPort,
  type CloudflareDomainManagementBinding,
} from "./cloudflare-domain-management.js";
import { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";
import {
  createProviderReconciliationPort,
  type ProviderReconciliationBinding,
} from "./provider-reconciliation.js";
import type { WorkspaceMailProviderBinding } from "./shared-mail-persistence.js";
import type { GithubAuthorizationBinding } from "./github-source-authorization.js";
import type { GithubOrganizationBinding } from "./github-organization-connection.js";
import { createWorkosSessionStatusClient } from "./workos-session-status.js";
import { createWorkosUserApiKeyClient } from "./workos-user-api-keys.js";
import { createD1ProductOperationReader } from "./d1-product-operation.js";
import {
  createD1DevAccessManagementPort,
  createD1DevAccessTicketsPort,
  isD1DevAccessRuntime,
} from "./d1-dev-access.js";
import {
  createD1DeploymentDiagnosticsPort,
  createD1FunctionRunsPort,
  isD1CustomerReadsRuntime,
} from "./d1-customer-reads.js";
import type { ManagedSourcePrivateBinding } from "./managed-source-composition.js";
import type { SourceInspectorBinding } from "./product-surface.js";
import type { ControlApiDependencies, ControlApiPersistence } from "./contracts.js";
import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type { ProductApiPreviewRuntime } from "@ohmyhost/contracts/previews";
import {
  createPreviewSurface,
  notifyPreviewSources,
  type PreviewExecutionBinding,
} from "./preview-surface.js";
import { createGithubInitialPreviewSource } from "./d1-github-auto-deploy.js";

export interface D1ExtendedBindings {
  readonly PREVIEW_API_RUNTIME?: ProductApiPreviewRuntime;
  readonly PREVIEW_EXECUTION?: PreviewExecutionBinding;
  readonly CONTROL_RUNTIME?: unknown;
  readonly PUBLIC_ENTRY_RUNTIME?: PublicEntryRuntime;
  readonly PUBLIC_ENTRY_RETENTION_RUNTIME?: PublicEntryRetentionRuntime;
  readonly CUSTOMER_FEEDBACK_RUNTIME?: FeedbackRuntime;
  readonly PUBLIC_CREDIT_RUNTIME?: D1CreditRuntime;
  /** The credit service: the daily credit log behind the usage report. */
  readonly CREDIT_SERVICE?: CreditServiceBinding;
  readonly PRODUCT_API_RUNTIME?: D1ProductSurfaceRuntime &
    D1ProjectDataChangeRuntime & { readApiProductOperation(input: unknown): Promise<unknown> };
  readonly MANAGED_SOURCE_RUNTIME?: unknown;
  readonly DEV_ACCESS_RUNTIME?: unknown;
  readonly MAIL_MANAGEMENT_RUNTIME?: D1MailDomainReadRuntime;
  readonly SHARED_MAIL_RUNTIME?: unknown;
  readonly MAIL_DOMAIN_OBSERVER?: Partial<WorkspaceMailProviderBinding>;
  readonly GITHUB_RUNTIME?: unknown;
  readonly SOURCE_INSPECTOR?: SourceInspectorBinding & Partial<ManagedSourcePrivateBinding>;
  readonly MANAGED_ARTIFACTS_NAMESPACE_US?: string;
  readonly MANAGED_ARTIFACTS_NAMESPACE_EU?: string;
  readonly OPERATION_PUBLISHER?: { wake(): Promise<void> };
  readonly AUTH_STATUS?: unknown;
  readonly PROVIDER_RECONCILIATION?: ProviderReconciliationBinding;
  readonly CLOUDFLARE_DOMAIN_MANAGEMENT?: CloudflareDomainManagementBinding;
  readonly ENVIRONMENT_SECRET_KEY_BASE64?: string;
  readonly ENVIRONMENT_SECRET_KEY_VERSION?: string;
  readonly ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON?: string;
}

/** A port whose private binding is only required when a route actually calls it; a missing binding fails that call. */
export function lazyPort<T extends object>(build: () => T): T {
  let target: T | undefined;
  return new Proxy({} as T, {
    get(_proxy, key) {
      target ??= build();
      return Reflect.get(target, key);
    },
  });
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null) throw new Error(`${name}_binding_required`);
  return value;
}

/** Calls the publisher on its RPC binding as a method; a bound copy would reach it as the method "wake.bind". */
export function wakeOperationPublisher(
  bindings: Pick<D1ExtendedBindings, "OPERATION_PUBLISHER">,
): () => Promise<void> {
  return async () => required(bindings.OPERATION_PUBLISHER, "operation_publisher").wake();
}

/** Every Core-backed port of the Control API, built on first use. */
export function createD1ExtendedPorts(input: {
  readonly bindings: D1ExtendedBindings;
  readonly publicOrigin: string;
  readonly clock: Clock;
  readonly ids: UlidFactory;
}) {
  const { bindings, clock, ids } = input;
  const devAccessCipher = () =>
    createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: required(bindings.ENVIRONMENT_SECRET_KEY_BASE64, "environment_secret_key"),
      currentKeyVersion: Number(bindings.ENVIRONMENT_SECRET_KEY_VERSION),
      crypto: globalThis.crypto,
      ...(bindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON === undefined
        ? {}
        : { additionalKeysJson: bindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON }),
    });
  const productRuntime = () => {
    const runtime = required(bindings.PRODUCT_API_RUNTIME, "product_api");
    if (!isD1ProductSurfaceRuntime(runtime)) throw new Error("product_api_binding_required");
    return runtime;
  };
  const devAccess = () => {
    const runtime = bindings.DEV_ACCESS_RUNTIME;
    if (!isD1DevAccessRuntime(runtime)) throw new Error("dev_access_binding_required");
    return runtime;
  };
  const githubDependencies = () => {
    const runtime = bindings.GITHUB_RUNTIME,
      product = bindings.PRODUCT_API_RUNTIME,
      control = bindings.CONTROL_RUNTIME;
    if (
      !isD1GithubRuntime(runtime) ||
      !isD1ProductSurfaceRuntime(product) ||
      typeof Reflect.get(Object(control), "authorizeOrganizationAction") !== "function"
    )
      throw new Error("github_binding_required");
    return {
      runtime,
      product: product as NonNullable<D1ExtendedBindings["PRODUCT_API_RUNTIME"]>,
      control: control as {
        authorizeOrganizationAction(input: unknown): Promise<"allow" | "deny">;
      },
      callbackUri: `${input.publicOrigin}/v1/github/oauth/callback`,
      clock,
      ids,
      cipher: devAccessCipher(),
      sessionStatus: createWorkosSessionStatusClient(auth() as never),
      apiKeyStatus: createWorkosUserApiKeyClient(auth() as never),
    };
  };
  const auth = () => required(bindings.AUTH_STATUS, "auth_status");
  const customerReads = () => {
    const runtime = bindings.CONTROL_RUNTIME;
    if (!isD1CustomerReadsRuntime(runtime)) throw new Error("customer_reads_binding_required");
    return runtime;
  };
  const sourceInspector = () => required(bindings.SOURCE_INSPECTOR, "source_inspector");
  const managedSources = () => {
    const runtime = required(bindings.MANAGED_SOURCE_RUNTIME, "managed_source");
    const binding = sourceInspector();
    if (
      !isD1ManagedSourceRuntime(runtime) ||
      !bindings.MANAGED_ARTIFACTS_NAMESPACE_US ||
      !bindings.MANAGED_ARTIFACTS_NAMESPACE_EU ||
      typeof binding.managedGit !== "function" ||
      typeof binding.managedBlob !== "function"
    )
      throw new Error("managed_source_binding_required");
    return createD1ManagedSourceComposition({
      runtime,
      clock,
      ids,
      binding: binding as ManagedSourcePrivateBinding,
      namespaces: {
        us: bindings.MANAGED_ARTIFACTS_NAMESPACE_US,
        eu: bindings.MANAGED_ARTIFACTS_NAMESPACE_EU,
      },
      wake: wakeOperationPublisher(bindings),
    });
  };
  return {
    previews: lazyPort(() => {
      const core = required(bindings.PREVIEW_API_RUNTIME, "preview_api");
      const source = sourceInspector() as SourceInspectorBinding & {
        resolvePreviewGithubHead(input: {
          installationId: string;
          repositoryId: string;
          repositoryFullName: string;
          ref: string | null;
        }): Promise<unknown>;
      };
      return createPreviewSurface({
        core,
        runtime: required(bindings.PREVIEW_EXECUTION, "preview_execution"),
        cipher: devAccessCipher(),
        ids,
        hostSuffix:
          input.publicOrigin === "https://app.ohmyho.st" ? "preview.omh.st" : "preview.dev.omh.st",
        ensureInitialSource: createGithubInitialPreviewSource({
          core,
          source,
          notify: (scope) => notifyPreviewSources(core, bindings.PREVIEW_EXECUTION, scope),
        }),
      });
    }) as NonNullable<ControlApiDependencies["previews"]>,
    publicEntry: lazyPort(() =>
      createD1PublicEntry(required(bindings.PUBLIC_ENTRY_RUNTIME, "public_entry"), clock),
    ) as NonNullable<ControlApiDependencies["publicEntry"]>,
    credits: lazyPort(() =>
      createD1CreditManagement({
        runtime: required(bindings.PUBLIC_CREDIT_RUNTIME, "public_credit"),
        service: bindings.CREDIT_SERVICE,
        clock,
        ids,
      }),
    ) as NonNullable<ControlApiDependencies["credits"]>,
    productSurface: lazyPort(() => {
      const runtime = productRuntime();
      return createD1ProductSurfacePort({
        runtime,
        clock,
        ids,
        sourceInspector: sourceInspector(),
        dataChanges: createD1ProjectDataChanges({
          runtime,
          clock,
          ids,
          devAccessCipher: devAccessCipher(),
        }),
      });
    }) as ControlApiDependencies["productSurface"],
    projectMailDomains: lazyPort(() =>
      createD1ProjectMailDomainsPort(required(bindings.MAIL_MANAGEMENT_RUNTIME, "mail_management")),
    ) as ControlApiDependencies["projectMailDomains"],
    sharedMail: lazyPort(() => {
      const runtime = bindings.SHARED_MAIL_RUNTIME,
        provider = bindings.MAIL_DOMAIN_OBSERVER;
      if (
        !isD1SharedMailRuntime(runtime) ||
        typeof provider?.ensureWorkspaceMailDomain !== "function" ||
        typeof provider.syncWorkspaceMailDomain !== "function" ||
        typeof provider.retireWorkspaceMailDomain !== "function"
      )
        throw new Error("shared_mail_binding_required");
      return createD1SharedMailPort({
        runtime,
        provider: provider as WorkspaceMailProviderBinding,
        clock,
        ids,
      });
    }) as NonNullable<ControlApiDependencies["sharedMail"]>,
    githubSourceAuthorization: lazyPort(() =>
      createD1GithubSourceAuthorization({
        ...githubDependencies(),
        source: sourceInspector() as unknown as GithubAuthorizationBinding,
      }),
    ) as NonNullable<ControlApiDependencies["githubSourceAuthorization"]>,
    githubOrganizationConnection: lazyPort(() =>
      createD1GithubOrganizationConnection({
        ...githubDependencies(),
        source: sourceInspector() as unknown as GithubOrganizationBinding,
      }),
    ) as NonNullable<ControlApiDependencies["githubOrganizationConnection"]>,
    organizationMcpConnections: lazyPort(() => {
      const runtime = bindings.CONTROL_RUNTIME;
      if (!isOrganizationMcpConnectionsRuntime(runtime))
        throw new Error("organization_mcp_connections_binding_required");
      return createOrganizationMcpConnectionsPort({ runtime, clock });
    }) as NonNullable<ControlApiDependencies["organizationMcpConnections"]>,
    devAccessTickets: lazyPort(() =>
      createD1DevAccessTicketsPort({ runtime: devAccess(), clock, ids, crypto: globalThis.crypto }),
    ) as ControlApiDependencies["devAccessTickets"],
    devAccessManagement: lazyPort(() =>
      createD1DevAccessManagementPort({
        runtime: devAccess(),
        clock,
        crypto: globalThis.crypto,
        cipher: devAccessCipher(),
      }),
    ) as NonNullable<ControlApiDependencies["devAccessManagement"]>,
    functionRuns: lazyPort(() => createD1FunctionRunsPort(customerReads())) as NonNullable<
      ControlApiDependencies["functionRuns"]
    >,
    deploymentDiagnostics: lazyPort(() =>
      createD1DeploymentDiagnosticsPort(customerReads(), () => clock.now()),
    ) as NonNullable<ControlApiDependencies["deploymentDiagnostics"]>,
    providerReconciliation: lazyPort(() =>
      createProviderReconciliationPort(
        required(bindings.PROVIDER_RECONCILIATION, "provider_reconciliation"),
      ),
    ) as NonNullable<ControlApiDependencies["providerReconciliation"]>,
    cloudflareDomains: lazyPort(() =>
      createCloudflareDomainManagementPort(
        required(bindings.CLOUDFLARE_DOMAIN_MANAGEMENT, "cloudflare_domain_management"),
      ),
    ) as NonNullable<ControlApiDependencies["cloudflareDomains"]>,
    managedSources: lazyPort(managedSources) as NonNullable<
      ControlApiDependencies["managedSources"]
    >,
    /** Feedback and the original full operation read; project recovery and database reads stay in the caller. */
    persistence: {
      ...(bindings.CUSTOMER_FEEDBACK_RUNTIME === undefined
        ? {}
        : createD1FeedbackPersistence({ runtime: bindings.CUSTOMER_FEEDBACK_RUNTIME, clock, ids })),
      ...(bindings.PRODUCT_API_RUNTIME === undefined
        ? {}
        : { getOperation: createD1ProductOperationReader(bindings.PRODUCT_API_RUNTIME) }),
    } satisfies Partial<ControlApiPersistence>,
  };
}
