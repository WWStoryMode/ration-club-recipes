# syntax=docker/dockerfile:1
#
# Ration Club Recipes: one image serving the web page and the API.
# Run exactly ONE container, with a persistent volume at /data (the docs.plus login, audit log, approval queue and
# photo-link record live there). See "Hosting with Docker" in the README.

# ---------------------------------------------------------------------------
# Build: install everything, build the web page and compile the server.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
# Install scripts stay on here: esbuild (allowed in pnpm-workspace.yaml) needs its binary for vite. The root
# "prepare" (husky) finds no .git in the image and does nothing.
RUN pnpm install --frozen-lockfile

COPY server server
COPY web web
RUN pnpm --filter web run build && pnpm --filter server run build

# ---------------------------------------------------------------------------
# Runtime: production dependencies, the compiled server and the built page. Runs as the unprivileged "node" user.
# ---------------------------------------------------------------------------
FROM node:24-slim
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HOST=0.0.0.0 \
    PORT=3000 \
    SECRETS_DIR=/data/secrets \
    DATA_DIR=/data/app
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod --filter server --ignore-scripts \
 && rm -rf /root/.cache /root/.local/share/pnpm

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

# Liveness only: /health never calls docs.plus, so a dead login can't cause restart loops.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node directly (not pnpm), so SIGTERM reaches the server and it releases its one-instance lock.
CMD ["node", "server/dist/index.js"]
