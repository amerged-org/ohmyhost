# ohmyho.st

ohmyho.st provides application hosting, PostgreSQL, storage and transactional
mail. This repository contains the hosting platform, its API and clients. The
PostgreSQL infrastructure is developed in [PGCF](https://github.com/amerged-org/cloudflare-postgres).

- [API contract](packages/contracts/openapi.yaml) and [TypeScript SDK](packages/sdk-ts)
- [CLI](apps/product-cli), [MCP server](apps/mcp) and [agent skills](skills)
- [Customer runtime](packages/customer-runtime) and [application fixtures](fixtures)
- [Product documentation](https://docs.ohmyho.st) for released features

## Development

Use the Node.js version in `.node-version` and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm contracts:check
pnpm sdk-ts:check
```

Worker bindings and provider resources in the source are templates for your own
installation. Store deployment configuration and credentials in your own
provider secret store. Consult the product documentation for hosted behavior.

## Licensing

The platform is source available under [Elastic License 2.0](LICENSE).
[The license manifest](licenses/manifest.json) identifies Apache-2.0 client and
runtime source. [NOTICES](NOTICE) and dependency-specific notices record
attribution. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
