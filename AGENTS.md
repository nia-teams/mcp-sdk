# AGENTS.md

Instructions for AI coding agents building enterprise MCP servers with `@nia-teams/mcp-sdk` or contributing to this repository.

## Core Architecture

`@nia-teams/mcp-sdk` extends the official `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` packages for Nia Teams. Keep standard MCP transport, tool schemas, `ui://` resource serving, and `postMessage` bridging in the official packages; use `@nia-teams/mcp-sdk` for Nia Teams authentication, TaskBar confirmation cards, and right-sidebar Workspace App integration.

### Subpath Boundaries

- `@nia-teams/mcp-sdk/auth` (Node.js): `createWorkloadOidcVerifier`, `WorkloadOidcError`, `canonicalJson`, `canonicalJsonSha256`, and issuer/audience constants.
- `@nia-teams/mcp-sdk/cards` (Node.js): `createMcpConfirmCard`, `createWebhookConfirmCard`, `cardToolResult`, `withConfirmCard`, `cardActionSuccess`, `cardActionError`, `createCardId`, `signCardBody`, `verifyCardSignature`.
- `@nia-teams/mcp-sdk/apps` (Node.js): Re-exports `@modelcontextprotocol/ext-apps/server` (`registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`) plus `niaWorkspaceMeta`, `registerNiaWorkspaceApp`, `verifyBoundViewer`, and `createSafeApiPathChecker`.
- `@nia-teams/mcp-sdk/apps/client` (Browser): Re-exports `@modelcontextprotocol/ext-apps` (`App`, `PostMessageTransport`) plus `createMcpAppFetch` and `isMcpAppEmbedded`. Browser bundles must import only `/apps/client`, never the Node server entrypoints.
- `@nia-teams/mcp-sdk/testing` (Node.js test): `createWorkloadOidcProvider`, `generateTestRsaKeyPair`, `signTestConfirmationToken`, `signTestViewerContextToken`.

## Building a Nia Teams MCP Server

### 1. HTTP Boundary & Workload OIDC

Expose Streamable HTTP (`StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`) and authenticate the `Authorization` header with `createWorkloadOidcVerifier().verifyBearerHeader(...)` before dispatching MCP requests.

- Default trust parameters: `issuer: "https://nia-teams.com"`, `audience: "nia-teams-workload"`, `jwksUrl: "https://nia-teams.com/oauth2/jwks"`, algorithm `RS256`.
- Normal Agent and Workspace App requests carry `principal_type: "workload"`, `sub: "<agentSlug>"`, and `groups` (`team:<slug>`, `org:<slug>`, `role:<roleKey>`). Scope data queries to `identity.subject`, `identity.orgs`, and `identity.roles`.
- When a human clicks a TaskBar confirmation card with an MCP handler, Nia Teams calls the MCP server using its platform callback token (`principal_type: "service"`, `sub: "nia-teams-platform"`). Enable `allowServicePrincipal: true` on the HTTP route that receives card callbacks, and require `identity.principalType === "workload"` inside ordinary Agent-invoked read/proposal tools.

### 2. Human-Confirmed Mutations (TaskBar Cards)

Model every state-changing or destructive action as two separate tools:

1. **Proposal tool** (called by the AI): Persist pending intent if needed and return `cardToolResult(summaryText, createMcpConfirmCard({ cardId, title, server, toolName, arguments }))`. Never mutate target state inside the proposal tool. Note that `server` must equal the mount name configured on the Agent (for example `"ops"`), not `McpServer` `serverInfo.name`.
2. **Execution tool** (called after human click): Call `await auth.verifyHumanActionContext(extra._meta, { server, tool, arguments: args, expectedCardId })` first. This verifies the RS256 platform signature, 5-minute TTL, `human_confirmed: true`, `cardId`, and `canonicalJsonSha256(args)`. Then check business authorization for `human.confirmedBy` (or `human.identityToken` when `requiresIdentity` is used), execute atomically with a durable database CAS / version check, and return `cardActionSuccess(...)` or `cardActionError(...)`.

If using webhook callbacks (`createWebhookConfirmCard`), pass the raw unparsed request body bytes to `verifyCardSignature(secret, rawBodyBuffer, req.headers["x-nia-signature"])` when `webhookSecret` is configured.

### 3. Right-Sidebar Workspace Apps

- Build the frontend into a single inline HTML file using Vite + `vite-plugin-singlefile` and serve it with `RESOURCE_MIME_TYPE` (`text/html;profile=mcp-app`) at a `ui://` URI via `registerNiaWorkspaceApp`.
- Set `threadEntrypoint: true` to list the App in the GroupChat top **Apps** menu, and `requireTeamAdmin: true` when regular `member` users should not see or open it.
- In browser code, use `App` from `@nia-teams/mcp-sdk/apps/client` (and `@modelcontextprotocol/ext-apps/react` hooks for React UIs). Use `createMcpAppFetch({ app, apiToolName })` to forward relative `GET` / `POST` `/api/...` JSON requests over `app.callServerTool`.
- On the server, validate every `entryTool` and `apiTool` call with `verifyBoundViewer(extra._meta, { requireTeamAdmin })` and `createSafeApiPathChecker(...)`. Remember that `_meta.boundContext` (`{ viewerUserId, viewerTeamRole }`) is an unencrypted host assertion — only trust it after `verifyBearerHeader` has authenticated the Nia Teams workload connection for your expected Agent subject/groups.
  - Allow `owner` / `admin` / `member`: `verifyBoundViewer(extra._meta)`
  - Allow `owner` / `admin` only: `verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`
  - Allow `owner` only: check `viewer.viewerTeamRole === "owner"`

### 4. Mounting onto Nia Teams

- Endpoints must be reachable from Nia Teams over Streamable HTTP (`https://...`), avoiding loopback, RFC1918 private IPs, link-local ranges, and `.local` / `.internal` hostnames.
- Mount names match `^[a-zA-Z0-9-]+$`. Agent-visible tool names become `mcp__<mountName>__<toolName>`, while the MCP server registers `<toolName>`.
- Omit static `Authorization` headers when mounting so Nia Teams automatically injects and refreshes its 5-minute RS256 Workload OIDC token.
- Anyone in chat can ask an Agent to propose an `mcp_servers` update, which creates a confirmation card; a live `owner` or `admin` of that Agent must click Confirm to apply it.

### 5. Local Verification

Write offline unit and round-trip tests before deployment using `@nia-teams/mcp-sdk/testing` (`createWorkloadOidcProvider`, `generateTestRsaKeyPair`, `signTestConfirmationToken`) together with `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js`. Cover both happy paths and rejection cases (wrong role/group, tampered arguments, replayed confirmation, unauthorized viewer role, disallowed API path).

## Maintaining This Repository

Run all verification checks from the repository root before committing:

```sh
npm test
npm run typecheck
npm run build
```

When touching `src/apps/client.ts` or `examples/workspace-ui/`, also verify the single-file frontend build:

```sh
npm --prefix examples/workspace-ui run typecheck
npm --prefix examples/workspace-ui run build
```

Repository invariants:

- Keep `canonicalJson` and `canonicalJsonSha256` wire-compatible with Nia Teams (`src/canonical-json.ts`): lexicographic UTF-16 code-unit key sorting, dense arrays only, explicit errors on sparse arrays, `undefined`, non-plain objects, and circular references.
- Keep `README.md`, `README_CN.md`, and `docs/SPECIFICATION.md` aligned whenever public APIs or wire claims change.
- Verify `npm pack --dry-run` before publishing to ensure only `dist/` and public documentation are packaged.
