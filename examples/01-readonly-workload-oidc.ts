import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import {
  createWorkloadOidcVerifier,
  WorkloadOidcError,
} from "@nia-teams/mcp-sdk/auth";

const auth = createWorkloadOidcVerifier();
/** Authenticate before parsing/dispatching MCP. Bind data queries to the verified identity. */
export const httpServer = createServer(async (req, res) => {
  let server: McpServer | undefined,
    transport: StreamableHTTPServerTransport | undefined;
  try {
    const identity = await auth.verifyBearerHeader(req.headers.authorization, {
      requiredGroups: ["org:acme"],
    });
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    server = new McpServer({ name: "enterprise-logs", version: "1.0.0" });
    server.registerTool(
      "query_logs",
      {
        description: "Query logs belonging to the authenticated Agent and organization",
        inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
        annotations: { readOnlyHint: true },
      },
      async ({ limit }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              subject: identity.subject,
              orgs: identity.orgs,
              limit,
              rows: [],
            }),
          },
        ],
      }),
    );
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent)
      res
        .writeHead(
          error instanceof WorkloadOidcError ? error.statusCode : 500,
          { "WWW-Authenticate": "Bearer" },
        )
        .end("Request rejected");
  } finally {
    await transport?.close();
    await server?.close();
  }
});
// Run with a TypeScript runner, then connect an authenticated HTTP MCP client.
if (process.env.RUN_EXAMPLE === "1") httpServer.listen(3000, "127.0.0.1");
