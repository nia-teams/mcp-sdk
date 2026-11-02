import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
  type McpUiAppResourceConfig,
} from "@modelcontextprotocol/ext-apps/server";
import { WorkloadOidcError } from "../auth/index.js";
export {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  getUiCapability,
  EXTENSION_ID,
} from "@modelcontextprotocol/ext-apps/server";

export interface NiaWorkspaceMetaOptions {
  resourceUri: string;
  visibility?: ("model" | "app")[];
  workspace?: boolean;
  threadEntrypoint?: boolean;
  requireTeamAdmin?: boolean;
}
/** Returns the value for a tool's _meta, not an enclosing { _meta } object. */
export function niaWorkspaceMeta(options: NiaWorkspaceMetaOptions) {
  if (
    !/^ui:\/\/[^\s\x00-\x1f]+$/.test(options.resourceUri) ||
    options.resourceUri.length > 4096
  )
    throw new TypeError("Expected a ui:// resource URI");
  return {
    ui: {
      resourceUri: options.resourceUri,
      ...(options.visibility ? { visibility: options.visibility } : {}),
    },
    "nia/workspace": options.workspace ?? true,
    ...(options.requireTeamAdmin !== undefined
      ? { "nia/requireTeamAdmin": options.requireTeamAdmin }
      : {}),
    ...(options.threadEntrypoint
      ? { "openai/ui.entrypoints": [{ type: "thread" }] }
      : {}),
  };
}
const apiSchema = {
  method: z.enum(["GET", "POST"]),
  path: z.string().min(1).max(2048),
  body: z.unknown().optional(),
};
export interface NiaWorkspaceAppOptions<
  Input extends ZodRawShapeCompat | undefined = undefined,
> extends NiaWorkspaceMetaOptions {
  html: string | (() => string | Promise<string>);
  resourceName?: string;
  resourceConfig?: McpUiAppResourceConfig;
  entryTool: {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: Input;
    handler: ToolCallback<Input>;
  };
  apiTool?: {
    name: string;
    description?: string;
    handler: ToolCallback<typeof apiSchema>;
  };
}
/** Registration only: authenticated handlers must enforce viewer and business authorization. */
export function registerNiaWorkspaceApp<
  Input extends ZodRawShapeCompat | undefined = undefined,
>(server: McpServer, options: NiaWorkspaceAppOptions<Input>) {
  const meta = niaWorkspaceMeta(options);
  const resource = registerAppResource(
    server,
    options.resourceName ?? options.entryTool.title ?? options.entryTool.name,
    options.resourceUri,
    { ...options.resourceConfig, mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: options.resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text:
            typeof options.html === "function"
              ? await options.html()
              : options.html,
        },
      ],
    }),
  );
  const { name, handler, ...entryConfig } = options.entryTool;
  const entryTool = registerAppTool<ZodRawShapeCompat, Input>(
    server,
    name,
    { ...entryConfig, _meta: meta },
    handler as Parameters<typeof registerAppTool<ZodRawShapeCompat, Input>>[3],
  );
  const apiTool = options.apiTool
    ? registerAppTool(
        server,
        options.apiTool.name,
        {
          description: options.apiTool.description,
          inputSchema: apiSchema,
          _meta: {
            ui: { resourceUri: options.resourceUri, visibility: ["app"] },
          },
        },
        options.apiTool.handler,
      )
    : undefined;
  return { resource, entryTool, apiTool };
}
export interface VerifiedBoundViewer {
  viewerUserId: string;
  viewerTeamRole: "owner" | "admin" | "member";
  actor: string;
}
/** Trust only after authenticating the platform transport; boundContext is not a signature. */
export function verifyBoundViewer(
  meta: Record<string, unknown> | undefined,
  options: { requireTeamAdmin?: boolean } = {},
): VerifiedBoundViewer {
  const bound = meta?.boundContext;
  const ctx =
    bound && typeof bound === "object" && !Array.isArray(bound)
      ? (bound as Record<string, unknown>)
      : {};
  const id =
    typeof ctx.viewerUserId === "string" ? ctx.viewerUserId.trim() : "";
  const role =
    typeof ctx.viewerTeamRole === "string" ? ctx.viewerTeamRole.trim() : "";
  if (
    !/^[a-f0-9]{24}$/i.test(id) ||
    (role !== "owner" && role !== "admin" && role !== "member") ||
    (options.requireTeamAdmin && role === "member")
  )
    throw new WorkloadOidcError(403, "Authorized bound viewer required");
  return {
    viewerUserId: id.toLowerCase(),
    viewerTeamRole: role,
    actor: `user:${id.toLowerCase()}`,
  };
}
export interface SafeApiRoutes {
  get?: Array<{ pattern: RegExp; queryKeys?: readonly string[] }>;
  post?: readonly RegExp[];
}
/** Positive allowlist over raw paths: never normalize a malicious URL into an allowed route. */
export function createSafeApiPathChecker(
  routes: SafeApiRoutes,
): (method: string, rawPath: unknown) => boolean {
  const test = (pattern: RegExp, value: string) => {
    const copy = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
    return copy.test(value);
  };
  return (method, rawPath) => {
    if (
      typeof rawPath !== "string" ||
      !rawPath.startsWith("/api/") ||
      rawPath.length > 2048 ||
      /[\s\x00-\x1f\x7f#\\]/.test(rawPath)
    )
      return false;
    const qIdx = rawPath.indexOf("?"),
      pathname = qIdx < 0 ? rawPath : rawPath.slice(0, qIdx);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    // Reject encoded separators/dots outright, including nested escaping for a second decoder.
    if (
      /%(?:2e|2f|5c|25)/i.test(pathname) ||
      /[\s\x00-\x1f\x7f\\?#]/.test(decoded) ||
      decoded.split("/").some((segment) => segment === "." || segment === "..")
    )
      return false;
    if (method.toUpperCase() === "GET") {
      const route = routes.get?.find(
        (r) => test(r.pattern, pathname) && test(r.pattern, decoded),
      );
      if (!route) return false;
      const query = qIdx < 0 ? "" : rawPath.slice(qIdx + 1);
      try {
        decodeURIComponent(query.replace(/\+/g, " "));
      } catch {
        return false;
      }
      const keys = new Set<string>();
      for (const [key, value] of new URLSearchParams(query)) {
        if (
          !route.queryKeys?.includes(key) ||
          keys.has(key) ||
          /[\x00-\x1f\x7f]/.test(key + value)
        )
          return false;
        keys.add(key);
      }
      return true;
    }
    return (
      method.toUpperCase() === "POST" &&
      qIdx < 0 &&
      !!routes.post?.some((re) => test(re, pathname) && test(re, decoded))
    );
  };
}
