declare const usdMicrosBrand: unique symbol;
declare const creditMicrosBrand: unique symbol;

export type UsdMicros = bigint & { readonly [usdMicrosBrand]: "UsdMicros" };
export type CreditMicros = bigint & {
  readonly [creditMicrosBrand]: "CreditMicros";
};

export const POSTGRES_INT8_MIN = -(2n ** 63n);
export const POSTGRES_INT8_MAX = 2n ** 63n - 1n;

const CANONICAL_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;

export function usdMicros(value: bigint): UsdMicros {
  return checkedInt8(value, "USD micros") as UsdMicros;
}

export function creditMicros(value: bigint): CreditMicros {
  return checkedInt8(value, "credit micros") as CreditMicros;
}

export function microsToJson(value: UsdMicros | CreditMicros): string {
  return value.toString(10);
}

export function usdMicrosFromJson(value: unknown): UsdMicros {
  return usdMicros(parseDecimal(value));
}

export function creditMicrosFromJson(value: unknown): CreditMicros {
  return creditMicros(parseDecimal(value));
}

export function addCreditMicros(left: CreditMicros, right: CreditMicros): CreditMicros {
  return creditMicros(left + right);
}

function parseDecimal(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw new TypeError("Micros JSON value must be a canonical decimal string");
  }
  return BigInt(value);
}

function checkedInt8(value: bigint, name: string): bigint {
  if (value < POSTGRES_INT8_MIN || value > POSTGRES_INT8_MAX) {
    throw new RangeError(`${name} must fit PostgreSQL int8`);
  }
  return value;
}
