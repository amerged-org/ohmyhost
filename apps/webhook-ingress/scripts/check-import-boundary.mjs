import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const allowedDirectDependencies = new Set([
  "@ohmyhost/database",
  "@ohmyhost/platform",
  "@ohmyhost/provider-github",
  "@ohmyhost/provider-stripe",
  "@ohmyhost/provider-resend",
  "@ohmyhost/workos-auth-contracts",
  "hono",
]);
const allowedSourceImports = new Set([
  "@ohmyhost/database",
  "@ohmyhost/platform",
  "@ohmyhost/provider-github/webhooks",
  "@ohmyhost/provider-stripe/webhooks",
  "@ohmyhost/provider-resend/webhooks",
  "@ohmyhost/workos-auth-contracts",
  "hono",
]);
const forbiddenPackages = new Set([
  "@ohmyhost/control-api",
  "@ohmyhost/product-cli",
  "@ohmyhost/workos-management",
  "@ohmyhost/workos-token-verifier",
]);
const forbiddenSourcePatterns = [
  [
    /\b(?:STRIPE_SECRET_KEY|createStripeBillingProvider)\b/u,
    "Stripe provider-management capability",
  ],
  [/\bprocess\.env\b/u, "environment access"],
  [/\b(?:WORKOS_API_KEY|WORKOS_MANAGEMENT_API_KEY|WORKOS_FGA)\b/u, "broad WorkOS capability"],
  [/@workos-inc\//u, "WorkOS provider SDK"],
  [/\bconsole\./u, "direct console logging"],
  [
    /provider-github\/(?:app-jwt|installation-token|archive)/u,
    "GitHub provider-management capability",
  ],
  [
    /\b(?:GITHUB_APP_PRIVATE_KEY|GITHUB_APP_CLIENT_ID|GITHUB_INSTALLATION_TOKEN)\b/u,
    "GitHub provider credential",
  ],
  [
    /\b(?:createGithubAppJwt|requestGithubInstallationToken|fetchExactGithubArchive)\b/u,
    "GitHub provider-management capability",
  ],
  [/\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|[a-z_]+\s+SET)\b/iu, "direct SQL"],
  [/\b(?:CONTROL_DATABASE_URL|HYPERDRIVE|withTransaction)\b/u, "direct database access"],
  [/apps\/(?:control-api|product-cli|workos-management)\//u, "forbidden app dependency"],
];

const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
const directDependencies = Object.keys(manifest.dependencies ?? {});
for (const dependency of directDependencies) {
  if (!allowedDirectDependencies.has(dependency)) {
    throw new Error(`Webhook ingress has an unapproved direct dependency: ${dependency}`);
  }
}

const githubProviderRoot = join(repositoryRoot, "packages/provider-github");
const githubProviderManifest = JSON.parse(
  await readFile(join(githubProviderRoot, "package.json"), "utf8"),
);
if (githubProviderManifest.exports?.["./webhooks"]?.source !== "./src/webhooks.ts") {
  throw new Error("GitHub provider does not expose the required dedicated webhook subpath");
}
const githubWebhookSurface = await readFile(join(githubProviderRoot, "src/webhooks.ts"), "utf8");
if (
  /from\s+["']\.\/(?:app-jwt|installation-token|archive)(?:\.js)?["']/u.test(
    githubWebhookSurface,
  ) ||
  /\b(?:createGithubAppJwt|requestGithubInstallationToken|fetchExactGithubArchive)\b/u.test(
    githubWebhookSurface,
  )
) {
  throw new Error("GitHub webhook subpath includes provider-management capability");
}

const sourceFiles = await filesBelow(join(appRoot, "src"), new Set([".ts"]));
const builtFiles = await filesBelow(join(appRoot, "dist"), new Set([".js", ".map"]));
if (builtFiles.length === 0) throw new Error("Webhook ingress build artifacts are missing");

for (const path of [...sourceFiles, ...builtFiles]) {
  const content = await readFile(path, "utf8");
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(content)) {
      throw new Error(`${label} found in ${relative(repositoryRoot, path)}`);
    }
  }
  for (const specifier of importSpecifiers(content)) {
    if (specifier.startsWith(".") || allowedSourceImports.has(specifier)) continue;
    throw new Error(
      `Unapproved built/source import ${specifier} in ${relative(repositoryRoot, path)}`,
    );
  }
}

const workspacePackages = await loadWorkspacePackages();
const closure = new Set();
const pending = [...directDependencies];
while (pending.length > 0) {
  const dependency = pending.pop();
  if (dependency === undefined || closure.has(dependency)) continue;
  closure.add(dependency);
  if (forbiddenPackages.has(dependency)) {
    throw new Error(`Forbidden package in webhook ingress transitive graph: ${dependency}`);
  }
  const workspaceManifest = workspacePackages.get(dependency);
  if (workspaceManifest !== undefined) {
    pending.push(...Object.keys(workspaceManifest.dependencies ?? {}));
  }
}

stdout.write(
  `${JSON.stringify({
    result: "PASS",
    source_files: sourceFiles.length,
    built_files: builtFiles.length,
    transitive_dependencies: [...closure].sort(),
  })}\n`,
);

async function filesBelow(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path, extensions)));
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(path);
  }
  return files.sort();
}

function importSpecifiers(content) {
  const matches = content.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/gu);
  return [...matches].map((match) => match[2]).filter((value) => value !== undefined);
}

async function loadWorkspacePackages() {
  const packages = new Map();
  for (const parent of ["apps", "packages"]) {
    const entries = await readdir(join(repositoryRoot, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(repositoryRoot, parent, entry.name, "package.json");
      try {
        const candidate = JSON.parse(await readFile(path, "utf8"));
        if (typeof candidate.name === "string") packages.set(candidate.name, candidate);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  return packages;
}
