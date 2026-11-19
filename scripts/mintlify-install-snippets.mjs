/**
 * The non-global SDK install snippet of the Mintlify docs. It names the npm package, never a website archive: a project
 * lockfile would keep that URL, and the superseded release directory it names is deleted by the next client release.
 */
export function installSdkSnippet(version) {
  return `\n\`\`\`sh\nnpm install @amerged/ohmyhost-sdk@${version}\n\`\`\`\n`;
}
