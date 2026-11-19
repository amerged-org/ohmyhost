import { normalizeApplicationRoot } from "@ohmyhost/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import { creditMicros, parseUlid } from "../shared/index.js";

import type {
  BuildPlanInput,
  BuildProvider,
  BuildStartInput,
  DatabaseApplyInput,
  DatabaseProvider,
  DatabaseProjectPlacementProvider,
  DeploymentApplyInput,
  DeploymentPlanInput,
  DomainApplyInput,
  DomainProvider,
  EdgeRuntimeProvider,
  MailSendInput,
  MailProvider,
  MailTenantProvider,
  ObservedResource,
  ProviderMutationContext,
  ProviderPlan,
  ProviderRef,
  ProviderRemoveInput,
  StaticHostingProvider,
  UsageSource,
} from "./providers.js";
import type { FrameworkPlan } from "./framework.js";
import type * as PublicPorts from "./index.js";
import type * as PublicPlatform from "../index.js";

const operationId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const projectId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const environmentId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX");

const mutationContext: ProviderMutationContext = {
  operationId,
  idempotencyKey: "operation:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId,
  environmentId,
};

const staticPlan: ProviderPlan<"static-hosting"> = {
  capability: "static-hosting",
  actions: ["publish immutable artifact"],
  estimatedCreditCharge: creditMicros(1n),
};

const frameworkPlan: FrameworkPlan = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: normalizeApplicationRoot(),
  adapter: "vite",
  runtime: "static",
  installCommand: "pnpm install --frozen-lockfile",
  buildCommand: "pnpm build",
  outputDirectory: "dist",
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
};

const staticRef: ProviderRef<"static-hosting"> = {
  capability: "static-hosting",
  provider: "local-test",
  externalId: "static-1",
};

describe("provider capability ports", () => {
  it("exposes separate capability-specific contracts", () => {
    expectTypeOf<StaticHostingProvider>().toHaveProperty("apply");
    expectTypeOf<EdgeRuntimeProvider>().toHaveProperty("apply");
    expectTypeOf<BuildProvider>().toHaveProperty("start");
    expectTypeOf<DatabaseProvider>().toHaveProperty("apply");
    expectTypeOf<DatabaseProjectPlacementProvider>().toHaveProperty("createProject");
    expectTypeOf<DatabaseProjectPlacementProvider>().toHaveProperty("observeProject");
    expectTypeOf<DomainProvider>().toHaveProperty("apply");
    expectTypeOf<MailProvider>().toHaveProperty("send");
    expectTypeOf<MailTenantProvider>().toHaveProperty("createTenant");
    expectTypeOf<MailTenantProvider>().toHaveProperty("observeTenant");
    expectTypeOf<UsageSource>().toHaveProperty("read");
  });

  it("requires mutation context for apply/remove while observe stays read-only", () => {
    expectTypeOf<Parameters<StaticHostingProvider["apply"]>[0]>().toEqualTypeOf<
      DeploymentApplyInput<"static-hosting">
    >();
    expectTypeOf<Parameters<StaticHostingProvider["remove"]>[0]>().toEqualTypeOf<
      ProviderRemoveInput<"static-hosting">
    >();
    expectTypeOf<Parameters<StaticHostingProvider["observe"]>[0]>().toEqualTypeOf<
      ProviderRef<"static-hosting">
    >();
    expectTypeOf<
      Parameters<StaticHostingProvider["observeByMutation"]>[0]
    >().toEqualTypeOf<ProviderMutationContext>();
    expectTypeOf<ReturnType<StaticHostingProvider["observeByMutation"]>>().toEqualTypeOf<
      Promise<ObservedResource<"static-hosting"> | null>
    >();

    expectTypeOf<Parameters<EdgeRuntimeProvider["remove"]>[0]>().toHaveProperty("context");
    expectTypeOf<DatabaseApplyInput>().toHaveProperty("context");
    expectTypeOf<Parameters<DatabaseProvider["remove"]>[0]>().toHaveProperty("context");
    expectTypeOf<DomainApplyInput>().toHaveProperty("context");
    expectTypeOf<Parameters<DomainProvider["remove"]>[0]>().toHaveProperty("context");
    expectTypeOf<MailSendInput>().toHaveProperty("context");
  });

  it("passes the same stable context into provider mutations at runtime", async () => {
    const received: ProviderMutationContext[] = [];
    const observedMutations: ProviderMutationContext[] = [];
    const plannedFrameworks: FrameworkPlan[] = [];
    const provider: StaticHostingProvider = {
      plan: async (input) => {
        plannedFrameworks.push(input.frameworkPlan);
        return staticPlan;
      },
      apply: async (input) => {
        received.push(input.context);
        return { ...staticRef, createdAt: new Date("2026-01-01T00:00:00.000Z") };
      },
      observe: async (ref) => ({
        ref,
        state: "ready",
        observedAt: new Date("2026-01-01T00:00:01.000Z"),
      }),
      observeByMutation: async (context) => {
        observedMutations.push(context);
        return {
          ref: staticRef,
          state: "ready",
          observedAt: new Date("2026-01-01T00:00:01.000Z"),
        };
      },
      remove: async (input) => {
        received.push(input.context);
      },
    };

    await provider.plan({
      artifactDigest: "sha256:artifact",
      projectId,
      environmentId,
      frameworkPlan,
    });
    await provider.apply({
      artifactDigest: "sha256:artifact",
      context: mutationContext,
      frameworkPlan,
      plan: staticPlan,
    });
    await provider.remove({ ref: staticRef, context: mutationContext });
    await provider.observe(staticRef);
    const recovered = await provider.observeByMutation(mutationContext);

    expect(received).toEqual([mutationContext, mutationContext]);
    expect(observedMutations).toEqual([mutationContext]);
    expect(recovered?.ref).toEqual(staticRef);
    expect(plannedFrameworks).toEqual([frameworkPlan]);
  });

  it("carries the produced framework plan through deployment plan and apply inputs", () => {
    expectTypeOf<DeploymentPlanInput>().toHaveProperty("frameworkPlan");
    expectTypeOf<DeploymentPlanInput["frameworkPlan"]>().toEqualTypeOf<FrameworkPlan>();
    expectTypeOf<
      DeploymentApplyInput<"static-hosting">["frameworkPlan"]
    >().toEqualTypeOf<FrameworkPlan>();
    expectTypeOf<Parameters<EdgeRuntimeProvider["plan"]>[0]>().toEqualTypeOf<DeploymentPlanInput>();
    expectTypeOf<Parameters<EdgeRuntimeProvider["apply"]>[0]>().toEqualTypeOf<
      DeploymentApplyInput<"edge-runtime">
    >();
  });

  it("requires build start to consume its accepted plan and stop to carry context", () => {
    expectTypeOf<Parameters<BuildProvider["plan"]>[0]>().toEqualTypeOf<BuildPlanInput>();
    expectTypeOf<Parameters<BuildProvider["start"]>[0]>().toEqualTypeOf<BuildStartInput>();
    expectTypeOf<BuildStartInput>().toHaveProperty("plan");
    expectTypeOf<BuildStartInput>().toHaveProperty("acceptedPlanDigest");
    expectTypeOf<Parameters<BuildProvider["stop"]>[0]>().toEqualTypeOf<
      ProviderRemoveInput<"build">
    >();
    expectTypeOf<Parameters<BuildProvider["read"]>[0]>().toEqualTypeOf<ProviderRef<"build">>();
  });

  it("passes an accepted plan and stable context into build mutations", async () => {
    const buildPlan: ProviderPlan<"build"> = {
      capability: "build",
      actions: ["run isolated build"],
      estimatedCreditCharge: creditMicros(2n),
    };
    const buildRef: ProviderRef<"build"> = {
      capability: "build",
      provider: "local-test",
      externalId: "build-1",
    };
    const received: BuildStartInput[] = [];
    const stopped: ProviderMutationContext[] = [];
    const provider: BuildProvider = {
      plan: async () => buildPlan,
      start: async (input) => {
        received.push(input);
        return {
          ...buildRef,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          state: "queued",
        };
      },
      read: async () => ({
        ...buildRef,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        state: "running",
      }),
      stop: async (input) => {
        stopped.push(input.context);
      },
    };
    const startInput: BuildStartInput = {
      sourceDigest: "sha256:source",
      buildPlanDigest: "sha256:framework-plan",
      plan: buildPlan,
      acceptedPlanDigest: "sha256:provider-plan",
      context: mutationContext,
    };

    await provider.start(startInput);
    await provider.stop({ ref: buildRef, context: mutationContext });

    expect(received).toEqual([startInput]);
    expect(stopped).toEqual([mutationContext]);
  });

  it("exports mutation contracts from both public platform entry points", () => {
    expectTypeOf<PublicPorts.ProviderMutationContext>().toEqualTypeOf<ProviderMutationContext>();
    expectTypeOf<PublicPlatform.ProviderMutationContext>().toEqualTypeOf<ProviderMutationContext>();
    expectTypeOf<PublicPorts.ProviderRemoveInput<"domain">>().toEqualTypeOf<
      ProviderRemoveInput<"domain">
    >();
    expectTypeOf<PublicPlatform.BuildStartInput>().toEqualTypeOf<BuildStartInput>();
    expectTypeOf<PublicPorts.DeploymentPlanInput>().toEqualTypeOf<DeploymentPlanInput>();
    expectTypeOf<PublicPorts.StaticHostingProvider>().toEqualTypeOf<StaticHostingProvider>();
    expectTypeOf<PublicPlatform.StaticHostingProvider>().toEqualTypeOf<StaticHostingProvider>();
    expectTypeOf<PublicPlatform.DatabaseProjectPlacementProvider>().toEqualTypeOf<DatabaseProjectPlacementProvider>();
  });
});
