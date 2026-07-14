import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSlimEnabled, slimResponse } from "../slim";

const fullType = {
  object: "type",
  id: "type-id-1",
  key: "page",
  name: "Page",
  plural_name: "Pages",
  layout: "basic",
  archived: false,
  icon: { format: "emoji", emoji: "📄" },
  properties: [
    { object: "property", id: "prop-id-1", key: "tag", name: "Tag", format: "multi_select" },
    { object: "property", id: "prop-id-2", key: "description", name: "Description", format: "text" },
  ],
};

const objectEntity = {
  object: "object",
  id: "obj-id-1",
  name: "My object",
  icon: null,
  archived: false,
  space_id: "space-1",
  snippet: "The beginning...",
  layout: "basic",
  type: fullType,
  properties: [
    { object: "property", id: "prop-id-2", key: "description", name: "Description", format: "text", text: "hello" },
    { object: "property", id: "prop-id-3", key: "done", name: "Done", format: "checkbox", checkbox: false },
    { object: "property", id: "prop-id-4", key: "due", name: "Due date", format: "date", date: null },
    { object: "property", id: "prop-id-5", key: "url", name: "URL", format: "url", url: "" },
    {
      object: "property",
      id: "prop-id-6",
      key: "tag",
      name: "Tag",
      format: "multi_select",
      multi_select: [{ object: "tag", id: "tag-id-1", key: "opaque", name: "urgent", color: "red" }],
    },
    {
      object: "property",
      id: "prop-id-7",
      key: "status",
      name: "Status",
      format: "select",
      select: { object: "tag", id: "tag-id-2", key: "opaque2", name: "open", color: "blue" },
    },
    { object: "property", id: "prop-id-8", key: "links", name: "Links", format: "objects", objects: [] },
  ],
};

describe("slimResponse", () => {
  it("compacts objects in list responses", () => {
    const payload = {
      data: [objectEntity],
      pagination: { total: 1, offset: 0, limit: 100, has_more: false },
    };
    const slimmed = slimResponse(payload) as any;

    const obj = slimmed.data[0];
    // discriminators, nulls and archived:false removed
    expect(obj.object).toBeUndefined();
    expect(obj.icon).toBeUndefined();
    expect(obj.archived).toBeUndefined();
    // identity and content preserved
    expect(obj.id).toBe("obj-id-1");
    expect(obj.name).toBe("My object");
    expect(obj.snippet).toBe("The beginning...");
    // embedded type compacted to identifiers, nested definitions dropped
    expect(obj.type).toEqual({ id: "type-id-1", key: "page", name: "Page" });
    // pagination untouched
    expect(slimmed.pagination).toEqual({ total: 1, offset: 0, limit: 100, has_more: false });
  });

  it("drops empty property values and compacts the rest", () => {
    const slimmed = slimResponse({ data: [objectEntity] }) as any;
    const props = slimmed.data[0].properties;
    const keys = props.map((p: any) => p.key);

    // empty date / url / objects entries removed entirely
    expect(keys).toEqual(["description", "done", "tag", "status"]);
    // metadata compacted: no id / object, value preserved
    expect(props[0]).toEqual({ key: "description", name: "Description", format: "text", text: "hello" });
    // false checkbox is a real value, not "empty"
    expect(props[1].checkbox).toBe(false);
    // tags keep the id needed to set select values, drop key/object
    expect(props[2].multi_select).toEqual([{ id: "tag-id-1", name: "urgent", color: "red" }]);
    expect(props[3].select).toEqual({ id: "tag-id-2", name: "open", color: "blue" });
  });

  it("keeps the markdown body intact", () => {
    const withBody = { object: { ...objectEntity, markdown: "# Title\n\nBody text" } };
    const slimmed = slimResponse(withBody) as any;
    expect(slimmed.object.markdown).toBe("# Title\n\nBody text");
  });

  it("keeps full type definitions in type responses", () => {
    // A top-level type (get-type / list-types) is not an object entity and
    // must keep its property definitions.
    const slimmed = slimResponse({ type: fullType }) as any;
    expect(slimmed.type.properties).toHaveLength(2);
    expect(slimmed.type.properties[0]).toEqual({
      id: "prop-id-1",
      key: "tag",
      name: "Tag",
      format: "multi_select",
    });
    expect(slimmed.type.plural_name).toBe("Pages");
    expect(slimmed.type.object).toBeUndefined();
  });

  it("keeps archived:true but drops archived:false", () => {
    const slimmed = slimResponse({
      data: [{ ...objectEntity, archived: true }],
    }) as any;
    expect(slimmed.data[0].archived).toBe(true);
  });

  it("passes primitives and unknown shapes through", () => {
    expect(slimResponse("plain string")).toBe("plain string");
    expect(slimResponse(42)).toBe(42);
    expect(slimResponse(null)).toBe(null);
    expect(slimResponse({ status: "error", message: "boom" })).toEqual({ status: "error", message: "boom" });
  });

  it("keeps property values with unknown formats", () => {
    const unknown = {
      ...objectEntity,
      properties: [{ object: "property", id: "x", key: "weird", name: "Weird", format: "hologram", hologram: "hi" }],
    };
    const slimmed = slimResponse({ data: [unknown] }) as any;
    expect(slimmed.data[0].properties[0].key).toBe("weird");
    expect(slimmed.data[0].properties[0].hologram).toBe("hi");
  });
});

describe("isSlimEnabled", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to enabled", () => {
    delete process.env.ANYTYPE_MCP_SLIM_RESPONSES;
    expect(isSlimEnabled()).toBe(true);
  });

  it.each(["false", "0", "off", "FALSE"])("is disabled by %s", (value) => {
    process.env.ANYTYPE_MCP_SLIM_RESPONSES = value;
    expect(isSlimEnabled()).toBe(false);
  });

  it("stays enabled for other values", () => {
    process.env.ANYTYPE_MCP_SLIM_RESPONSES = "true";
    expect(isSlimEnabled()).toBe(true);
  });
});
