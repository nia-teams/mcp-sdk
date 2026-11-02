English | [简体中文](./README_CN.md)

# @nia-teams/mcp-sdk

**Connect enterprise systems to Nia Teams with verified Agent identity,
human-confirmed changes, and embedded workspace UIs—without rebuilding MCP.**

When your enterprise connects databases, logs, deployment pipelines, approval
workflows, or admin dashboards to [Nia Teams](https://nia-teams.com) through the
**Model Context Protocol (MCP)**, the official SDKs handle the base protocol:
`@modelcontextprotocol/sdk` provides JSON-RPC over Streamable HTTP, `tools/call`,
and `resources/read`; `@modelcontextprotocol/ext-apps` provides standard MCP Apps,
`ui://` resources, initialization, and iframe postMessage bridging.

**`@nia-teams/mcp-sdk` is the thin Nia Teams extension layer on top of those
official SDKs.** It adds three enterprise primitives:

1. **Zero-static-secret workload & human-action OIDC** (`/auth`). Agent MCP
   requests carry an RS256 OIDC Bearer JWT: `iss: https://nia-teams.com`,
   `aud: nia-teams-workload`, `sub: <agentSlug>`, and groups such as
   `["team:...", "org:...", "role:..."]`. Verify against `/oauth2/jwks`; no
   long-lived Agent API keys need to be distributed or rotated. For card clicks,
   detail views, and supported role-mounted workspace calls, the host attaches
   a short-lived signed context via `_meta["nia/confirmationToken"]`,
   `_meta["nia/viewerContextToken"]`, or `_meta["nia/sourceContextToken"]` as
   appropriate. Its lifetime is at most five minutes, and it binds the exact
   server, tool name, and canonical SHA-256 argument digest
   (`context_arguments_sha256`). Platform callback service identities use a
   distinct subject; they are not human consent on their own.
2. **Human-in-the-loop TaskBar confirmation cards** (`/cards`). Split a write
   operation into a proposal and an executor. An AI's proposal call returns a
   `_niaCard` envelope in `structuredContent` instead of performing the mutation.
   Nia Teams renders the card in the group chat / TaskBar. Only after an
   authorized human clicks **Confirm** does the host call the executor with
   `nia/confirmationToken`, or POST a webhook signed with
   `X-Nia-Signature` HMAC-SHA256. Your executor still verifies authorization and
   uses a durable business CAS to prevent repeated side effects.
3. **Sidebar Workspace MCP Apps** (`/apps` and `/apps/client`). Build on official
   `ui://` resources with MIME `text/html;profile=mcp-app`. Add
   `_meta["nia/workspace"]: true` for the desktop right-hand split workspace /
   mobile full-screen panel, `_meta["openai/ui.entrypoints"]: [{ type: "thread" }]`
   for the group chat's top Apps menu, and `_meta["nia/requireTeamAdmin"]: true`
   for admin-only advertisements. Helpers validate `_meta.boundContext` viewer
   roles and strict API path allowlists. The small `createMcpAppFetch` browser
   adapter routes existing frontend `fetch('/api/...')`-style calls through
   official `app.callServerTool()`; the official App owns initialization and
   postMessage. Metadata alone is not authorization.

Workload authentication needs no static Agent API secret. The optional webhook
card path **does** use a shared HMAC secret; choose MCP callbacks when you want
OIDC-based confirmation without that webhook secret.

Maintained by **Nia Teams** · [GitHub](https://github.com/nia-teams/mcp-sdk) ·
[MIT](LICENSE) · [AI agent guide](./AGENTS.md) · [Protocol specification](./docs/SPECIFICATION.md)

## End-to-end: three flows, one enterprise MCP server

```text
Nia Teams Host                       Enterprise MCP Server           Enterprise systems
(Agent + authenticated human)        (official MCP SDK + this SDK)

1. READ
Agent -- tools/call + OIDC Bearer --> verifyBearerHeader + policy ---> scoped database/log query
      <-- text / structured data --- standard MCP result <----------- result

2. WRITE WITH HUMAN CONFIRMATION
Agent -- proposal tools/call ------> build _niaCard; NO mutation
Host  <-- text + _niaCard ---------- cardToolResult
Human -- Confirm in TaskBar -------> Host authorizes the click
Host  -- execution tools/call -----> verifyHumanActionContext -------> permissions + durable CAS
         + confirmationToken        (server/tool/arguments/card)      then apply change
      <-- action result ----------- cardActionSuccess / cardActionError
      (Alternative: Host -- raw POST + X-Nia-Signature --> verified webhook)

3. WORKSPACE APP
Host  -- resources/read ui:// -----> single-file HTML resource
      <-- text/html;profile=mcp-app
  |
  +-- Sandbox Iframe (desktop split workspace / mobile full-screen)
      official App.connect() <----> Host's official ui/initialize / postMessage bridge
      createMcpAppFetch('/api/...')
        -> App.callServerTool() ---> Host -- tools/call -------------> API bridge
                                           + authenticated context   verifyBoundViewer
                                                                     + safe path allowlist
                                                                     + business authorization
      <--------------------------- { status, body } <--------------- enterprise API result
```

The iframe never needs the Agent's Bearer token or a webhook secret. The host
owns its credentials and viewer context; the server owns the business decision.

## Official open-source SDKs vs. what this package adds

| Responsibility                                                         | Official package / tool                                                            | What `@nia-teams/mcp-sdk` adds                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| MCP server/client, schemas, transports, `tools/call`, `resources/read` | `@modelcontextprotocol/sdk` (`McpServer`, Streamable HTTP, `InMemoryTransport`)    | No replacement; use these directly                                                                 |
| RS256 signatures, JWT/JWK validation, remote/local JWKS                | `jose`                                                                             | Nia issuer/audience defaults, subject/group policy, bounded exact-call human/source context checks |
| Interactive `ui://` HTML resources and UI tools                        | `@modelcontextprotocol/ext-apps/server` (`registerAppTool`, `registerAppResource`) | Unchanged re-exports, workspace/thread/admin metadata, convenient registration                     |
| `App`, `ui/initialize`, iframe postMessage JSON-RPC, React hooks       | `@modelcontextprotocol/ext-apps` and its `/react` export                           | JSON REST-to-tool adapter; no custom bridge or React hook implementation                           |
| Single-file HTML/JS/CSS bundling                                       | Vite + `vite-plugin-singlefile`                                                    | A working example; no regex bundler                                                                |
| Human confirmation card rendering and callbacks                        | Nia Teams Host                                                                     | `_niaCard` builders, action results, HMAC helpers; no custom card renderer                         |
| Workspace viewer and REST bridge defenses                              | Authenticated host + enterprise application                                        | Bound-viewer validation and strict traversal/query/route allowlists                                |
| Offline extension tests                                                | Official SDK `InMemoryTransport` + `jose`                                          | Local test issuer, RSA keys, confirmation/viewer-context signers                                   |

This package does **not** replace MCP, implement an Apps host, or bundle upstream
SDKs. Standard MCP clients continue to see ordinary `content[].text` results.

## Install

Node.js **20+**, ESM with TypeScript declarations (no CommonJS build).

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| Import                           | Contents                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `@nia-teams/mcp-sdk`             | Server-side barrel: auth, cards, apps, testing                                |
| `@nia-teams/mcp-sdk/auth`        | JWT verification, canonical JSON, constants                                   |
| `@nia-teams/mcp-sdk/cards`       | Card types/builders, action results, HMAC                                     |
| `@nia-teams/mcp-sdk/apps`        | Official server helper re-exports, workspace registration, viewer/path checks |
| `@nia-teams/mcp-sdk/apps/client` | Browser-only `App`, `PostMessageTransport`, JSON fetch adapter                |
| `@nia-teams/mcp-sdk/testing`     | Offline issuer, RSA test keys, human token signers                            |

**Browser code must use `/apps/client`, not the server barrel.**
Peer dependencies use the official SDK; nothing is vendored or forked.

## 1. Authenticate a workload

```ts
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";

const auth = createWorkloadOidcVerifier();
// At the HTTP boundary, before dispatching MCP:
const identity = await auth.verifyBearerHeader(request.headers.authorization, {
  requiredGroups: ["role:logs.reader"],
  // Optional subject allowlist. An empty list denies everyone.
  allowedSubjects: ["example-agent"],
});
// Bind the actual data query to identity.subject / identity.groups.
```

Defaults: issuer `https://nia-teams.com`, audience `nia-teams-workload`, JWKS
`https://nia-teams.com/oauth2/jwks`. Configure `issuer`, `audience`, `jwksUrl`,
`fetchImpl`, or an offline public `jwks`. RS256 is the only accepted algorithm.
`WorkloadOidcError.statusCode` is 401 for missing/expired credentials and 403
for invalid tokens or authorization denials. Infrastructure fetch errors propagate.

Service principals are denied unless `allowServicePrincipal: true` is supplied.
That switch authenticates a principal; it does **not** authorize a mutation.
Use an explicit subject/role policy, not just a valid issuer/audience.

## 2. Propose, then confirm a mutation

```ts
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
} from "@nia-teams/mcp-sdk/cards";

const envelope = createMcpConfirmCard({
  cardId: "changes:change-123",
  title: "Apply change",
  subtitle: "Version 7",
  server: "changes",
  toolName: "apply_change",
  arguments: { changeId: "change-123", expectedVersion: 7 },
});
// Proposal tool returns this; it never performs the mutation.
return cardToolResult("Review and confirm this change.", envelope);
```

In the separate `apply_change` tool:

```ts
const human = await auth.verifyHumanActionContext(extra._meta, {
  server: "changes",
  tool: "apply_change",
  arguments: args,
  expectedCardId: `changes:${args.changeId}`,
});
// Recheck business permissions and atomically apply using a durable version CAS.
// Audit human.confirmedBy and human.jti; reject already-processed changes.
return cardActionSuccess({ result: { changeId: args.changeId } });
```

The platform signs the exact server/tool/arguments/card/viewer binding. Human
contexts last at most five minutes. `intent: 'view'` accepts only
`nia/viewerContextToken` with `human_confirmed: false`; it is not write consent.
Optional `nia/identityToken` is SHA-256-bound to the signed context, but the
external provider's token validity and permissions still need verification.

Other helpers:

- `createWebhookConfirmCard({ title, url, mcpServerName, pendingInput, ... })`.
  Verify `x-nia-signature` against the **raw** body before parsing it.
- `createCardId({ prefix, input, now?, bucketMs? })`: canonical input hash,
  60-second default bucket; omit options for a UUID.
- `withConfirmCard(producer, text?)`: wraps a sync/async **card producer**, never
  a write executor, as a normal async MCP result callback.
- `cardActionError(message, { errorKind? })` and `cardActionSuccess({ status?,
statusLabel?, result?, text? })` implement the exact action-result contract.

Card IDs and JWT `jti` values are **not** a built-in replay store. Use a durable
business transaction/CAS or nonce ledger. HMAC has no timestamp of its own.

## 3. Register a Workspace App

```ts
import {
  registerNiaWorkspaceApp,
  verifyBoundViewer,
  createSafeApiPathChecker,
} from "@nia-teams/mcp-sdk/apps";

const allowed = createSafeApiPathChecker({
  get: [{ pattern: /^\/api\/reports$/, queryKeys: ["limit"] }],
  post: [/^\/api\/reports\/refresh$/],
});

registerNiaWorkspaceApp(server, {
  resourceUri: "ui://example/dashboard",
  html: () => readSingleFileHtml(),
  threadEntrypoint: true,
  requireTeamAdmin: true,
  visibility: ["app"],
  entryTool: {
    name: "open_dashboard",
    title: "Dashboard",
    handler: async (extra) => {
      verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      return { content: [{ type: "text", text: "Dashboard ready" }] };
    },
  },
  apiTool: {
    name: "dashboard_api",
    handler: async ({ method, path, body }, extra) => {
      const viewer = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      if (!allowed(method, path)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Forbidden route" }],
          structuredContent: {
            status: 403,
            body: { error: "Forbidden route" },
          },
        };
      }
      // Dispatch only to your application's authorization-aware business layer.
      const response = await dispatchAuthorizedApi({
        method,
        path,
        body,
        viewer,
      });
      return {
        content: [{ type: "text", text: `HTTP ${response.status}` }],
        structuredContent: { status: response.status, body: response.body },
      };
    },
  },
});
```

Registration adds metadata; it does **not** automatically authorize callbacks.
`boundContext` is trustworthy **only after** authenticating the platform transport
and restricting its authorized Team/role mount. Never accept it as a credential
from arbitrary clients. `verifyBoundViewer` validates a 24-hex viewer ID and
owner/admin/member role; `requireTeamAdmin` denies members.

Browser:

```ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";
const app = new App({ name: "Dashboard", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "dashboard_api" });
const response = await apiFetch("/api/reports?limit=20");
const reports = await response.json();
```

The first call lazily awaits official `app.connect()`. An already initialized
App is reused. Concurrent calls share initialization. This is a **JSON-only**
adapter: GET/POST, relative `/api/` paths, JSON string POST bodies, cancellation,
and `Response` with HTTP status and JSON body. It does not proxy cookies, custom
headers, credentials, streaming, uploads, or arbitrary origins. Validate paths
and business authority again on the server. `isMcpAppEmbedded()` is an iframe
heuristic, not a capability negotiation or authorization check.

Bundle with official tooling:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({ plugins: [viteSingleFile()] });
```

Serve the resulting HTML with MIME `text/html;profile=mcp-app`. Do not manually
rewrite script chunks or implement your own `ui/initialize` / postMessage bridge.

## Offline tests

```ts
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
const provider = createWorkloadOidcProvider({
  issuer: "https://nia-teams.com",
  audience: "nia-teams-workload",
  tokenTtlSeconds: 300,
  activeKey: await generateTestRsaKeyPair(),
});
const verifier = createWorkloadOidcVerifier({ jwks: await provider.getJwks() });
const token = await provider.signIdToken({
  subject: "example-agent",
  groups: ["team:example-agent"],
  claims: { principal_type: "workload" },
});
await verifier.verifyBearerHeader(`Bearer ${token}`);

const confirmationToken = await signTestConfirmationToken(provider, {
  server: "changes",
  tool: "apply_change",
  arguments: { changeId: "change-123", expectedVersion: 7 },
  cardId: "changes:change-123",
});
await verifier.verifyHumanActionContext(
  { "nia/confirmationToken": confirmationToken },
  {
    server: "changes",
    tool: "apply_change",
    arguments: { changeId: "change-123", expectedVersion: 7 },
    expectedCardId: "changes:change-123",
  },
);
```

`signTestConfirmationToken(provider, { server, tool, arguments, cardId, ... })`
and `signTestViewerContextToken(...)` sign bounded human-context JWTs. They return
token strings, not enclosing metadata. The provider must have TTL <= 300 seconds.
Combine these with the official SDK's `InMemoryTransport` for real MCP
Server/Client round trips. Test-only keys and issuers must never become production
trust anchors.

## Examples and development

- [Read-only workload-authenticated HTTP server](examples/01-readonly-workload-oidc.ts)
- [TaskBar proposal and confirmed mutation](examples/02-taskbar-confirm-card.ts)
- [Workspace server](examples/03-workspace-mcp-app.ts) and [bundled UI](examples/workspace-ui)

```sh
npm ci
npm run typecheck
npm test
npm run build
# Optional: build the actual single-file UI example (after building the SDK):
cd examples/workspace-ui && npm install && npm run build
```

Server examples use the public `@nia-teams/mcp-sdk/*` subpaths.
Example 01 listens only with `RUN_EXAMPLE=1` and a TypeScript runner. Examples
02/03 export servers to mount behind your own authenticated MCP HTTP boundary.
Example business data is deliberately stubbed; replace it with authorized queries,
durable transactions, and audit storage.

See [docs/SPECIFICATION.md](docs/SPECIFICATION.md) for exact wire contracts and
security boundaries. MIT license; upstream SDKs remain independently maintained.
