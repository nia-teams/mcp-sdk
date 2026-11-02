import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerNiaWorkspaceApp,
  registerAppTool,
  registerAppResource,
  verifyBoundViewer,
  createSafeApiPathChecker,
} from "@nia-teams/mcp-sdk/apps";

export const server = new McpServer({
  name: "enterprise-workspace",
  version: "1.0.0",
});
const allowed = createSafeApiPathChecker({
  get: [{ pattern: /^\/api\/reports$/, queryKeys: ["limit"] }],
  post: [/^\/api\/reports\/refresh$/],
});
registerNiaWorkspaceApp(server, {
  resourceUri: "ui://enterprise/reports",
  html: () =>
    readFile(
      new URL("./workspace-ui/dist/index.html", import.meta.url),
      "utf8",
    ),
  threadEntrypoint: true,
  requireTeamAdmin: true,
  visibility: ["app"],
  entryTool: {
    name: "open_reports",
    title: "Reports",
    handler: async (extra) => {
      verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      return { content: [{ type: "text", text: "Reports workspace ready" }] };
    },
  },
  apiTool: {
    name: "reports_api",
    handler: async ({ method, path, body }, extra) => {
      const viewer = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      if (!allowed(method, path))
        return {
          isError: true,
          content: [{ type: "text", text: "Forbidden route" }],
          structuredContent: {
            status: 403,
            body: { error: "Forbidden route" },
          },
        };
      // Dispatch to your existing application's authorization-aware handler here.
      // Never let the browser select the upstream origin or bypass business authorization.
      return {
        content: [{ type: "text", text: "HTTP 200" }],
        structuredContent: {
          status: 200,
          body: {
            reports: [],
            actor: viewer.actor,
            method,
            requestBody: body ?? null,
          },
        },
      };
    },
  },
});
// These are official ext-apps/server helpers re-exported unchanged for custom setups.
void registerAppTool;
void registerAppResource;
// Authenticate the transport and restrict authorized Team/role mounts before trusting
// boundContext; it is injected by the trusted host, not a standalone credential.
