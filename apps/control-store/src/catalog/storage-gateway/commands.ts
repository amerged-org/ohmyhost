import type { CatalogContext } from "../common.js";
import { authenticateStorageGateway } from "./auth.js";
import {
  claimStorageUpload,
  readStorageUploadReservation,
  completeStorageUpload,
  readStorageObject,
  readStorageObjects,
  readUnconfirmedStorageClaims,
  markUnconfirmedStorageClaimAttempts,
} from "./uploads.js";
import {
  claimStorageDelete,
  completeStorageErasure,
  claimStorageDeletes,
  completeStorageErasures,
} from "./deletes.js";
import {
  readRetiredStorageInventory,
  claimRetiredStorageDeletes,
  completeRetiredStorageDeletes,
} from "./retired.js";

/** Store-owned layout/routing fence; each underlying command keeps its frozen four-ID authority. */
export type BindStorageCommand = <Result>(
  command: (context: CatalogContext, input: unknown) => Promise<Result>,
) => (input: unknown) => Promise<Result>;

/** Customer Gateway and accepted retired-data cleanup remain separate private capabilities. */
export function createStorageGatewayCommands(bind: BindStorageCommand) {
  return Object.freeze({
    gateway: Object.freeze({
      authenticateStorageGateway: bind(authenticateStorageGateway),
      claimStorageUpload: bind(claimStorageUpload),
      readStorageUploadReservation: bind(readStorageUploadReservation),
      completeStorageUpload: bind(completeStorageUpload),
      readStorageObject: bind(readStorageObject),
      claimStorageDelete: bind(claimStorageDelete),
      completeStorageErasure: bind(completeStorageErasure),
      readStorageObjects: bind(readStorageObjects),
      readUnconfirmedStorageClaims: bind(readUnconfirmedStorageClaims),
      markUnconfirmedStorageClaimAttempts: bind(markUnconfirmedStorageClaimAttempts),
      claimStorageDeletes: bind(claimStorageDeletes),
      completeStorageErasures: bind(completeStorageErasures),
    }),
    data: Object.freeze({
      readRetiredStorageInventory: bind(readRetiredStorageInventory),
      claimRetiredStorageDeletes: bind(claimRetiredStorageDeletes),
      completeRetiredStorageDeletes: bind(completeRetiredStorageDeletes),
    }),
  });
}
