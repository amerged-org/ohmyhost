export interface WorkspaceMailProviderBinding {
  ensureWorkspaceMailDomain(input: unknown): Promise<unknown>;
  syncWorkspaceMailDomain(input: unknown): Promise<unknown>;
  retireWorkspaceMailDomain(input: unknown): Promise<unknown>;
}
