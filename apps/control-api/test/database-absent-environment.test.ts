import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";

import { createD1DatabaseComputePort } from "../src/database-compute.js";
import { createProjectDatabaseDiagnosticsPort } from "../src/project-database-diagnostics.js";
import { createProjectDatabaseEventsPort } from "../src/project-database-events.js";
import { createControlApi } from "../src/index.js";
import {
  API,
  BEARER,
  JSON_BEARER,
  PROJECT_ID,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

const PROJECT = `${API}/v1/projects/${PROJECT_ID}`;
const UNKNOWN_PROJECT = `${API}/v1/projects/${parseUlid("0000000000000000000000000F")}`;

/** A compute port whose binding and runtime must never answer for an environment without a database. */
function absentCompute() {
  return createD1DatabaseComputePort(
    {
      readCompute: async () => null,
      changeCompute: async () => {
        throw new Error("Unused compute change");
      },
      runComputeChange: async () => {
        throw new Error("Unused compute change");
      },
    },
    {
      readProjectDatabaseOperation: async () => {
        throw new Error("Unused operation read");
      },
      readProjectComputeContext: async () => {
        throw new Error("Unused compute context");
      },
    },
  );
}

describe("environment without a database", () => {
  it("answers the unknown-project problem for compute, query and events", async () => {
    const app = createControlApi(
      routeDependencies({
        databaseCompute: absentCompute(),
        projectDatabaseEvents: createProjectDatabaseEventsPort(
          {
            databaseEvents: async () => ({ status: "absent" }),
            createDatabaseTable: async () => ({ status: "absent" }),
          },
          {
            readProjectDatabaseAdmission: async () => ({ status: "admitted" }),
            recordProjectDatabaseEventAudit: async () => ({ recorded: true }),
          },
          { now: () => new Date("2026-10-31T10:00:00.000Z") },
        ),
        projectDatabaseDiagnostics: createProjectDatabaseDiagnosticsPort({
          queryProject: async () => ({ status: "absent" }),
        }),
      }),
    );

    const unknown = await app.request(`${UNKNOWN_PROJECT}/database/compute`, { headers: BEARER });
    expect(unknown.status).toBe(404);
    const reference = await unknown.json();

    const compute = await app.request(`${PROJECT}/database/compute?environment=dev`, {
      headers: BEARER,
    });
    expect(compute.status).toBe(404);
    await expect(compute.json()).resolves.toEqual(reference);

    const webhooks = await app.request(`${PROJECT}/database/webhooks?environment=dev`, {
      headers: BEARER,
    });
    expect(webhooks.status).toBe(404);
    await expect(webhooks.json()).resolves.toEqual(reference);

    const query = await app.request(`${PROJECT}/database/query`, {
      method: "POST",
      headers: JSON_BEARER,
      body: JSON.stringify({ environment: "dev", statement: "SELECT 1", parameters: [] }),
    });
    expect(query.status).toBe(404);
    await expect(query.json()).resolves.toEqual(reference);
  });
});
