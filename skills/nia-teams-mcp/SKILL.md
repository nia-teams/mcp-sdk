---
name: nia-teams-mcp
description: Use when building or modifying an MCP server that uses @nia-teams/mcp-sdk or is mounted on a Nia Teams Agent (Workload OIDC verification, TaskBar confirmation cards, and right-sidebar Workspace Apps).
---

# Nia Teams MCP Server Development

`@nia-teams/mcp-sdk` layers multi-user group-chat primitives onto `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` (SEP-1865). Upstream MCP packages own Streamable HTTP transport, `McpServer` tool and resource registration, `ui://` iframe hosting, and `postMessage` JSON-RPC; `@nia-teams/mcp-sdk` owns caller workload OIDC (`/auth`), human-confirmed TaskBar cards (`/cards`), right-sidebar Workspace App viewer context (`/apps` on Node.js, `/apps/client` in browser bundles), and offline OIDC fixtures (`/testing`). Exact TypeScript signatures live in `node_modules/@nia-teams/mcp-sdk/dist/**/*.d.ts`, runnable integrations in `examples/` (or `node_modules/@nia-teams/mcp-sdk/examples/`), and wire-level claim schemas in `docs/SPECIFICATION.md` (or `node_modules/@nia-teams/mcp-sdk/docs/SPECIFICATION.md`).

## Identity & Trust Model

Instantiate the verifier with `const auth = createWorkloadOidcVerifier()` from `@nia-teams/mcp-sdk/auth` (which defaults to Nia Teams' production issuer and JWKS). Nia Teams separates transport-level caller authentication from human-actor context:

- **Outer HTTP transport (`Authorization: Bearer <JWT>`)**: Agent tool calls and Workspace App requests carry `principal_type: "workload"`, `sub: "<agentSlug>"`, and `groups` (`team:<slug>`, `org:<slug>`, optional `role:<key>`), while TaskBar MCP confirmation callbacks are initiated by the Nia Teams callback service with `principal_type: "service"` and `sub: "nia-teams-platform"`.
- **Route principal selection**: Pass `{ allowServicePrincipal: true }` to `auth.verifyBearerHeader(req.headers.authorization, ...)` on `/mcp` routes that receive TaskBar MCP callbacks; inside ordinary read, proposal, and Workspace App tools, check `identity.principalType === "workload"` and authorize callers by `identity.subject`, `identity.orgs`, or `identity.roles`.
- **Inner human actor (`extra._meta`)**: TaskBar execution callbacks carry `_meta["nia/confirmationToken"]`, an RS256 JWT signed by Nia Teams binding `confirmed_by` (24-hex user ID), `confirmation_card_id`, `context_server`, `context_tool`, and `context_arguments_sha256` (`canonicalJsonSha256(args)`). Workspace App tool calls carry `_meta.boundContext` (`{ viewerUserId, viewerTeamRole }`), a plaintext host assertion of the viewer's live Agent role (`owner` | `admin` | `member`) that `verifyBoundViewer` trusts only after the outer HTTP request passes `auth.verifyBearerHeader` for an authorized `workload` principal.

Expose `/mcp` via `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`, verify `req.headers.authorization` before `transport.handleRequest(req, res)`, and map `WorkloadOidcError` to HTTP `err.statusCode` (`401` or `403`).

## Confirmed Mutations (`/cards`)

Group-chat Agents reason over open-ended conversation, so state-changing operations split across a confirmation boundary:

- **Proposal (`createMcpConfirmCard` / `cardToolResult`)**: Invoked by the Agent without mutating target business state; returns a `_niaCard` envelope for the TaskBar. Set `server` to the MCP mount name configured on the Nia Teams Agent (such as `"ops"`), matching the `context_server` claim signed on confirmation.
- **Execution (`verifyHumanActionContext` / `cardActionSuccess` / `cardActionError`)**: Invoked after a member confirms in the TaskBar. Call `const human = await auth.verifyHumanActionContext(extra._meta, { server, tool, arguments: args, expectedCardId })`, authorize `human.confirmedBy` against business permissions (consuming `human.identityToken` when `requiresIdentity: { provider: "gitlab", instance: "<host>" }` is configured), and guard the state transition with an atomic idempotency check (such as database version CAS or unique `human.jti`).
- **Webhook callbacks (`createWebhookConfirmCard` / `verifyCardSignature`)**: Set `mcpServerName` to the Agent's MCP mount entry carrying `webhookSecret`, and verify `req.headers["x-nia-signature"]` against the raw UTF-8 request body `Buffer` via `verifyCardSignature(secret, rawBodyBuffer, header)`.

## Workspace Apps (`/apps` & `/apps/client`)

- **Browser bundle**: Bundle the UI into a single self-contained HTML string (for example with Vite and `vite-plugin-singlefile`) and import `App` and `createMcpAppFetch` from `@nia-teams/mcp-sdk/apps/client` (web-standard APIs + `@modelcontextprotocol/ext-apps` only). `createMcpAppFetch({ app, apiToolName })` forwards relative `GET` and `POST` `/api/...` JSON calls over `app.callServerTool` and expects `{ status, body }` in `structuredContent`.
- **Server registration & enforcement**: `registerNiaWorkspaceApp` registers the `ui://` resource and emits host `_meta` (`workspace: true` for the right-hand split pane, `threadEntrypoint: true` for the GroupChat header Apps menu, `requireTeamAdmin: true` for host-side `owner`/`admin` gating, `visibility: ["app"]` to scope calls to the Apps menu and iframe). Because `registerNiaWorkspaceApp` sets metadata only, `entryTool` and `apiTool` handlers enforce server-side access via `verifyBoundViewer(extra._meta, { requireTeamAdmin })` and `createSafeApiPathChecker`.

## Mounting & Offline Verification

- **Agent mounting**: Nia Teams connects to publicly reachable `https://` Streamable HTTP endpoints configured via the Agent's `mcp_servers` tool (`headers` left unset for automatic Workload OIDC injection; tools registered as `<tool>` under mount `<mount>` expose to the Agent as `mcp__<mount>__<tool>`).
- **Offline tests (`/testing`)**: Create an in-memory provider with `createWorkloadOidcProvider({ issuer: "https://nia-teams.com", audience: "nia-teams-workload", tokenTtlSeconds: 300, activeKey: await generateTestRsaKeyPair() })`, pass `{ jwks: await provider.getJwks() }` to `createWorkloadOidcVerifier`, and pair `signTestConfirmationToken` / `signTestViewerContextToken` with `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js` to test authorized paths, rejected principals and roles, argument digest mismatches, replay/CAS conflicts, and route allowlists.
