# ohmyho.st plugin package

This local package combines the ohmyho.st Skills with its remote MCP connection. It contains no
API keys, device tokens, runtime credentials, hooks or local server dependency. The client
connects through managed OAuth. Current account membership, roles and any explicit token restrictions
determine which actions are available. Existing authenticated connections retain their OAuth
identity; cached tool definitions or Skills may need a refresh or new chat, not a new OAuth login.

The remote server advertises WorkOS Connect authorization metadata and standard OIDC scopes
(`openid`, `profile`, `email`, `offline_access`). The client completes OAuth through that
metadata. Workspace setup may be required when the account has no workspace. Secret input and
GitHub connection use their own protected handoffs. Each action still checks current rights.

Use the included get-started and deploy Skills to continue the same project across chats.
Keep the existing local CLI/device-login workflow for a local checkout, and the GitHub Skill
for a project that already uses GitHub or a customer who explicitly selects it.

## Prepare and check

From the platform repository, run:

```sh
node scripts/prepare-agent-plugin.mjs
node scripts/prepare-agent-plugin.mjs --check
```

The script copies the canonical customer Skills into this contained package. It refuses
symbolic links, unexpected package files, invalid manifest paths and any credential-bearing
MCP configuration. Rerun it after canonical Skills or generated surface references change.

The folder contains an OpenAI compatibility manifest at `.codex-plugin/plugin.json` and a Claude
manifest at `.claude-plugin/plugin.json`; both use the same `.mcp.json`. All referenced files
stay inside the package. A platform-specific upload archive includes only that platform's
manifest directory. An upload archive must contain the folder or these files without
symbolic links, other repositories, credential files or unrelated workspace contents.

## Native testing and publication

This repository package is prepared for testing, not evidence of a public directory listing or
a completed native-client acceptance run. First verify the deployed HTTPS server and OAuth
discovery, then install the package in the chosen client's private/local testing source. In
Claude, add/connect the bundled connector from the plugin's Connectors tab; installing the
Skills alone does not authenticate the user. In ChatGPT, test the custom remote MCP connection
and the complete installed package through the supported plugin testing flow.

Exercise a new app, a resumed app, a competing edit, a denied project and a private secret-input
handoff, including a used or expired link. Check a verified preview and an explicitly approved
publication of the exact commit.
Public review, reviewer access, listings and publication remain separate authorized steps;
never bundle reviewer credentials or fabricate a registered connector ID.

Official packaging references:

- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI connection testing](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI submission](https://developers.openai.com/plugins/deploy/submission)
- [Claude manifest reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude plugins and bundled connectors](https://claude.com/docs/plugins/overview)
