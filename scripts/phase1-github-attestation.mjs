/* global process */

import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "./phase1-evidence-core.mjs";

export const GH_ATTESTATION_VERIFIER_VERSION = "2.97.0";
export const GH_ATTESTATION_VERIFIER_ARCHIVE_SHA256 =
  "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112";
export const GH_ATTESTATION_VERIFIER_SHA256 =
  "141507c337e8b202ad398550c3b73d72f5af92e86f71665214538a81efd4c409";
export const GH_ATTESTATION_VERIFIER_RELATIVE_PATH = ".tools/gh_2.97.0_linux_amd64/bin/gh";

const validateGitHubContext = ({ repository, signerWorkflow, sourceDigest, sourceRef }) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("INVALID_ATTESTATION_REPOSITORY");
  }
  if (
    ![
      `${repository}/.github/workflows/phase1-native-keyring.yml`,
      `${repository}/.github/workflows/phase1-workos-capabilities.yml`,
    ].includes(signerWorkflow)
  ) {
    throw new Error("INVALID_ATTESTATION_WORKFLOW");
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceDigest) || sourceRef !== "refs/heads/main") {
    throw new Error("INVALID_ATTESTATION_SOURCE");
  }
  if (
    process.env["GITHUB_ACTIONS"] !== "true" ||
    process.env["RUNNER_ENVIRONMENT"] !== "github-hosted" ||
    process.env["GITHUB_REPOSITORY"] !== repository ||
    process.env["GITHUB_SHA"] !== sourceDigest ||
    process.env["GITHUB_REF"] !== sourceRef
  ) {
    throw new Error("INVALID_GITHUB_ATTESTATION_CONTEXT");
  }
};

const resolvePinnedVerifier = async (root) => {
  const verifierPath = join(root, GH_ATTESTATION_VERIFIER_RELATIVE_PATH);
  let metadata;
  let content;
  try {
    metadata = await lstat(verifierPath);
    content = await readFile(verifierPath);
  } catch {
    throw new Error("ATTESTATION_VERIFIER_INVALID");
  }
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0 ||
    sha256(content) !== GH_ATTESTATION_VERIFIER_SHA256
  ) {
    throw new Error("ATTESTATION_VERIFIER_INVALID");
  }
  return verifierPath;
};

export const verifyGitHubAttestation = async ({
  root,
  subjectPath,
  repository,
  signerWorkflow,
  sourceDigest,
  sourceRef,
}) => {
  validateGitHubContext({ repository, signerWorkflow, sourceDigest, sourceRef });
  const verifierPath = await resolvePinnedVerifier(root);
  const result = spawnSync(
    verifierPath,
    [
      "attestation",
      "verify",
      subjectPath,
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-ref",
      sourceRef,
      "--source-digest",
      sourceDigest,
      "--deny-self-hosted-runners",
    ],
    {
      env: Object.fromEntries(
        ["HOME", "GH_TOKEN", "GITHUB_TOKEN"]
          .map((name) => [name, process.env[name]])
          .filter((entry) => entry[1] !== undefined),
      ),
      stdio: "ignore",
      timeout: 30_000,
    },
  );
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new Error("GITHUB_ATTESTATION_INVALID");
  }
};
