import type { D1ProjectRuntime } from "./d1-project-persistence.js";
import type { NativeAuthAdmin } from "./native-auth-composition.js";

/** Region is read from the current Core project, never from a request or model argument. */
export function createRegionalNativeAuthAdmin(input: {
  readonly runtime: D1ProjectRuntime;
  readonly us: NativeAuthAdmin;
  readonly eu: NativeAuthAdmin;
}): NativeAuthAdmin {
  async function select(value: unknown): Promise<NativeAuthAdmin> {
    if (typeof value !== "object" || value === null) throw new Error("native_auth_unavailable");
    const organizationId = Reflect.get(value, "organizationId"),
      projectId = Reflect.get(value, "projectId");
    if (typeof organizationId !== "string" || typeof projectId !== "string")
      throw new Error("native_auth_unavailable");
    const project = await input.runtime.getCustomerProject({ organizationId, projectId });
    if (
      !project ||
      project.organizationId !== organizationId ||
      project.projectId !== projectId ||
      (project.region !== "us" && project.region !== "eu")
    )
      throw new Error("native_auth_unavailable");
    return project.region === "us" ? input.us : input.eu;
  }
  return {
    async applyRealmPolicy(value) {
      const binding = await select(value);
      return binding.applyRealmPolicy(value);
    },
    async applyProviderPolicy(value) {
      const binding = await select(value);
      return binding.applyProviderPolicy(value);
    },
    async listUsers(value) {
      const binding = await select(value);
      return binding.listUsers(value);
    },
    async getUser(value) {
      const binding = await select(value);
      return binding.getUser(value);
    },
    async mutateUser(value) {
      const binding = await select(value);
      return binding.mutateUser(value);
    },
    async deliverInvitation(value) {
      const binding = await select(value);
      return binding.deliverInvitation(value);
    },
  };
}
