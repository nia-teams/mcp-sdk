import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

const auth = createWorkloadOidcVerifier();
export const server = new McpServer({
  name: "enterprise-changes",
  version: "1.0.0",
});
// Demo datastore. In production use durable pending state + an atomic transaction/CAS.
const pending = new Map<
  string,
  { expectedVersion: number; applied: boolean }
>();
server.registerTool(
  "propose_change",
  { inputSchema: { changeId: z.string(), expectedVersion: z.number().int() } },
  async (args) => {
    if (!pending.has(args.changeId))
      pending.set(args.changeId, {
        expectedVersion: args.expectedVersion,
        applied: false,
      });
    return cardToolResult(
      "Review this change before applying it.",
      createMcpConfirmCard({
        cardId: `changes:${args.changeId}`,
        title: `Apply change ${args.changeId}`,
        subtitle: `Version ${args.expectedVersion}`,
        server: "enterprise-changes",
        toolName: "apply_change",
        arguments: args,
      }),
    );
  },
);
server.registerTool(
  "apply_change",
  {
    inputSchema: { changeId: z.string(), expectedVersion: z.number().int() },
    annotations: { destructiveHint: true },
  },
  async (args, extra) => {
    const human = await auth.verifyHumanActionContext(extra._meta, {
      server: "enterprise-changes",
      tool: "apply_change",
      arguments: args,
      expectedCardId: `changes:${args.changeId}`,
    });
    const change = pending.get(args.changeId);
    if (
      !change ||
      change.applied ||
      change.expectedVersion !== args.expectedVersion
    )
      return cardActionError("Change already applied or version mismatch");
    // Replace with a durable transaction: permission recheck, version CAS, mutation, and audit.
    change.applied = true;
    return cardActionSuccess({
      result: { changeId: args.changeId, approvedBy: human.confirmedBy },
    });
  },
);
// Mount behind an authenticated MCP HTTP transport (example 01).
// Permit the platform service bearer only on this callback path; separately verify
// the exact signed human context above. Service identity alone never authorizes writes.
