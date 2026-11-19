export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const floorHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;
export const floorDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
export const isoOf = (ms: number): string => new Date(ms).toISOString();
/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export const dayOf = (ms: number): string => isoOf(ms).slice(0, 10);

/** A cursor or window boundary must be a canonical ISO instant aligned to `step`; anything else is corrupt state. */
export function parseBoundary(value: string, step: number): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || isoOf(ms) !== value || ms % step !== 0)
    throw new TypeError("credit_service_boundary_invalid");
  return ms;
}
