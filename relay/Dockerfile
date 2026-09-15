# syntax=docker/dockerfile:1.7
# Build from the repository root: fly deploy (see fly.toml) or
#   docker build -f relay/Dockerfile .

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY companion/src/hub.mjs companion/src/hub.mjs
COPY plugins/figma-bridge/mcp/tools.mjs plugins/figma-bridge/mcp/tools.mjs
COPY relay/src relay/src
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=8080
EXPOSE 8080

CMD ["node", "--disable-warning=ExperimentalWarning", "relay/src/main.mjs"]
