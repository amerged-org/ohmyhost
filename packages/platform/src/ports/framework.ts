import type { BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
/* v8 ignore file -- compile-time contract; exercised by TypeScript tests */

import type { LockfileName, OhmyhostConfig } from "@ohmyhost/contracts";
import type { ApplicationRoot } from "@ohmyhost/contracts/application-root";
import type { CustomerAuthRequirement } from "../modules/customer-auth/customer-auth.js";
import type { AiJurisdiction } from "../shared/ai-gateway.js";

export interface RepositorySnapshot {
  readonly root: ApplicationRoot;
  readonly files: readonly string[];
}

interface DetectionEvidenceBase {
  readonly path: string;
  readonly reason: string;
}

export interface RepositoryConfigDetectionEvidence extends DetectionEvidenceBase {
  readonly scope: "repository";
  readonly path: "ohmyhost.yaml";
}

export interface ApplicationDetectionEvidence extends DetectionEvidenceBase {
  readonly scope: "application";
}

export type DetectionEvidence = RepositoryConfigDetectionEvidence | ApplicationDetectionEvidence;

export interface DetectionResult {
  readonly adapter: string;
  readonly confidenceBasisPoints: number;
  readonly evidence: readonly ApplicationDetectionEvidence[];
}

export type FrameworkRuntime = "static" | "edge" | "functions";

export interface FrameworkPlan {
  readonly schemaVersion: "ohmyhost.framework-plan/v5";
  readonly applicationRoot: ApplicationRoot;
  readonly adapter: string;
  readonly runtime: FrameworkRuntime;
  readonly installCommand: string;
  readonly buildCommand?: string;
  readonly outputDirectory?: string;
  /** Source-selected private Next.js prerender cache budget. */
  readonly ssgCacheMaxBytes?: number;
  readonly nextRevalidatePath?: true;
  readonly serverOutputDirectory?: string;
  readonly serverEntryPoint?: string;
  readonly serverConfigPath?: string;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
  readonly runtimePolicy: Readonly<{
    readonly healthCheckPath: string;
    readonly egressAllowedOrigins: readonly string[];
    readonly browser?: BrowserPolicy;
  }>;
  readonly database: DatabaseRequirement;
  readonly auth: CustomerAuthRequirement;
  readonly mail: MailRequirement;
  readonly storage: StorageRequirement;
  readonly functions?: FunctionsRequirement;
  readonly ai?: AiRequirement;
  readonly browser?: Readonly<{ enabled: true }>;
}

/** Present only while ohmyhost.yaml declares `ai.enabled`; a plan without it is the same plan as before AI. */
export type AiRequirement = Readonly<{
  readonly enabled: true;
  readonly jurisdiction: AiJurisdiction;
}>;

export type DatabaseRequirement =
  | Readonly<{ readonly enabled: false }>
  | Readonly<{ readonly enabled: true; readonly migrations: string }>;

export type MailRequirement = Readonly<{ readonly enabled: boolean }>;

export type StorageRequirement =
  | Readonly<{ readonly enabled: false }>
  | Readonly<{
      readonly enabled: true;
      readonly provider: "r2";
      readonly jurisdiction: "eu" | "us";
      readonly public: false;
    }>;

/** Declared UTC cron schedules dispatched to the Worker module's scheduled handler. */
export type FunctionsRequirement = Readonly<{ readonly crons: readonly string[] }>;

export interface FrameworkPlanInput {
  readonly repositoryConfig: OhmyhostConfig;
  readonly repositoryConfigEvidence: RepositoryConfigDetectionEvidence;
  readonly application: RepositorySnapshot;
  readonly detection: DetectionResult;
  readonly requestedRuntime?: FrameworkRuntime | "auto";
}

export interface FrameworkAdapter {
  detect(repository: RepositorySnapshot): Promise<DetectionResult>;
  plan(input: FrameworkPlanInput): Promise<FrameworkPlan>;
}

/**
 * Reads the text of the application lockfile the package manager admits, so framework versions
 * are judged as installed; undefined when the lockfile is binary or was not decoded.
 */
export type FrameworkLockfileLoader = (path: LockfileName) => Promise<string | undefined>;
