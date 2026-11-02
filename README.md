# @nia-teams/mcp-sdk

English | [简体中文](./README_CN.md)

Connect enterprise services (databases, logs, deployment pipelines, approvals, and admin consoles) to [Nia Teams](https://nia-teams.com) over MCP.

Before jumping into code, this guide first explains **what these capabilities are inside Nia Teams**, **what comes from standard MCP vs. what Nia Teams extends**, and **what the OIDC tokens actually look like on the wire**.

---

## 1. Background: How Nia Teams Extends MCP

In Nia Teams, humans and AI Agents work together inside shared GroupChats. When you mount an MCP server onto an Agent, your server participates in three core Nia Teams product primitives beyond plain tool calls:

### 1.1 Workload OIDC Authentication (Zero Static API Keys)

In typical setups, connecting an external service to an Agent requires generating a static API key, pasting it into Agent settings, and rotating it manually.

Nia Teams includes a built-in **Workload OIDC issuer** (`https://nia-teams.com`):
- As long as you leave custom `Authorization` headers empty when mounting your MCP server, **every HTTP request** Nia Teams sends to your `/mcp` endpoint automatically carries a short-lived RS256 Bearer JWT (`Authorization: Bearer <JWT>`, 5-minute TTL, refreshed 30 seconds before expiry).
- Your server stores zero shared secrets. It verifies the JWT against Nia Teams' public JWKS (`https://nia-teams.com/oauth2/jwks`) and reads which Agent is calling, which organization (`org:*`) it belongs to, and which platform roles (`role:*`) it holds.

#### What do the OIDC tokens look like?

Nia Teams signs **two kinds** of RS256 JWTs under the same issuer and JWKS (distinguished by `principal_type` and where they are carried):

**(1) Outer HTTP `Authorization: Bearer <JWT>` — When an Agent calls a tool or opens a Workspace App (`principal_type: "workload"`)**

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "ops-agent",
  "principal_type": "workload",
  "groups": [
    "team:ops-agent",
    "org:acme",
    "role:ops.reader"
  ],
  "iat": 1790812800,
  "nbf": 1790812800,
  "exp": 1790813100,
  "jti": "c9f7e120-531b-45c4-98d4-9ef8a3a01234"
}
```
- `sub`: The calling **Agent's slug** (identifies the Agent workload, not a human in chat).
- `groups`: The Agent's team (`team:<slug>`), organization (`org:<slug>`), and platform-assigned `AuthorizationRole`s (`role:<roleKey>`, plus `nia:elevated:role:<roleKey>` when a human has approved temporary session elevation).

**(2) Inner MCP `_meta["nia/confirmationToken"]` — When a human clicks Confirm on a TaskBar card and Nia Teams invokes the execution tool (`principal_type: "service"`)**

On card-confirmation callbacks, the outer HTTP Bearer token identifies the platform callback service (`sub: "nia-teams-platform"`, `principal_type: "service"`), while MCP `params._meta["nia/confirmationToken"]` carries a signed JWT locked to the exact human click and tool arguments:

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
  "nbf": 1790812860,
  "exp": 1790813160,
  "jti": "38a1b544-89ef-4a0e-b8c1-7640219c5511"
}
```
- `confirmed_by` / `confirmed_by_name`: The 24-character hex Nia Teams user ID and display name of the human who clicked the button.
- `context_server` / `context_tool` / `context_arguments_sha256`: Cryptographically binds the token to the target mount name, tool name, and canonical JSON SHA-256 digest of the arguments — if any argument is modified, verification fails with `403`.

---

### 1.2 What is the TaskBar (Human Confirmation Cards)?

In every Nia Teams GroupChat, directly **below the message timeline and above the composer / Agent execution bar**, sits a persistent action strip called the **TaskBar**.

The TaskBar is Nia Teams' **human-in-the-loop gate for write operations**:
- When an Agent wants to perform a state-changing or destructive action (restarting a production service, running a database migration, merging an MR, changing permissions), it does not execute the mutation directly. Instead, it calls a **proposal tool** that returns a structured confirmation card (`_niaCard: true`).
- Nia Teams renders that card in the GroupChat's TaskBar (and increments the chat's unread action badge), showing the title, description, optional detail view, and a **Confirm** button (optionally requiring external OAuth such as GitLab or GitHub via `requiresIdentity`).
- **Nothing mutates while the card is pending.** Only after an authorized human clicks the button in the TaskBar does Nia Teams mint the `nia/confirmationToken` above, invoke your **execution tool** (or signed webhook), and transition the card to running / succeeded / failed.

---

### 1.3 What is an MCP App & the Right-Sidebar Console (Workspace App)?

The official MCP extension [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865) defines **MCP Apps**: an MCP server can serve an HTML application at a `ui://` resource URI (`text/html;profile=mcp-app`), and the iframe talks back to the MCP server over `postMessage` using `app.callServerTool(...)`.

In generic MCP clients, an MCP App renders as a small inline card inside a single chat message bubble and scrolls out of view. **Nia Teams extends standard MCP Apps into a persistent Right-Sidebar Console (Workspace App)**:
- **Desktop right-hand split pane / mobile full-screen sheet**: When a tool sets `_meta["nia/workspace"]: true`, opening the MCP App docks it in the **right-hand split workspace** alongside the chat — so your team can inspect dashboards, review queues, or edit configurations on the right while continuing to talk with colleagues and Agents on the left.
- **GroupChat top "Apps" menu entrypoint**: Setting `threadEntrypoint: true` adds the console directly to the **Apps** dropdown in the GroupChat header. Humans can open the console with one click at any time without asking the AI to invoke a tool first.
- **Live viewer role injection**: Whenever a human opens the sidebar console or triggers a request from it, Nia Teams resolves that human's live role on the Agent (`owner`, `admin`, or `member`) and injects it into the tool call's `_meta.boundContext`, and can hide admin-only consoles from regular members (`requireTeamAdmin: true`).

---

### 1.4 Standard MCP vs. Nia Teams Extensions at a Glance

`@nia-teams/mcp-sdk` is a thin layer on top of [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps). Standard MCP handles transport and UI bridging; this package adds the Nia Teams extensions in the right column:

| Capability | Standard MCP (`@modelcontextprotocol/sdk` & `ext-apps`) | Nia Teams Extension (`@nia-teams/mcp-sdk`) |
| --- | --- | --- |
| **Transport & Core Primitives** | JSON-RPC 2.0, `StreamableHTTPServerTransport`, `McpServer.registerTool` / `registerResource`, `CallToolResult` | No custom wrapper needed — 100% native `@modelcontextprotocol/sdk` |
| **Identity & Auth (`/auth`)** | Leaves HTTP headers and JSON-RPC `_meta` open to host implementations | • Automatic outbound Workload OIDC RS256 JWTs (`iss=https://nia-teams.com`) + `createWorkloadOidcVerifier`<br>• Signed `_meta["nia/confirmationToken"]` / `_meta["nia/viewerContextToken"]` + `canonicalJsonSha256` argument binding |
| **TaskBar Confirm Cards (`/cards`)** | Standard `CallToolResult.structuredContent` container | • `structuredContent: { _niaCard: true, card }` TaskBar card schema<br>• Two-step proposal + execution tool callbacks, external OAuth binding (`requiresIdentity`), and `X-Nia-Signature` webhook HMAC helpers |
| **Sidebar Workspace Apps (`/apps`, `/apps/client`)** | `ui://` HTML resources (`text/html;profile=mcp-app`), `registerAppTool` / `registerAppResource`, browser `App` & `PostMessageTransport` | • Right-sidebar split workspace docking (`_meta["nia/workspace"]`) & GroupChat header **Apps** menu entry (`threadEntrypoint`)<br>• Admin-only visibility (`_meta["nia/requireTeamAdmin"]`) & live viewer role verification (`verifyBoundViewer`)<br>• Browser `createMcpAppFetch` (`fetch('/api/...')` → `app.callServerTool`) & server `createSafeApiPathChecker` route allowlist |

---

## 2. Installation & Package Entrypoints

Requires **Node.js 20+** (ESM + TypeScript declarations).

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| Import path | Environment | Purpose |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | Verify HTTP Bearer JWTs, human confirmation/viewer tokens, and canonical JSON digests |
| `@nia-teams/mcp-sdk/cards` | Node.js | Build TaskBar confirmation cards (`_niaCard`), action results, and webhook HMAC signatures |
| `@nia-teams/mcp-sdk/apps` | Node.js | Register right-sidebar Workspace Apps (`ui://`), validate viewer roles (`verifyBoundViewer`) and safe API paths |
| `@nia-teams/mcp-sdk/apps/client` | Browser | Official `App` / `PostMessageTransport` re-exports + `createMcpAppFetch` REST-to-MCP adapter |
| `@nia-teams/mcp-sdk/testing` | Node.js (Dev) | In-memory OIDC provider, test RSA key generator, and human token signers for Vitest |
| `@nia-teams/mcp-sdk` | Node.js | Server-side barrel re-exporting `auth`, `cards`, `apps`, and `testing` |

---

## 3. Quickstart: Build & Mount in 5 Minutes

### Step 1: Verify OIDC and expose a read-only tool

Create an HTTP `/mcp` endpoint using the official `StreamableHTTPServerTransport` and verify the caller's Bearer JWT before dispatching MCP requests:

```ts
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createWorkloadOidcVerifier, WorkloadOidcError } from "@nia-teams/mcp-sdk/auth";

const auth = createWorkloadOidcVerifier(); // Defaults: iss=https://nia-teams.com, aud=nia-teams-workload

createServer(async (req, res) => {
  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  let server: McpServer | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  try {
    // 1. Authenticate caller at the HTTP boundary:
    //    - Normal Agent calls carry principal_type="workload" and sub="<agentSlug>"
    //    - Platform TaskBar card callbacks carry principal_type="service" and sub="nia-teams-platform"
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
          throw new WorkloadOidcError(403, "Agent requires role:ops.reader");
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

### Step 2: Mount your server onto a Nia Teams Agent

Deploy your server to an HTTPS URL reachable from Nia Teams (for example, `https://ops.acme.com/mcp`), then open a chat with your Agent and say:

> Connect MCP server `ops` at `https://ops.acme.com/mcp`

What happens next:

1. The Agent calls its built-in `mcp_servers` tool (`action: "update"`, `upsert: [{ name: "ops", url: "https://ops.acme.com/mcp" }]`), which posts a **confirmation card** in the TaskBar.
2. An **owner** or **admin** of that Agent clicks **Confirm** on the card (or adds it in **Agent Settings → MCP**).
3. Leave custom `Authorization` headers empty — Nia Teams automatically attaches a fresh RS256 Bearer JWT on every HTTP request (setting a static `Authorization` header disables automatic OIDC injection).
4. Your tools appear to the Agent as `mcp__ops__<toolName>` (for example, `mcp__ops__query_service_logs`), while your server registers plain names (`query_service_logs`).

> **Mount scopes & network rules**
> - **Three mount levels**: **Agent mount** (applies to all chats of that Agent), **Routine mount** (`routine.mcpServers`, isolated to sessions triggered by that Routine), and **Blueprint built-in** (platform-managed and locked).
> - **SSRF protection**: Custom URLs must be `https://` (or `http://`) and cannot target `localhost`, loopback (`127.0.0.0/8`), private RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), or `.local` / `.internal` hostnames.

---

## 4. Pattern 1: Human-Confirmed Writes (TaskBar Cards)

Model every destructive or state-changing operation as two tools: a **proposal tool** (called by the AI, emits a TaskBar card, mutates nothing) and an **execution tool** (called by Nia Teams only after a human clicks **Confirm**).

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// 1. AI calls this tool -> emits a confirmation card in the GroupChat TaskBar
server.registerTool(
  "propose_restart",
  {
    description: "Propose restarting a production service (emits a TaskBar confirmation card)",
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
  },
  async (args) => {
    await db.savePendingRestart(args);
    return cardToolResult(
      `Confirmation card created to restart ${args.service}. Waiting for human approval.`,
      createMcpConfirmCard({
        cardId: `restart:${args.service}:v${args.expectedVersion}`,
        title: `Restart ${args.service}`,
        subtitle: `v${args.expectedVersion}`,
        description: args.reason,
        actionLabel: "Confirm Restart",
        // `server` MUST match the mount name configured on the Agent (e.g. "ops")
        server: "ops",
        toolName: "execute_restart",
        arguments: args,
      }),
    );
  },
);

// 2. Nia Teams calls this tool ONLY after a human clicks "Confirm Restart" in the TaskBar
server.registerTool(
  "execute_restart",
  {
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
    annotations: { destructiveHint: true },
  },
  async (args, extra) => {
    // Cryptographically verifies:
    // - Signed by Nia Teams (`sub: "nia-teams-platform"`, <= 5 min lifetime)
    // - Locked to server="ops", tool="execute_restart", cardId, and canonicalJsonSha256(args)
    const human = await auth.verifyHumanActionContext(extra._meta, {
      server: "ops",
      tool: "execute_restart",
      arguments: args,
      expectedCardId: `restart:${args.service}:v${args.expectedVersion}`,
    });

    // Check business permissions for the clicking user (`human.confirmedBy` is a 24-hex Nia Teams userId)
    if (!(await db.canUserRestartService(human.confirmedBy, args.service))) {
      return cardActionError("Only service owners can approve production restarts", {
        errorKind: "auth_forbidden",
      });
    }

    // Apply atomically with a database CAS / version check so replays or double-clicks are rejected
    const applied = await db.applyRestartCas(args.service, args.expectedVersion, {
      approvedBy: human.confirmedBy,
      approvedByName: human.confirmedByName,
      jti: human.jti,
    });
    if (!applied) {
      return cardActionError("Restart already executed or version changed");
    }

    return cardActionSuccess({
      statusLabel: "Restarted",
      result: { service: args.service, approvedBy: human.confirmedBy },
    });
  },
);
```

Need an async HTTP webhook instead of an MCP execution tool? Use `createWebhookConfirmCard({ title, url, mcpServerName: "ops", pendingInput })`. If you configure `webhookSecret` on the mount, verify `req.headers["x-nia-signature"]` against the raw request body bytes with `verifyCardSignature(secret, rawBodyBuffer, header)`. If no `webhookSecret` is set and the webhook shares the MCP server's origin, Nia Teams signs a Bearer JWT with `human_confirmed: true` and `confirmed_by: "<userId>"`.

---

## 5. Pattern 2: Right-Sidebar Console (Workspace App)

To open an interactive console (dashboards, review queues, config editors) in the right-hand split pane of Nia Teams, bundle your frontend as a single HTML file and register it with `registerNiaWorkspaceApp`. The browser iframe never handles tokens or secrets.

### 1. Bundle your frontend as a single HTML file

Use Vite + `vite-plugin-singlefile` so all JS and CSS inline cleanly into one `ui://` HTML resource:

```ts
// ui/vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
});
```

In your browser code, import `@nia-teams/mcp-sdk/apps/client` (never import the Node server barrel in browser bundles):

```ts
// ui/src/main.ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";

const app = new App({ name: "Ops Console", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "ops_console_api" });

// Lazily connects `app` on first request and forwards GET & POST JSON endpoints over MCP postMessage
const res = await apiFetch("/api/incidents?status=open");
const { incidents } = await res.json();
```

You can also use `@modelcontextprotocol/ext-apps/react` (`useApp`, `useHostStyleVariables`, `useDocumentTheme`) directly in React apps to match Nia Teams' light/dark theme variables.

### 2. Register the Workspace App and API bridge on your MCP server

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
  threadEntrypoint: true,   // Show in the group chat's top "Apps" menu
  requireTeamAdmin: true,   // Hide from regular members; only Agent owner/admin can open
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
      // Verify the live human viewer's role on EVERY call (`owner` or `admin` here)
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

## 6. Permission Reference: Agent, Owner, Admin, and Member

Each Agent in Nia Teams has its own member roster with three roles: **`owner`** (creator or transferred owner), **`admin`** (manages Agent configuration), and **`member`** (uses the Agent and chats).

Keep the two layers distinct: **`role:*` in the outer HTTP JWT is a platform `AuthorizationRole` assigned to the Agent workload, whereas a human's `owner` / `admin` / `member` role is passed inside MCP `_meta`**. Here is how permissions work across every surface:

| Surface | What Nia Teams enforces automatically | What your MCP server receives & enforces |
| --- | --- | --- |
| **Mounting an MCP server** (`mcp_servers`) | Anyone in chat can ask the Agent to propose a mount; **only the Agent's `owner` or `admin`** can click Confirm on the mount card. | N/A (handled by Nia Teams before connecting). |
| **AI calling a read / proposal tool** | Injects the Agent's workload JWT (`sub: "<agentSlug>"`, `groups`). | Check `identity.subject`, `identity.orgs`, and `identity.roles` via `verifyBearerHeader`. |
| **Human clicking a TaskBar Confirm Card** | By default, checks that the clicker is a member (`owner`, `admin`, or `member`) of the Agent that emitted the card. If the card sets `requiresIdentity: { provider }`, skips the Agent-member check, resolves the clicker's external OAuth token, and passes `_meta["nia/identityToken"]`. | Call `verifyHumanActionContext(extra._meta, ...)`:<br>• **Any Agent member**: valid token is sufficient if you have no narrower ACL.<br>• **Specific admins / owners on custom mounts**: check `human.confirmedBy` (24-hex Nia userId) against your enterprise ACL/roster, or verify `human.identityToken` against the upstream provider (e.g. GitHub/GitLab). *(Note: `human.sourceTeam?.role` is only populated on platform role-managed approval cards, not generic custom mounts.)* |
| **Human opening & using a Workspace App** | Requires the user to be in **both** the GroupChat and the Agent's member list. Setting `requireTeamAdmin: true` hides the App from `member` in the top Apps menu and blocks `/apps/open` with 403. | On authenticated Agent mounts, Nia Teams injects live `_meta.boundContext = { viewerUserId, viewerTeamRole }`:<br>• **Allow `owner` / `admin` / `member`**: `const v = verifyBoundViewer(extra._meta)`<br>• **Allow `owner` / `admin` only**: `const v = verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`<br>• **Allow `owner` only**: check `if (v.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "Owner required")` |

> **Security note on `_meta.boundContext`**: Unlike `nia/confirmationToken` (which is a signed JWT), `boundContext` is a plain JSON object injected by Nia Teams over the authenticated MCP connection. Only trust `verifyBoundViewer(extra._meta)` **after** `verifyBearerHeader` has authenticated the Nia Teams workload JWT for your expected Agent `allowedSubjects` / `requiredGroups`.

---

## 7. Testing Locally (Zero Cloud Dependencies)

You do not need a live Nia Teams environment to test your server. `@nia-teams/mcp-sdk/testing` ships an in-memory RS256 OIDC provider and token signers that pair with the official `InMemoryTransport`:

```ts
import { expect, test } from "vitest";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";

test("verifies workload JWT and human confirmation token offline", async () => {
  const provider = createWorkloadOidcProvider({
    issuer: "https://nia-teams.com",
    audience: "nia-teams-workload",
    tokenTtlSeconds: 300,
    activeKey: await generateTestRsaKeyPair(),
  });

  const auth = createWorkloadOidcVerifier({ jwks: await provider.getJwks() });

  // 1. Simulate an Agent workload call
  const agentJwt = await provider.signIdToken({
    subject: "ops-agent",
    groups: ["team:ops-agent", "org:acme", "role:ops.reader"],
    claims: { principal_type: "workload" },
  });
  const identity = await auth.verifyBearerHeader(`Bearer ${agentJwt}`, {
    requiredGroups: ["role:ops.reader"],
  });
  expect(identity.subject).toBe("ops-agent");

  // 2. Simulate a human clicking Confirm on a TaskBar card
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

## 8. Examples & References

- **Runnable examples**:
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) — Streamable HTTP `/mcp` server with OIDC auth and scoped read queries
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) — Two-step proposal + human-confirmed write with version CAS
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) & [`examples/workspace-ui/`](./examples/workspace-ui) — Right-sidebar Workspace App + Vite single-file frontend
- **AI coding guide**: [`AGENTS.md`](./AGENTS.md) — Drop-in context for AI coding agents building or reviewing Nia Teams MCP servers
- **Wire protocol**: [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md) — Exact JWT claims, canonical JSON rules, `_niaCard` schemas, and security invariants

## License

[MIT](./LICENSE) © Nia Teams
