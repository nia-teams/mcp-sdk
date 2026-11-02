# @nia-teams/mcp-sdk

English | [简体中文](./README_CN.md)

Connect internal logs, databases, deployment pipelines, or admin consoles to [Nia Teams](https://nia-teams.com) Agents over MCP.

## What is Nia Teams

Nia Teams is a workspace where humans and AI Agents work together in the same group chats. Each Agent has its own members with three roles: `owner`, `admin`, and `member`. Mention an Agent in chat and it queries data, writes code, or updates configurations.

What an Agent can do depends on the tools mounted on it. Tools connect over MCP: wrap your internal log service, database, or deployment system as an MCP server and mount it onto the Agent.

Standard MCP only covers "AI calls a tool." Putting an Agent into a multi-person group chat brings up three extra problems:

- How does your server know which Agent is calling and what data it is allowed to see?
- For operations like restarting production or mutating a database, how do you make sure a human approved it before it runs?
- When a dashboard or form works better than chat messages, where does the UI live?

Nia Teams has a built-in answer for each of the three. This SDK wires them up on your server.

[Screenshot: A group chat showing the TaskBar, the right sidebar, and the top Apps menu]

### 1. Identity: No Static API Keys

Every time an Agent calls your server, the HTTP request carries a token signed by Nia Teams stating which Agent is calling, which organization it belongs to, and which roles it holds. Your server verifies it against Nia Teams' public keys — no per-Agent API keys to issue or rotate.

Tokens expire in 5 minutes and Nia Teams refreshes them automatically.

### 2. TaskBar: Nothing Runs Until a Human Clicks

The TaskBar is the strip right above the chat input box where pending action cards sit waiting for a human.

[Screenshot: A confirmation card for "Restart payments-api" sitting in the TaskBar]

Write operations work in two steps: the AI only proposes. It calls your proposal tool, which posts a card to the TaskBar explaining what it wants to do and why. Nothing has changed yet.

When an authorized person in the chat clicks Confirm, Nia Teams calls your execution tool and attaches a signed token recording who clicked, which card they clicked, and a hash of the arguments. If a single field in the arguments was altered, the token no longer matches and your server rejects the call.

### 3. Right Sidebar: Give the Agent a Console

The official [MCP App](https://github.com/modelcontextprotocol/ext-apps) extension lets a tool attach a web UI. Most clients render that UI inside a chat message bubble, where it scrolls out of view a few messages later.

Nia Teams opens it in a dedicated pane on the right side of the chat: keep talking on the left while watching metrics or reviewing tickets on the right. You can also pin it to the Apps menu at the top of the chat so anyone in the group can open it directly without asking the AI.

[Screenshot: An operations console open in the right sidebar]

On every request from that pane, Nia Teams tells your server which user is interacting and whether they are an `owner`, `admin`, or `member` of the Agent. You can also hide admin consoles from regular members entirely.

### Standard MCP vs. Nia Teams Additions

| | Standard MCP | Added by Nia Teams |
| --- | --- | --- |
| Tool calls & transport | Everything | Unchanged |
| Identity | Leaves headers and `_meta` open | Agent token, human confirmation token |
| Confirmation cards | Tools can return structured data | Rendered in TaskBar, calls execution tool on click |
| UI | MCP App (tool-attached web page) | Right sidebar, Apps menu entry, live viewer role |

Transport and UI bridging use the official `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` packages; this SDK implements the right-hand column.

---

## Install

Requires Node.js 20+.

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| Subpath | Environment | Purpose |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | Verify HTTP Bearer tokens, human confirmation tokens, and argument digests |
| `@nia-teams/mcp-sdk/cards` | Node.js | Build TaskBar cards, return execution status, verify webhook signatures |
| `@nia-teams/mcp-sdk/apps` | Node.js | Register right-sidebar apps, check viewer roles, allowlist API paths |
| `@nia-teams/mcp-sdk/apps/client` | Browser | `App` and `createMcpAppFetch` for calling server tools from browser UI code |
| `@nia-teams/mcp-sdk/testing` | Node.js (test) | Mint local test tokens without connecting to Nia Teams |

---

## Quickstart

### 1. Start a Read-Only Server with Token Verification

Expose `/mcp` with the official `StreamableHTTPServerTransport` and verify the `Authorization` header before handling requests:

```ts
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createWorkloadOidcVerifier, WorkloadOidcError } from "@nia-teams/mcp-sdk/auth";

const auth = createWorkloadOidcVerifier();

createServer(async (req, res) => {
  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  let server: McpServer | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  try {
    // Verify the Bearer token:
    // Agent calls have principalType "workload"; TaskBar card callbacks have "service"
    const identity = await auth.verifyBearerHeader(req.headers.authorization, {
      allowServicePrincipal: true,
    });

    server = new McpServer({ name: "ops-service", version: "1.0.0" });

    server.registerTool(
      "query_service_logs",
      {
        description: "Query recent production error logs for a service",
        inputSchema: {
          service: z.string(),
          limit: z.number().int().min(1).max(100).default(20),
        },
      },
      async ({ service, limit }) => {
        if (identity.principalType !== "workload" || !identity.roles.includes("ops.reader")) {
          throw new WorkloadOidcError(403, "Requires role:ops.reader");
        }
        const rows = await queryLogsFromDb({ orgs: identity.orgs, service, limit });
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );

    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      if (err instanceof WorkloadOidcError) {
        res.writeHead(err.statusCode, { "WWW-Authenticate": "Bearer" }).end(err.message);
      } else {
        res.writeHead(500).end("Internal Server Error");
      }
    }
  } finally {
    await transport?.close();
    await server?.close();
  }
}).listen(3000);
```

### 2. Mount It onto an Agent

Deploy the server to a public HTTPS URL (such as `https://ops.acme.com/mcp`; loopback and private IPs are blocked), then tell your Agent in chat:

> Connect MCP server `ops` at `https://ops.acme.com/mcp`

The Agent posts a configuration card to the TaskBar. Once an `owner` or `admin` of that Agent clicks Confirm, the server is mounted (you can also add it under Agent Settings → MCP).

Leave custom `Authorization` headers empty when mounting so Nia Teams attaches its OIDC token automatically. A tool registered as `query_service_logs` on your server appears to the Agent as `mcp__ops__query_service_logs`.

---

## TaskBar Confirmation Cards

Split any write operation into two tools: `propose_restart` for the AI to post a card without touching production, and `execute_restart` for Nia Teams to call after a human clicks Confirm.

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// 1. Proposal tool: called by the AI, posts a card to the TaskBar
server.registerTool(
  "propose_restart",
  {
    description: "Propose restarting a production service and wait for human confirmation",
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
  },
  async (args) => {
    await db.savePendingRestart(args);
    return cardToolResult(
      `Created confirmation card to restart ${args.service}.`,
      createMcpConfirmCard({
        cardId: `restart:${args.service}:v${args.expectedVersion}`,
        title: `Restart ${args.service}`,
        subtitle: `v${args.expectedVersion}`,
        description: args.reason,
        actionLabel: "Confirm Restart",
        server: "ops", // Mount name configured on the Agent
        toolName: "execute_restart",
        arguments: args,
      }),
    );
  },
);

// 2. Execution tool: called by Nia Teams after a human clicks "Confirm Restart"
server.registerTool(
  "execute_restart",
  {
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
    annotations: { destructiveHint: true },
  },
  async (args, extra) => {
    // Verify the platform signature, server name, tool name, cardId, and argument hash
    const human = await auth.verifyHumanActionContext(extra._meta, {
      server: "ops",
      tool: "execute_restart",
      arguments: args,
      expectedCardId: `restart:${args.service}:v${args.expectedVersion}`,
    });

    // human.confirmedBy is the clicker's 24-character hex Nia Teams user ID
    if (!(await db.canUserRestartService(human.confirmedBy, args.service))) {
      return cardActionError("Only service owners can restart production instances", {
        errorKind: "auth_forbidden",
      });
    }

    // Use a database version check so double-clicks or replays are rejected
    const applied = await db.applyRestartCas(args.service, args.expectedVersion, {
      approvedBy: human.confirmedBy,
      approvedByName: human.confirmedByName,
      jti: human.jti,
    });
    if (!applied) {
      return cardActionError("Already executed or version changed");
    }

    return cardActionSuccess({
      statusLabel: "Restarted",
      result: { service: args.service, approvedBy: human.confirmedBy },
    });
  },
);
```

To trigger an HTTP webhook on click instead of an MCP tool, use `createWebhookConfirmCard({ title, url, mcpServerName: "ops", pendingInput })` and verify `req.headers["x-nia-signature"]` against the raw request body with `verifyCardSignature(secret, rawBodyBuffer, header)`.

---

## Right-Sidebar Pages

Bundle your frontend into a single HTML file with `vite-plugin-singlefile` and register it with `registerNiaWorkspaceApp`. The browser page does not handle any tokens.

### 1. Frontend

```ts
// ui/vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
});
```

Import from `@nia-teams/mcp-sdk/apps/client` in browser code:

```ts
// ui/src/main.ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";

const app = new App({ name: "Ops Console", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "ops_console_api" });

// Works like regular fetch; calls ops_console_api on your MCP server over postMessage
const res = await apiFetch("/api/incidents?status=open");
const { incidents } = await res.json();
```

### 2. Server Registration

```ts
import { readFile } from "node:fs/promises";
import {
  registerNiaWorkspaceApp,
  verifyBoundViewer,
  createSafeApiPathChecker,
} from "@nia-teams/mcp-sdk/apps";

const isAllowedRoute = createSafeApiPathChecker({
  get: [{ pattern: /^\/api\/incidents$/, queryKeys: ["status", "limit"] }],
  post: [/^\/api\/incidents\/[a-z0-9-]+\/ack$/],
});

registerNiaWorkspaceApp(server, {
  resourceUri: "ui://ops/console",
  html: () => readFile(new URL("../ui/dist/index.html", import.meta.url), "utf8"),
  threadEntrypoint: true, // List in the group chat's top Apps menu
  requireTeamAdmin: true, // Visible only to the Agent's owner and admin
  visibility: ["app"],
  entryTool: {
    name: "open_ops_console",
    title: "Ops Console",
    handler: async (extra) => {
      verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      return { content: [{ type: "text", text: "Ops Console opened" }] };
    },
  },
  apiTool: {
    name: "ops_console_api",
    handler: async ({ method, path, body }, extra) => {
      const viewer = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });

      if (!isAllowedRoute(method, path)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Forbidden route" }],
          structuredContent: { status: 403, body: { error: "Forbidden route" } },
        };
      }

      const result = await handleIncidentApi({ method, path, body, actorId: viewer.viewerUserId });
      return {
        content: [{ type: "text", text: `HTTP ${result.status}` }],
        structuredContent: { status: result.status, body: result.body },
      };
    },
  },
});
```

---

## Tokens and Permissions

Every request has two layers: the outer HTTP `Authorization` header tells you which Agent (or platform service) sent the request, and the inner MCP `_meta` object tells you which human clicked a card or opened a page.

### 1. Agent Token in the HTTP Header

`verifyBearerHeader` decodes an RS256 JWT with these claims:

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "ops-agent",
  "principal_type": "workload",
  "groups": ["team:ops-agent", "org:acme", "role:ops.reader"],
  "iat": 1790812800,
  "exp": 1790813100
}
```

- `identity.subject` (`sub`): The Agent's slug (e.g. `"ops-agent"`). When a human clicks a TaskBar card, Nia Teams calls your server using its platform identity instead: `sub: "nia-teams-platform"`, `principal_type: "service"`.
- `identity.orgs` / `identity.teams` / `identity.roles`: Arrays parsed from `groups`. Note that `role:*` is a machine role assigned to the Agent, not a human's `owner` / `admin` / `member` role.

### 2. Human Confirmation Token on Card Clicks

When a human clicks Confirm in the TaskBar, Nia Teams places this signed token in `extra._meta["nia/confirmationToken"]`:

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "nia-teams-platform",
  "principal_type": "service",
  "human_confirmed": true,
  "confirmed_by": "65f000000000000000000001",
  "confirmed_by_name": "Alice",
  "confirmation_card_id": "restart:payments-api:v3",
  "context_server": "ops",
  "context_tool": "execute_restart",
  "context_arguments_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "iat": 1790812860,
  "exp": 1790813160,
  "jti": "38a1b544-89ef-4a0e-b8c1-7640219c5511"
}
```

`verifyHumanActionContext` checks the signature, 5-minute lifetime, server name, tool name, `cardId`, and argument hash, then returns `confirmedBy` (user ID) and `confirmedByName`.

### 3. Checking Human `owner` / `admin` / `member` Roles

- **Mounting an MCP server**: Anyone in chat can ask the Agent to propose a mount, but only the Agent's `owner` or `admin` can click Confirm on the mount card.
- **Clicking a TaskBar card**: By default, Nia Teams checks that the clicker is a member of the Agent (`owner`, `admin`, or `member`). To restrict an action to specific people, check `human.confirmedBy` against your own permission table, or set `requiresIdentity: { provider: "gitlab" }` on the card so Nia Teams passes the clicker's external OAuth token in `human.identityToken`. (Note: `human.sourceTeam?.role` is only present on built-in platform approval flows, not custom mounts.)
- **Using a right-sidebar page**: On every `entryTool` and `apiTool` call, Nia Teams sets `extra._meta.boundContext` with the live viewer's role. Authenticate the outer HTTP request with `verifyBearerHeader` (and restrict `allowedSubjects` / `requiredGroups`) first, then check the viewer with `verifyBoundViewer`:
  - Allow `owner`, `admin`, and `member`: `verifyBoundViewer(extra._meta)`
  - Allow `owner` and `admin` only: `verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`
  - Allow `owner` only: check `if (viewer.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "Owner required")`

---

## Local Unit Tests

`@nia-teams/mcp-sdk/testing` mints tokens in memory so you can run tests in Vitest without a live Nia Teams environment:

```ts
import { expect, test } from "vitest";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";

test("verifies Agent token and human confirmation token offline", async () => {
  const provider = createWorkloadOidcProvider({
    issuer: "https://nia-teams.com",
    audience: "nia-teams-workload",
    tokenTtlSeconds: 300,
    activeKey: await generateTestRsaKeyPair(),
  });

  const auth = createWorkloadOidcVerifier({ jwks: await provider.getJwks() });

  const agentJwt = await provider.signIdToken({
    subject: "ops-agent",
    groups: ["team:ops-agent", "org:acme", "role:ops.reader"],
    claims: { principal_type: "workload" },
  });
  const identity = await auth.verifyBearerHeader(`Bearer ${agentJwt}`, {
    requiredGroups: ["role:ops.reader"],
  });
  expect(identity.subject).toBe("ops-agent");

  const args = { service: "payments-api", expectedVersion: 3 };
  const confirmationToken = await signTestConfirmationToken(provider, {
    server: "ops",
    tool: "execute_restart",
    arguments: args,
    cardId: "restart:payments-api:v3",
    confirmedBy: "65f000000000000000000001",
    confirmedByName: "Alice",
  });

  const human = await auth.verifyHumanActionContext(
    { "nia/confirmationToken": confirmationToken },
    { server: "ops", tool: "execute_restart", arguments: args, expectedCardId: "restart:payments-api:v3" },
  );
  expect(human.confirmedByName).toBe("Alice");
});
```

---

## Examples and Docs

- Runnable examples:
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) — Read-only log query server
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) — TaskBar confirmation cards and execution callback
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) & [`examples/workspace-ui/`](./examples/workspace-ui) — Right-sidebar console and Vite frontend
- AI coding guide: [`AGENTS.md`](./AGENTS.md)
- Wire specification: [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md)

## License

[MIT](./LICENSE) © Nia Teams
