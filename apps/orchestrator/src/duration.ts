export const MAX_OPERATIONAL_DURATION_MILLISECONDS = 86_400_000;

/**
 * One day is the operational ceiling for dispatcher leases and retry delays.
 * It bounds recovery latency and avoids unsafe arithmetic with JavaScript Date timestamps.
 */
export function assertOperationalDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_OPERATIONAL_DURATION_MILLISECONDS) {
    throw new RangeError(
      `${name} must be an integer between 1 and ${MAX_OPERATIONAL_DURATION_MILLISECONDS} milliseconds`,
    );
  }
}
