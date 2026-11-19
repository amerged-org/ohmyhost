import test from "node:test";
import assert from "node:assert/strict";
import { readQaInventory, QA_PROJECTS } from "../qa-inventory.mjs";

test("QA inventory reads only the seven fixed isolated Development assignments", async () => {
  const rows = new Map(
    QA_PROJECTS.map((x, i) => [
      x.projectId,
      {
        ...x,
        environmentId: `01M700N2PQY18W4NGX2TSM${String(i).padStart(4, "0")}`,
        physicalEnvironmentId: `01M700N2PQY18W4NGX2TSM${String(i + 10).padStart(4, "0")}`,
      },
    ]),
  );
  const env = {
    QA_DEV_ACCESS: {
      async readDevShareState(input) {
        const x = rows.get(input.projectId);
        assert.ok(x);
        return {
          scope: {
            organizationId: input.organizationId,
            projectId: x.projectId,
            environmentId: x.environmentId,
            handle: `qa-${x.fixture}`,
            origin: `https://dev-qa-${x.fixture}.dev.check.omh.st`,
            devAccessEpoch: 2,
          },
        };
      },
    },
    QA_DATABASE_AUTHORITY: {
      async readApiProjectDataChangeState(input) {
        const x = rows.get(input.projectId);
        return {
          assignments: {
            dataMode: "isolated",
            dev: { environmentId: x.environmentId, dataEnvironmentId: x.physicalEnvironmentId },
            prod: {
              environmentId: "01M700N2PQY18W4NGX2TSM9999",
              dataEnvironmentId: "01M700N2PQY18W4NGX2TSM9998",
            },
          },
          registrationGenerations: [
            { dataEnvironmentId: x.physicalEnvironmentId, registrationVersion: 3 },
          ],
        };
      },
      async readRuntimeBinding(input) {
        const x = rows.get(input.projectId);
        return {
          provider: "pgcf",
          region: "eu",
          physicalEnvironmentId: x.physicalEnvironmentId,
          registrationVersion: 3,
          authorizedEnvironmentIds: [x.environmentId],
        };
      },
    },
  };
  const result = await readQaInventory(env);
  assert.equal(result.projects.length, 7);
  assert.deepEqual(
    result.projects.map((x) => x.projectId),
    QA_PROJECTS.map((x) => x.projectId),
  );
  env.QA_DATABASE_AUTHORITY.readRuntimeBinding = async () => null;
  await assert.rejects(() => readQaInventory(env), /qa_inventory_unavailable/);
});
