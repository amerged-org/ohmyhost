import { createD1RuntimeSecretPersistence } from "./d1-persistence.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  SystemClock,
  SystemEntropy,
  createEnvironmentSecretCipherKeyring,
  createUlidFactory,
} from "@ohmyhost/platform";

import {
  requireRuntimeSecretDeliveryBindings,
  type RuntimeSecretDeliveryBindings,
} from "./bindings.js";
import { createRuntimeSecretDelivery } from "./runtime.js";
import { readQaPreviewMailKey } from "./qa-preview-mail-key.js";
import { createPreviewSecretAccess } from "./preview-secrets.js";
import type { PreviewRuntimeFence } from "@ohmyhost/contracts/previews";

type Runtime = ReturnType<typeof createRuntimeSecretDelivery>;

async function invoke<Result>(
  rawBindings: unknown,
  action: (runtime: Runtime) => Promise<Result>,
): Promise<Result> {
  const bindings = requireRuntimeSecretDeliveryBindings(rawBindings);
  return action(createRuntime(bindings));
}

function createRuntime(bindings: RuntimeSecretDeliveryBindings): Runtime {
  const clock = new SystemClock();
  const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  return createRuntimeSecretDelivery({
    persistence: createD1RuntimeSecretPersistence(bindings.RUNTIME_SECRET_RUNTIME),
    cipher: createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: bindings.ENVIRONMENT_SECRET_KEY_BASE64,
      ...(bindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON === undefined
        ? {}
        : { additionalKeysJson: bindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON }),
      currentKeyVersion: Number(bindings.ENVIRONMENT_SECRET_KEY_VERSION),
      crypto: globalThis.crypto,
    }),
    wfp: bindings.WFP_MANAGEMENT,
    ids,
    clock,
    entropy: new SystemEntropy(),
  });
}

/** Bound only by the private Development QA mail Worker; no caller chooses a secret scope. */
export class QaPreviewMailKey extends WorkerEntrypoint<RuntimeSecretDeliveryBindings> {
  public async read(input?: never): Promise<string> {
    if (arguments.length !== 0 || input !== undefined) throw new Error("qa_mail_key_unavailable");
    return readQaPreviewMailKey(this.env);
  }
}

/** Private trusted preview Worker only; no plaintext platform key crosses into its guest. */
export class RuntimeSecretDeliveryPreview extends WorkerEntrypoint<RuntimeSecretDeliveryBindings> {
  public fetchPreview(request: Request, fence: PreviewRuntimeFence) {
    return createPreviewSecretAccess(requireRuntimeSecretDeliveryBindings(this.env)).fetchPreview(
      request,
      fence,
    );
  }
  public readCustomerVariables(input: { fence: PreviewRuntimeFence; names?: readonly string[] }) {
    return createPreviewSecretAccess(
      requireRuntimeSecretDeliveryBindings(this.env),
    ).readCustomerVariables(input);
  }
}

export class RuntimeSecretDeliveryService extends WorkerEntrypoint<RuntimeSecretDeliveryBindings> {
  public async stageCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.stageCandidate(input));
  }

  public async stagePromotionCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.stagePromotionCandidate(input));
  }

  public async recordStagedCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.recordStagedCandidate(input));
  }

  public async prepareExistingCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.prepareExistingCandidate(input));
  }

  public async activateCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.activateCandidate(input));
  }

  public async recordActivatedCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.recordActivatedCandidate(input));
  }

  public async observeActivation(input: unknown) {
    return invoke(this.env, (runtime) => runtime.observeActivation(input));
  }

  public async compensateActivation(input: unknown) {
    return invoke(this.env, (runtime) => runtime.compensateActivation(input));
  }

  public async compensateGatewayActivation(input: unknown) {
    return invoke(this.env, (runtime) => runtime.compensateGatewayActivation(input));
  }

  public async removeCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.removeCandidate(input));
  }

  public async removePersistedCandidate(input: unknown) {
    return invoke(this.env, (runtime) => runtime.removePersistedCandidate(input));
  }

  public async installPlatformSecret(input: unknown) {
    return invoke(this.env, (runtime) => runtime.installPlatformSecret(input));
  }

  public async ensureCustomerAuthSecret(input: unknown) {
    return invoke(this.env, (runtime) => runtime.ensureCustomerAuthSecret(input));
  }

  public async ensureMailGatewayKey(input: unknown) {
    return invoke(this.env, (runtime) => runtime.ensureMailGatewayKey(input));
  }

  public async ensureStorageGatewayKey(input: unknown) {
    return invoke(this.env, (runtime) => runtime.ensureStorageGatewayKey(input));
  }

  public async ensureAiGatewayKey(input: unknown) {
    return invoke(this.env, (runtime) => runtime.ensureAiGatewayKey(input));
  }
  public async ensureBrowserGatewayKey(input: unknown) {
    return invoke(this.env, (runtime) => runtime.ensureBrowserGatewayKey(input));
  }

  public async reconcileRuntimeSecrets(input: unknown) {
    return invoke(this.env, (runtime) => runtime.reconcileRuntimeSecrets(input));
  }
}

export default class RuntimeSecretDeliveryWorker extends WorkerEntrypoint<RuntimeSecretDeliveryBindings> {
  public async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  }

  public async scheduled() {
    return invoke(this.env, (runtime) => runtime.syncPendingOne());
  }
}
