import { bounded } from "./deadline.mjs";
import { validateQaManifest } from "../capabilities/config.mjs";

const organizationId = "01M145HEM4JWAP8KJBG92BSCGE";
const principalId = "user:user_01JWHSH01K3QSVWDSVMQNB7RC3";
export const QA_PROJECTS = Object.freeze([
  { fixture: "react-vite", projectId: "01M6ZXZ47EYV0ZBK9EWMB5PBA3" },
  { fixture: "vanilla-vite", projectId: "01M700198NMGMR2RNEFANMDTY2" },
  { fixture: "tanstack-start", projectId: "01M7005KE6MZBYQ55GEZMBE0H1" },
  { fixture: "next-edge", projectId: "01M7009D9C3DREP783XY2CZ8DJ" },
  { fixture: "astro-edge", projectId: "01M700DHMFFRVYNF8JJ547KS1Z" },
  { fixture: "next-native-auth", projectId: "01M700GSJ36CCXDS2ZBATQ9ZFT" },
  { fixture: "next-app-mail", projectId: "01M700N2PQY18W4NGX2TSM9FKT" },
]);

async function scope(env, item) {
  const input = { organizationId, projectId: item.projectId, principalId };
  const share = await env.QA_DEV_ACCESS.readDevShareState(input);
  const view = await env.QA_DATABASE_AUTHORITY.readApiProjectDataChangeState(input);
  const dev = view?.assignments?.dev;
  const prod = view?.assignments?.prod;
  if (
    !share?.scope ||
    view.assignments.dataMode !== "isolated" ||
    !dev ||
    !prod ||
    share.scope.organizationId !== organizationId ||
    share.scope.projectId !== item.projectId ||
    dev.environmentId !== share.scope.environmentId ||
    dev.environmentId === prod.environmentId ||
    dev.dataEnvironmentId === prod.dataEnvironmentId
  )
    throw new Error("qa_inventory_unavailable");
  const binding = await env.QA_DATABASE_AUTHORITY.readRuntimeBinding({
    organizationId,
    projectId: item.projectId,
    environmentId: dev.environmentId,
  });
  const generations = view.registrationGenerations?.filter(
    (x) => x.dataEnvironmentId === dev.dataEnvironmentId,
  );
  if (
    !binding ||
    binding.provider !== "pgcf" ||
    binding.region !== "eu" ||
    binding.physicalEnvironmentId !== dev.dataEnvironmentId ||
    generations?.length !== 1 ||
    generations[0].registrationVersion !== binding.registrationVersion ||
    binding.authorizedEnvironmentIds?.length !== 1 ||
    binding.authorizedEnvironmentIds[0] !== dev.environmentId
  )
    throw new Error("qa_inventory_unavailable");
  return {
    fixture: item.fixture,
    organizationId,
    projectId: item.projectId,
    environmentId: dev.environmentId,
    physicalEnvironmentId: dev.dataEnvironmentId,
    registrationVersion: binding.registrationVersion,
    region: "eu",
    handle: share.scope.handle,
    origin: share.scope.origin,
    principalId,
    devAccessEpoch: share.scope.devAccessEpoch,
  };
}

export async function readQaInventory(env) {
  return bounded(async () => {
    const projects = [];
    for (const item of QA_PROJECTS) {
      const first = await scope(env, item);
      const after = await scope(env, item);
      if (JSON.stringify(first) !== JSON.stringify(after))
        throw new Error("qa_inventory_unavailable");
      projects.push(first);
    }
    return validateQaManifest({ platform: "development", projects });
  }, 60_000);
}
