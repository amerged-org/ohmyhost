/*
 * The Core entrypoint that the AI gateway Worker binds as AI_RUNTIME must satisfy the gateway contract. This file is never
 * run; `pnpm typecheck` fails when a method of the Core drifts from the contract's types.
 */
import type { AiGatewayRuntime as Contract } from "@ohmyhost/platform/shared";

import type { AiGatewayRuntime as Core } from "../../src/worker-main.js";

declare const core: Core;
export const conforms: Contract = core;
