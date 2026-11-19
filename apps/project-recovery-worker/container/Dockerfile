# Trusted SQL export runtime. Both official amd64 images are pinned by manifest digest.
# No provider credential, customer archive or connection URI enters the build context.
FROM --platform=linux/amd64 node:24.15.0-bookworm-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde AS node-runtime

FROM --platform=linux/amd64 postgres:18.6-bookworm@sha256:9e73daeb439141c2b11eea2463f5f1a3b269fd90d897b41cddb7cb440f21aa5d
# pg_dump verifies the customer database with PGSSLROOTCERT=system, which needs the system CA
# bundle; the base image ships none (Dev export 01M3A034WEA2HF7MFNNWFXV9XN failed on it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/ohmyho
COPY --chmod=0644 dist/container/agent.cjs /opt/ohmyho/agent.cjs
USER postgres
EXPOSE 8080
ENTRYPOINT ["node", "/opt/ohmyho/agent.cjs"]
