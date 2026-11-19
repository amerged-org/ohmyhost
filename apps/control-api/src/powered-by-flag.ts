import type { PoweredByFlagState } from "@ohmyhost/database";

import type { ProductSurfaceContext, ProductSurfaceMutationContext } from "./contracts.js";

export interface PoweredByFlagPort {
  readonly get: (context: ProductSurfaceContext) => Promise<PoweredByFlagState | null>;
  readonly set: (
    request: ProductSurfaceMutationContext & { enabled: boolean },
  ) => Promise<PoweredByFlagState | null>;
}
