import { parseProjectProvisioningMessageV1 } from "@ohmyhost/orchestrator";
import { parseUlid } from "@ohmyhost/platform";

export const message = parseProjectProvisioningMessageV1({
  version: 1,
  eventType: "ProjectProvisioningRequested",
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
});

export const attemptId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
