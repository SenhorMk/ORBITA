# Workers da mensageria (MSG-020A): uma imagem, um processo por container.
# O tipo vem no comando: `inbox` ou `envio`. Kill switches desligados por padrão.
# Multi-arquitetura (amd64 e arm64), para a VM Ampere da Oracle Always Free.

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npx tsc -p scripts/tsconfig.worker.json --outDir dist-worker --incremental false

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist-worker ./dist-worker
USER node
ENTRYPOINT ["node", "dist-worker/scripts/worker-supervisionado.js"]
