import { URL } from "node:url";
import { OpenAPIV3 } from "openapi-types";

/**
 * Parses the ANYTYPE_API_BASE_URL environment variable and returns the origin.
 * Returns null if not set, invalid, or uses an unsupported protocol.
 */
export function parseBaseUrlFromEnv(): string | null {
  const endpoint = process.env.ANYTYPE_API_BASE_URL;
  if (!endpoint) {
    return null;
  }

  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(
        `ANYTYPE_API_BASE_URL must use http:// or https:// protocol, got: ${url.protocol}. Ignoring and using fallback.`,
      );
      return null;
    }
    return url.origin;
  } catch (error) {
    console.warn("Failed to parse ANYTYPE_API_BASE_URL environment variable:", error);
    return null;
  }
}

/**
 * Determines the base URL using priority order:
 * 1. ANYTYPE_API_BASE_URL environment variable
 * 2. OpenAPI spec servers[0].url
 * 3. Default fallback: http://127.0.0.1:31009
 */
export function determineBaseUrl(openApiSpec?: OpenAPIV3.Document): string {
  // Priority 1: Environment variable
  const envEndpoint = parseBaseUrlFromEnv();
  if (envEndpoint) {
    console.error(`Using base URL from ANYTYPE_API_BASE_URL: ${envEndpoint}`);
    return envEndpoint;
  }

  // Priority 2: OpenAPI spec servers[0].url
  const specUrl = openApiSpec?.servers?.[0]?.url;
  if (specUrl) {
    console.error(`Using base URL from OpenAPI spec: ${specUrl}`);
    return specUrl;
  }

  // Priority 3: Default fallback
  const defaultUrl = "http://127.0.0.1:31009";
  console.error(`Using default base URL: ${defaultUrl}`);
  return defaultUrl;
}

/**
 * Gets the default OpenAPI spec URL.
 * If ANYTYPE_API_BASE_URL is set, uses it with /docs/openapi.json suffix.
 * Otherwise, returns the default spec URL.
 */
export function getDefaultSpecUrl(): string {
  const endpoint = parseBaseUrlFromEnv();
  if (endpoint) {
    return `${endpoint}/docs/openapi.json`;
  }
  return "http://127.0.0.1:31009/docs/openapi.json";
}

/**
 * Hostnames that route to the host machine from inside a container. Anytype
 * only accepts loopback Host headers and answers anything else with
 * 403 "request origin is not allowed", so requests routed through one of these
 * still have to present themselves as localhost.
 */
const CONTAINER_HOST_ALIASES = new Set([
  "host.docker.internal",
  "gateway.docker.internal",
  "host.containers.internal",
  "host.lima.internal",
]);

/**
 * Gets the Host header to send with Anytype API requests, or null to leave the
 * header to the HTTP client. ANYTYPE_API_HOST_HEADER overrides the mapping.
 */
export function getHostHeaderOverride(baseUrl?: string | null): string | null {
  const override = process.env.ANYTYPE_API_HOST_HEADER;
  if (override) {
    return override;
  }

  const target = baseUrl ?? parseBaseUrlFromEnv();
  if (!target) {
    return null;
  }

  try {
    const url = new URL(target);
    if (!CONTAINER_HOST_ALIASES.has(url.hostname)) {
      return null;
    }
    return url.port ? `localhost:${url.port}` : "localhost";
  } catch {
    return null;
  }
}
