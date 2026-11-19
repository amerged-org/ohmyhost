import {
  createRecoveryControlHandler,
  type RecoveryStorePort,
} from "../../src/control-mediator.js";

/**
 * The real control handler inside workerd, in front of a real service binding. The test bundles this module; the
 * grant and container identity a Container would attach to the intercepted request travel in headers because there is
 * no Container in this harness.
 */
interface Env {
  readonly STORE: RecoveryStorePort;
}

const handler = createRecoveryControlHandler<Env>({
  dependencies: (env) => ({ store: env.STORE }),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const grant: unknown = JSON.parse(request.headers.get("x-grant") ?? "null");
    return handler(
      new Request(`http://recovery-control.internal${url.pathname}`, {
        method: request.method,
        headers: { authorization: request.headers.get("authorization") ?? "" },
        body: request.body,
        duplex: "half",
      } as RequestInit),
      env,
      {
        containerId: request.headers.get("x-container-id") ?? "",
        className: "RecoverySandbox",
        params: grant,
      },
    );
  },
};
