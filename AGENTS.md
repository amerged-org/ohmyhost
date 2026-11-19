# Working on ohmyho.st

Start with [development](docs/development.md) and the current
[platform architecture](docs/architecture/index.md).

Keep installation-specific configuration, credentials, customer data and
operational evidence outside this checkout. Use synthetic fixtures for tests
and examples.

Keep the API contract, generated SDK, MCP tool metadata, and affected Skills
in sync. Update the architecture decision and source coverage when relevant.
Use `pnpm verify:fast` for local checks and complete CI for the exact release
revision. Report suspected vulnerabilities through [SECURITY.md](SECURITY.md).
