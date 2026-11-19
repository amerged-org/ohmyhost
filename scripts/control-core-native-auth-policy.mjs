const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Closed private release input, canonicalized for rendering and exact provider readback. */
export function normalizeNativeAuthLaunchPolicy(value = { mode: "disabled" }) {
  if (!object(value) || typeof value.mode !== "string")
    throw new Error("Native Auth launch policy is invalid");
  if (["disabled", "password-general-availability"].includes(value.mode)) {
    if (Object.keys(value).join(",") !== "mode")
      throw new Error("Native Auth launch policy is invalid");
    return { mode: value.mode };
  }
  if (
    value.mode !== "allowlist" ||
    Object.keys(value).sort().join(",") !== "mode,projects" ||
    !Array.isArray(value.projects) ||
    value.projects.length > 1000
  )
    throw new Error("Native Auth launch policy is invalid");
  const projects = value.projects.map((project) => {
    if (
      !object(project) ||
      Object.keys(project).sort().join(",") !== "organizationId,projectId" ||
      typeof project.organizationId !== "string" ||
      typeof project.projectId !== "string" ||
      !ULID.test(project.organizationId) ||
      !ULID.test(project.projectId)
    )
      throw new Error("Native Auth launch policy is invalid");
    return { organizationId: project.organizationId, projectId: project.projectId };
  });
  return { mode: "allowlist", projects };
}
