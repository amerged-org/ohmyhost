import type { BindCommand } from "../platform-commands.js";
import { recordDeliveryAttempt } from "./attempts.js";
import { claimDelivery } from "./claim.js";
import { failDelivery, releaseDelivery } from "./lease.js";
import { stageDelivery } from "./stage.js";
import { activateDelivery, compensateDelivery } from "./terminal.js";
import { readQaPreviewMailEnvelope } from "./qa-preview-mail.js";
import {
  registerNextCacheScope,
  listNextCacheRetirementScopes,
  authorizeNextCacheRetirement,
  recordNextCacheRetired,
} from "./next-cache.js";
import {
  authorizeRuntimeSecretManifest,
  readDeliveryState,
  readPendingDeliveries,
  readActiveDeliveryTarget,
  readRecordedDeliveryStage,
} from "./reads.js";
import {
  installPlatformSecret,
  ensurePlatformSecret,
  ensureMailSecret,
  ensureStorageSecret,
  ensureAiSecret,
  ensureBrowserSecret,
  readPromotionMailSource,
} from "./platform.js";

/** The exact original15 persistence actions. Provider calls, plaintext, cipher keys and arbitrary SQL stay outside. */
export function createRuntimeSecretCommands(bind: BindCommand) {
  return Object.freeze({
    claim: bind(claimDelivery),
    fail: bind(failDelivery),
    release: bind(releaseDelivery),
    readPending: bind(readPendingDeliveries),
    recordPendingAttempt: bind(recordDeliveryAttempt),
    readState: bind(readDeliveryState),
    stageWfp: bind(stageDelivery),
    activateWfp: bind(activateDelivery),
    compensateWfp: bind(compensateDelivery),
    readActiveWfpTarget: bind(readActiveDeliveryTarget),
    readRecordedWfpStage: bind(readRecordedDeliveryStage),
    installPlatform: bind(installPlatformSecret),
    ensurePlatform: bind(ensurePlatformSecret),
    ensureAiGateway: bind(ensureAiSecret),
    ensureBrowserGateway: bind(ensureBrowserSecret),
    ensureMailGateway: bind(ensureMailSecret),
    readPromotionMailGatewaySource: bind(readPromotionMailSource),
    ensureStorageGateway: bind(ensureStorageSecret),
    authorizeManifest: bind(authorizeRuntimeSecretManifest),
    readQaPreviewMailEnvelope: bind(readQaPreviewMailEnvelope),
    registerNextCacheScope: bind(registerNextCacheScope),
    listNextCacheRetirementScopes: bind(listNextCacheRetirementScopes),
    authorizeNextCacheRetirement: bind(authorizeNextCacheRetirement),
    recordNextCacheRetired: bind(recordNextCacheRetired),
  });
}
