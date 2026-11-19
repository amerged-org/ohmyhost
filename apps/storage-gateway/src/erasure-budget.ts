export const STORAGE_ERASURE_BUDGET_MILLISECONDS = 6_000;
export const STORAGE_ERASURE_ACK_BATCH_SIZE = 32;

/** Leaves the default ten-second customer deadline room for durable receipts and the response. */
export async function withStorageErasureBudget<T>(
  callerSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, STORAGE_ERASURE_BUDGET_MILLISECONDS);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) controller.abort();
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
  }
}
