import {
  DeploymentPersistenceConflictError,
  SourceArchiveReconciliationConflictError,
} from "@ohmyhost/database/provisioning-persistence";

type Method = (input: never) => Promise<unknown>;
type MethodName<B> = { [K in keyof B]: B[K] extends Method ? K : never }[keyof B];
type InputOf<M> = M extends (input: infer I) => unknown ? I : never;
type ResultOf<M> = M extends (input: never) => Promise<infer R> ? R : never;

/**
 * One named method of the private Core binding. Only the original domain refusals are reconstructed from their
 * serialized name; transport uncertainty and every other error pass through and never become absence or success.
 */
export async function callBinding<B extends object, K extends MethodName<B>>(
  binding: B,
  method: K,
  input: InputOf<B[K]>,
): Promise<ResultOf<B[K]>> {
  const target = binding as unknown as Record<PropertyKey, (input: unknown) => Promise<unknown>>;
  try {
    return (await target[method](input)) as ResultOf<B[K]>;
  } catch (error) {
    if (error instanceof Error && error.name === "DeploymentPersistenceConflictError")
      throw new DeploymentPersistenceConflictError(error.message);
    if (error instanceof Error && error.name === "SourceArchiveReconciliationConflictError")
      throw new SourceArchiveReconciliationConflictError();
    throw error;
  }
}

/** A port whose methods forward their input unchanged: port method name -> binding method name. */
export function forwardCalls<B extends object, const T extends Record<string, MethodName<B>>>(
  binding: B,
  names: T,
): { [P in keyof T]: B[T[P]] } {
  return Object.fromEntries(
    Object.entries(names).map(([port, method]) => [
      port,
      (input: never) => callBinding(binding, method, input),
    ]),
  ) as { [P in keyof T]: B[T[P]] };
}
