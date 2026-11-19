import type { DeploymentInventoryPort } from "./deployment-inventory-port.js";

/** Retirement runs only under Core's retained tombstone authority; each success is recorded before the next page. */
export async function retireNextCacheScopes(
  retirement: { retire(input: unknown): Promise<unknown> },
  inventory: Pick<
    DeploymentInventoryPort,
    "listNextCacheRetirementScopes" | "recordNextCacheRetired"
  >,
  authority: {
    organizationId: string;
    projectId: string;
    operationId: string;
    cleanupRunId: string;
  },
): Promise<boolean> {
  let cursor: string | undefined;
  try {
    do {
      const page = await inventory.listNextCacheRetirementScopes({
        ...authority,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      if (page === null) return false;
      for (const scope of page.scopes) {
        const input = {
          ...authority,
          environmentId: scope.environmentId,
          deploymentId: scope.deploymentId,
        };
        const result = await retirement.retire(input);
        if (
          typeof result !== "object" ||
          result === null ||
          Array.isArray(result) ||
          Object.keys(result).length !== 1 ||
          Reflect.get(result, "kind") !== "retired"
        )
          return false;
        const recorded = await inventory.recordNextCacheRetired(input);
        if (recorded !== "recorded" && recorded !== "existing") return false;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return true;
  } catch {
    return false;
  }
}
