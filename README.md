English | [简体中文](./README_CN.md)

# @nia-teams/mcp-sdk

Build enterprise MCP servers for [Nia Teams](https://nia-teams.com) with verified Agent identity, human-confirmed writes, and right-sidebar Workspace Apps.

`@nia-teams/mcp-sdk` is a thin extension layer on top of the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps). Standard MCP handles JSON-RPC, Streamable HTTP, `tools/call`, `resources/read`, and `ui://` iframe bridging; this package adds the three Nia Teams primitives you need in production:

1. **Zero-static-key OIDC (`/auth`)** — Every HTTP request from Nia Teams carries a short-lived RS256 Bearer JWT (`iss: https://nia-teams.com`, `aud: nia-teams-workload`), verified against public JWKS (`/oauth2/jwks`). No static Agent API keys to issue or rotate.
2. **TaskBar Confirmation Cards (`/cards`)** — Split write operations into a **proposal tool** (called by AI, emits a card, mutates nothing) and an **execution tool** (called only after a human clicks **Confirm**, carrying a signed 5-minute `nia/confirmationToken` locked to the exact server, tool, and canonical SHA-256 of the arguments).
3. **Sidebar Workspace Apps (`/apps`, `/apps/client`)** — Open interactive single-file HTML dashboards in the Nia Teams right-hand split workspace (or group-chat **Apps** menu) with live viewer role context (`owner` / `admin` / `member`) and a 40-line `fetch('/api/...')` → `app.callServerTool` adapter.

## Install

Requires **Node.js 20+** (ESM + TypeScript declarations).

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| Import path | Environment | Purpose |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | Verify HTTP Bearer JWTs, human confirmation/viewer tokens, and canonical JSON digests |
| `@nia-teams/mcp-sdk/cards` | Node.js | Build TaskBar confirmation cards (`_niaCard`), action results, and webhook HMAC signatures |
| `@nia-teams/mcp-sdk/apps` | Node.js | Register Workspace Apps (`ui://`), validate viewer roles (`verifyBoundViewer`) and safe API paths |
| `@nia-teams/mcp-sdk/apps/client` | Browser | Official `App` / `PostMessageTransport` re-exports + `createMcpAppFetch` REST-to-MCP adapter |
| `@nia-teams/mcp-sdk/testing` | Node.js (Dev) | In-memory OIDC provider, test RSA key generator, and human token signers for Vitest |
| `@nia-teams/mcp-sdk` | Node.js | Server-side barrel re-exporting `auth`, `cards`, `apps`, and `testing` |

---

## Quickstart: Build & Mount in 5 Minutes

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
      const status = err instanceof WorkloadOidcError ? err.statusCode : 500;
      res.writeHead(status, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
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
3. Leave custom `Authorization` headers empty — Nia Teams automatically attaches a fresh RS256 Bearer JWT on every HTTP request (5-minute TTL, auto-refreshed 30s before expiry).
4. Your tools appear to the Agent as `mcp__ops__<toolName>` (for example, `mcp__ops__query_service_logs`), while your server registers plain names (`query_service_logs`).

> **Mount scopes & network rules**
> - **Three mount levels**: **Agent mount** (applies to all chats of that Agent), **Routine mount** (`routine.mcpServers`, isolated to sessions triggered by that Routine), and **Blueprint built-in** (platform-managed and locked).
> - **SSRF protection**: Custom URLs must be `https://` (or `http://`) and cannot target `localhost`, loopback (`127.0.0.0/8`), private RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), or `.local` / `.internal` hostnames.

---

## Pattern 1: Human-Confirmed Writes (TaskBar Cards)

AI models should never directly execute destructive mutations (restarting production services, running SQL migrations, transferring ownership). Instead, register two tools:

1. **Proposal tool (`propose_restart`)** — Called by the Agent. Saves a pending record and returns a `_niaCard` envelope. Performs **zero** side effects.
2. **Execution tool (`execute_restart`)** — Invoked by Nia Teams only when a human clicks **Confirm** on the TaskBar card.

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// 1. AI calls this tool -> emits a confirmation card in TaskBar
server.registerTool(
  "propose_restart",
  {
    description: "Propose restarting a production service (requires human confirmation)",
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

// 2. Nia Teams calls this tool ONLY after a human clicks "Confirm Restart"
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

    // Check business permissions for the clicking user (`human.confirmedBy` is their Nia Teams userId)
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

## Pattern 2: Right-Sidebar Workspace Apps

Workspace Apps let humans open a full interactive UI (dashboards, review queues, config editors) in the right-hand split pane of Nia Teams, powered by `@modelcontextprotocol/ext-apps`.

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

// Works like fetch() for relative /api/ GET & POST JSON endpoints over MCP postMessage
const res = await apiFetch("/api/incidents?status=open");
const { incidents } = await res.json();
```

You can also use `@modelcontextprotocol/ext-apps/react` (`useApp`, `useHostStyleVariables`, `useDocumentTheme`) directly in React apps.

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

## Understanding Identity & Permissions

Nia Teams separates **which Agent/service sent the HTTP request** from **which human clicked a button or opened a panel**. Mixing them up is the #1 source of bugs.

### 1. Outer HTTP `Authorization: Bearer <JWT>` — Who is calling?

Every HTTP request to `/mcp` carries an RS256 JWT verifiable against `https://nia-teams.com/oauth2/jwks`:

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "luca-ops",
  "principal_type": "workload",
  "groups": ["team:luca-ops", "org:luca", "role:ops.reader"],
  "iat": 1790812800,
  "exp": 1790813100
}
```

- `identity.subject` (`sub`): For Agent and Workspace App calls, this is the **Agent's slug** (e.g. `"luca-ops"`), **not** a human user. When a human clicks a TaskBar confirmation card, Nia Teams calls your MCP server using its platform callback identity: `sub: "nia-teams-platform"`, `principal_type: "service"`.
- `identity.orgs` / `identity.teams` / `identity.roles`: Parsed from `groups` (`org:*`, `team:*`, `role:*`). Note that `role:*` is a platform `AuthorizationRole` bound to the **Agent** — it is **not** a human's `owner` / `admin` / `member` role.
- `identity.elevatedRoles`: Present only when a human approved temporary session elevation (`nia:elevated:role:<key>`).

### 2. Human Roles (`owner` / `admin` / `member` / External OAuth) — What can the human do?

Each Agent in Nia Teams has its own member roster with three roles: **`owner`** (creator or transferred owner), **`admin`** (manages Agent configuration), and **`member`** (uses the Agent and chats).

Here is how permissions work across every surface and how to enforce `member`, `admin`, or `owner` in your code:

| Surface | What Nia Teams enforces automatically | What your MCP server receives & enforces |
| --- | --- | --- |
| **Mounting an MCP server** (`mcp_servers`) | Anyone in chat can ask the Agent to propose a mount; **only the Agent's `owner` or `admin`** can click Confirm on the mount card. | N/A (handled by Nia Teams before connecting). |
| **AI calling a read / proposal tool** | Injects the Agent's workload JWT (`sub: "<agentSlug>"`, `groups`). | Check `identity.subject`, `identity.orgs`, and `identity.roles` via `verifyBearerHeader`. |
| **Human clicking a TaskBar Confirm Card** | By default, checks that the clicker is a member (`owner`, `admin`, or `member`) of the Agent that emitted the card. If the card sets `requiresIdentity: { provider }`, skips the Agent-member check, resolves the clicker's external OAuth token, and passes `_meta["nia/identityToken"]`. | Call `verifyHumanActionContext(extra._meta, ...)`:<br>• **Any Agent member**: valid token is sufficient if you have no narrower ACL.<br>• **Specific admins / owners on custom mounts**: check `human.confirmedBy` (24-hex Nia userId) against your enterprise ACL/roster, or verify `human.identityToken` against the upstream provider (e.g. GitHub/GitLab). *(Note: `human.sourceTeam?.role` is only populated on platform role-managed approval cards, not generic custom mounts.)* |
| **Human opening & using a Workspace App** | Requires the user to be in **both** the GroupChat and the Agent's member list. Setting `requireTeamAdmin: true` hides the App from `member` in the top Apps menu and blocks `/apps/open` with 403. | On authenticated Agent mounts, Nia Teams injects live `_meta.boundContext = { viewerUserId, viewerTeamRole }`:<br>• **Allow `owner` / `admin` / `member`**: `const v = verifyBoundViewer(extra._meta)`<br>• **Allow `owner` / `admin` only**: `const v = verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`<br>• **Allow `owner` only**: check `if (v.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "Owner required")` |

> **Security note on `_meta.boundContext`**: Unlike `nia/confirmationToken` (which is a signed JWT), `boundContext` is a plain JSON object injected by Nia Teams over the authenticated MCP connection. Only trust `verifyBoundViewer(extra._meta)` **after** `verifyBearerHeader` has authenticated the Nia Teams workload JWT for your expected Agent `allowedSubjects` / `requiredGroups`.

---

## Testing Locally (Zero Cloud Dependencies)

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

## Examples & References

- **Runnable examples**:
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) — Streamable HTTP `/mcp` server with OIDC auth and scoped read queries
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) — Two-step proposal + human-confirmed write with version CAS
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) & [`examples/workspace-ui/`](./examples/workspace-ui) — Right-sidebar Workspace App + Vite single-file frontend
- **AI coding guide**: [`AGENTS.md`](./AGENTS.md) — Drop-in context for AI coding agents building or reviewing Nia Teams MCP servers
- **Wire protocol**: [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md) — Exact JWT claims, canonical JSON rules, `_niaCard` schemas, and security invariants

## License

[MIT](./LICENSE) © Nia Teams
