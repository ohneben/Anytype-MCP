# ohneben Anytype MCP

[![CI](https://github.com/ohneben/Anytype-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/ohneben/Anytype-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE.md)

Talk to your [Anytype](https://anytype.io) knowledge base in plain language from
AI assistants like **Claude**, **Cursor**, and any other
[MCP](https://modelcontextprotocol.io) client.

This is a self-hosted fork of the official
[`anyproto/anytype-mcp`](https://github.com/anyproto/anytype-mcp) that adds a
**Docker container** and a **Streamable-HTTP** transport, so the server can run
quietly in the background and be reached by any MCP client over HTTP. (The
original speaks stdio only.)

## Why this one?

The [official Anytype MCP server](https://github.com/anyproto/anytype-mcp) is
great, but it runs as a `stdio` subprocess that each client has to launch on
demand. This project keeps **100% of its capabilities** and adds a
**production-style deployment**: one always-on server, in Docker, that any
number of MCP clients can reach over HTTP.

| Capability | **This project** | Official `anyproto/anytype-mcp` | Other community servers\* |
| --- | :---: | :---: | :---: |
| Full Anytype API coverage (dynamic OpenAPI → MCP tools) | ✅ | ✅ | ✅ |
| `stdio` transport | ✅ | ✅ | ✅ |
| **Streamable-HTTP transport** (via `mcp-remote`) | ✅ | ❌ | ❌ |
| **Always-on background service** | ✅ | ❌ | ❌ |
| **One server → many clients at once** | ✅ | ❌ | ❌ |
| **Docker + docker-compose** | ✅ | ❌ | ❌ |
| **Health-check endpoint + auto-restart** | ✅ | ❌ | ❌ |
| **Optional bearer-token auth** on the endpoint | ✅ | ❌ | ❌ |
| 🟢 / 🟡 / 🔴 read-only / write / destructive tool hints | ✅ | ➖ | ➖ |
| Automated test suite (Vitest) | ✅ | ✅ | ➖ |
| License | MIT | MIT | varies |

<sub>\*Community servers such as [`Qwinty/anytype-mcp`](https://github.com/Qwinty/anytype-mcp) (JS), [`wethegreenpeople/anytype-mcp`](https://github.com/wethegreenpeople/anytype-mcp) (Python) and [`anytype-mcp-plus`](https://github.com/MAB2908/anytype-mcp-plus) — most are `stdio`-only and launched via `npx`. "➖" = not documented / varies. Snapshot from July 2026; check each project for its latest.</sub>

**In short:** if you just want to try Anytype from your AI client, the official
server is perfect. If you want it **running in the background, always ready, and
shared across every MCP client on your machine**, use this one.

## What you can do

Once it's connected, ask your assistant things like:

- "Search my Anytype for notes about the Q3 launch."
- "Create a task 'Write the report', due in 3 days."
- "Make a new space called 'Travel' and add a packing checklist."

Tools are generated automatically from your running Anytype app and grouped into
🟢 read-only, 🟡 write, and 🔴 delete.

The server is tuned to keep your assistant fast and frugal with tool calls:

- **`API-get-overview`** — a synthesized tool that returns all spaces with their
  types (or, given a `space_id`, that space's types and property definitions) in
  a single call, instead of a list-spaces → list-types → list-properties cascade.
- **Slim responses** — API payloads are compacted before they reach the
  assistant: empty property values, `object` discriminators, and nulls are
  dropped, and the type embedded in each search/list result is reduced to its
  identifiers. This typically shrinks list/search responses by well over half,
  which means less context burned per call and fewer follow-up calls. Set
  `ANYTYPE_MCP_SLIM_RESPONSES=false` to get raw API payloads instead.
- **Routing hints** — tool descriptions tell the assistant which tool is
  cheapest for a job (e.g. search instead of paginating lists, and that only
  `get-object` returns the full markdown body).

## How it works

```
Claude / Cursor / …  ──MCP──►  this server  ──HTTP──►  Anytype desktop app (local API)
```

The server only talks to the **local API** of the Anytype **desktop app** on
your own machine. Your data stays on your computer.

## Requirements

- The **Anytype desktop app**, installed and running (it serves a local API at
  `127.0.0.1:31009`).
- **Docker** (Docker Desktop on macOS/Windows) for the setup below.

## Quick start (Docker)

**1. Add your API key.** Copy the example config and paste in a key:

```bash
cp .env.example .env
# open .env and set ANYTYPE_API_KEY=...   (see "Get an API key" below)
```

**2. Start the server:**

```bash
docker compose up -d --build
```

**3. Confirm it's running:**

```bash
curl -s http://localhost:8769/healthz     # → {"status":"ok"}
```

**4. Connect your MCP client.** Add this under `mcpServers` in your client
config (e.g. Claude Desktop or Claude Code), then fully quit and reopen the app:

```json
"anytype": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://localhost:8769/mcp", "--allow-http"]
}
```

That's it — ask your assistant to search or create something in Anytype.

## Get an API key

In the Anytype desktop app: **Settings → API Keys → Create new**. Copy the key
into `.env` as `ANYTYPE_API_KEY=`. Your key stays in `.env`, which git ignores,
so it is never committed.

## Configuration

Everything is set in `.env` (copied from `.env.example`):

| Variable | Default | What it does |
| --- | --- | --- |
| `ANYTYPE_API_KEY` | — | Your Anytype API key. **Required.** |
| `ANYTYPE_VERSION` | `2025-11-08` | Anytype API version header. |
| `ANYTYPE_API_BASE_URL` | `http://host.docker.internal:31009` | Where the Anytype app's API is reachable from the container. |
| `PORT` | `8769` | Host port for the MCP endpoint. |
| `MCP_SHARED_TOKEN` | *(empty)* | Optional bearer token to protect the endpoint. Empty = open, for localhost only. |
| `ANYTYPE_MCP_SLIM_RESPONSES` | `true` | Compact API responses before sending them to the assistant. Set to `false` for raw payloads. |

After changing `.env`, reload with `docker compose up -d --force-recreate`.

For logs, restart, key rotation, and verification commands, see
**[DOCKER.md](./DOCKER.md)**.

## Run from source (stdio, no Docker)

Prefer the classic stdio mode? Build it locally:

```bash
npm install
npm run build
```

Then register it with your client using a stdio command and your key in
`OPENAPI_MCP_HEADERS` — see the
[upstream README](https://github.com/anyproto/anytype-mcp#readme) for the exact
stdio configuration.

## Security

- Your API key lives only in `.env`, which is git-ignored. **Never commit real keys.**
- The HTTP endpoint is unauthenticated by default (fine on localhost). To expose
  it beyond your machine, set `MCP_SHARED_TOKEN` and send it as a `Bearer` header
  or `?token=…`.

## Credits & license

Built on the official
[Anytype MCP server](https://github.com/anyproto/anytype-mcp) by Any Association.
Licensed under the [MIT License](./LICENSE.md).
