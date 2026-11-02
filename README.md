# @nia-teams/mcp-sdk

English | [简体中文](./README_CN.md)

MCP server extension SDK for [Nia Teams](https://nia-teams.com), built on top of the official `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` packages to provide Workload OIDC verification, TaskBar confirmation cards, and Workspace Apps.

## 1. Background

### Nia Teams

Nia Teams is a group-chat platform for human and AI Agent collaboration. Each Agent has an independent member list with `owner`, `admin`, and `member` roles. An Agent's capabilities are determined by its mounted MCP Servers: once internal logging systems, databases, or deployment services are wrapped as MCP Servers and mounted onto an Agent, the Agent can invoke their Tools.

The MCP specification defines the tool-calling protocol between client and server. Operating inside a multi-user group chat introduces three requirements not covered by the base specification:

- **Caller identity**: The MCP Server needs to identify the calling Agent along with its organization and assigned roles;
- **Human-in-the-loop confirmation**: Destructive or state-changing write operations require explicit human approval before execution;
- **Interactive UI**: Forms, dashboards, and consoles need a dedicated layout and entry point in the group chat.

Nia Teams addresses these with Workload OIDC, TaskBar, and Workspace Apps. This SDK provides their server-side integration.

[Screenshot: GroupChat interface highlighting the TaskBar, Workspace sidebar, and Apps menu]

### Workload OIDC

Acting as an OIDC Issuer (`https://nia-teams.com`), Nia Teams attaches an RS256-signed JWT in the `Authorization` header on every request to an MCP Server. Its claims carry the Agent identifier (`sub`) and its team, organization, and role memberships (`groups`). The MCP Server verifies signatures against the Issuer's public JWKS without issuing or rotating static API keys.

JWTs have a 5-minute TTL and are refreshed automatically by the platform. Full claim definitions are covered in Section 6 and [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md).

### TaskBar

The TaskBar sits above the group-chat message input and displays action cards awaiting confirmation.

[Screenshot: A confirmation card in the TaskBar]

Write operations integrated with the TaskBar are split into two Tools:

1. **Propose tool**: Invoked by the Agent. It returns a `_niaCard` envelope that the platform renders as a confirmation card in the TaskBar. This Tool should not produce side effects.
2. **Execute tool**: Invoked by the platform after an authorized member clicks confirm. The request carries `nia/confirmationToken` in `_meta` — a signed JWT binding the confirming user, card ID, target server and tool, and the SHA-256 digest of the canonical JSON arguments to prevent parameter tampering and support audit trails.

### Workspace App

MCP Apps (SEP-1865, `@modelcontextprotocol/ext-apps`) is an official MCP extension: a Tool declares a `ui://` HTML resource rendered by the host in an iframe, which invokes server Tools over `postMessage`. Most hosts render MCP Apps inline inside the message stream.

Nia Teams extends MCP Apps with three capabilities:

- **Workspace sidebar**: Declaring `_meta["nia/workspace"]` opens the App in a dedicated right-hand split pane alongside the group chat (or full-screen on mobile);
- **Apps menu entrypoint**: Declaring `_meta["openai/ui.entrypoints"]` pins the App to the Apps menu in the group-chat header so members can open it directly without invoking the Agent;
- **Viewer context**: On each tool call, the platform injects the active user's ID and role; declaring `_meta["nia/requireTeamAdmin"]` hides the App from regular `member` users.

[Screenshot: Operations console open in the Workspace sidebar]

### Standard MCP vs. Nia Teams Extensions

| Module | Standard MCP / Official Packages | Nia Teams Extensions |
| --- | --- | --- |
| Transport & tool calling | Streamable HTTP, JSON-RPC, `McpServer` | None |
| Authentication | Reserves `Authorization` header and `_meta` | Workload OIDC JWT, confirmation token |
| Human confirmation | `structuredContent` | `_niaCard`, TaskBar rendering, execute tool callback |
| Interactive UI | MCP Apps (`ui://` resource, iframe, `postMessage`) | Workspace sidebar, Apps menu entrypoint, viewer context |

Transport and MCP Apps use the official SDKs directly; `@nia-teams/mcp-sdk` implements the right-hand column.

---

## 2. Installation & Subpaths

Requires Node.js 20+ (ESM + TypeScript declarations).

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| Subpath | Environment | Responsibility |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | Verify `Authorization` Bearer JWTs, `nia/confirmationToken`, and canonical JSON argument digests |
| `@nia-teams/mcp-sdk/cards` | Node.js | Build `_niaCard` envelopes, format execution results, verify webhook HMAC signatures |
| `@nia-teams/mcp-sdk/apps` | Node.js | Register Workspace Apps (`ui://`), validate viewer context, configure API path allowlists |
| `@nia-teams/mcp-sdk/apps/client` | Browser | Re-export official `App` / `PostMessageTransport` and provide the `createMcpAppFetch` adapter |
| `@nia-teams/mcp-sdk/testing` | Node.js (test) | In-memory OIDC provider, test keypair generator, and confirmation token signers |
| `@nia-teams/mcp-sdk` | Node.js | Server-side barrel re-exporting `auth`, `cards`, `apps`, and `testing` |

---

## 3. Quickstart

### 1. Start an MCP Server with OIDC Verification

Expose a `/mcp` endpoint using `StreamableHTTPServerTransport` and verify the `Authorization` header with `auth.verifyBearerHeader` before dispatching requests:

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
    // Verify the Authorization Bearer JWT:
    // Agent calls carry principalType "workload"; platform card callbacks carry "service"
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

### 2. Mount onto an Agent

Deploy the server to a publicly reachable HTTPS endpoint (such as `https://ops.acme.com/mcp`; loopback and private IP ranges are rejected), then instruct the target Agent in chat:

> Connect MCP server `ops` at `https://ops.acme.com/mcp`

The Agent invokes its built-in `mcp_servers` Tool to emit a configuration card in the TaskBar. The mount takes effect once an `owner` or `admin` of that Agent confirms the card (or configures it under Agent Settings → MCP).

Leave custom `Authorization` headers empty when mounting so Nia Teams injects the Workload OIDC JWT automatically. A Tool registered as `query_service_logs` on the server is exposed to the Agent as `mcp__ops__query_service_logs`.

---

## 4. TaskBar Confirmation Cards

Split write operations into two Tools: `propose_restart` acts as the propose tool, returning a confirmation card without modifying target state; `execute_restart` acts as the execute tool, invoked by the platform after a member confirms.

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// 1. Propose tool: invoked by the Agent, returns a confirmation card for the TaskBar
server.registerTool(
  "propose_restart",
  {
    description: "Propose restarting a production service and emit a TaskBar confirmation card",
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
        server: "ops", // Matches the MCP mount name configured on the Agent
        toolName: "execute_restart",
        arguments: args,
      }),
    );
  },
);

// 2. Execute tool: invoked by the platform after a member confirms the TaskBar card
server.registerTool(
  "execute_restart",
  {
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
    annotations: { destructiveHint: true },
  },
  async (args, extra) => {
    // Verify the platform-signed nia/confirmationToken, server, tool, cardId, and argument digest
    const human = await auth.verifyHumanActionContext(extra._meta, {
      server: "ops",
      tool: "execute_restart",
      arguments: args,
      expectedCardId: `restart:${args.service}:v${args.expectedVersion}`,
    });

    // human.confirmedBy is the confirming user's 24-character hex Nia Teams user ID
    if (!(await db.canUserRestartService(human.confirmedBy, args.service))) {
      return cardActionError("Only service owners may restart production instances", {
        errorKind: "auth_forbidden",
      });
    }

    // Enforce idempotency via database version CAS to prevent concurrent clicks or replay
    const applied = await db.applyRestartCas(args.service, args.expectedVersion, {
      approvedBy: human.confirmedBy,
      approvedByName: human.confirmedByName,
      jti: human.jti,
    });
    if (!applied) {
      return cardActionError("Operation already executed or version changed");
    }

    return cardActionSuccess({
      statusLabel: "Restarted",
      result: { service: args.service, approvedBy: human.confirmedBy },
    });
  },
);
```

To dispatch an asynchronous HTTP webhook upon confirmation instead of an MCP Tool callback, use `createWebhookConfirmCard({ title, url, mcpServerName: "ops", pendingInput })` and verify `req.headers["x-nia-signature"]` against the raw request body bytes using `verifyCardSignature(secret, rawBodyBuffer, header)`.

---

## 5. Workspace App

Bundle the frontend into a single HTML file using `vite-plugin-singlefile` and register the `ui://` resource and associated Tools on the server with `registerNiaWorkspaceApp`. The iframe does not handle authentication tokens.

### 1. Frontend Build & Client Calls

```ts
// ui/vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
});
```

Import the browser entrypoint `@nia-teams/mcp-sdk/apps/client`:

```ts
// ui/src/main.ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";

const app = new App({ name: "Ops Console", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "ops_console_api" });

// Connects lazily on first call and forwards requests to ops_console_api over postMessage
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
  threadEntrypoint: true, // Register in the group-chat header Apps menu
  requireTeamAdmin: true, // Visible only to the Agent's owner and admin
  visibility: ["app"],
  entryTool: {
    name: "open_ops_console",
    title: "Ops Console",
    handler: async (extra) => {
      verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      return { content: [{ type: "text", text: "Ops Console ready" }] };
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

## 6. Token Claims & Role Authorization

MCP requests carry two layers of identity: the outer HTTP `Authorization` header identifies the calling principal (Agent workload or platform callback service), while the inner MCP `_meta` object identifies the member who confirmed a card or interacted with a Workspace App.

### 1. Workload OIDC JWT (HTTP Header)

Example payload verified and decoded by `verifyBearerHeader`:

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

- `identity.subject` (`sub`): The Agent identifier (e.g. `"ops-agent"`). When a member confirms a TaskBar card, the platform invokes the callback using its service principal: `sub: "nia-teams-platform"`, `principal_type: "service"`.
- `identity.orgs` / `identity.teams` / `identity.roles`: Prefix-stripped arrays extracted from `groups`. `role:*` represents a platform `AuthorizationRole` bound to the Agent, distinct from a human member's `owner` / `admin` / `member` role.

### 2. Confirmation Token (`_meta["nia/confirmationToken"]`)

Example payload passed in `extra._meta["nia/confirmationToken"]` when a member confirms a TaskBar card:

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

`verifyHumanActionContext` validates the signature, 5-minute lifetime, `context_server`, `context_tool`, `confirmation_card_id`, and argument digest, returning `confirmedBy` (user ID) and `confirmedByName`.

### 3. Member Role (`owner` / `admin` / `member`) Authorization

- **MCP Server mount configuration**: Any group-chat participant can ask the Agent to propose a mount, but only an `owner` or `admin` of that Agent can confirm the configuration card.
- **TaskBar card callbacks**: By default, the platform verifies that the confirming user is a member of the Agent (`owner`, `admin`, or `member`). To restrict approval to specific users, check `human.confirmedBy` against your authorization table, or set `requiresIdentity: { provider: "gitlab" }` on the card so the platform passes the user's external OAuth token in `human.identityToken`. (Note: `human.sourceTeam?.role` is populated only on built-in platform role-approval flows, not on custom mounts.)
- **Workspace App access control**: On each `entryTool` and `apiTool` invocation, the platform injects `viewerUserId` and `viewerTeamRole` into `extra._meta.boundContext`. Verify the outer HTTP connection with `verifyBearerHeader` (restricting `allowedSubjects` / `requiredGroups`) first, then validate the member's role with `verifyBoundViewer`:
  - Allow `owner`, `admin`, and `member`: `verifyBoundViewer(extra._meta)`
  - Allow `owner` and `admin` only: `verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`
  - Allow `owner` only: check `if (viewer.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "Owner required")`

---

## 7. Offline Unit Testing

`@nia-teams/mcp-sdk/testing` provides an in-memory OIDC Provider and token signers that pair with the official `InMemoryTransport` for offline unit tests:

```ts
import { expect, test } from "vitest";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";

test("verifies workload JWT and confirmation token offline", async () => {
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

## 8. Examples & Specification

- Runnable examples:
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) — Read-only log query server with Workload OIDC verification
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) — Two-step propose / execute confirmation card with version CAS
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) & [`examples/workspace-ui/`](./examples/workspace-ui) — Workspace App server and single-file frontend
- AI coding guide: [`AGENTS.md`](./AGENTS.md)
- Wire protocol specification: [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md)

## License

[MIT](./LICENSE) © Nia Teams
