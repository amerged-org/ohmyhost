import { WorkerEntrypoint } from "cloudflare:workers";
import { createGatewayRoutingHandlers, type GatewayRoutingBindings } from "./gateway-routing.js";

export class GatewayRoutingService extends WorkerEntrypoint<GatewayRoutingBindings> {
  public resolve(input: unknown) {
    return createGatewayRoutingHandlers(this.env).resolve(input);
  }
}

export class GatewayRoutingManagementService extends WorkerEntrypoint<GatewayRoutingBindings> {
  public activate(input: unknown) {
    return createGatewayRoutingHandlers(this.env).activate(input);
  }
  public observe(input: unknown) {
    return createGatewayRoutingHandlers(this.env).observe(input);
  }
  public remove(input: unknown) {
    return createGatewayRoutingHandlers(this.env).remove(input);
  }
  public compensate(input: unknown) {
    return createGatewayRoutingHandlers(this.env).compensate(input);
  }
  public authorizeCandidateRemoval(input: unknown) {
    return createGatewayRoutingHandlers(this.env).authorizeCandidateRemoval(input);
  }
}
