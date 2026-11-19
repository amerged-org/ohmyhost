import type {
  SharedGatewayActivation,
  SharedGatewayMutation,
  SharedGatewayReceipt,
  SharedGatewayScope,
} from "@ohmyhost/platform";

export type { SharedGatewayReceipt };
export { parseSharedGatewayReceipt as readGatewayReceipt } from "@ohmyhost/platform";
export interface GatewayRegistry {
  authorizeCandidateRemoval(
    input: SharedGatewayScope & {
      operationId: string;
      claimId: string;
      candidateReceiptId: string;
      productDeploymentId: string;
      scriptName: string;
      providerTag: string;
    },
  ): Promise<unknown>;
  activate(input: SharedGatewayActivation): Promise<unknown>;
  observe(input: SharedGatewayScope): Promise<unknown>;
  remove(input: SharedGatewayMutation): Promise<unknown>;
  compensate(input: SharedGatewayMutation): Promise<unknown>;
}
