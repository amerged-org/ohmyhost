# The build sandbox of the build runner: one instance builds one customer commit and is destroyed.
# The image carries no credential; the build runner passes BUILD_AGENT_TOKEN when it starts a sandbox.
# Node 24.15.0 is the runtime the retired CodeBuild project pinned; the pinned Corepack needs it.
FROM --platform=linux/amd64 node:24.15.0-bookworm-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde

# procps provides pkill and pgrep, util-linux provides setpriv.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

# Platform tools live under their own prefix; build-runtime.mjs calls them by absolute path.
# Bun alone runs its install script, which places the platform binary. OpenNext 1.20.9 bundles
# @opennextjs/aws 4.1.8, which writes the route-scoped cache keys of Next 15.5.27 and 16.3.8.
RUN npm install --global --prefix /opt/ohmyhost-platform --ignore-scripts --no-audit --no-fund \
    corepack@0.35.0 wrangler@4.125.0 @opennextjs/cloudflare@1.20.9 \
  && npm install --global --prefix /opt/ohmyhost-platform --no-audit --no-fund bun@1.2.22 \
  && npm cache clean --force
# Reviewed OpenNext fixes for Next.js 16.4 and its resume header; other OpenNext bytes stop the build.
COPY --chmod=0644 apps/build-runner/sandbox/open-next-patch.mjs /opt/ohmyho/open-next-patch.mjs
RUN node /opt/ohmyho/open-next-patch.mjs /opt/ohmyhost-platform/lib/node_modules/@opennextjs/cloudflare

RUN useradd --create-home --uid 10001 --shell /bin/bash ohmyho-build

# The three parsers build-runtime.mjs imports, at the versions the repository tests it with.
WORKDIR /opt/ohmyho
RUN npm install --prefix /opt/ohmyho --ignore-scripts --no-audit --no-fund acorn@8.18.0 es-module-lexer@1.7.0 @babel/parser@7.29.8 \
  && npm cache clean --force
# Exactly the static import closure of agent.mjs. The build UID must be able to read it.
COPY --chmod=0644 apps/build-runner/sandbox/build-runtime.mjs apps/build-runner/sandbox/agent.mjs apps/build-runner/sandbox/next-writable-cache.mjs /opt/ohmyho/
COPY --chmod=0644 packages/contracts/src/framework-build-script.mjs /packages/contracts/src/framework-build-script.mjs
COPY --chmod=0644 packages/contracts/src/browser-capabilities.ts /packages/contracts/src/browser-capabilities.ts
COPY --chmod=0644 packages/contracts/src/customer-auth-admission.ts /packages/contracts/src/customer-auth-admission.ts
COPY --chmod=0644 packages/contracts/src/egress-origin.ts /packages/contracts/src/egress-origin.ts
RUN chmod 0755 /opt/ohmyho /packages /packages/contracts /packages/contracts/src

EXPOSE 8080
CMD ["node", "/opt/ohmyho/agent.mjs"]
