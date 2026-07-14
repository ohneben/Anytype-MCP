import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { Headers } from "node-fetch";
import { OpenAPIV3 } from "openapi-types";
import { HttpClient, HttpClientError } from "../client/http-client";
import { OpenAPIToMCPConverter, OperationWithMeta } from "../openapi/parser";
import { determineBaseUrl } from "../utils/base-url";
import { isSlimEnabled, slimResponse } from "./slim";

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
  "Tools are named `API-<operation>` (e.g. API-list-spaces, API-create-object, API-delete-tag). Most operations are scoped to a space and take its space_id.",
  "",
  "Work efficiently — minimize tool calls:",
  "1. Start with API-get-overview: ONE call returns every space with its types (and, given a space_id, that space's types incl. property keys and all property definitions). Do not call API-list-spaces + API-list-types + API-list-properties separately for orientation.",
  "2. To find content, prefer search (API-search-space, or API-search-global when the space is unknown) with a query over paginating API-list-objects.",
  "3. Search/list results contain metadata and a snippet only; call API-get-object just for the objects whose full markdown body you actually need.",
  "4. List endpoints accept limit up to 1000 — raise limit instead of paginating with many small calls.",
].join("\n");

/**
 * Extra routing hints appended to generated tool descriptions. The base
 * descriptions come from the OpenAPI spec served by the Anytype app; these
 * hints steer the MCP client toward the cheapest tool for the job so it
 * spends fewer calls on orientation and pagination.
 */
const TOOL_HINTS: Record<string, string> = {
  "API-list-spaces": "For orientation prefer API-get-overview, which also returns each space's types in the same call.",
  "API-list-types": "For orientation prefer API-get-overview (one call for types + properties).",
  "API-list-properties": "For orientation prefer API-get-overview (one call for types + properties).",
  "API-search-global":
    "Searches across all spaces — fastest way to locate objects when the space is unknown. Returns metadata + snippet only; use API-get-object for full content.",
  "API-search-space":
    "Preferred over paginating API-list-objects when looking for specific objects. Returns metadata + snippet only; use API-get-object for full content.",
  "API-list-objects":
    "Returns metadata + snippet only, no body. For targeted lookups prefer API-search-space. limit can be up to 1000.",
  "API-get-object": "The only read that returns the full markdown body of an object.",
  "API-create-object": "type_key comes from API-get-overview or API-list-types; set properties in the same call instead of updating afterwards.",
  "API-update-object": "Property values are set by property key; tag values by tag id (see API-list-tags).",
};

const OVERVIEW_TOOL_NAME = "API-get-overview";

const OVERVIEW_TOOL_DESCRIPTION =
  "🟢 READ-ONLY. One-call workspace orientation — call this FIRST instead of separate list-spaces/list-types/list-properties calls. " +
  "Without arguments: returns all spaces, each with its object types (key, name, layout). " +
  "With space_id: returns that space's types (including each type's property keys) and all property definitions. " +
  "Combined server-side from the spaces, types, and properties endpoints.";

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

      // Synthesized orientation tool: collapses the usual list-spaces /
      // list-types / list-properties discovery round-trips into one call.
      if (this.supportsOverview()) {
        tools.push({
          name: OVERVIEW_TOOL_NAME,
          description: OVERVIEW_TOOL_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              space_id: {
                type: "string",
                description:
                  "Optional. When set, returns detailed schema (types with property keys + all property definitions) for this space only. When omitted, returns all spaces with their types.",
              },
            },
            required: [],
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
        });
      }

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

      if (name === OVERVIEW_TOOL_NAME && this.supportsOverview()) {
        return this.handleOverview(params as { space_id?: string } | undefined);
      }

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name);
      if (!operation) {
        throw new Error(`Method ${name} not found`);
      }

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, params);
        const payload = isSlimEnabled() ? slimResponse(response.data) : response.data;

        // Convert response to MCP format
        return {
          content: [
            {
              type: "text", // currently this is the only type that seems to be used by mcp server
              text: JSON.stringify(payload), // TODO: pass through the http status code text?
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

  /** The overview tool is only offered when the spec provides its building blocks. */
  private supportsOverview(): boolean {
    return (
      !this.openApiLookup[OVERVIEW_TOOL_NAME] &&
      !!this.openApiLookup["API-list-spaces"] &&
      !!this.openApiLookup["API-list-types"]
    );
  }

  private async callOperation(toolName: string, params: Record<string, unknown>): Promise<any> {
    const operation = this.findOperation(toolName);
    if (!operation) {
      throw new Error(`Method ${toolName} not found`);
    }
    const response = await this.httpClient.executeOperation(operation, params);
    return response.data;
  }

  /**
   * Aggregate the discovery endpoints into a single compact answer, so the MCP
   * client gets oriented ("which spaces exist, what lives in them") with one
   * tool call instead of a list-spaces/list-types/list-properties cascade.
   */
  private async handleOverview(params?: { space_id?: string }) {
    const spaceId = params?.space_id;
    try {
      const result = spaceId ? await this.buildSpaceOverview(spaceId) : await this.buildGlobalOverview();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slimResponse(result)) }],
      };
    } catch (error) {
      console.error("Error building overview", error);
      if (error instanceof HttpClientError) {
        const data = error.data?.response?.data ?? error.data ?? {};
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", ...(typeof data === "object" ? data : { data }) }),
            },
          ],
        };
      }
      throw error;
    }
  }

  /** Compact a Type for overview output; propertyKeys only in per-space detail. */
  private compactType(type: any, includePropertyKeys: boolean) {
    const compact: Record<string, unknown> = {
      key: type?.key,
      name: type?.name,
      layout: type?.layout,
    };
    if (includePropertyKeys && Array.isArray(type?.properties)) {
      compact.property_keys = type.properties.map((p: any) => p?.key).filter(Boolean);
    }
    return compact;
  }

  private async buildSpaceOverview(spaceId: string) {
    const listParams = { space_id: spaceId, limit: 1000 };
    const [typesData, propertiesData] = await Promise.all([
      this.callOperation("API-list-types", listParams),
      this.openApiLookup["API-list-properties"]
        ? this.callOperation("API-list-properties", listParams)
        : Promise.resolve(undefined),
    ]);

    return {
      space_id: spaceId,
      types: (typesData?.data ?? []).map((t: any) => this.compactType(t, true)),
      properties: (propertiesData?.data ?? []).map((p: any) => ({
        id: p?.id,
        key: p?.key,
        name: p?.name,
        format: p?.format,
      })),
      hint: "Use API-search-space to find objects here; API-get-object for full content. Property values are set by key.",
    };
  }

  /** Cap the per-space type fan-out so an account with many spaces stays fast. */
  private static readonly OVERVIEW_MAX_SPACES_WITH_TYPES = 10;

  private async buildGlobalOverview() {
    const spacesData = await this.callOperation("API-list-spaces", { limit: 200 });
    const spaces: any[] = spacesData?.data ?? [];
    const detailed = spaces.slice(0, MCPProxy.OVERVIEW_MAX_SPACES_WITH_TYPES);

    const typesBySpace = await Promise.all(
      detailed.map(async (space: any) => {
        try {
          const typesData = await this.callOperation("API-list-types", { space_id: space?.id, limit: 200 });
          return (typesData?.data ?? []).map((t: any) => this.compactType(t, false));
        } catch (error) {
          console.error(`Failed to list types for space ${space?.id}`, error);
          return undefined;
        }
      }),
    );

    return {
      spaces: spaces.map((space: any, i: number) => ({
        id: space?.id,
        name: space?.name,
        description: space?.description,
        ...(i < detailed.length && typesBySpace[i] ? { types: typesBySpace[i] } : {}),
      })),
      ...(spaces.length > detailed.length
        ? { note: `Types included for the first ${detailed.length} spaces only; call this tool with a space_id for details.` }
        : {}),
      hint: "Call this tool again with a space_id to get that space's types (with property keys) and property definitions.",
    };
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

  /** Prepend a 🟢/🟡/🔴 category banner and append a routing hint, if any. */
  private decorateDescription(toolName: string, description: string): string {
    const banner =
      this.classify(toolName) === "read"
        ? "🟢 READ-ONLY."
        : this.classify(toolName) === "destructive"
          ? "🔴 DESTRUCTIVE."
          : "🟡 WRITE.";
    const base = (description || "").trim();
    const hint = TOOL_HINTS[toolName];
    return [banner, base, hint].filter(Boolean).join(" ").trim();
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
