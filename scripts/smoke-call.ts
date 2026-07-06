/**
 * Calls a single tool end-to-end through the running HTTP server.
 * Usage: TOOL=API-list-spaces ARGS='{}' MCP_URL=http://127.0.0.1:8769/mcp npx tsx scripts/smoke-call.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL || "http://127.0.0.1:8769/mcp");
const client = new Client({ name: "smoke-call", version: "0.0.0" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(url));

const name = process.env.TOOL || "API-list-spaces";
const args = JSON.parse(process.env.ARGS || "{}");
const res = await client.callTool({ name, arguments: args });
console.log(JSON.stringify(res, null, 2).slice(0, 1000));

await client.close();
