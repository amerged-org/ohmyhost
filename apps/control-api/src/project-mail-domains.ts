import { type ProjectMailDomainsPort } from "./contracts.js";

export class ProjectMailDomainsUnavailableError extends Error {
  public constructor() {
    super("Project mail-domain storage is unavailable");
    this.name = "ProjectMailDomainsUnavailableError";
  }
}

export function createUnavailableProjectMailDomainsPort(): ProjectMailDomainsPort {
  const unavailable = async (): Promise<never> => {
    throw new ProjectMailDomainsUnavailableError();
  };
  return Object.freeze({ configure: unavailable, get: unavailable });
}
