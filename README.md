# @nia-teams/mcp-sdk

Small, production-compatible Nia Teams extensions for enterprise MCP servers:
**workload OIDC**, **human-confirmed TaskBar cards**, and **Workspace MCP Apps**.

Maintained by [Nia Teams](https://nia-teams.com) ·
[GitHub](https://github.com/nia-teams/mcp-sdk) · [MIT](LICENSE)

## Architecture: official protocols, thin extensions

```text
Enterprise MCP server
  @modelcontextprotocol/sdk             server, client, types, transports
  @modelcontextprotocol/ext-apps/server UI tools and ui:// HTML resources
  @nia-teams/mcp-sdk                    Nia auth, cards, workspace metadata
    jose                               RS256 / JWKS verification

Workspace UI
  @modelcontextprotocol/ext-apps       App, ui/initialize, postMessage JSON-RPC
  @nia-teams/mcp-sdk/apps/client        fetch-like JSON REST → tools/call
  vite-plugin-singlefile               bundle the UI as one HTML resource
```

This package does **not** implement an MCP server, JWT parser, Apps host, React
hooks, postMessage protocol, or HTML bundler. Use the official SDKs for those.
Official React hooks remain available from `@modelcontextprotocol/ext-apps/react`.
Standard MCP clients continue to see ordinary `content[].text` tool results.

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
} from "@nia-teams/mcp-sdk/apps";

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
      // Check createSafeApiPathChecker(...), then dispatch to your own business layer.
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
```

`signTestConfirmationToken(provider, { server, tool, arguments, cardId, ... })`
and `signTestViewerContextToken(...)` sign bounded human-context JWTs. They return
token strings, not enclosing metadata. The provider must have TTL <= 300 seconds.
Test-only keys and issuers must never become production trust anchors.

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
