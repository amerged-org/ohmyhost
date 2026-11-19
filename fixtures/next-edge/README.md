# Next.js edge fixture

This fixture proves the closed Next.js 16 production path used by ohmyhost:

1. `@opennextjs/cloudflare` transforms the Next.js build into `.open-next/worker.js` and root-origin assets.
2. Wrangler performs a credential-free dry-run bundle into `.ohmyhost-worker/worker.js`.
3. The trusted build broker packages only that bundled Worker and `.open-next/assets`; it never forwards project Wrangler metadata.
4. WFP recreates only the fixed `ASSETS` and `IMAGES` bindings plus approved runtime secrets.

Run the local production-runtime check at the project root origin:

```sh
pnpm install --frozen-lockfile --ignore-workspace
pnpm build:cloudflare
WRANGLER_SEND_METRICS=false \
  pnpm wrangler deploy --dry-run --outdir .ohmyhost-worker --config wrangler.jsonc
WRANGLER_SEND_METRICS=false \
  pnpm wrangler dev --local --port 8792 --config wrangler.jsonc
```

Two requests to `/` must contain different request nonces. The root API route and `fixture.txt` must return `200`.

This fixture does not prove a namespaced WFP deployment. That remains a separate sandbox acceptance test because WFP recreates provider bindings and wraps the bundled entry point.
