# Anytype MCP — self-hosted (Docker + Streamable HTTP)

This wraps the upstream [`anyproto/anytype-mcp`](https://github.com/anyproto/anytype-mcp)
(which speaks MCP over stdio) in a long-lived **Streamable-HTTP** server, so it
runs as a Docker container and is reachable by any MCP client via `mcp-remote`.

- **Endpoint:** `http://localhost:8769/mcp`  ·  **Health:** `http://localhost:8769/healthz`
- **Talks to:** the Anytype **desktop app's** local API at `127.0.0.1:31009` on the
  host, reached from the container via `host.docker.internal:31009`.
- **Tools:** generated dynamically from the *running* Anytype's OpenAPI spec, each
  tagged 🟢 READ-ONLY / 🟡 WRITE / 🔴 DESTRUCTIVE and annotated with
  `readOnlyHint`/`destructiveHint` so Claude groups them into Read-only vs
  Write/delete buckets (derived from the HTTP method).

## Prerequisites
- **Docker Desktop** (macOS/Windows) installed and running.
- The **Anytype desktop app** installed and running (it serves the local API on
  `127.0.0.1:31009`).

## First-time setup (new machine)
1. `cp .env.example .env`
2. Get an API key and put it in `.env` as `ANYTYPE_API_KEY=` — see
   "Get / rotate the key" below (nothing else in `.env` needs changing).
3. `docker compose up -d --build`
4. Register with Claude (see below), then fully quit & reopen Claude.
5. Check it: `curl -s http://localhost:8769/healthz` → `{"status":"ok"}`.

> The default port is **8769**; change `PORT` in `.env` (and the URL you register
> with Claude) if that port is already taken on your machine.

## Operate
```bash
docker compose up -d --build     # build + start (or apply changes)
docker compose logs -f           # tail logs
docker compose restart           # restart
docker compose down              # stop & remove
```
Config lives in `.env` (copy from `.env.example`). After editing `.env`, run
`docker compose up -d --force-recreate` to reload it.

## Get / rotate the key
The key is created by pairing with the running desktop app (or via
**Anytype → Settings → API Keys → Create new**). Pairing from the terminal:
```bash
# 1) start a pairing challenge — a 4-digit code appears in Anytype desktop
curl -s -X POST http://127.0.0.1:31009/v1/auth/challenges \
  -H 'Content-Type: application/json' -d '{"app_name":"anytype-mcp-docker"}'
#    -> {"challenge_id":"..."}

# 2) exchange challenge_id + the 4-digit code for a key
curl -s -X POST http://127.0.0.1:31009/v1/auth/api_keys \
  -H 'Content-Type: application/json' \
  -d '{"challenge_id":"<ID>","code":"<CODE>"}'
#    -> {"api_key":"..."}
```
Put the `api_key` in `.env` as `ANYTYPE_API_KEY=`, then
`docker compose up -d --force-recreate`. Delete any old keys in
**Anytype → Settings → API Keys**.

## Register with Claude
Add an `anytype` entry under `mcpServers`, then fully quit & reopen Claude to
load it. The config path is `~/.claude.json` for Claude Code and
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) for
Claude Desktop — but the two clients want different transports.

**Claude Code** speaks Streamable-HTTP natively, so point it straight at the
endpoint (no bridge process):
```json
"anytype": {
  "type": "http",
  "url": "http://localhost:8769/mcp"
}
```

**Claude Desktop** only supports stdio servers in its JSON config, so it needs
the `mcp-remote` bridge. Install it once and launch it with `node`:
```bash
npm i -g mcp-remote
```
```json
"anytype": {
  "command": "/opt/homebrew/bin/node",
  "args": [
    "/opt/homebrew/lib/node_modules/mcp-remote/dist/proxy.js",
    "http://localhost:8769/mcp",
    "--allow-http"
  ]
}
```

> **Don't launch the bridge with `npx -y mcp-remote …`.** `npx` re-resolves the
> package through the npm cache on every start; when a client boots several MCP
> servers at once they contend on that cache and some can hang *inside npx* for
> minutes, surfacing as a ~4-minute connection timeout with a perfectly healthy
> server. Pre-installing `mcp-remote` and invoking `node` directly avoids it.
> Use **absolute** paths: GUI apps don't inherit your shell `PATH`, and calling the
> bare `mcp-remote` binary fails because its `#!/usr/bin/env node` shebang can't find
> `node`. The paths shown are Apple-Silicon Homebrew defaults — check yours with
> `which node` and `npm root -g` (Intel Homebrew uses `/usr/local/...`).

To expose the endpoint beyond localhost, set `MCP_SHARED_TOKEN` in `.env` and
append `?token=<token>` to the URL (or send it as a Bearer header).

## Verify
```bash
curl -s http://localhost:8769/healthz                       # {"status":"ok"}
MCP_URL=http://127.0.0.1:8769/mcp npx tsx scripts/smoke-http.ts   # lists tools + banners
TOOL=API-list-spaces MCP_URL=http://127.0.0.1:8769/mcp npx tsx scripts/smoke-call.ts
```
