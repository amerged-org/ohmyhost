import {
  PROVIDER_RECONCILIATION_METHODS,
  PROVIDER_RECONCILIATION_FIELDS,
  type ProviderReconciliationDataPort,
  type ProviderReconciliationRuntimeBinding,
} from "./provider-reconciliation-data-port.js";

/** One generated method per native operation: the producer runs, only the exact native fields cross RPC. */
export function createCoreProviderReconciliationDataPort(
  binding: ProviderReconciliationRuntimeBinding,
): ProviderReconciliationDataPort {
  for (const method of PROVIDER_RECONCILIATION_METHODS)
    if (typeof Reflect.get(Object(binding), method) !== "function")
      throw new TypeError("Provider reconciliation capability is incomplete");
  const rpc = binding as Record<
    (typeof PROVIDER_RECONCILIATION_METHODS)[number],
    (input: object) => unknown
  >;
  return Object.freeze(
    Object.fromEntries(
      PROVIDER_RECONCILIATION_METHODS.map((method) => [
        method,
        (produce: () => object) => {
          const input = produce();
          return rpc[method](
            Object.fromEntries(
              PROVIDER_RECONCILIATION_FIELDS[method].map((key) => [key, Reflect.get(input, key)]),
            ),
          );
        },
      ]),
    ),
  ) as ProviderReconciliationDataPort;
}
