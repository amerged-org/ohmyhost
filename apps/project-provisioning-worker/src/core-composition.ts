import {
  createProjectProvisioningConsumer,
  createProjectProvisioningPublisher,
  createProductCommandConsumer,
  createProductCommandPublisher,
} from "@ohmyhost/orchestrator";
import { SystemClock, SystemEntropy, createUlidFactory, parseUlid } from "@ohmyhost/platform";
import type { CorePublisherBindings, CoreConsumerBindings } from "./core-bindings.js";
import {
  createCoreProvisioningOutbox,
  createCoreProductClaims,
  createCoreProvisioningPersistence,
  createCoreManagedSourceState,
} from "./core-persistence.js";
import {
  createCloudflareProjectProvisioningQueue,
  createCloudflareProjectProvisioningWorkflow,
  createCloudflareProductCommandWorkflow,
} from "./cloudflare-adapters.js";
import { createQueueMessageRouter } from "./composition.js";
import {
  createManagedSourcePublicationConsumer,
  projectClaimedPublication,
  sendWithDeadline,
} from "./managed-source-jobs.js";
const ids = (clock: SystemClock) => createUlidFactory({ clock, entropy: new SystemEntropy() });
/** Bounded publisher order and deadlines with separate claim, send and acknowledge calls. */
export function createCoreScheduledPublisher(bindings: CorePublisherBindings, limit: 1 | 10 = 10) {
  const clock = new SystemClock(),
    identities = ids(clock),
    binding = bindings.PROJECT_DISPATCH_RUNTIME,
    queue = createCloudflareProjectProvisioningQueue(bindings.PROJECT_PROVISIONING_QUEUE);
  const provisioning = createProjectProvisioningPublisher({
    outbox: createCoreProvisioningOutbox(binding, clock, identities),
    queue,
    queueSendTimeoutMilliseconds: 5_000,
    classifyQueueError: () => "uncertain",
  });
  const product = createProductCommandPublisher({
    claims: createCoreProductClaims(binding, clock, identities),
    queue,
  });
  const managed = async () => {
    if (
      await binding.recoverManagedSourceDispatch({
        now: clock.now().toISOString(),
        auditEventId: identities.next(),
      })
    )
      return { status: "reconciliation_required" as const };
    // A publication whose dispatch can never succeed ends before this tick claims more work.
    if (await binding.sweepExhaustedManagedSourceDispatch({ now: clock.now().toISOString() }))
      return { status: "reconciliation_required" as const };
    const claimed = await binding.claimManagedSourceDispatch({
      now: clock.now().toISOString(),
      attemptId: identities.next(),
    });
    if (claimed === null) return { status: "idle" as const };
    const message = projectClaimedPublication({
      ...claimed,
      eventId: parseUlid(claimed.eventId),
      organizationId: parseUlid(claimed.organizationId),
      projectId: parseUlid(claimed.projectId),
      operationId: parseUlid(claimed.operationId),
      billingEpochId: parseUlid(claimed.billingEpochId),
      attemptId: parseUlid(claimed.attemptId),
      claimedAt: claimed.claimedAt,
      leaseExpiresAt: claimed.leaseExpiresAt,
    });
    await binding.readManagedSourceDispatchState(message);
    if ((await sendWithDeadline(queue, JSON.stringify(message))) !== "sent") {
      const result = await binding.failManagedSourceDispatch({
        eventId: claimed.eventId,
        attemptId: claimed.attemptId,
        errorCode: "MANAGED_SOURCE_QUEUE_SEND_UNCERTAIN",
        failedAt: clock.now().toISOString(),
        auditEventId: identities.next(),
      });
      if (result === null) throw new Error("Managed source dispatch attempt is stale");
      return { status: result.outcome };
    }
    if (
      !(await binding.acknowledgeManagedSourceDispatch({
        eventId: claimed.eventId,
        attemptId: claimed.attemptId,
        now: clock.now().toISOString(),
      }))
    )
      throw new Error("Managed source dispatch attempt is stale");
    return { status: "published" as const };
  };
  return Object.freeze({
    publishOne: async () => {
      // A failing recovery is one operation's stuck state: it must not hold back the publishing of every tenant.
      try {
        for (let i = 0; i < limit; i++)
          if (
            (await binding.recoverProductExecutionLease({ now: clock.now().toISOString() })) ===
            null
          )
            break;
      } catch (error) {
        console.error(
          "operation_lease_recovery_failed",
          error instanceof Error ? error.message : "unknown",
        );
      }
      let provisioningResult = await provisioning.publishOne();
      for (let i = 1; i < limit && provisioningResult.status === "published"; i++)
        provisioningResult = await provisioning.publishOne();
      let productResult = await product.publishOne();
      for (let i = 1; i < limit && productResult.status !== "idle"; i++)
        productResult = await product.publishOne();
      let managedSourceResult = await managed();
      for (let i = 1; i < limit && managedSourceResult.status !== "idle"; i++)
        managedSourceResult = await managed();
      return {
        provisioning: provisioningResult,
        product: productResult,
        managedSource: managedSourceResult,
      };
    },
  });
}
export function createCoreQueueConsumer(bindings: CoreConsumerBindings) {
  const clock = new SystemClock();
  return createQueueMessageRouter({
    provisioning: createProjectProvisioningConsumer({
      workflow: createCloudflareProjectProvisioningWorkflow(bindings.PROJECT_PROVISIONING_WORKFLOW),
      ...createCoreProvisioningPersistence(bindings.PROJECT_WORKFLOW_RUNTIME, clock, ids(clock)),
    }),
    product: createProductCommandConsumer(
      createCloudflareProductCommandWorkflow(bindings.DEPLOYMENT_WORKFLOW),
    ),
    ...(bindings.MANAGED_SOURCE_PROCESSOR
      ? {
          managedSource: createManagedSourcePublicationConsumer({
            state: createCoreManagedSourceState(bindings.PROJECT_DISPATCH_RUNTIME),
            processor: bindings.MANAGED_SOURCE_PROCESSOR,
          }),
        }
      : {}),
  });
}
export function createCoreWorkflowPersistence(
  binding: import("./core-persistence.js").ProjectWorkflowRuntimeBinding,
) {
  const clock = new SystemClock();
  return createCoreProvisioningPersistence(binding, clock, ids(clock));
}
