FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/exporters/package.json packages/exporters/package.json
COPY packages/mihomo/package.json packages/mihomo/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG TARGETOS
ARG TARGETARCH
ARG MIHOMO_VERSION=1.19.24
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gzip \
  && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
  case "${TARGETOS:-linux}-${TARGETARCH:-amd64}" in \
    linux-amd64) mihomo_asset="mihomo-linux-amd64-compatible-v${MIHOMO_VERSION}.gz" ;; \
    linux-arm64) mihomo_asset="mihomo-linux-arm64-v${MIHOMO_VERSION}.gz" ;; \
    *) echo "Unsupported target: ${TARGETOS}-${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/MetaCubeX/mihomo/releases/download/v${MIHOMO_VERSION}/${mihomo_asset}" -o /tmp/mihomo.gz; \
  gzip -d /tmp/mihomo.gz; \
  install -m 0755 /tmp/mihomo /usr/local/bin/mihomo; \
  mihomo -v
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY scripts/container-entrypoint.sh /usr/local/bin/mihomo-hive-entrypoint
RUN chmod +x /usr/local/bin/mihomo-hive-entrypoint && mkdir -p /data /data/generated
ENTRYPOINT ["mihomo-hive-entrypoint"]
CMD ["node", "apps/server/dist/index.js"]
