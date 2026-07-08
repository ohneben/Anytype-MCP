import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { Headers } from "node-fetch";
import { OpenAPIV3 } from "openapi-types";
import { HttpClient, HttpClientError } from "../client/http-client";
import { OpenAPIToMCPConverter, OperationWithMeta } from "../openapi/parser";
import { determineBaseUrl } from "../utils/base-url";

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject;
  put?: OpenAPIV3.OperationObject;
  post?: OpenAPIV3.OperationObject;
  delete?: OpenAPIV3.OperationObject;
  patch?: OpenAPIV3.OperationObject;
};

type NewToolDefinition = {
  methods: Array<{
    name: string;
    description: string;
    inputSchema: IJsonSchema & { type: "object" };
    outputSchema?: IJsonSchema;
  }>;
};

const ANYTYPE_INSTRUCTIONS = [
  "Interact with the user's Anytype knowledge base — spaces, objects, lists, properties, tags, types, templates, members, and search.",
  "",
  "Every tool description starts with a category banner:",
  "  🟢 READ-ONLY — safe, only fetches data.",
  "  🟡 WRITE — creates or updates spaces, objects, properties, tags, types, or list entries.",
  "  🔴 DESTRUCTIVE — deletes or permanently removes data.",
  "Confirm 🟡 WRITE and 🔴 DESTRUCTIVE actions with the user before calling them.",
  "",
  "Tools are named `API-<operation>` (e.g. API-list-spaces, API-create-object, API-delete-tag). Most operations are scoped to a space: resolve a space with API-list-spaces or API-search-global first, then pass its space_id to the object, list, property, tag, type, and template tools.",
].join("\n");

export class MCPProxy {
  private server: Server;
  private httpClient: HttpClient;
  private tools: Record<string, NewToolDefinition>;
  private openApiLookup: Record<string, OperationWithMeta>;

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server(
      { name, version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: ANYTYPE_INSTRUCTIONS },
    );
    const baseUrl = determineBaseUrl(openApiSpec);
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: this.parseHeadersFromEnv(),
      },
      openApiSpec,
    );

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec);
    const { tools, openApiLookup } = converter.convertToMCPTools();
    this.tools = tools;
    this.openApiLookup = openApiLookup;

    this.setupHandlers();
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [];

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach((method) => {
          const toolNameWithMethod = `${toolName}-${method.name}`;
          const truncatedToolName = this.truncateToolName(toolNameWithMethod);
          tools.push({
            name: truncatedToolName,
            description: this.decorateDescription(toolNameWithMethod, method.description),
            inputSchema: method.inputSchema as Tool["inputSchema"],
            annotations: this.toolAnnotations(toolNameWithMethod),
          });
        });
      });

      return { tools };
    });

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error("calling tool", request.params);
      const { name, arguments: params } = request.params;

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name);
      if (!operation) {
        throw new Error(`Method ${name} not found`);
      }

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, params);

        // Convert response to MCP format
        return {
          content: [
            {
              type: "text", // currently this is the only type that seems to be used by mcp server
              text: JSON.stringify(response.data), // TODO: pass through the http status code text?
            },
          ],
        };
      } catch (error) {
        console.error("Error in tool call", error);
        if (error instanceof HttpClientError) {
          console.error("HttpClientError encountered, returning structured error", error);
          const data = error.data?.response?.data ?? error.data ?? {};
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "error", // TODO: get this from http status code?
                  ...(typeof data === "object" ? data : { data: data }),
                }),
              },
            ],
          };
        }
        throw error;
      }
    });
  }

  private findOperation(operationId: string): OperationWithMeta | null {
    return this.openApiLookup[operationId] ?? null;
  }

  private parseHeadersFromEnv(): Record<string, string> {
    const headersJson = process.env.OPENAPI_MCP_HEADERS;
    if (!headersJson) {
      return {};
    }

    try {
      const headers = JSON.parse(headersJson);
      if (typeof headers !== "object" || headers === null) {
        console.warn("OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:", typeof headers);
        return {};
      }
      return headers;
    } catch (error) {
      console.warn("Failed to parse OPENAPI_MCP_HEADERS environment variable:", error);
      return {};
    }
  }

  private getContentType(headers: Headers): "text" | "image" | "binary" {
    const contentType = headers.get("content-type");
    if (!contentType) return "binary";

    if (contentType.includes("text") || contentType.includes("json")) {
      return "text";
    } else if (contentType.includes("image")) {
      return "image";
    }
    return "binary";
  }

  /** Classify an operation as read-only / write / destructive. Drives BOTH the
   *  description banner and the MCP tool annotations below, so they never drift. */
  private classify(toolName: string): "read" | "write" | "destructive" {
    const op = this.openApiLookup[toolName];
    const method = (op?.method || "").toLowerCase();
    // Search uses POST (the query travels in the request body) but is read-only.
    if (/^search([-_]|$)/i.test(op?.operationId || "")) return "read";
    if (method === "get") return "read";
    if (method === "delete") return "destructive";
    return "write"; // post / put / patch (and any unknown => treat as write)
  }

  /** MCP tool annotations. `readOnlyHint`/`destructiveHint` are what the Claude
   *  client uses to group tools into "Read-only tools" and "Write/delete tools";
   *  without them everything lands under a single "Other tools" bucket. */
  private toolAnnotations(toolName: string): { readOnlyHint: boolean; destructiveHint: boolean } {
    const category = this.classify(toolName);
    return { readOnlyHint: category === "read", destructiveHint: category === "destructive" };
  }

  /** Prepend a 🟢/🟡/🔴 category banner to a tool description. */
  private decorateDescription(toolName: string, description: string): string {
    const banner =
      this.classify(toolName) === "read"
        ? "🟢 READ-ONLY."
        : this.classify(toolName) === "destructive"
          ? "🔴 DESTRUCTIVE."
          : "🟡 WRITE.";
    const base = (description || "").trim();
    return `${banner} ${base}`.trim();
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport);
  }
}
