/** Stored timestamps are ISO-8601 UTC with microseconds: `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
const STORED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

/** Normalises a JavaScript ISO string (milliseconds) or an already stored value to the stored form. */
export function storedTimestamp(value: string): string {
  if (STORED.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value)) {
    throw new TypeError(`not an ISO-8601 UTC timestamp: ${value}`);
  }
  return `${instant.toISOString().slice(0, 23)}000Z`;
}

/** Adds milliseconds to a stored timestamp, keeping its microsecond tail. */
export function shiftStored(value: string, milliseconds: number): string {
  const instant = new Date(Date.parse(`${value.slice(0, 23)}Z`) + milliseconds);
  return `${instant.toISOString().slice(0, 23)}${value.slice(23)}`;
}
