FROM --platform=linux/amd64 node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS helper
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY container/write-file.c /tmp/write-file.c
RUN cc -O2 -Wall -Wextra -Werror -o /tmp/spike-write /tmp/write-file.c

FROM --platform=linux/amd64 node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates procps && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash preview \
    && npm install --global --ignore-scripts --no-audit --no-fund corepack@0.35.0 npm@11.5.1 \
    && COREPACK_HOME=/opt/corepack corepack install --global pnpm@10.28.2
# Only manifests and public lock graphs affect the dependency seed. Fixture source,
# metadata and container helper changes do not invalidate this large layer.
COPY seed-fixtures/ /opt/fixtures/
RUN set -eu; mkdir -p /opt/pnpm-store /opt/npm-cache /workspace; \
    for fixture in react-vite vanilla-vite tanstack-start next-edge next-native-auth next-app-mail; do \
      cd /opt/fixtures/$fixture; COREPACK_HOME=/opt/corepack corepack pnpm@10.28.2 fetch --frozen-lockfile --ignore-scripts --store-dir=/opt/pnpm-store; rm -rf node_modules; \
    done; \
    cd /opt/fixtures/astro-edge; npm ci --ignore-scripts --no-audit --no-fund --cache=/opt/npm-cache; rm -rf node_modules; \
    chown -R 10001:10001 /opt/pnpm-store /opt/npm-cache /home/preview /opt/corepack

COPY --from=docker.io/cloudflare/sandbox:1.0.1@sha256:e796e813de8213fb062bba279ddeddbf61277389a2cc7b3e4620075a9188843b /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=helper /tmp/spike-write /usr/local/bin/spike-write
COPY tooling/ /opt/preview-tooling/
RUN cd /opt/preview-tooling && npm ci --ignore-scripts --no-audit --no-fund --cache=/tmp/preview-tooling-npm-cache \
    && rm -rf /tmp/preview-tooling-npm-cache
COPY fixtures/cloudflare-preview/ /opt/fixtures/
COPY container/ /opt/preview-spike/
COPY fixture-provenance.json /opt/preview-spike/fixture-provenance.json
CMD ["sleep", "infinity"]
