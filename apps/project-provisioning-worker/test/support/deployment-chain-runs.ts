import { parseProductCommandMessageV1, type ProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import type { createControlStore } from "../../../control-store/src/store.js";
import { workflowFixture } from "../../../control-store/test/provisioning/workflow-fixture.js";
import type { TestControl } from "../../../control-store/test/support/control-d1.js";
import { newUlid } from "../../../control-store/src/catalog/common.js";
import {
  buildArtifact,
  buildReceipt,
  recordedStage,
  sourceArchive,
  stagedCandidate,
  wfpReceipt,
  domainEnvironment,
  type ChainIds,
  type Handlers,
} from "./deployment-chain-providers.js";

export type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
/** One accepted command with the Workflow identity it runs under, and the Core ids its provider answers repeat. */
export interface ChainRun {
  readonly command: ProductCommandMessageV1;
  readonly workflowId: string;
  readonly chain: ChainIds;
}

/** The queue dispatcher acknowledges the request's outbox event before the Workflow runs (as in production). */
export async function acknowledge(control: TestControl, eventId: string) {
  await control.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(eventId, "2026-10-28T11:00:04.000000Z")
    .run();
}

/**
 * The project's domain record, which project provisioning writes once per project; the gateway authority of every
 * activation is derived from it (control-store gateway facts AUTHORITY). Seeded like provider-fixtures does.
 */
export async function seedProjectDomain(control: TestControl, r: Fixture) {
  const handle = r.p.projectHandle;
  await control.core
    .prepare(
      "INSERT INTO cloudflare_project_domains(organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,mail_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at) VALUES(?1,?2,?3,?4,'omh.st',?5,?6,NULL,'user:fixture',?7,?7,?8)",
    )
    .bind(
      r.p.organizationId,
      r.p.projectId,
      r.p.operation.operationId,
      handle,
      `${handle}.omh.st`,
      `dev-${handle}.omh.st`,
      new Uint8Array(32).fill(3),
      "2026-10-28T10:00:00.000000Z",
    )
    .run();
}

/** A new DeploymentRequestedV1 of the fixture, parsed as the queue consumer parses it. */
export function deployRun(r: Fixture): ChainRun {
  const command = parseProductCommandMessageV1({
    version: 1,
    eventType: "DeploymentRequestedV1",
    eventId: r.input.eventId,
    organizationId: r.p.organizationId,
    projectId: r.p.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
    billingEpochId: r.p.billingEpochId,
    planId: r.plan,
  });
  return {
    command,
    workflowId: r.input.logicalWorkflowId,
    chain: {
      organizationId: r.p.organizationId,
      billingEpochId: r.p.billingEpochId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
      environmentName: "dev",
      operationId: r.input.operationId,
      deploymentId: r.deployment,
      buildId: "build-1",
    },
  };
}

/**
 * The provider answers of one chain: every answer is shaped like the real service's answer, and the activation is the
 * real gateway activation of the Core (through `activate`).
 */
export function chainHandlers(
  chain: ChainIds,
  activate: (input: unknown) => Promise<unknown>,
  stage: "stageCandidate" | "stagePromotionCandidate" = "stageCandidate",
) {
  const statuses = ["running", "succeeded"];
  let publicOrigin = "";
  return {
    SOURCE_FETCHER: { acquireExact: () => sourceArchive(chain) },
    BUILD_RUNNER: {
      startBuild: () => buildReceipt(chain),
      readBuild: () => ({ status: statuses.shift() ?? "succeeded" }),
      readBuildArtifact: () => buildArtifact(chain),
    },
    RUNTIME_SECRET_DELIVERY: {
      [stage]: () => stagedCandidate(chain),
      recordStagedCandidate: (input: unknown) => {
        const record = input as {
          candidateReceiptId: string;
          runtimeSecretDeliveryStage: Record<string, unknown>;
        };
        return {
          status: "recorded",
          runtimeSecretDeliveryStage: recordedStage(
            record.runtimeSecretDeliveryStage,
            record.candidateReceiptId,
          ),
        };
      },
      recordActivatedCandidate: (input: unknown) => {
        const record = input as { runtimeSecretDeliveryStage: unknown };
        return {
          status: "activated",
          activationReceiptId: newUlid(),
          activatedAt: new Date().toISOString(),
          runtimeSecretDeliveryStage: record.runtimeSecretDeliveryStage,
        };
      },
    },
    WFP_MANAGEMENT: {
      activateCandidate: async (input: unknown) => {
        const gateway = (await activate(input)) as { publicOrigin: string };
        publicOrigin = gateway.publicOrigin;
        return {
          status: "activated",
          candidate: wfpReceipt(chain),
          gateway,
          deploymentUrl: gateway.publicOrigin,
        };
      },
    },
    CLOUDFLARE_DOMAIN_MANAGEMENT: {
      ensureEnvironment: (input: unknown) =>
        domainEnvironment(input as Record<string, unknown>, publicOrigin),
    },
  } satisfies Handlers;
}

/** The real gateway activation of the Core for the scope the WFP stub receives. */
export function gatewayActivation(store: ReturnType<typeof createControlStore>, chain: ChainIds) {
  return async (raw: unknown) => {
    const input = raw as {
      organizationId: string;
      operationId: string;
      claimId: string;
      candidateReceiptId: string;
      previousGateway?: { revision?: number } | null;
    };
    return store.gateway.management.activate({
      organizationId: input.organizationId,
      projectId: chain.projectId,
      environmentId: chain.environmentId,
      operationId: input.operationId,
      claimId: input.claimId,
      expectedRevision: input.previousGateway?.revision ?? null,
      candidateReceiptId: input.candidateReceiptId,
      egressAllowedOrigins: [],
    });
  };
}
