/**
 * Smoke test for the Streamable-HTTP server: connects with the real MCP client,
 * lists tools, and prints the 🟢/🟡/🔴 banner distribution. No Anytype API key
 * required — listing only reads the public OpenAPI spec.
 *
 * Usage: MCP_URL=http://127.0.0.1:8769/mcp npx tsx scripts/smoke-http.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL || "http://127.0.0.1:8769/mcp");
const transport = new StreamableHTTPClientTransport(url);
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });

await client.connect(transport);

const { tools } = await client.listTools();
console.log("tool count:", tools.length);

const banners: Record<string, number> = {};
for (const t of tools) {
  const b = (t.description || "").slice(0, 2);
  banners[b] = (banners[b] || 0) + 1;
}
console.log("banner distribution:", banners);

const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
const write = tools.filter((t) => t.annotations && t.annotations.readOnlyHint === false && !t.annotations.destructiveHint);
const missing = tools.filter((t) => !t.annotations || t.annotations.readOnlyHint === undefined);
console.log("\nannotation buckets (drive the Claude UI grouping):");
console.log(`  Read-only tools:   ${readOnly.length}`);
console.log(`  Write tools:       ${write.length}`);
console.log(`  Destructive tools: ${destructive.length}`);
console.log(`  MISSING annotation:${missing.length}`);

console.log("\nsample (name -> annotations):");
for (const t of tools.slice(0, 6)) {
  console.log(`  ${t.name} -> ${JSON.stringify(t.annotations)}`);
}

await client.close();
