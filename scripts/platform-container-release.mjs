/* global AbortSignal, setTimeout, structuredClone */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

const API = "https://api.cloudflare.com/client/v4";
const REGISTRY = "registry.cloudflare.com";
const SOURCE = "https://github.com/amerged-org/ohmyhost";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u;
const REVISION_LABEL = "org.opencontainers.image.revision";
const RECIPE_LABEL = "st.ohmyho.release.recipe";
// ModifyUserDeploymentConfiguration fields from Cloudflare's Containers API. The actual write
// still uses only fields proven in the accepted rollout, never defaults added by application GET.
const WRITABLE_CONFIGURATION = new Set([
  "image",
  "wrangler_ssh",
  "authorized_keys",
  "trusted_user_ca_keys",
  "ssh_public_key_ids",
  "secrets",
  "instance_type",
  "vcpu",
  "memory",
  "memory_mib",
  "disk",
  "environment_variables",
  "labels",
  "network",
  "command",
  "entrypoint",
  "dns",
  "ports",
  "checks",
  "provisioner",
  "observability",
  "experimental_flags",
]);
// Wrangler's canonical instance types; API readbacks expand these into resource quantities.
const INSTANCE_TYPES = Object.freeze({
  lite: [0.0625, 256, 2000],
  basic: [0.25, 1024, 4000],
  "standard-1": [0.5, 4096, 8000],
  "standard-2": [1, 6144, 12000],
  "standard-3": [2, 8192, 16000],
  "standard-4": [4, 12288, 20000],
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The preview has one version-bound named image; scheduled Containers retain their old ABI. */
export function containerBuildInput(container) {
  if (container.images === undefined) return container;
  if (
    container.scheduling_policy !== "durable_object" ||
    !object(container.images) ||
    Object.keys(container.images).length !== 1 ||
    container.image !== undefined ||
    container.image_build_context !== undefined ||
    container.image_vars !== undefined
  )
    throw new Error("Container named-image recipe is invalid");
  const [name] = Object.keys(container.images);
  const image = container.images[name];
  if (
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(name) ||
    !object(image) ||
    Object.keys(image).some(
      (key) => !["dockerfile", "build_context", "build_vars"].includes(key),
    ) ||
    typeof image.dockerfile !== "string"
  )
    throw new Error("Container named-image recipe is invalid");
  const build = {
    ...container,
    image: image.dockerfile,
    ...(image.build_context === undefined ? {} : { image_build_context: image.build_context }),
    ...(image.build_vars === undefined ? {} : { image_vars: image.build_vars }),
  };
  delete build.images;
  return build;
}

export function setContainerReleaseImage(container, image) {
  if (container.images === undefined) {
    container.image = image;
    delete container.image_build_context;
    delete container.image_vars;
  } else {
    const names = Object.keys(container.images);
    if (container.scheduling_policy !== "durable_object" || names.length !== 1)
      throw new Error("Container named-image target is invalid");
    container.images = { [names[0]]: { image } };
  }
}

function verifyVersionImage(configuration, version, target, image) {
  const name = Object.keys(target.container.images)[0];
  const containers = version.resources?.script_runtime?.containers;
  const matches = Array.isArray(containers)
    ? containers.filter(
        (value) =>
          value?.name === target.container.name && value.class_name === target.container.class_name,
      )
    : [];
  if (
    matches.length !== 1 ||
    !object(matches[0].images) ||
    Object.keys(matches[0].images).length !== 1 ||
    matches[0].images[name] !== image ||
    boundNamespace(configuration, version.resources?.bindings, target.container.class_name) !==
      target.namespaceId
  )
    throw new Error("Container version-bound image differs from the approved release");
  return name;
}

/** Prepare all identities and immutable images before activating any Worker code. */
export async function prepareContainerRelease({
  configuration,
  repositoryRoot,
  sha,
  run,
  wrangler,
  fetch,
  env,
  configPath,
  imageReceiptPath,
  rehearsedImages,
  allowContainerBootstrap = false,
}) {
  if (configuration.containers === undefined) return null;
  if (!Array.isArray(configuration.containers) || configuration.containers.length === 0)
    throw new Error("Container release requires at least one declared container");
  if (typeof imageReceiptPath !== "string" || imageReceiptPath.length === 0)
    throw new Error(
      "Container release requires --container-images <private receipt outside the checkout>",
    );
  const receiptPath = resolve(imageReceiptPath);
  const location = relative(await realpath(repositoryRoot), await realpath(dirname(receiptPath)));
  if (location !== ".." && !location.startsWith("../") && !isAbsolute(location))
    throw new Error("Container image receipt must be retained outside the release checkout");
  const production = /-production(?:-(?:us|eu))?$/u.test(configuration.name);
  const pinnedReceipt = await readPrivateReceipt(receiptPath);
  const approval = await readPrivateReceipt(`${receiptPath}.development`);
  if (approval !== null && !isDevelopmentApproval(pinnedReceipt, approval, sha))
    throw new Error("Container Development approval does not match the retained image receipt");
  if (production && (pinnedReceipt === null || approval === null))
    throw new Error(
      "Production container release requires the existing Development-verified image receipt",
    );
  const accountId = configuration.account_id ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (
    !/^[a-f0-9]{32}$/u.test(accountId ?? "") ||
    (configuration.account_id !== undefined &&
      env.CLOUDFLARE_ACCOUNT_ID !== undefined &&
      configuration.account_id !== env.CLOUDFLARE_ACCOUNT_ID)
  )
    throw new Error("Container release requires one exact Cloudflare account_id");
  if (
    pinnedReceipt !== null &&
    (pinnedReceipt.value.schemaVersion !== 1 ||
      pinnedReceipt.value.sourceCommit !== sha ||
      pinnedReceipt.value.accountId !== accountId ||
      !object(pinnedReceipt.value.images))
  )
    throw new Error("Container image receipt belongs to another account or source commit");
  const credential = await privateCommand(run, wrangler, ["auth", "token", "--json"]);
  if (
    !["oauth", "api_token"].includes(credential.type) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  )
    throw new Error("Container release credential is unavailable");
  const request = async (path, method = "GET", body, missingWorker = false) => {
    const response = await safeFetch(fetch, `${API}/accounts/${accountId}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json().catch(() => null);
    if (
      missingWorker &&
      response.status === 404 &&
      value?.success === false &&
      Array.isArray(value.errors) &&
      value.errors.length === 1 &&
      value.errors[0]?.code === 10007
    )
      return null;
    if (!response.ok || value?.success !== true || value.result === undefined)
      throw new Error(`Container API request failed with status ${response.status}`);
    return value.result;
  };
  const account = await request("/containers/me");
  if (account.external_account_id !== accountId)
    throw new Error("Container account readback does not match the release account");
  const bootstrapAllowed =
    allowContainerBootstrap === true &&
    ["ohmyho-live-preview-poc-private-fullstack", "ohmyho-live-preview-production"].includes(
      configuration.name,
    ) &&
    configuration.containers.length === 1 &&
    configuration.containers[0].class_name === "PreviewSandbox" &&
    configuration.containers[0].scheduling_policy === "durable_object";
  if (allowContainerBootstrap && !bootstrapAllowed)
    throw new Error("Container bootstrap is outside the closed Preview profile");
  const settings = await request(
    `/workers/scripts/${encodeURIComponent(configuration.name)}/settings`,
    "GET",
    undefined,
    bootstrapAllowed,
  );
  const targets = [];
  const names = new Set();
  for (const container of configuration.containers) {
    if (
      !object(container) ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(container.name ?? "") ||
      names.has(container.name)
    )
      throw new Error("Container release requires distinct explicit application names");
    names.add(container.name);
    const namespaceId =
      settings === null
        ? null
        : boundNamespace(configuration, settings.bindings, container.class_name);
    const apps = await request(
      `/containers/applications?name=${encodeURIComponent(container.name)}`,
    );
    if (
      !Array.isArray(apps) ||
      (settings === null ? apps.length !== 0 : apps.length !== 1 || apps[0].name !== container.name)
    )
      throw new Error("Container release requires one existing application with the exact name");
    const application = apps[0];
    const target = {
      container,
      applicationId: application?.id ?? null,
      accountIdentity: accountId,
      namespaceId,
      observability: structuredClone(application?.observability),
      bootstrap: settings === null,
    };
    if (!target.bootstrap) validateApplication(application, target);
    targets.push(target);
  }
  const images = new Map();
  for (const target of targets) {
    const build = containerBuildInput(target.container);
    const recipe = await imageRecipe(build, repositoryRoot);
    const key = hash(JSON.stringify(recipe));
    if (!images.has(key)) {
      const imageName = `ohmyho-release-${key.slice(0, 16)}`;
      const tag = `${imageName}:${sha}`;
      const expectedImage = rehearsedImages?.[key];
      if (rehearsedImages !== undefined) {
        if (expectedImage === undefined)
          throw new Error("Rehearsal has no typed local image for the exact container recipe");
        await validateLocalContainerImage({ image: expectedImage, sha, recipe: key, run });
      }
      const pinnedImage = pinnedReceipt?.value.images[key];
      const prefix = `${REGISTRY}/${accountId}/${imageName}@`;
      if (
        pinnedReceipt !== null &&
        (typeof pinnedImage !== "string" ||
          !pinnedImage.startsWith(prefix) ||
          !DIGEST.test(pinnedImage.slice(prefix.length)))
      )
        throw new Error("Container image receipt does not pin the exact build recipe");
      const inspect = () =>
        inspectRegistryImage({
          accountId,
          imageName,
          reference: pinnedImage === undefined ? sha : pinnedImage.slice(prefix.length),
          sha,
          recipe: key,
          expectedImage,
          run,
          wrangler,
          configPath,
          fetch,
        });
      let image = await inspect();
      if (pinnedImage !== undefined && image !== pinnedImage)
        throw new Error(
          "Container pinned image is unavailable or changed; the release will not rebuild it",
        );
      if (image === null) {
        const rehearsed = rehearsedImages?.[key];
        if (rehearsedImages !== undefined && rehearsed === undefined)
          throw new Error("Rehearsal has no local image for the exact container recipe");
        if (rehearsed !== undefined) {
          await validateLocalContainerImage({ image: rehearsed, sha, recipe: key, run });
          await run("docker", ["tag", rehearsed.imageId, tag], { cwd: repositoryRoot });
        } else {
          const args = [
            "build",
            "--load",
            "--platform",
            "linux/amd64",
            "--provenance=false",
            "--label",
            `${REVISION_LABEL}=${sha}`,
            "--label",
            `org.opencontainers.image.source=${SOURCE}`,
            "--label",
            `${RECIPE_LABEL}=${key}`,
            "--file",
            build.image,
            "--tag",
            tag,
          ];
          for (const [name, value] of Object.entries(recipe.args))
            args.push("--build-arg", `${name}=${value}`);
          args.push(build.image_build_context ?? dirname(build.image));
          await run("docker", args, { cwd: repositoryRoot });
        }
        await run(wrangler, ["containers", "push", tag, "--config", configPath], { cwd: tmpdir() });
        image = await inspect();
        if (image === null) throw new Error("Container image was not found after publication");
      }
      images.set(key, image);
    }
    target.image = images.get(key);
  }
  if (pinnedReceipt !== null && Object.keys(pinnedReceipt.value.images).length !== images.size)
    throw new Error("Container image receipt has a different build recipe set");
  const receipt =
    pinnedReceipt ??
    (await createPrivateReceipt(receiptPath, {
      schemaVersion: 1,
      sourceCommit: sha,
      accountId,
      images: Object.fromEntries(images),
    }));
  // Wrangler must see the same immutable images as the rollout, but must never roll them out itself.
  const rendered = structuredClone(configuration);
  rendered.containers.forEach((container, index) => {
    setContainerReleaseImage(container, targets[index].image);
  });
  await writeFile(configPath, `${JSON.stringify(rendered, null, 2)}\n`, { mode: 0o600 });
  return {
    configuration: rendered,
    targets,
    request,
    sha,
    receiptPath,
    receiptSha256: hash(receipt.contents),
    production,
  };
}

/** This runs even when the exact Worker version was already deployed by a previous attempt. */
export async function completeContainerRelease({
  release,
  version,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 120,
}) {
  if (release === null) return [];
  const receipts = [];
  for (const target of release.targets) {
    if (target.bootstrap) {
      const apps = await release.request(
        `/containers/applications?name=${encodeURIComponent(target.container.name)}`,
      );
      if (!Array.isArray(apps) || apps.length !== 1 || apps[0].name !== target.container.name)
        throw new Error(
          "Container bootstrap application is missing or ambiguous; reconcile the original creation",
        );
      target.applicationId = apps[0].id;
      target.namespaceId = boundNamespace(
        release.configuration,
        version.resources?.bindings,
        target.container.class_name,
      );
      target.observability = structuredClone(apps[0].observability);
      validateApplication(apps[0], target);
    }
    if (
      boundNamespace(
        release.configuration,
        version.resources?.bindings,
        target.container.class_name,
      ) !== target.namespaceId
    )
      throw new Error("Container Worker version changed the Durable Object namespace");
    const path = `/containers/applications/${target.applicationId}`;
    let application = await release.request(path);
    validateApplication(application, target);
    if (target.container.images !== undefined) {
      const imageBinding = verifyVersionImage(release.configuration, version, target, target.image);
      if (!ID.test(version.id ?? ""))
        throw new Error("Container Worker version identity is invalid");
      receipts.push({
        applicationId: target.applicationId,
        image: target.image,
        imageBinding,
        workerVersionId: version.id,
        policy: "durable_object",
      });
      continue;
    }
    const description = `source ${release.sha}; image ${target.image}`;
    const legacyDescription = `origin/main ${release.sha}; image ${target.image}`;
    const existing = await release.request(`${path}/rollouts`);
    if (!Array.isArray(existing)) throw new Error("Container rollout list is invalid");
    const matches = existing.filter((rollout) =>
      [description, legacyDescription].includes(rollout.description),
    );
    if (matches.length > 1) throw new Error("Container release has ambiguous matching rollouts");
    let rollout = matches[0];
    const active = existing.filter((candidate) =>
      ["pending", "progressing"].includes(candidate.status),
    );
    if (active.some((candidate) => candidate.id !== rollout?.id))
      throw new Error(
        "Container application has another active rollout; inspect it before releasing",
      );
    const targetConfiguration = acceptedImageTarget({
      application,
      rollouts: existing,
      rollout,
      image: target.image,
    });
    // Freeze the exact recognized description, including for a legacy rollout resume.
    const expectedDescription = rollout === undefined ? description : rollout.description;
    if (rollout === undefined) {
      rollout = await release.request(`${path}/rollouts`, "POST", {
        description,
        strategy: "rolling",
        kind: "full_auto",
        target_configuration: targetConfiguration,
        steps: rolloutSteps(target.container).map((percentage, index) => ({
          step_size: { percentage },
          description: `Release step ${index + 1}: ${percentage}%`,
        })),
      });
    }
    if (!ID.test(rollout.id ?? "")) throw new Error("Container rollout identity is invalid");
    let completed = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const observed = await release.request(`${path}/rollouts/${rollout.id}`);
      if (
        observed.id !== rollout.id ||
        observed.description !== expectedDescription ||
        !isDeepStrictEqual(observed.target_configuration, targetConfiguration)
      )
        throw new Error("Container rollout readback changed its target");
      if (!["pending", "progressing", "completed"].includes(observed.status))
        throw new Error("Container rollout was reverted or replaced; inspect it before releasing");
      if (observed.status === "completed") {
        if (!hasCompletedSteps(observed))
          throw new Error("Container rollout completion readback is inconsistent");
        if (
          (observed.health?.errors !== undefined &&
            (!Array.isArray(observed.health.errors) || observed.health.errors.length !== 0)) ||
          (observed.health?.instances?.failed !== undefined &&
            observed.health.instances.failed !== 0)
        )
          throw new Error("Container rollout health readback reports failed instances or errors");
        application = await release.request(path);
        validateApplication(application, target);
        if (
          application.configuration.image !== target.image ||
          application.version !== observed.target_version ||
          !configurationMatches(targetConfiguration, application.configuration)
        )
          throw new Error(
            "Container application readback does not match the completed image rollout",
          );
        completed = true;
        break;
      }
      if (attempt + 1 < attempts) await wait(15_000);
    }
    if (!completed)
      throw new Error(
        `Container rollout ${rollout.id} is not complete; retry the same release to resume verification`,
      );
    receipts.push({
      applicationId: target.applicationId,
      image: target.image,
      rolloutId: rollout.id,
    });
  }
  if (!release.production) {
    await createPrivateReceipt(`${release.receiptPath}.development`, {
      schemaVersion: 1,
      receiptSha256: release.receiptSha256,
      sourceCommit: release.sha,
      workerName: release.configuration.name,
      containers: receipts,
    });
  }
  return receipts;
}

/** Completed train steps prove live Container state with GETs only, including registry bytes. */
export async function verifyContainerReleaseReceipt({
  configuration,
  receipt,
  version,
  run,
  wrangler,
  fetch,
  env,
  configPath,
  repositoryRoot,
  rehearsedImages,
}) {
  if (configuration.containers === undefined) {
    if (receipt.containers !== undefined && receipt.containers.length !== 0)
      throw new Error("Completed receipt unexpectedly includes Containers");
    return;
  }
  if (
    !Array.isArray(receipt.containers) ||
    receipt.containers.length !== configuration.containers.length
  )
    throw new Error("Completed Container receipt count differs");
  const accountId = configuration.account_id ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (
    !/^[a-f0-9]{32}$/u.test(accountId ?? "") ||
    (configuration.account_id !== undefined &&
      env.CLOUDFLARE_ACCOUNT_ID !== undefined &&
      configuration.account_id !== env.CLOUDFLARE_ACCOUNT_ID)
  )
    throw new Error("Completed Container account identity is invalid");
  const credential = await privateCommand(run, wrangler, ["auth", "token", "--json"]);
  if (
    !["oauth", "api_token"].includes(credential.type) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  )
    throw new Error("Completed Container readback credential is unavailable");
  const request = async (path) => {
    const response = await safeFetch(fetch, `${API}/accounts/${accountId}${path}`, {
      headers: { authorization: `Bearer ${credential.token}` },
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.success !== true || value.result === undefined)
      throw new Error("Completed Container readback failed");
    return value.result;
  };
  for (let index = 0; index < configuration.containers.length; index += 1) {
    const container = configuration.containers[index];
    const evidence = receipt.containers[index];
    const recipe = hash(JSON.stringify(await imageRecipe(container, repositoryRoot)));
    const imageName = `ohmyho-release-${recipe.slice(0, 16)}`;
    const expectedImage = rehearsedImages?.[recipe];
    if (rehearsedImages !== undefined) {
      if (expectedImage === undefined)
        throw new Error("Completed Container rehearsal omits its typed approved image identity");
      validateImageIdentity(expectedImage);
      if (expectedImage.recipeSha256 !== recipe)
        throw new Error("Completed Container typed image belongs to another build recipe");
    }
    const prefix = `${REGISTRY}/${accountId}/${imageName}@`;
    const named = container.images !== undefined;
    if (
      !ID.test(evidence.applicationId ?? "") ||
      (named
        ? evidence.policy !== "durable_object" || evidence.workerVersionId !== version.id
        : !ID.test(evidence.rolloutId ?? "")) ||
      !evidence.image?.startsWith(prefix) ||
      !DIGEST.test(evidence.image.slice(prefix.length))
    )
      throw new Error("Completed Container immutable evidence is invalid");
    const image = await inspectRegistryImage({
      accountId,
      imageName,
      reference: evidence.image.slice(prefix.length),
      sha: receipt.sha,
      recipe,
      run,
      wrangler,
      configPath,
      fetch,
      expectedImage,
    });
    if (image !== evidence.image) throw new Error("Completed Container registry image differs");
    const application = await request(`/containers/applications/${evidence.applicationId}`);
    const target = {
      container,
      applicationId: evidence.applicationId,
      accountIdentity: accountId,
      namespaceId: boundNamespace(configuration, version.resources?.bindings, container.class_name),
      observability: structuredClone(application.observability),
    };
    validateApplication(application, target);
    if (named) {
      if (
        verifyVersionImage(configuration, version, target, evidence.image) !== evidence.imageBinding
      )
        throw new Error("Completed Container named image binding differs");
      continue;
    }
    const path = `/containers/applications/${evidence.applicationId}/rollouts`;
    const rollouts = await request(path);
    if (!Array.isArray(rollouts)) throw new Error("Completed Container rollout list is invalid");
    const matches = rollouts.filter((rollout) => rollout.id === evidence.rolloutId);
    const rollout = matches.length === 1 ? matches[0] : null;
    if (
      ![
        `source ${receipt.sha}; image ${evidence.image}`,
        `origin/main ${receipt.sha}; image ${evidence.image}`,
      ].includes(rollout?.description) ||
      rollout.status !== "completed" ||
      !hasCompletedSteps(rollout) ||
      (rollout.health?.errors !== undefined &&
        (!Array.isArray(rollout.health.errors) || rollout.health.errors.length !== 0)) ||
      (rollout.health?.instances?.failed !== undefined && rollout.health.instances.failed !== 0) ||
      rollouts.some((other) => ["pending", "progressing"].includes(other.status))
    )
      throw new Error("Completed Container rollout or health drifted");
    const wanted = acceptedImageTarget({ application, rollouts, rollout, image: evidence.image });
    if (
      application.version !== rollout.target_version ||
      !configurationMatches(wanted, application.configuration)
    )
      throw new Error("Completed Container application target drifted");
  }
}

function acceptedImageTarget({ application, rollouts, rollout, image }) {
  // Even a completed own rollout must prove its image-only change against its predecessor;
  // using its own target as the baseline would silently adopt altered writable settings.
  const baselineVersion = rollout === undefined ? application.version : rollout.current_version;
  const baseline = rollouts.filter(
    (candidate) =>
      candidate.target_version === baselineVersion &&
      (candidate.status === "completed" ||
        (rollout !== undefined && candidate.status === "replaced")),
  );
  if (
    !Number.isSafeInteger(baselineVersion) ||
    baselineVersion < 1 ||
    baseline.length !== 1 ||
    !ID.test(baseline[0].id ?? "") ||
    !hasCompletedSteps(baseline[0])
  )
    throw new Error("Container accepted baseline is missing, ambiguous or incomplete");
  const accepted = baseline[0].target_configuration;
  if (
    !object(accepted) ||
    typeof accepted.image !== "string" ||
    Object.keys(accepted).some((key) => !WRITABLE_CONFIGURATION.has(key)) ||
    (application.observability !== undefined && accepted.observability !== undefined)
  )
    throw new Error("Container accepted baseline configuration cannot be preserved safely");
  const desired = { ...structuredClone(accepted), image };
  if (rollout !== undefined && !isDeepStrictEqual(rollout.target_configuration, desired))
    throw new Error("Container own rollout target differs from the accepted image-only change");
  if (rollout === undefined) {
    if (!configurationMatches(accepted, application.configuration))
      throw new Error(
        "Container accepted baseline configuration differs from application readback",
      );
  } else {
    // A timed-out POST may already advance app.version. Cloudflare then marks the previously
    // completed rollout replaced, while the own rollout retains its exact accepted predecessor.
    if (
      !Number.isSafeInteger(rollout.target_version) ||
      rollout.target_version <= baselineVersion ||
      !isDeepStrictEqual(rollout.current_configuration, accepted)
    )
      throw new Error("Container own rollout baseline differs from its accepted predecessor");
    const current =
      application.version === baselineVersion
        ? accepted
        : application.version === rollout.target_version
          ? desired
          : null;
    if (current === null || !configurationMatches(current, application.configuration))
      throw new Error("Container own rollout configuration differs from application readback");
  }
  return desired;
}

function hasCompletedSteps(rollout) {
  return (
    Array.isArray(rollout.steps) &&
    rollout.steps.length > 0 &&
    rollout.steps.every((step) => step.status === "completed") &&
    rollout.steps.at(-1).step_size?.percentage === 100 &&
    Number.isSafeInteger(rollout.progress?.total_instances) &&
    rollout.progress.total_instances >= 0 &&
    rollout.progress.updated_instances === rollout.progress.total_instances
  );
}

function configurationMatches(expected, actual) {
  const resources = (configuration) => {
    if (!object(configuration)) return null;
    const values = [configuration.vcpu, configuration.memory_mib, configuration.disk?.size_mb];
    if (configuration.instance_type !== undefined) {
      const preset = INSTANCE_TYPES[configuration.instance_type];
      return preset !== undefined &&
        values.every((value, index) => value === undefined || value === preset[index])
        ? preset
        : null;
    }
    return values.every((value) => Number.isFinite(value) && value > 0) ? values : null;
  };
  const expectedResources = resources(expected);
  if (expectedResources === null || !isDeepStrictEqual(expectedResources, resources(actual)))
    return false;
  const matches = (wanted, observed) =>
    object(wanted)
      ? object(observed) &&
        Object.entries(wanted).every(([key, value]) => matches(value, observed[key]))
      : isDeepStrictEqual(wanted, observed);
  return Object.entries(expected).every(
    ([key, value]) =>
      ["instance_type", "vcpu", "memory_mib"].includes(key) || matches(value, actual[key]),
  );
}

/** The operator retains these create-only files across Dev, Prod, retries and checkout cleanup. */
async function readPrivateReceipt(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Container image receipt cannot be opened safely");
  }
  try {
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid()) ||
      details.size < 2 ||
      details.size > 65536
    )
      throw new Error("Container image receipt permissions or size are invalid");
    const contents = await handle.readFile("utf8");
    return { contents, value: parsePrivateJson(contents) };
  } finally {
    await handle.close();
  }
}

async function createPrivateReceipt(path, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error("Container image receipt could not be persisted");
    const existing = await readPrivateReceipt(path);
    if (existing === null || !isDeepStrictEqual(existing.value, value))
      throw new Error("Container image receipt already pins different release evidence");
    return existing;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { contents, value };
}

function isDevelopmentApproval(receipt, approval, sha) {
  const proof = approval.value;
  return (
    receipt !== null &&
    object(receipt.value.images) &&
    proof.schemaVersion === 1 &&
    proof.sourceCommit === sha &&
    proof.receiptSha256 === hash(receipt.contents) &&
    typeof proof.workerName === "string" &&
    /(?:-poc-private-fullstack|-development-(?:us|eu))$/u.test(proof.workerName) &&
    Array.isArray(proof.containers) &&
    proof.containers.length > 0 &&
    proof.containers.every(
      (entry) =>
        object(entry) &&
        ID.test(entry.applicationId ?? "") &&
        (entry.policy === undefined
          ? ID.test(entry.rolloutId ?? "")
          : entry.policy === "durable_object" &&
            Object.keys(entry).sort().join(",") ===
              "applicationId,image,imageBinding,policy,workerVersionId" &&
            /^[a-z][a-z0-9_-]{0,31}$/u.test(entry.imageBinding ?? "") &&
            /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(entry.workerVersionId ?? "")) &&
        Object.values(receipt.value.images).includes(entry.image),
    ) &&
    Object.values(receipt.value.images).every((image) =>
      proof.containers.some((entry) => entry.image === image),
    )
  );
}

function boundNamespace(configuration, bindings, className) {
  if (
    typeof className !== "string" ||
    !configuration.durable_objects?.bindings?.some(
      (binding) =>
        binding.class_name === className &&
        (binding.script_name === undefined || binding.script_name === configuration.name),
    )
  )
    throw new Error("Container release requires a local Durable Object binding");
  const matches = Array.isArray(bindings)
    ? bindings.filter(
        (binding) =>
          binding.type === "durable_object_namespace" &&
          binding.class_name === className &&
          (binding.script_name === undefined || binding.script_name === configuration.name),
      )
    : [];
  if (matches.length !== 1 || !ID.test(matches[0].namespace_id ?? ""))
    throw new Error("Container Durable Object namespace readback is invalid");
  return matches[0].namespace_id;
}

function validateApplication(
  application,
  { container, applicationId, accountIdentity, namespaceId, observability },
) {
  if (container.images !== undefined) {
    if (
      !ID.test(applicationId ?? "") ||
      application.id !== applicationId ||
      application.name !== container.name ||
      application.account_id !== accountIdentity ||
      application.durable_objects?.namespace_id !== namespaceId ||
      application.scheduling_policy !== "durable_object" ||
      (container.max_instances !== undefined &&
        application.max_instances !== container.max_instances) ||
      !isDeepStrictEqual(application.observability, observability)
    )
      throw new Error("Container durable-object application identity or settings differ");
    for (const [key, value] of Object.entries(container.constraints ?? {})) {
      if (!isDeepStrictEqual(application.constraints?.[key], value))
        throw new Error("Container application placement differs from the declared release");
    }
    return;
  }
  if (
    !ID.test(applicationId ?? "") ||
    application.id !== applicationId ||
    application.name !== container.name ||
    application.account_id !== accountIdentity ||
    application.durable_objects?.namespace_id !== namespaceId ||
    application.scheduling_policy !== (container.scheduling_policy ?? "default") ||
    application.max_instances !== container.max_instances ||
    application.rollout_active_grace_period !== (container.rollout_active_grace_period ?? 0) ||
    !object(application.configuration) ||
    (application.observability !== undefined && !object(application.observability)) ||
    !isDeepStrictEqual(application.observability, observability)
  )
    throw new Error("Container application identity or settings differ from the declared release");
  for (const [key, value] of Object.entries(container.constraints ?? {})) {
    const normalized = (v) => (Array.isArray(v) ? [...v].sort() : v);
    if (!isDeepStrictEqual(normalized(application.constraints?.[key]), normalized(value)))
      throw new Error("Container application placement differs from the declared release");
  }
  const resources = INSTANCE_TYPES[container.instance_type];
  const actual = application.configuration;
  if (
    !resources ||
    (actual.instance_type !== undefined && actual.instance_type !== container.instance_type) ||
    (actual.instance_type === undefined &&
      !isDeepStrictEqual([actual.vcpu, actual.memory_mib, actual.disk?.size_mb], resources))
  )
    throw new Error("Container application instance type differs from the declared release");
  if (
    container.affinities !== undefined &&
    !isDeepStrictEqual(application.affinities, container.affinities)
  )
    throw new Error("Container application affinities differ from the declared release");
  rolloutSteps(container);
}

function rolloutSteps(container) {
  const steps =
    container.rollout_step_percentage ?? ((container.max_instances ?? 1) < 2 ? [100] : [10, 100]);
  if (
    !Array.isArray(steps) ||
    steps.length === 0 ||
    steps.at(-1) !== 100 ||
    steps.some(
      (step, index) =>
        !Number.isInteger(step) ||
        step < 10 ||
        step > 100 ||
        (index > 0 && step <= steps[index - 1]),
    )
  )
    throw new Error("Container rollout steps must increase to 100 percent");
  return steps;
}

/**
 * The recipe names the Dockerfile and every COPY source it reads from the build context. The image
 * name, recipe label and receipts key on it, so a changed input (such as the admission policy) can
 * never reuse an image built from older bytes.
 */
export async function imageRecipe(container, root) {
  container = containerBuildInput(container);
  const image = container.image;
  if (typeof image !== "string" || !isAbsolute(image))
    throw new Error("Container release requires a repository Dockerfile with source provenance");
  const context = container.image_build_context ?? dirname(image);
  const [realRoot, realImage, realContext] = await Promise.all([
    realpath(root),
    realpath(image),
    realpath(context),
  ]);
  const safeRelative = (path) => {
    const value = relative(realRoot, path);
    if (isAbsolute(value) || value === ".." || value.startsWith("../"))
      throw new Error("Container build path leaves the release repository");
    return value;
  };
  if (!(await stat(realImage)).isFile() || !(await stat(realContext)).isDirectory())
    throw new Error("Container build paths are invalid");
  const args = container.image_vars ?? {};
  if (
    !object(args) ||
    Object.entries(args).some(
      ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string",
    )
  )
    throw new Error("Container image build arguments are invalid");
  const dockerfile = await readFile(realImage);
  const inputs = new Map();
  for (const source of contextSources(dockerfile.toString("utf8"))) {
    const path = join(realContext, ...source.split("/"));
    inputs.set(safeRelative(path), await readRecipeInput(path));
  }
  return {
    dockerfile: safeRelative(realImage),
    context: safeRelative(realContext),
    dockerfileSha256: hash(dockerfile),
    args: Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
    inputs: [...inputs.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((path) => ({ path, sha256: inputs.get(path) })),
  };
}

const COPY_FLAG = /^--(?:chown=\S+|chmod=[0-7]{3,4}|link(?:=(?:true|false))?)$/u;
const SOURCE_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;

/**
 * Context paths named by COPY instructions. Only explicit relative file paths are understood;
 * every form that can read other context bytes (ADD, globs, variables, heredocs, JSON form,
 * RUN --mount, ONBUILD or parser directives) refuses the recipe instead of being ignored.
 */
function contextSources(text) {
  const unsupported = () => {
    throw new Error("Container image recipe cannot pin a Dockerfile context input form");
  };
  const instructions = [];
  let pending = null;
  // BuildKit ignores a leading byte-order mark, so a directive behind one still applies.
  for (const raw of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = raw.replace(/^[ \t]+/u, "");
    if (/^#[ \t]*(?:syntax|escape|check)[ \t]*=/iu.test(line)) unsupported();
    // Comment and blank lines never end an instruction, also inside a continuation.
    if (line.trim() === "" || line.startsWith("#")) continue;
    const continued = /\\[ \t]*$/u.test(line);
    // BuildKit removes only the backslash and line break, so a continuation line keeps its
    // leading whitespace, which separates its first word from the word before the backslash.
    const kept = pending === null ? line : raw;
    const content = continued ? kept.replace(/\\[ \t]*$/u, "") : kept;
    pending = pending === null ? content : pending + content;
    if (!continued) {
      instructions.push(pending);
      pending = null;
    }
  }
  if (pending !== null) instructions.push(pending);
  const stages = [];
  const sources = [];
  for (const instruction of instructions) {
    const [keyword, ...words] = instruction.trim().split(/[ \t]+/u);
    const name = keyword.toUpperCase();
    if (name === "ADD" || name === "ONBUILD") unsupported();
    if (["RUN", "COPY"].includes(name) && instruction.includes("<<")) unsupported();
    if (name === "FROM") {
      const operands = words.filter((word) => !/^--platform=\S+$/u.test(word));
      if (operands.length === 3 && operands[1].toLowerCase() === "as")
        stages.push(operands[2].toLowerCase());
      else if (operands.length === 1) stages.push(null);
      else unsupported();
    } else if (name === "RUN") {
      for (const word of words) {
        if (!word.startsWith("--")) break;
        if (/^--mount(?:=|$)/u.test(word)) unsupported();
      }
    } else if (name === "COPY") {
      if (words[0]?.startsWith("[")) unsupported();
      let index = 0;
      let stage;
      for (; words[index]?.startsWith("--"); index += 1) {
        const from = /^--from=(.+)$/u.exec(words[index]);
        if (from !== null) stage = from[1].toLowerCase();
        else if (!COPY_FLAG.test(words[index])) unsupported();
      }
      const operands = words.slice(index);
      if (operands.length < 2) unsupported();
      if (stage !== undefined) {
        // An earlier stage's filesystem is not a context input; anything else would be an image.
        if (
          !stages.includes(stage) &&
          !(/^(?:0|[1-9][0-9]*)$/u.test(stage) && Number(stage) < stages.length)
        )
          unsupported();
        continue;
      }
      for (const source of operands.slice(0, -1)) {
        const segments = source.split("/");
        if (!segments.every((segment) => SOURCE_SEGMENT.test(segment) && !/^\.+$/u.test(segment)))
          unsupported();
        sources.push(segments.join("/"));
      }
    }
  }
  return sources;
}

/** A recipe input is one regular file read without following a link, bounded in size. */
async function readRecipeInput(path) {
  let details;
  let real;
  try {
    details = await lstat(path);
    real = await realpath(path);
  } catch {
    throw new Error("Container image input is missing or unreadable");
  }
  if (!details.isFile() || real !== path)
    throw new Error("Container image input must be a regular file, not a link or directory");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error("Container image input is missing or unreadable");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 64 * 1024 * 1024)
      throw new Error("Container image input must be a regular file of at most 64 MiB");
    return hash(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function manifestDescriptorIdentity(descriptor, { requireConfig = true } = {}) {
  const configDigest = descriptor?.annotations?.["config.digest"];
  if (
    !object(descriptor) ||
    ![
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].includes(descriptor.mediaType) ||
    !DIGEST.test(descriptor.digest ?? "") ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1 ||
    ((requireConfig || configDigest !== undefined) && !DIGEST.test(configDigest ?? "")) ||
    (descriptor.platform !== undefined &&
      (descriptor.platform.os !== "linux" || descriptor.platform.architecture !== "amd64"))
  )
    throw new Error(
      "Rehearsal requires complete single-platform manifest and config descriptor identities",
    );
  return {
    manifestDigest: descriptor.digest,
    ...(configDigest === undefined ? {} : { configDigest }),
  };
}

function validateImageIdentity(image) {
  if (
    !object(image) ||
    !DIGEST.test(image.imageId ?? "") ||
    !["config", "manifest"].includes(image.imageIdKind) ||
    !DIGEST.test(image.manifestDigest ?? "") ||
    !DIGEST.test(image.configDigest ?? "") ||
    image.manifestDigest === image.configDigest ||
    image.imageId !== (image.imageIdKind === "manifest" ? image.manifestDigest : image.configDigest)
  )
    throw new Error("Rehearsal typed local image identity is invalid");
}

/** Independent build/daemon metadata identifies the manifest and config before publication. */
export function captureLocalContainerImageIdentity({ record, metadata, sha, recipe }) {
  const build = manifestDescriptorIdentity(metadata?.["containerimage.descriptor"], {
    requireConfig: false,
  });
  if (metadata?.["containerimage.digest"] !== build.manifestDigest)
    throw new Error("Rehearsal BuildKit manifest and config identities are inconsistent");
  const hasDescriptor = record?.Descriptor !== undefined && record.Descriptor !== null;
  const local = hasDescriptor
    ? manifestDescriptorIdentity(record.Descriptor)
    : { manifestDigest: build.manifestDigest, configDigest: record?.Id };
  if (
    hasDescriptor &&
    (local.manifestDigest !== build.manifestDigest ||
      record.Descriptor.mediaType !== metadata["containerimage.descriptor"].mediaType ||
      record.Descriptor.size !== metadata["containerimage.descriptor"].size)
  )
    throw new Error("Rehearsal Docker and BuildKit manifest descriptors differ");
  // Docker's --load exporter can omit both optional BuildKit config fields; the daemon's
  // manifest descriptor then supplies its config identity (classic stores use opaque Id).
  // Every declared duplicate must still agree, and modern daemon config metadata is mandatory.
  for (const declared of [metadata?.["containerimage.config.digest"], build.configDigest])
    if (declared !== undefined && (!DIGEST.test(declared) || declared !== local.configDigest))
      throw new Error("Rehearsal BuildKit and Docker config identities are inconsistent");
  const image = {
    imageId: record?.Id,
    recipeSha256: recipe,
    imageIdKind: hasDescriptor ? "manifest" : "config",
    ...local,
  };
  validateImageIdentity(image);
  validateLocalImageRecord({ record, image, sha, recipe });
  return image;
}

function validateLocalImageRecord({ record, image, sha, recipe }) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? "") || !/^[a-f0-9]{64}$/u.test(recipe ?? ""))
    throw new Error("Rehearsal source or image recipe identity is invalid");
  const hasDescriptor = record?.Descriptor !== undefined && record.Descriptor !== null;
  if (
    record?.Id !== image.imageId ||
    hasDescriptor !== (image.imageIdKind === "manifest") ||
    (hasDescriptor &&
      !isDeepStrictEqual(manifestDescriptorIdentity(record.Descriptor), {
        manifestDigest: image.manifestDigest,
        configDigest: image.configDigest,
      })) ||
    record?.Os !== "linux" ||
    record?.Architecture !== "amd64" ||
    record?.Config?.Labels?.[REVISION_LABEL] !== sha ||
    record?.Config?.Labels?.[RECIPE_LABEL] !== recipe ||
    record?.Config?.Labels?.["org.opencontainers.image.source"] !== SOURCE
  )
    throw new Error(
      "Rehearsal local image source revision, recipe, platform or typed identity differs",
    );
}

/** A rehearsal image is consumed by immutable local ID, never by a mutable tag. */
export async function validateLocalContainerImage({ image, sha, recipe, run }) {
  validateImageIdentity(image);
  if (image.recipeSha256 !== recipe) throw new Error("Rehearsal local image identity is invalid");
  let value;
  try {
    value = JSON.parse(await run("docker", ["image", "inspect", image.imageId]));
  } catch {
    throw new Error("Rehearsal local image is unavailable");
  }
  const record = Array.isArray(value) && value.length === 1 ? value[0] : null;
  validateLocalImageRecord({ record, image, sha, recipe });
  return record.Id;
}

export function verifyRegistryImageIdentity({ manifestDigest, configDigest, expectedImage }) {
  validateImageIdentity(expectedImage);
  if (
    !DIGEST.test(manifestDigest ?? "") ||
    !DIGEST.test(configDigest ?? "") ||
    (expectedImage.imageIdKind === "manifest" && manifestDigest !== expectedImage.manifestDigest) ||
    configDigest !== expectedImage.configDigest ||
    expectedImage.imageId !==
      (expectedImage.imageIdKind === "manifest" ? manifestDigest : configDigest)
  )
    throw new Error(
      "Container registry manifest/config differs from the rehearsed immutable local image",
    );
}

async function inspectRegistryImage({
  accountId,
  imageName,
  reference,
  sha,
  recipe,
  run,
  wrangler,
  configPath,
  fetch,
  expectedImage,
}) {
  const credentials = await privateCommand(run, wrangler, [
    "containers",
    "registries",
    "credentials",
    REGISTRY,
    "--pull",
    "--expiration-minutes",
    "5",
    "--json",
    "--config",
    configPath,
  ]);
  if (typeof credentials.password !== "string" || credentials.password.length === 0)
    throw new Error("Container registry credential is unavailable");
  const headers = {
    authorization: `Basic ${Buffer.from(`v1:${credentials.password}`).toString("base64")}`,
    accept:
      "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
  };
  const base = `https://${REGISTRY}/v2/${accountId}/${imageName}`;
  const manifestResponse = await safeFetch(fetch, `${base}/manifests/${reference}`, { headers });
  if (manifestResponse.status === 404) return null;
  if (!manifestResponse.ok)
    throw new Error(`Container registry request failed with status ${manifestResponse.status}`);
  const manifestBytes = await manifestResponse.text();
  const digest = manifestResponse.headers.get("Docker-Content-Digest");
  if (!DIGEST.test(digest ?? "") || `sha256:${hash(manifestBytes)}` !== digest)
    throw new Error("Container registry manifest digest is invalid");
  const manifest = parsePrivateJson(manifestBytes);
  if (manifest.schemaVersion !== 2 || !DIGEST.test(manifest.config?.digest ?? ""))
    throw new Error("Container registry requires a single platform image manifest");
  if (expectedImage !== undefined)
    verifyRegistryImageIdentity({
      manifestDigest: digest,
      configDigest: manifest.config.digest,
      expectedImage,
    });
  const blobResponse = await safeFetch(fetch, `${base}/blobs/${manifest.config.digest}`, {
    headers,
  });
  if (!blobResponse.ok)
    throw new Error(`Container image configuration read failed with status ${blobResponse.status}`);
  const blob = await blobResponse.text();
  if (
    `sha256:${hash(blob)}` !== manifest.config.digest ||
    Buffer.byteLength(blob) !== manifest.config.size
  )
    throw new Error("Container image configuration digest is invalid");
  const config = parsePrivateJson(blob);
  if (
    config.os !== "linux" ||
    config.architecture !== "amd64" ||
    config.config?.Labels?.[REVISION_LABEL] !== sha ||
    config.config?.Labels?.[RECIPE_LABEL] !== recipe ||
    config.config?.Labels?.["org.opencontainers.image.source"] !== SOURCE
  )
    throw new Error("Container image source revision or platform does not match the release");
  return `${REGISTRY}/${accountId}/${imageName}@${digest}`;
}

function parsePrivateJson(value) {
  try {
    const parsed = JSON.parse(value);
    if (!object(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("Container response JSON is invalid");
  }
}

async function privateCommand(run, wrangler, args) {
  try {
    const value = JSON.parse(await run(wrangler, args, { cwd: tmpdir() }));
    if (!object(value)) throw new Error();
    return value;
  } catch {
    throw new Error("Container release credential is unavailable");
  }
}

async function safeFetch(fetch, url, options) {
  try {
    return await fetch(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Container provider request is unavailable");
  }
}
