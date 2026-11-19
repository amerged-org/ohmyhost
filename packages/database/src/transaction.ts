import type { PoolClient } from "pg";

declare const transactionClientBrand: unique symbol;

export type TransactionClient = PoolClient & {
  readonly [transactionClientBrand]: true;
};
