import type { Clock } from "./clock.js";
import type { EntropySource } from "./entropy.js";

declare const ulidBrand: unique symbol;
export type Ulid = string & { readonly [ulidBrand]: "Ulid" };

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIMESTAMP = 0xffffffffffff;
const RANDOM_BYTES = 10;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface UlidFactory {
  next(): Ulid;
}

export interface UlidFactoryDependencies {
  readonly clock: Clock;
  readonly entropy: EntropySource;
}

export function parseUlid(value: string): Ulid {
  if (!ULID_PATTERN.test(value)) {
    throw new TypeError("Invalid canonical ULID");
  }
  return value as Ulid;
}

export function createUlidFactory({ clock, entropy }: UlidFactoryDependencies): UlidFactory {
  let lastTimestamp = -1;
  let lastRandom: Uint8Array<ArrayBufferLike> = new Uint8Array(RANDOM_BYTES);

  return {
    next(): Ulid {
      const observedTimestamp = clock.now().getTime();
      if (!Number.isSafeInteger(observedTimestamp) || observedTimestamp < 0) {
        throw new RangeError("ULID clock must return a non-negative millisecond time");
      }

      const timestamp = Math.max(observedTimestamp, lastTimestamp);
      if (timestamp > MAX_TIMESTAMP) {
        throw new RangeError("ULID timestamp exceeds 48 bits");
      }

      if (timestamp === lastTimestamp) {
        lastRandom = incrementRandom(lastRandom);
      } else {
        const random = new Uint8Array(RANDOM_BYTES);
        entropy.fill(random);
        lastRandom = random;
        lastTimestamp = timestamp;
      }

      return parseUlid(
        `${encodeBase32(BigInt(timestamp), 10)}${encodeBase32(bytesToBigInt(lastRandom), 16)}`,
      );
    },
  };
}

function incrementRandom(previous: Uint8Array): Uint8Array {
  const next = previous.slice();
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const value = next[index];
    if (value === undefined) {
      throw new Error("ULID random state is invalid");
    }
    next[index] = (value + 1) & 0xff;
    if (next[index] !== 0) {
      return next;
    }
  }
  throw new RangeError("ULID entropy exhausted within one millisecond");
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = ALPHABET.charAt(Number(remaining & 31n)) + encoded;
    remaining >>= 5n;
  }
  if (remaining !== 0n) {
    throw new RangeError("Value does not fit encoded ULID segment");
  }
  return encoded;
}
