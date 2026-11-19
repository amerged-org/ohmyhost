import { parseUlid } from "@ohmyhost/platform";

export type ProjectDataChangeKind =
  | "isolate_prod_keeps_data"
  | "isolate_dev_keeps_data"
  | "share_prod_keeps_data"
  | "reset_dev";
export interface ProjectDataAssignment {
  readonly environmentId: string;
  readonly environment: "dev" | "prod";
  readonly dataEnvironmentId: string;
  readonly assignmentVersion: number;
  readonly assignedAt: string;
}
export interface ProjectDataAssignments {
  readonly dataMode: "shared" | "isolated";
  readonly dev: ProjectDataAssignment;
  readonly prod: ProjectDataAssignment;
}
export interface ProjectDataChangeTransition {
  readonly change: ProjectDataChangeKind;
  readonly before: ProjectDataAssignments;
  readonly after: ProjectDataAssignments;
  readonly retiredDataEnvironmentIds: readonly string[];
  readonly reauthorizations: readonly {
    readonly dataEnvironmentId: string;
    readonly authorizedEnvironmentIds: readonly string[];
    readonly direction: "narrow" | "widen";
  }[];
  readonly redeployEnvironments: readonly ("dev" | "prod")[];
  readonly removeDevDeployment: boolean;
}
export class ProjectDataEnvironmentConflictError extends Error {
  readonly code = "data_change_not_applicable";
  constructor() {
    super("Project data assignments conflict with the requested change");
    this.name = "ProjectDataEnvironmentConflictError";
  }
}

export function planProjectDataChangeTransition(input: {
  readonly change: ProjectDataChangeKind;
  readonly assignments: ProjectDataAssignments;
  readonly newDataEnvironmentId: string;
  readonly prodDatabaseReady: boolean;
}): ProjectDataChangeTransition {
  const { change, assignments: before } = input;
  parseUlid(input.newDataEnvironmentId);
  for (const assignment of [before.dev, before.prod]) {
    parseUlid(assignment.environmentId);
    parseUlid(assignment.dataEnvironmentId);
  }
  const shared = before.dev.dataEnvironmentId === before.prod.dataEnvironmentId;
  if (
    shared !== (before.dataMode === "shared") ||
    (change === "isolate_prod_keeps_data" || change === "isolate_dev_keeps_data"
      ? !shared
      : shared) ||
    (change === "share_prod_keeps_data" && !input.prodDatabaseReady) ||
    ![
      "isolate_prod_keeps_data",
      "isolate_dev_keeps_data",
      "share_prod_keeps_data",
      "reset_dev",
    ].includes(change) ||
    (change !== "share_prod_keeps_data" &&
      [before.dev.dataEnvironmentId, before.prod.dataEnvironmentId].includes(
        input.newDataEnvironmentId,
      ))
  )
    throw new ProjectDataEnvironmentConflictError();
  const losing: "dev" | "prod" = change === "isolate_dev_keeps_data" ? "prod" : "dev";
  const after = Object.freeze({
    ...before,
    dataMode: change === "share_prod_keeps_data" ? ("shared" as const) : ("isolated" as const),
    [losing]: Object.freeze({
      ...before[losing],
      dataEnvironmentId:
        change === "share_prod_keeps_data"
          ? before.prod.dataEnvironmentId
          : input.newDataEnvironmentId,
      assignmentVersion: before[losing].assignmentVersion + 1,
    }),
  });
  const removeDevDeployment = change === "share_prod_keeps_data" || change === "reset_dev";
  const reauthorizations: ProjectDataChangeTransition["reauthorizations"] = [
    ...(removeDevDeployment
      ? [
          {
            dataEnvironmentId: before.dev.dataEnvironmentId,
            authorizedEnvironmentIds: Object.freeze([] as string[]),
            direction: "narrow" as const,
          },
        ]
      : []),
    ...(change === "reset_dev"
      ? []
      : [
          {
            dataEnvironmentId:
              change === "share_prod_keeps_data"
                ? before.prod.dataEnvironmentId
                : before.dev.dataEnvironmentId,
            authorizedEnvironmentIds: Object.freeze(
              change === "share_prod_keeps_data"
                ? [before.dev.environmentId, before.prod.environmentId].sort()
                : [before[losing === "dev" ? "prod" : "dev"].environmentId],
            ),
            direction:
              change === "share_prod_keeps_data" ? ("widen" as const) : ("narrow" as const),
          },
        ]),
  ];
  return Object.freeze({
    change,
    before,
    after,
    retiredDataEnvironmentIds: Object.freeze(
      removeDevDeployment ? [before.dev.dataEnvironmentId] : [],
    ),
    reauthorizations: Object.freeze(reauthorizations),
    redeployEnvironments: Object.freeze([losing]),
    removeDevDeployment,
  });
}
