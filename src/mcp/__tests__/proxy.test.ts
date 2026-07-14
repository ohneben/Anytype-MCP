import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Headers } from "node-fetch";
import { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../client/http-client";
import { MCPProxy } from "../proxy";

// Mock the dependencies
vi.mock("../../client/http-client");
vi.mock("@modelcontextprotocol/sdk/server/index.js");

describe("MCPProxy", () => {
  let proxy: MCPProxy;
  let mockOpenApiSpec: OpenAPIV3.Document;

  const getHandlers = (proxy: MCPProxy) => {
    const server = (proxy as any).server;
    return server.setRequestHandler.mock.calls
      .flatMap((x: unknown[]) => x)
      .filter((x: unknown) => typeof x === "function");
  };

  const createMockOpenApiSpec = (overrides?: Partial<OpenAPIV3.Document>): OpenAPIV3.Document => ({
    openapi: "3.0.0",
    servers: [{ url: "http://localhost:3000" }],
    info: { title: "Test API", version: "1.0.0" },
    paths: {
      "/test": {
        get: {
          operationId: "getTest",
          responses: { "200": { description: "Success" } },
        },
      },
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenApiSpec = createMockOpenApiSpec();
    proxy = new MCPProxy("test-proxy", mockOpenApiSpec);
  });

  describe("listTools handler", () => {
    it("should return converted tools from OpenAPI spec", async () => {
      const [listToolsHandler] = getHandlers(proxy);
      const result = await listToolsHandler();

      expect(result).toHaveProperty("tools");
      expect(Array.isArray(result.tools)).toBe(true);
    });

    it("should truncate tool names exceeding 64 characters", async () => {
      const specWithLongName = createMockOpenApiSpec({
        paths: {
          "/test": {
            get: {
              operationId: "a".repeat(65),
              responses: { "200": { description: "Success" } },
            },
          },
        },
      });
      const testProxy = new MCPProxy("test-proxy", specWithLongName);
      const [listToolsHandler] = getHandlers(testProxy);
      const result = await listToolsHandler();

      expect(result.tools[0].name.length).toBeLessThanOrEqual(64);
    });
  });

  describe("callTool handler", () => {
    const mockSuccessResponse = {
      data: { message: "success" },
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    };

    it("should execute operation and return formatted response", async () => {
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccessResponse);

      (proxy as any).openApiLookup = {
        "API-getTest": {
          operationId: "getTest",
          responses: { "200": { description: "Success" } },
          method: "get",
          path: "/test",
        },
      };

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: "API-getTest", arguments: {} } });

      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ message: "success" }) }],
      });
    });

    it("should throw error for non-existent operation", async () => {
      const [, callToolHandler] = getHandlers(proxy);

      await expect(callToolHandler({ params: { name: "nonExistentMethod", arguments: {} } })).rejects.toThrow(
        "Method nonExistentMethod not found",
      );
    });

    it("should handle tool names exceeding 64 characters", async () => {
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccessResponse);

      const longToolName = "a".repeat(65);
      const truncatedToolName = longToolName.slice(0, 64);
      (proxy as any).openApiLookup = {
        [truncatedToolName]: {
          operationId: longToolName,
          responses: { "200": { description: "Success" } },
          method: "get",
          path: "/test",
        },
      };

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: truncatedToolName, arguments: {} } });

      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ message: "success" }) }],
      });
    });
  });

  describe("response slimming", () => {
    const verboseObjectList = {
      data: [
        {
          object: "object",
          id: "obj-1",
          name: "Doc",
          icon: null,
          archived: false,
          type: {
            object: "type",
            id: "type-1",
            key: "page",
            name: "Page",
            properties: [{ object: "property", id: "p-1", key: "tag", name: "Tag", format: "multi_select" }],
          },
          properties: [
            { object: "property", id: "p-2", key: "description", name: "Description", format: "text", text: "hi" },
            { object: "property", id: "p-3", key: "due", name: "Due", format: "date", date: null },
          ],
        },
      ],
    };

    const setupLookup = () => {
      (proxy as any).openApiLookup = {
        "API-getTest": {
          operationId: "getTest",
          responses: { "200": { description: "Success" } },
          method: "get",
          path: "/test",
        },
      };
    };

    it("slims verbose payloads by default", async () => {
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: verboseObjectList,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
      });
      setupLookup();

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: "API-getTest", arguments: {} } });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.data[0].type).toEqual({ id: "type-1", key: "page", name: "Page" });
      expect(payload.data[0].properties).toEqual([
        { key: "description", name: "Description", format: "text", text: "hi" },
      ]);
      expect(payload.data[0].icon).toBeUndefined();
      expect(payload.data[0].object).toBeUndefined();
    });

    it("returns raw payloads when slimming is disabled", async () => {
      process.env.ANYTYPE_MCP_SLIM_RESPONSES = "false";
      try {
        (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
          data: verboseObjectList,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
        });
        setupLookup();

        const [, callToolHandler] = getHandlers(proxy);
        const result = await callToolHandler({ params: { name: "API-getTest", arguments: {} } });
        expect(JSON.parse(result.content[0].text)).toEqual(verboseObjectList);
      } finally {
        delete process.env.ANYTYPE_MCP_SLIM_RESPONSES;
      }
    });
  });

  describe("overview tool", () => {
    const anytypeLikeLookup = () => ({
      "API-list-spaces": {
        operationId: "list_spaces",
        responses: { "200": { description: "Success" } },
        method: "get",
        path: "/v1/spaces",
      },
      "API-list-types": {
        operationId: "list_types",
        responses: { "200": { description: "Success" } },
        method: "get",
        path: "/v1/spaces/{space_id}/types",
      },
      "API-list-properties": {
        operationId: "list_properties",
        responses: { "200": { description: "Success" } },
        method: "get",
        path: "/v1/spaces/{space_id}/properties",
      },
    });

    it("is listed when the spec has spaces and types endpoints", async () => {
      (proxy as any).openApiLookup = anytypeLikeLookup();
      (proxy as any).tools = { API: { methods: [] } };

      const [listToolsHandler] = getHandlers(proxy);
      const result = await listToolsHandler();
      const overview = result.tools.find((t: any) => t.name === "API-get-overview");

      expect(overview).toBeDefined();
      expect(overview.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    });

    it("is not listed for specs without those endpoints", async () => {
      const [listToolsHandler] = getHandlers(proxy);
      const result = await listToolsHandler();
      expect(result.tools.find((t: any) => t.name === "API-get-overview")).toBeUndefined();
    });

    it("aggregates spaces with their types in one call", async () => {
      (proxy as any).openApiLookup = anytypeLikeLookup();
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(
        async (operation: any) => {
          if (operation.operationId === "list_spaces") {
            return {
              data: { data: [{ id: "space-1", name: "Wiki", object: "space" }] },
              status: 200,
              headers: new Headers(),
            };
          }
          return {
            data: { data: [{ id: "type-1", key: "page", name: "Page", layout: "basic", properties: [] }] },
            status: 200,
            headers: new Headers(),
          };
        },
      );

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: "API-get-overview", arguments: {} } });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.spaces).toEqual([
        { id: "space-1", name: "Wiki", types: [{ key: "page", name: "Page", layout: "basic" }] },
      ]);
    });

    it("returns space detail with property keys when given a space_id", async () => {
      (proxy as any).openApiLookup = anytypeLikeLookup();
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(
        async (operation: any, params: any) => {
          expect(params.space_id).toBe("space-1");
          if (operation.operationId === "list_types") {
            return {
              data: {
                data: [
                  {
                    id: "type-1",
                    key: "task",
                    name: "Task",
                    layout: "action",
                    properties: [{ id: "p-1", key: "done", name: "Done", format: "checkbox" }],
                  },
                ],
              },
              status: 200,
              headers: new Headers(),
            };
          }
          return {
            data: { data: [{ id: "p-1", key: "done", name: "Done", format: "checkbox" }] },
            status: 200,
            headers: new Headers(),
          };
        },
      );

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({
        params: { name: "API-get-overview", arguments: { space_id: "space-1" } },
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.space_id).toBe("space-1");
      expect(payload.types[0]).toEqual({ key: "task", name: "Task", layout: "action", property_keys: ["done"] });
      expect(payload.properties).toEqual([{ id: "p-1", key: "done", name: "Done", format: "checkbox" }]);
    });

    it("still returns spaces when a per-space types call fails", async () => {
      (proxy as any).openApiLookup = anytypeLikeLookup();
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(
        async (operation: any) => {
          if (operation.operationId === "list_spaces") {
            return {
              data: { data: [{ id: "space-1", name: "Wiki" }] },
              status: 200,
              headers: new Headers(),
            };
          }
          throw new Error("types unavailable");
        },
      );

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: "API-get-overview", arguments: {} } });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.spaces).toEqual([{ id: "space-1", name: "Wiki" }]);
    });
  });

  describe("getContentType", () => {
    it("should return correct content type for different headers", () => {
      const getContentType = (proxy as any).getContentType.bind(proxy);

      expect(getContentType(new Headers({ "content-type": "text/plain" }))).toBe("text");
      expect(getContentType(new Headers({ "content-type": "application/json" }))).toBe("text");
      expect(getContentType(new Headers({ "content-type": "image/jpeg" }))).toBe("image");
      expect(getContentType(new Headers({ "content-type": "application/octet-stream" }))).toBe("binary");
      expect(getContentType(new Headers())).toBe("binary");
    });
  });

  describe("parseHeadersFromEnv", () => {
    const originalEnv = process.env;
    const expectHeaders = (headers: Record<string, string>) => {
      expect(HttpClient).toHaveBeenCalledWith(expect.objectContaining({ headers }), expect.anything());
    };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should parse valid JSON headers from env", () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
        Authorization: "Bearer token123",
        "X-Custom-Header": "test",
      });
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({ Authorization: "Bearer token123", "X-Custom-Header": "test" });
    });

    it("should return empty object when env var is not set", () => {
      delete process.env.OPENAPI_MCP_HEADERS;
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({});
    });

    it("should return empty object and warn on invalid JSON", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.OPENAPI_MCP_HEADERS = "invalid json";
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({});
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to parse OPENAPI_MCP_HEADERS environment variable:",
        expect.any(Error),
      );
    });

    it("should return empty object and warn on non-object JSON", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.OPENAPI_MCP_HEADERS = '"string"';
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({});
      expect(consoleSpy).toHaveBeenCalledWith(
        "OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:",
        "string",
      );
    });
  });

  describe("base URL integration", () => {
    const originalEnv = process.env;
    const expectBaseUrl = (url: string) => {
      expect(HttpClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: url }), expect.anything());
    };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should use ANYTYPE_API_BASE_URL when set", () => {
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012";
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectBaseUrl("http://localhost:31012");
    });

    it("should use spec servers when env var not set", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectBaseUrl("http://localhost:3000");
    });

    it("should use default when neither env var nor spec servers available", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      new MCPProxy("test-proxy", createMockOpenApiSpec({ servers: undefined }));
      expectBaseUrl("http://127.0.0.1:31009");
    });
  });

  describe("connect", () => {
    it("should connect to transport", async () => {
      const mockTransport = {} as Transport;
      await proxy.connect(mockTransport);

      const server = (proxy as any).server;
      expect(server.connect).toHaveBeenCalledWith(mockTransport);
    });
  });
});
