/**
 * Streamable-HTTP entry point for the Anytype MCP server.
 *
 * The upstream project speaks MCP over stdio (see src/init-server.ts). This
 * module instead serves the same MCPProxy over the MCP "Streamable HTTP"
 * transport on a local port, so it can run as a long-lived Docker container and
 * be reached by any MCP client via `mcp-remote http://localhost:PORT/mcp`
 * — no stdio wrapper needed.
 *
 * Endpoints:
 *   POST/GET/DELETE /mcp   MCP Streamable HTTP (stateful, per-session)
 *   GET             /healthz   liveness probe (always 200 while the process is up)
 *
 * Auth: if MCP_SHARED_TOKEN is set, every /mcp request must present it as
 * `Authorization: Bearer <token>` or `?token=<token>`. Empty token => open
 * (intended for localhost-only Docker use).
 *
 * The Anytype API base URL and credentials come from the environment and are
 * consumed by MCPProxy (ANYTYPE_API_BASE_URL, OPENAPI_MCP_HEADERS). For
 * convenience OPENAPI_MCP_HEADERS is synthesised from ANYTYPE_API_KEY /
 * ANYTYPE_VERSION when it is not provided explicitly.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { OpenAPIV3 } from "openapi-types";
import { MCPProxy } from "./mcp/proxy";
import { getDefaultSpecUrl } from "./utils/base-url";

const PORT = parseInt(process.env.PORT || "8769", 10);
const SHARED_TOKEN = process.env.MCP_SHARED_TOKEN || "";

// Build OPENAPI_MCP_HEADERS from the friendlier ANYTYPE_API_KEY / ANYTYPE_VERSION
// env vars when the caller has not supplied the raw JSON header blob itself.
if (!process.env.OPENAPI_MCP_HEADERS && process.env.ANYTYPE_API_KEY) {
  process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
    Authorization: `Bearer ${process.env.ANYTYPE_API_KEY}`,
    "Anytype-Version": process.env.ANYTYPE_VERSION || "2025-11-08",
  });
}

// ---------------------------------------------------------------------------
// OpenAPI spec is fetched lazily on the first session so the container comes up
// (and /healthz stays green) even when the Anytype desktop app is momentarily
// unavailable. A failed fetch clears the cache so the next request retries.
// ---------------------------------------------------------------------------
let specPromise: Promise<OpenAPIV3.Document> | null = null;

async function fetchSpec(): Promise<OpenAPIV3.Document> {
  const url = getDefaultSpecUrl();
  const res = await axios.get(url, { timeout: 10_000 });
  return (typeof res.data === "string" ? JSON.parse(res.data) : res.data) as OpenAPIV3.Document;
}

function getSpec(): Promise<OpenAPIV3.Document> {
  if (!specPromise) {
    specPromise = fetchSpec().catch((err) => {
      specPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return specPromise;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "3600");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function jsonRpcError(res: ServerResponse, status: number, message: string, id: unknown = null): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: id ?? null });
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authOk(req: IncomingMessage, url: URL): boolean {
  if (!SHARED_TOKEN) return true;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    if (tokensMatch(auth.slice(7).trim(), SHARED_TOKEN)) return true;
  }
  const q = url.searchParams.get("token");
  if (q && tokensMatch(q, SHARED_TOKEN)) return true;
  return false;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Session registry — one MCPProxy + transport per MCP session id.
// ---------------------------------------------------------------------------
const transports: Record<string, StreamableHTTPServerTransport> = {};

async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    jsonRpcError(res, 400, "Invalid JSON body");
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  let transport: StreamableHTTPServerTransport;
  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(body)) {
    let spec: OpenAPIV3.Document;
    try {
      spec = await getSpec();
    } catch (err) {
      jsonRpcError(
        res,
        503,
        `Cannot reach the Anytype API (${getDefaultSpecUrl()}). Is the Anytype desktop app running? ${
          err instanceof Error ? err.message : String(err)
        }`,
        (body as { id?: unknown })?.id,
      );
      return;
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const proxy = new MCPProxy("Anytype API", spec);
    await proxy.connect(transport);
  } else {
    jsonRpcError(res, 400, "No valid session id, and not an initialize request", (body as { id?: unknown })?.id);
    return;
  }

  await transport.handleRequest(req, res, body);
}

async function handleMcpSessionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers["mcp-session-id"];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
  if (!sid || !transports[sid]) {
    jsonRpcError(res, 400, "Missing or unknown session id");
    return;
  }
  await transports[sid].handleRequest(req, res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (url.pathname !== "/mcp") {
    jsonRpcError(res, 404, "Not found");
    return;
  }

  if (!authOk(req, url)) {
    jsonRpcError(res, 401, "Missing or invalid Bearer token (header or ?token=)");
    return;
  }

  try {
    if (req.method === "POST") {
      await handleMcpPost(req, res);
    } else if (req.method === "GET" || req.method === "DELETE") {
      await handleMcpSessionRequest(req, res);
    } else {
      jsonRpcError(res, 405, "Method not allowed");
    }
  } catch (err) {
    console.error("Unhandled error handling /mcp request:", err);
    if (!res.headersSent) {
      jsonRpcError(res, 500, err instanceof Error ? err.message : "Internal error");
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`Anytype MCP (Streamable HTTP) listening on http://0.0.0.0:${PORT}/mcp`);
  console.error(`Health check at http://0.0.0.0:${PORT}/healthz`);
  if (!SHARED_TOKEN) {
    console.error("MCP_SHARED_TOKEN is empty; /mcp is UNAUTHENTICATED (fine for localhost-only use).");
  }
});
