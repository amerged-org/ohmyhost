import { usageRateCard, creditMicros, usdMicros } from "@ohmyhost/platform/shared";
import type { RateCard } from "@ohmyhost/platform/shared";

/** The published price versions the tests need, one pure definition each; the arithmetic lives in the platform. */
export interface CardDates {
  readonly publishedAt: string;
  readonly effectiveFrom: string;
}

export const usageCard = (dates: CardDates): RateCard =>
  usageRateCard(dates.publishedAt, dates.effectiveFrom);

/** Mail uses the owner's explicit 100% markup, independent of other resource tariffs. */
export const resendMailCard = (dates: CardDates): RateCard => ({
  ...usageRateCard(dates.publishedAt, dates.effectiveFrom),
  id: "resend-2026-09-22-v1",
  rates: ["mail.sent", "mail.received"].map((meter) => ({
    meter,
    unit: meter === "mail.sent" ? "recipient" : "message",
    unitsPerCharge: 1n,
    providerCostPerCharge: usdMicros(900n),
    creditsPerCharge: creditMicros(180000n),
    minimumCreditCharge: creditMicros(0n),
    roundingMode: "ceil" as const,
  })),
});
