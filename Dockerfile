# Anytype MCP — Streamable HTTP server.
#
# Runs as a long-lived HTTP server on a local port, reachable by any MCP client
# via `mcp-remote http://localhost:PORT/mcp`. The server talks to the
# Anytype desktop app's local API on the host via host.docker.internal
# (configured in docker-compose.yml).
FROM node:24-alpine

WORKDIR /app

# Install dependencies first for better layer caching. tsx (a devDependency)
# runs the TypeScript entrypoint directly, so we install the full dependency set.
COPY package.json package-lock.json ./
RUN npm ci

# Application source (node_modules, .env, build artefacts excluded via .dockerignore).
COPY . .

ENV PORT=8769
EXPOSE 8769

CMD ["npx", "tsx", "src/http-server.ts"]
