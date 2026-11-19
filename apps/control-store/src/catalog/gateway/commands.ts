import type { BindCommand } from "../platform-commands.js";
import { activateGatewayRoute, removeGatewayRoute, compensateGatewayRoute } from "./mutations.js";
import { observeGatewayRoute, resolveGatewayRoute } from "./reads.js";
import { authorizeGatewayCandidateRemoval } from "./removal.js";
import { beginRuntimeProbe } from "./probe.js";

/** Separate read, route mutation and fixed probe capabilities over the same qualified Core authority. */
export function createGatewayCommands(bind: BindCommand) {
  return Object.freeze({
    lookup: Object.freeze({ resolve: bind(resolveGatewayRoute) }),
    management: Object.freeze({
      activate: bind(activateGatewayRoute),
      observe: bind(observeGatewayRoute),
      remove: bind(removeGatewayRoute),
      compensate: bind(compensateGatewayRoute),
      authorizeCandidateRemoval: bind(authorizeGatewayCandidateRemoval),
    }),
    probe: Object.freeze({ beginProbe: bind(beginRuntimeProbe) }),
  });
}
