import type { PreviewRuntimeFence } from "@ohmyhost/contracts/previews";

export interface PreviewDatabaseConnection {
  query(input: unknown): Promise<unknown>;
  commit?(): Promise<unknown>;
  close(): Promise<void>;
}
export interface PreviewDatabaseService {
  execute(input: {
    fence: PreviewRuntimeFence;
    operation: "query" | "transaction";
    input: unknown;
  }): Promise<unknown>;
  open(input: { fence: PreviewRuntimeFence }): Promise<PreviewDatabaseConnection>;
  openRls(input: {
    fence: PreviewRuntimeFence;
    identity: unknown;
  }): Promise<PreviewDatabaseConnection>;
}
type HandleOperation =
  | "open"
  | "openRls"
  | "connection-query"
  | "connection-commit"
  | "connection-close";
interface Handle {
  readonly fence: PreviewRuntimeFence;
  readonly connection: PreviewDatabaseConnection;
  readonly timer: ReturnType<typeof setTimeout>;
}
const same = (a: PreviewRuntimeFence, b: PreviewRuntimeFence) =>
  a.previewId === b.previewId &&
  a.runtimeGeneration === b.runtimeGeneration &&
  a.tokenGeneration === b.tokenGeneration;

/** RPC targets never enter the guest; a short-lived opaque handle addresses this actor's map. */
export class PreviewDatabaseHandles {
  private readonly handles = new Map<string, Handle>();
  public async invoke(
    service: PreviewDatabaseService,
    fence: PreviewRuntimeFence,
    operation: HandleOperation,
    input: unknown,
  ): Promise<unknown> {
    if (operation === "open" || operation === "openRls") {
      if (this.handles.size >= 32) throw new Error("preview_database_unavailable");
      const connection =
        operation === "open"
          ? await service.open({ fence })
          : await service.openRls({ fence, identity: input });
      const handle = crypto.randomUUID();
      const timer = setTimeout(() => {
        void this.close(handle);
      }, 30_000);
      this.handles.set(handle, { fence, connection, timer });
      return { handle };
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("handle" in input) ||
      typeof input.handle !== "string"
    )
      throw new Error("preview_database_unavailable");
    const entry = this.handles.get(input.handle);
    if (!entry || !same(entry.fence, fence)) throw new Error("preview_database_unavailable");
    if (operation === "connection-close") {
      await this.close(input.handle);
      return null;
    }
    if (operation === "connection-commit") {
      if (!entry.connection.commit) throw new Error("preview_database_unavailable");
      return entry.connection.commit();
    }
    return entry.connection.query("input" in input ? input.input : undefined);
  }
  private async close(handle: string): Promise<void> {
    const entry = this.handles.get(handle);
    if (!entry) return;
    this.handles.delete(handle);
    clearTimeout(entry.timer);
    await entry.connection.close();
  }
  public async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.handles.keys()].map((handle) => this.close(handle)),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("preview_database_close_unknown");
  }
}
