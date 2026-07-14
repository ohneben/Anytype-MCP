/**
 * Response slimming for Anytype API payloads.
 *
 * The raw API is very verbose: every object in a list/search response embeds a
 * full `Type` (including that type's own property definitions), and every
 * property value carries six fields of metadata even when the value is empty.
 * For a 100-item list response this easily multiplies the payload by 3-5x,
 * which burns the MCP client's context window and forces it into extra,
 * narrower tool calls.
 *
 * slimResponse() removes only information that is redundant or recoverable
 * through a dedicated tool call:
 *   - `object` discriminator fields ("object": "object" / "property" / ...)
 *   - null / undefined / empty-string / empty-array fields
 *   - `archived: false` (the default; `archived: true` is kept)
 *   - property values with no value set (the entire entry)
 *   - property-value metadata: `id` and `object` are dropped; `key` (what the
 *     update APIs accept), `name`, `format` and the value itself are kept
 *   - tag values keep `id` (needed to set select values), `name` and `color`
 *   - the `type` embedded in an object entity is compacted to {id, key, name};
 *     full type definitions remain available via list-types / get-type
 *
 * Everything else — ids, markdown bodies, pagination, top-level type/property
 * responses — passes through untouched. Set ANYTYPE_MCP_SLIM_RESPONSES=false
 * to disable slimming and return raw API payloads.
 */

/** Maps PropertyFormat to the field that holds the actual value. */
const PROPERTY_VALUE_FIELD: Record<string, string> = {
  text: "text",
  number: "number",
  select: "select",
  multi_select: "multi_select",
  date: "date",
  files: "files",
  checkbox: "checkbox",
  url: "url",
  email: "email",
  phone: "phone",
  objects: "objects",
};

export function isSlimEnabled(): boolean {
  const flag = (process.env.ANYTYPE_MCP_SLIM_RESPONSES || "").trim().toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "off";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * An "object entity" (Object / ObjectWithBody) is the only place where we
 * compact the embedded `type` and treat `properties` as property *values*.
 * Top-level type/property responses keep their full shape.
 */
function isObjectEntity(node: Record<string, unknown>): boolean {
  return typeof node.id === "string" && isPlainObject(node.type) && Array.isArray(node.properties);
}

/** Compact a tag to the fields needed to read and re-set it. */
function slimTag(tag: unknown): unknown {
  if (!isPlainObject(tag)) return tag;
  const out: Record<string, unknown> = {};
  for (const field of ["id", "name", "color"]) {
    if (!isEmptyValue(tag[field])) out[field] = tag[field];
  }
  return Object.keys(out).length > 0 ? out : tag;
}

/**
 * Compact a PropertyWithValue entry. Returns undefined when the property has
 * no value set, so the caller can drop the entry entirely.
 */
function slimPropertyValue(prop: unknown): unknown {
  if (!isPlainObject(prop)) return slim(prop);
  const format = typeof prop.format === "string" ? prop.format : undefined;
  const valueField = format ? PROPERTY_VALUE_FIELD[format] : undefined;
  if (!valueField) {
    // Unknown/future format: keep it, generic slimming only.
    return slim(prop);
  }

  const value = prop[valueField];
  if (isEmptyValue(value)) return undefined;

  const out: Record<string, unknown> = {};
  if (!isEmptyValue(prop.key)) out.key = prop.key;
  if (!isEmptyValue(prop.name)) out.name = prop.name;
  out.format = format;
  if (valueField === "select") {
    out[valueField] = slimTag(value);
  } else if (valueField === "multi_select" && Array.isArray(value)) {
    out[valueField] = value.map(slimTag);
  } else {
    out[valueField] = slim(value);
  }
  return out;
}

/** Compact the `type` embedded in an object entity to its identifiers. */
function slimEmbeddedType(type: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ["id", "key", "name"]) {
    if (!isEmptyValue(type[field])) out[field] = type[field];
  }
  return Object.keys(out).length > 0 ? out : type;
}

function slimObjectEntity(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "object" && typeof value === "string") continue;
    if (key === "archived" && value === false) continue;
    if (isEmptyValue(value)) continue;

    if (key === "type" && isPlainObject(value)) {
      out.type = slimEmbeddedType(value);
    } else if (key === "properties" && Array.isArray(value)) {
      const props = value.map(slimPropertyValue).filter((p) => p !== undefined);
      if (props.length > 0) out.properties = props;
    } else {
      out[key] = slim(value);
    }
  }
  return out;
}

function slim(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(slim).filter((item) => item !== undefined);
  }
  if (!isPlainObject(node)) {
    return node;
  }
  if (isObjectEntity(node)) {
    return slimObjectEntity(node);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "object" && typeof value === "string") continue;
    if (key === "archived" && value === false) continue;
    if (isEmptyValue(value)) continue;
    out[key] = slim(value);
  }
  return out;
}

/**
 * Slim an API response payload before it is serialized for the MCP client.
 * Never throws: on any unexpected shape it returns the input unchanged.
 */
export function slimResponse(data: unknown): unknown {
  try {
    return slim(data);
  } catch (error) {
    console.error("Failed to slim response, returning raw payload", error);
    return data;
  }
}
