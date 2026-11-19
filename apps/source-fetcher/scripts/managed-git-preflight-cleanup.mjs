/** Operator cleanup is limited to the exact disposable locator whose creation was attempted. */
export async function cleanupDisposableRepository(
  { creationAttempted, name, remote, read, remove },
  originalFailure = null,
) {
  if (!creationAttempted) return originalFailure;
  const observe = async () => {
    const value = await read();
    if (!value || value.name !== name || value.remote !== remote)
      throw new Error("ACCEPTANCE_REPOSITORY_IDENTITY_MISMATCH");
  };
  try {
    try {
      await observe();
    } catch (error) {
      if (error?.code === "NOT_FOUND") return originalFailure;
      throw error;
    }
    try {
      await remove();
    } catch (error) {
      if (error?.code !== "NOT_FOUND") throw error;
    }
    try {
      await observe();
    } catch (error) {
      if (error?.code === "NOT_FOUND") return originalFailure;
      throw error;
    }
    throw new Error("REPOSITORY_DELETE_UNVERIFIED");
  } catch (error) {
    return originalFailure ?? error ?? new Error("REPOSITORY_DELETE_UNVERIFIED");
  }
}
