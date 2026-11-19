import type {
  PreviewRuntimeFence,
  PreviewSourceDelta,
  ProjectPreviewRuntime,
  SourceVersion,
} from "@ohmyhost/contracts/previews";
import type { FrameworkPlan } from "@ohmyhost/platform";

export type PreviewSourceResult = PreviewSourceDelta<FrameworkPlan>;
export interface PreviewSourcePort {
  previewDiff(input: {
    previewId: string;
    runtimeGeneration: number;
    tokenGeneration: number;
    from: SourceVersion | null;
    to: SourceVersion;
  }): Promise<PreviewSourceResult>;
}
export interface PreviewProcess {
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stderr?: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
}
export interface PreviewContainer {
  readonly running: boolean;
  readonly images: Readonly<Record<string, unknown>>;
  start(input: {
    image: unknown;
    instance: string;
    enableInternet: false;
    labels: Readonly<Record<string, string>>;
  }): void;
  destroy(): Promise<void>;
  setInactivityTimeout(milliseconds: number): Promise<void>;
  exec(
    command: readonly string[],
    options: {
      user?: string;
      stdin?: "pipe";
      stdout?: "ignore";
      stderr?: "ignore" | "pipe";
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      signal?: AbortSignal;
    },
  ): Promise<PreviewProcess>;
  getTcpPort(port: number): { fetch(request: Request): Promise<Response> };
  interceptOutboundHttp(
    host: string,
    service: { fetch(request: Request): Promise<Response> },
  ): Promise<void>;
  interceptOutboundHttps(
    host: string,
    service: { fetch(request: Request): Promise<Response> },
  ): Promise<void>;
  interceptAllOutboundHttp(service: { fetch(request: Request): Promise<Response> }): Promise<void>;
}
export interface PreviewStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}
export interface RuntimeExecutionPorts {
  readonly core: ProjectPreviewRuntime;
  readonly source: PreviewSourcePort;
  readonly container: PreviewContainer;
}
export interface PreviewIdentity extends PreviewRuntimeFence {
  readonly publicOrigin: string;
}
