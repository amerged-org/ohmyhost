FROM --platform=linux/amd64 node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS source-helper
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY apps/preview-runtime/container/source-write.c /tmp/
RUN cc -static -O2 -Wall -Wextra -Werror -o /tmp/preview-source /tmp/source-write.c

# Public fixture dependency graphs only. This stage never receives customer source or credentials.
FROM --platform=linux/amd64 node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS framework-seed
RUN useradd --create-home --uid 10001 --shell /bin/bash ohmyho-preview \
  && npm install --global --prefix /opt/ohmyhost-platform --ignore-scripts --no-audit --no-fund corepack@0.35.0 \
  && mkdir -p /home/ohmyho-preview/.local/share/pnpm/store /home/ohmyho-preview/.npm /tmp/framework-seed \
  && chown -R 10001:10001 /home/ohmyho-preview /tmp/framework-seed
COPY --chown=10001:10001 apps/preview-runtime/container/framework-dependency-seed/react-vite/package.json apps/preview-runtime/container/framework-dependency-seed/react-vite/pnpm-lock.yaml /tmp/framework-seed/react-vite/
COPY --chown=10001:10001 apps/preview-runtime/container/framework-dependency-seed/vanilla-vite/package.json apps/preview-runtime/container/framework-dependency-seed/vanilla-vite/pnpm-lock.yaml /tmp/framework-seed/vanilla-vite/
COPY --chown=10001:10001 apps/preview-runtime/container/framework-dependency-seed/tanstack-start/package.json apps/preview-runtime/container/framework-dependency-seed/tanstack-start/pnpm-lock.yaml /tmp/framework-seed/tanstack-start/
COPY --chown=10001:10001 apps/preview-runtime/container/framework-dependency-seed/next-edge/package.json apps/preview-runtime/container/framework-dependency-seed/next-edge/pnpm-lock.yaml /tmp/framework-seed/next-edge/
COPY --chown=10001:10001 apps/preview-runtime/container/framework-dependency-seed/next-native-auth/package.json apps/preview-runtime/container/framework-dependency-seed/next-native-auth/pnpm-lock.yaml /tmp/framework-seed/next-native-auth/
COPY --chown=10001:10001 apps/preview-runtime/container/framework-dependency-seed/next-app-mail/package.json apps/preview-runtime/container/framework-dependency-seed/next-app-mail/pnpm-lock.yaml /tmp/framework-seed/next-app-mail/
COPY --chown=10001:10001 apps/preview-runtime/container/framework-dependency-seed/astro-edge/package.json apps/preview-runtime/container/framework-dependency-seed/astro-edge/package-lock.json /tmp/framework-seed/astro-edge/
USER 10001:10001
ENV HOME=/home/ohmyho-preview COREPACK_HOME=/home/ohmyho-preview/.cache/node/corepack
WORKDIR /tmp/framework-seed
RUN set -eu; for fixture in next-native-auth next-app-mail; do \
      cmp /tmp/framework-seed/next-edge/pnpm-lock.yaml /tmp/framework-seed/$fixture/pnpm-lock.yaml; \
      node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));const b=JSON.parse(fs.readFileSync(process.argv[2]));for(const k of ["packageManager","dependencies","devDependencies","optionalDependencies","pnpm"])if(JSON.stringify(a[k])!==JSON.stringify(b[k]))process.exit(1)' /tmp/framework-seed/next-edge/package.json /tmp/framework-seed/$fixture/package.json; \
    done; \
    for fixture in react-vite vanilla-vite tanstack-start next-edge; do \
      cd /tmp/framework-seed/$fixture; /opt/ohmyhost-platform/bin/corepack pnpm@10.28.2 fetch --frozen-lockfile --ignore-scripts --store-dir /home/ohmyho-preview/.local/share/pnpm/store; rm -rf /tmp/framework-seed/$fixture/node_modules; \
    done; \
    cd /tmp/framework-seed/astro-edge; \
    npm exec --yes --ignore-scripts --package=npm@11.5.1 -- npm ci --ignore-scripts --no-audit --no-fund --cache /home/ohmyho-preview/.npm; \
    rm -rf /home/ohmyho-preview/.npm/_logs /home/ohmyho-preview/.npm/_npx

FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:1.0.1@sha256:e796e813de8213fb062bba279ddeddbf61277389a2cc7b3e4620075a9188843b AS sandbox-shim

FROM --platform=linux/amd64 node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git procps util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /bin/bash ohmyho-preview

RUN npm install --global --prefix /opt/ohmyhost-platform --ignore-scripts --no-audit --no-fund corepack@0.35.0 wrangler@4.158.0 \
  && npm install --global --prefix /opt/ohmyhost-platform --no-audit --no-fund bun@1.2.22 \
  && npm cache clean --force

# These exact managers serve the managed seed and qualification fixtures. Each VM receives its own
# writable copy from the immutable image; no tenant modules or application variables are cached here.
# The npm exec runs below execute as root, so the cache is handed to the runtime user in the same layer.
RUN COREPACK_HOME=/home/ohmyho-preview/.cache/node/corepack /opt/ohmyhost-platform/bin/corepack install --global pnpm@10.28.2 \
  && npm exec --cache=/home/ohmyho-preview/.npm --yes --ignore-scripts --package=npm@11.5.1 -- npm --version \
  && npm exec --cache=/home/ohmyho-preview/.npm --yes --ignore-scripts --package=npm@11.6.0 -- npm --version \
  && chown -R 10001:10001 /home/ohmyho-preview/.npm /home/ohmyho-preview/.cache

WORKDIR /opt/ohmyho
RUN npm install --prefix /opt/ohmyho --ignore-scripts --no-audit --no-fund acorn@8.18.0 es-module-lexer@1.7.0 @babel/parser@7.29.8 \
  && npm cache clean --force

# The intake reuses the production archive, frozen package-manager and security-floor checks.
COPY --chmod=0644 apps/build-runner/sandbox/build-runtime.mjs apps/build-runner/sandbox/build-runtime.mjs
COPY --chmod=0644 packages/contracts/src/framework-build-script.mjs packages/contracts/src/framework-build-script.mjs
COPY --chmod=0644 packages/contracts/src/browser-capabilities.ts packages/contracts/src/browser-capabilities.ts
COPY --chmod=0644 packages/contracts/src/customer-auth-admission.ts packages/contracts/src/customer-auth-admission.ts
COPY --chmod=0644 packages/contracts/src/egress-origin.ts packages/contracts/src/egress-origin.ts
COPY --chmod=0644 packages/customer-runtime/src/preview-transport.ts packages/customer-runtime/src/preview-transport.ts
COPY --chmod=0644 apps/preview-runtime/container/drivers.mjs apps/preview-runtime/container/protocol.mjs apps/preview-runtime/container/bindings-worker.mjs apps/preview-runtime/container/native-loader.mjs apps/preview-runtime/container/prepare.mjs apps/preview-runtime/container/serve.mjs apps/preview-runtime/container/
RUN chmod 0755 /opt/ohmyho/apps /opt/ohmyho/apps/build-runner /opt/ohmyho/apps/build-runner/sandbox \
    /opt/ohmyho/apps/preview-runtime /opt/ohmyho/apps/preview-runtime/container \
    /opt/ohmyho/packages /opt/ohmyho/packages/contracts /opt/ohmyho/packages/contracts/src \
    /opt/ohmyho/packages/customer-runtime /opt/ohmyho/packages/customer-runtime/src

COPY --from=framework-seed --chown=10001:10001 /home/ohmyho-preview/.local/share/pnpm/store /opt/preview-seed/pnpm-store
COPY --from=framework-seed --chown=10001:10001 /home/ohmyho-preview/.npm /opt/preview-seed/npm-cache
RUN mkdir -p /home/ohmyho-preview/.cache/node/corepack /home/ohmyho-preview/.npm /home/ohmyho-preview/.local/share \
  && chown -R 10001:10001 /home/ohmyho-preview/.cache/node/corepack \
  && chown 10001:10001 /home/ohmyho-preview/.npm /home/ohmyho-preview/.local/share \
  && rm -rf /home/ohmyho-preview/.npm/_logs

COPY --from=source-helper /tmp/preview-source /usr/local/bin/
COPY --from=sandbox-shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
EXPOSE 3001 3002 3003
CMD ["sleep", "infinity"]
