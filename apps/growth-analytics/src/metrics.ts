export interface CohortRow {
  label: string;
  numerator: number;
  denominator: number;
  mature: number;
  pending: number;
  anchor: string;
  watermark: string | null;
  unknown: number;
  segment: string;
}
export interface SourceHealth {
  source: string;
  watermark: string | null;
  status: string;
  historyFloor?: string | null;
  lastAttempt?: string | null;
  lastSuccess?: string | null;
  completedScan?: string | null;
  qualityFlags?: string[];
}
export interface Dashboard {
  cohorts: CohortRow[];
  sources: SourceHealth[];
  accountRollups?: import("./account-projection.js").AccountRollup[];
  returns?: {
    days: number;
    numerator: number;
    denominator: number;
    pending: number;
    historyComplete: boolean;
  }[];
  money?: {
    currency: string;
    gross: number;
    refunds: number;
    withdrawn: number;
    restored: number;
    net: number;
    openDisputes: number;
  }[];
  experiments?: {
    id: string;
    hypothesis: string;
    evidence: string;
    segment: string;
    metric: string;
    horizon: string;
    sampleSize: number;
    mature: boolean;
    conclusion: string;
    comparison: string;
    limitations: string[];
    guardrails: string[];
    evidenceReference: string | null;
    versions: string[];
  }[];
  limitations?: string[];
  nextCursor?: string | null;
  errors?: { error: string; count: number }[];
}
export interface TimelineItem {
  at: string;
  stage: string;
  error: string | null;
  actor: string | null;
  client: string | null;
  clientTrust: string | null;
  transport?: string | null;
  country?: string | null;
  campaign: string | null;
  environment: string | null;
  kind: string | null;
  health: string | null;
}
export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
  nextMissingStage: string | null;
  lastActivity: string | null;
  elapsed: string | null;
}
