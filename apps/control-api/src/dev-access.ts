import { type DevRuntimeProbeScope } from "@ohmyhost/dev-access-tokens";
import { parseUlid } from "@ohmyhost/platform";
import { parseProjectHandle } from "@ohmyhost/project-handles";

import type {
  DevAccessAuthorizeInput,
  DevAccessRedeemInput,
  DevAccessTicketsPort,
} from "./contracts.js";

export class DevAccessUnavailableError extends Error {
  public constructor() {
    super("Dev access is unavailable");
    this.name = "DevAccessUnavailableError";
  }
}

export function createUnavailableDevAccessTicketsPort(): DevAccessTicketsPort {
  return Object.freeze({
    async issue() {
      throw new DevAccessUnavailableError();
    },
  });
}

export function parseDevAccessRedeemInput(value: unknown): DevAccessRedeemInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "clientAddress,environmentId,handle,origin,projectId,ticket" ||
    typeof Reflect.get(value, "clientAddress") !== "string" ||
    String(Reflect.get(value, "clientAddress")).length < 1 ||
    String(Reflect.get(value, "clientAddress")).length > 64 ||
    typeof Reflect.get(value, "ticket") !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(String(Reflect.get(value, "ticket"))) ||
    typeof Reflect.get(value, "projectId") !== "string" ||
    typeof Reflect.get(value, "environmentId") !== "string" ||
    typeof Reflect.get(value, "origin") !== "string"
  ) {
    throw new TypeError("Dev access redemption input is invalid");
  }
  const handle = parseProjectHandle(Reflect.get(value, "handle"));
  const projectId = parseUlid(String(Reflect.get(value, "projectId")));
  const environmentId = parseUlid(String(Reflect.get(value, "environmentId")));
  const origin = String(Reflect.get(value, "origin"));
  if (
    ![`https://dev-${handle}.dev.check.omh.st`, `https://dev-${handle}.check.omh.st`].includes(
      origin,
    )
  ) {
    throw new TypeError("Dev access redemption input is invalid");
  }
  return Object.freeze({
    ticket: String(Reflect.get(value, "ticket")),
    projectId,
    environmentId,
    handle,
    origin,
    clientAddress: String(Reflect.get(value, "clientAddress")),
  });
}

export function parseDevAccessAuthorizeInput(value: unknown): DevAccessAuthorizeInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![
      "environmentId,handle,origin,projectId,sessionToken",
      "environmentId,handle,organizationHint,origin,projectId,sessionToken",
    ].includes(Object.keys(value).sort().join(",")) ||
    (Object.hasOwn(value, "organizationHint") &&
      typeof Reflect.get(value, "organizationHint") !== "string") ||
    (Reflect.get(value, "sessionToken") !== null &&
      typeof Reflect.get(value, "sessionToken") !== "string") ||
    (typeof Reflect.get(value, "sessionToken") === "string" &&
      String(Reflect.get(value, "sessionToken")).length > 2_048) ||
    typeof Reflect.get(value, "projectId") !== "string" ||
    typeof Reflect.get(value, "environmentId") !== "string" ||
    typeof Reflect.get(value, "origin") !== "string"
  ) {
    throw new TypeError("Dev access authorization input is invalid");
  }
  const handle = parseProjectHandle(Reflect.get(value, "handle"));
  const projectId = parseUlid(String(Reflect.get(value, "projectId")));
  const environmentId = parseUlid(String(Reflect.get(value, "environmentId")));
  const origin = String(Reflect.get(value, "origin"));
  if (
    ![`https://dev-${handle}.dev.check.omh.st`, `https://dev-${handle}.check.omh.st`].includes(
      origin,
    )
  ) {
    throw new TypeError("Dev access authorization input is invalid");
  }
  return Object.freeze({
    sessionToken:
      Reflect.get(value, "sessionToken") === null
        ? null
        : String(Reflect.get(value, "sessionToken")),
    projectId,
    environmentId,
    handle,
    origin,
    ...(Object.hasOwn(value, "organizationHint")
      ? { organizationHint: parseUlid(String(Reflect.get(value, "organizationHint"))) }
      : {}),
  });
}

export function parseDevRuntimeProbeInput(value: unknown): DevRuntimeProbeScope {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "deploymentId,environmentId,handle,method,operationId,organizationId,origin,path,projectId" ||
    (Reflect.get(value, "method") !== "GET" && Reflect.get(value, "method") !== "HEAD") ||
    typeof Reflect.get(value, "organizationId") !== "string" ||
    typeof Reflect.get(value, "projectId") !== "string" ||
    typeof Reflect.get(value, "environmentId") !== "string" ||
    typeof Reflect.get(value, "operationId") !== "string" ||
    typeof Reflect.get(value, "deploymentId") !== "string" ||
    typeof Reflect.get(value, "origin") !== "string" ||
    typeof Reflect.get(value, "path") !== "string"
  ) {
    throw new TypeError("Dev runtime probe input is invalid");
  }
  const organizationId = parseUlid(String(Reflect.get(value, "organizationId")));
  const projectId = parseUlid(String(Reflect.get(value, "projectId")));
  const environmentId = parseUlid(String(Reflect.get(value, "environmentId")));
  const operationId = parseUlid(String(Reflect.get(value, "operationId")));
  const deploymentId = parseUlid(String(Reflect.get(value, "deploymentId")));
  const handle = parseProjectHandle(Reflect.get(value, "handle"));
  const origin = String(Reflect.get(value, "origin"));
  const path = String(Reflect.get(value, "path"));
  if (
    ![`https://dev-${handle}.dev.check.omh.st`, `https://dev-${handle}.check.omh.st`].includes(
      origin,
    ) ||
    path.length < 1 ||
    path.length > 256 ||
    !/^\/(?!\/)[^?#]*$/u.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("Dev runtime probe input is invalid");
  }
  return Object.freeze({
    organizationId,
    projectId,
    environmentId,
    operationId,
    deploymentId,
    handle,
    origin,
    path,
    method: Reflect.get(value, "method") as "GET" | "HEAD",
  });
}
