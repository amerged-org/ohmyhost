import type { TransactionClient } from "./transaction.js";

export interface PublishedUsageRateCard {
  id: string;
  currency: "USD";
  published_at: string;
  effective_from: string;
  rates: {
    meter: string;
    unit: string;
    units_per_charge: string;
    provider_cost_micros: string | null;
    credit_micros: string;
  }[];
}
export declare function publishUsageRateCard(
  client: TransactionClient,
  input: {
    publishedAt: string;
    effectiveFrom: string;
  },
): Promise<string>;

/** PGCF charges configured memory × awake time; provider node costs are a separate fact. */
export declare function publishPgcfUsageRateCard(
  client: TransactionClient,
  input: {
    publishedAt: string;
    effectiveFrom: string;
  },
): Promise<string>;
/** 1.25x per measured CU-second gives 2.5x per active minute at 1 CU versus 0.5 CU. */
export declare function publishPerformanceComputeRateCard(
  client: TransactionClient,
  input: {
    publishedAt: string;
    effectiveFrom: string;
  },
): Promise<string>;

/** Mail uses the owner's explicit 100% markup, independent of other resource tariffs. */
export declare function publishResendMailUsageRateCard(
  client: TransactionClient,
  input: {
    publishedAt: string;
    effectiveFrom: string;
  },
): Promise<string>;

/** Daily peak payload bytes; provider metadata, administration and sampled requests stay platform expense. */
export declare function publishR2UsageRateCard(
  client: TransactionClient,
  input: {
    publishedAt: string;
    effectiveFrom: string;
  },
): Promise<string>;
/** Resources billed by lifetime from Control receipts; a 744-hour month is the provider's price unit. */
export declare function publishResourceUsageRateCard(
  client: TransactionClient,
  input: {
    publishedAt: string;
    effectiveFrom: string;
  },
): Promise<string>;
