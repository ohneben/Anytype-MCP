/**
 * Guards the invariant that every tool `input_schema.properties` key emitted by
 * the OpenAPI -> MCP converter satisfies the Anthropic Messages API key pattern
 * (`^[a-zA-Z0-9_.-]{1,64}$`). A single illegal key 400s the entire Claude
 * session, and the live server fetches its spec at runtime from the user's
 * Anytype app — so an unknown future spec could ship an illegal parameter name.
 *
 * These tests prove two things:
 *  1. The currently bundled spec produces ZERO renames (behaviour unchanged).
 *  2. A deliberately illegal synthetic spec is sanitized AND reverse-mapped, so
 *     the wire payload still carries the raw OpenAPI names.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAPIV3 } from "openapi-types";
import { describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../client/http-client";
import { OpenAPIToMCPConverter, sanitizePropertyKey, TOOL_ARG_KEY } from "../parser";

// Anthropic requires property keys to match this; MCP tool names are stricter
// (no dots) — the converter emits `API-<operationId>` so this always holds.
const PROPERTY_KEY = TOOL_ARG_KEY;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// Mock the OpenAPI client so executeOperation's wire call can be inspected
// without a real HTTP request. Keyed by operationId used in the synthetic spec.
const mockOperationFn = vi.fn();
vi.mock("openapi-client-axios", () => {
  const MockOpenAPIClientAxios = vi.fn(function (this: any) {
    this.init = vi.fn().mockResolvedValue({ createThing: mockOperationFn });
    return this;
  });
  return { default: MockOpenAPIClientAxios };
});

const specPath = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/openapi.json");
const bundledSpec = JSON.parse(readFileSync(specPath, "utf-8")) as OpenAPIV3.Document;

describe("bundled Anytype spec property keys", () => {
  const { tools, openApiLookup } = new OpenAPIToMCPConverter(bundledSpec).convertToMCPTools();

  it("every tool has at least one method (sanity)", () => {
    expect(tools.API!.methods.length).toBeGreaterThan(0);
  });

  it("every inputSchema.properties key is a legal Anthropic tool-argument key", () => {
    for (const method of tools.API!.methods) {
      for (const key of Object.keys(method.inputSchema.properties ?? {})) {
        expect(key, `property "${key}" of ${method.name}`).toMatch(PROPERTY_KEY);
      }
    }
  });

  it("every emitted tool name is a legal MCP tool name", () => {
    for (const method of tools.API!.methods) {
      expect(`API-${method.name}`, `tool name for ${method.name}`).toMatch(TOOL_NAME);
    }
  });

  it("produces ZERO renames, so request behaviour is byte-identical today", () => {
    for (const method of tools.API!.methods) {
      expect(method.argNameMap, `argNameMap for ${method.name}`).toBeUndefined();
    }
    for (const [name, op] of Object.entries(openApiLookup)) {
      expect(op.argNameMap, `argNameMap for ${name}`).toBeUndefined();
    }
  });
});

describe("sanitizePropertyKey", () => {
  it("returns legal names unchanged", () => {
    for (const legal of ["space_id", "object.id", "limit", "a-b", "A_B.c-d"]) {
      expect(sanitizePropertyKey(legal)).toBe(legal);
    }
  });

  it("coerces illegal names to a legal key", () => {
    expect(sanitizePropertyKey("filter[status]")).toBe("filter_status");
    expect(sanitizePropertyKey("bad$name")).toBe("bad_name");
    expect(sanitizePropertyKey("a b c")).toBe("a_b_c");
    // leading/trailing separators trimmed, all-illegal falls back to "arg"
    expect(sanitizePropertyKey("$$$")).toBe("arg");
    // cap at 64 characters
    expect(sanitizePropertyKey("x".repeat(100)).length).toBe(64);
  });

  it("dedupes collisions with a numeric suffix, never exceeding 64 chars", () => {
    const used = new Set<string>(["filter_status"]);
    const key = sanitizePropertyKey("filter[status]", used);
    expect(key).toBe("filter_status_1");
    expect(key).toMatch(PROPERTY_KEY);
  });
});

// A tiny spec with a deliberately illegal query param name and body property.
const syntheticSpec: OpenAPIV3.Document = {
  openapi: "3.0.0",
  info: { title: "Bad Spec", version: "1.0.0" },
  paths: {
    "/things": {
      post: {
        operationId: "createThing",
        summary: "Create a thing",
        parameters: [{ name: "filter[status]", in: "query", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["bad$name"],
                properties: {
                  "bad$name": { type: "string", description: "an illegally named field" },
                  ok_name: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

describe("synthetic illegal spec", () => {
  const { tools, openApiLookup } = new OpenAPIToMCPConverter(syntheticSpec).convertToMCPTools();
  const method = tools.API!.methods[0]!;
  const operation = openApiLookup["API-createThing"]!;

  it("emits only legal property keys", () => {
    const keys = Object.keys(method.inputSchema.properties ?? {});
    for (const key of keys) {
      expect(key, `property "${key}"`).toMatch(PROPERTY_KEY);
    }
    expect(keys.sort()).toEqual(["bad_name", "filter_status", "ok_name"]);
    // required also uses the sanitized keys
    expect((method.inputSchema.required ?? []).sort()).toEqual(["bad_name", "filter_status"]);
  });

  it("records argNameMap mapping sanitized keys back to raw OpenAPI names", () => {
    expect(method.argNameMap).toEqual({
      filter_status: "filter[status]",
      bad_name: "bad$name",
    });
    // the legal name is NOT recorded (identity entries are skipped)
    expect(method.argNameMap).not.toHaveProperty("ok_name");
    // and it is carried onto the stored operation for the request path
    expect(operation.argNameMap).toEqual(method.argNameMap);
  });

  it("executeOperation restores the raw names on the wire", async () => {
    mockOperationFn.mockReset();
    mockOperationFn.mockResolvedValue({ data: { ok: true }, status: 200, headers: {} });

    const client = new HttpClient({ baseUrl: "http://localhost" }, syntheticSpec);
    // Client is invoked with the SANITIZED keys (what the model produced).
    await client.executeOperation(operation, {
      filter_status: "active",
      bad_name: "hello",
      ok_name: "world",
    });

    expect(mockOperationFn).toHaveBeenCalledTimes(1);
    const [urlParameters, bodyParams] = mockOperationFn.mock.calls[0]!;
    // Query param restored to its raw name.
    expect(urlParameters).toEqual({ "filter[status]": "active" });
    // Body properties restored to their raw names.
    expect(bodyParams).toEqual({ "bad$name": "hello", ok_name: "world" });
  });
});
