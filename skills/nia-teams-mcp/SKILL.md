---
name: nia-teams-mcp
description: Use when building or modifying an MCP server that uses @nia-teams/mcp-sdk or is mounted on a Nia Teams Agent, including Workload OIDC, TaskBar confirmation cards, asynchronous card status for long-running jobs, and Workspace Apps.
---

# Nia Teams MCP integration

`@modelcontextprotocol/sdk` owns MCP transport and tool registration. `@modelcontextprotocol/ext-apps` owns MCP Apps resources and iframe messaging. This package adds Nia Teams identity verification, confirmation cards, and Workspace metadata.

Create `auth` with `createWorkloadOidcVerifier()` from `@nia-teams/mcp-sdk/auth`. Verify the HTTP Bearer credential before dispatching MCP requests. Authorize the verified Agent or organization with `allowedSubjects` or `requiredGroups`.

## Identity and confirmation

GroupChat Agents reason over open-ended conversation, so state-changing operations cross an explicit human confirmation boundary before execution.

Workload requests identify an Agent; MCP confirmation callbacks identify the Nia Teams service. Callback-capable routes accept `allowServicePrincipal: true`; ordinary read, proposal, and Workspace tools require `identity.principalType === "workload"`.

A proposal returns `cardToolResult` with `createMcpConfirmCard` without changing business state. The card's `server` matches the Agent's MCP mount name.

Execution verifies `extra._meta` through `auth.verifyHumanActionContext` with the expected server, tool, arguments, and card ID. Authorize `human.confirmedBy` through business permissions and apply changes through durable idempotency or version CAS. `requiresIdentity` binds an external OAuth credential to the signed human context.

Webhook receivers authenticate dispatch before trusting its body. HMAC integrations use `verifyCardSignature` on raw request bytes and the mount's `webhookSecret`.

## Asynchronous status

Execution confirmation is bounded to 300 seconds. Verify the human confirmation context at enqueue time inside the execute_* tool handler, not later inside the background worker. The separate `auth.verifyCardCallbackContext` accepts MCP metadata or `{ callbackToken }` and binds a status credential to the expected server and card for at most 7200 seconds.

Store the verified callback in private job storage and return `cardActionRunning` after enqueueing. Workers send serialized `postCardStatus` updates and inspect `CardStatusError.status` on HTTP rejection. Drop running updates that receive `409`; retry terminal success or failed updates once on `409` and report any remaining error. Report a terminal timeout before the callback credential expires for jobs that may exceed two hours. Status credentials authorize card updates only; the SDK derives the URL from the verified issuer and provides no retries or refresh credentials.

## Workspace Apps

Import browser helpers from `@nia-teams/mcp-sdk/apps/client`. Bundle the UI into one HTML file; `createMcpAppFetch` forwards relative JSON API requests over MCP Apps.

`registerNiaWorkspaceApp` registers resources and metadata. Its handlers enforce viewer access with `verifyBoundViewer` and API routes with `createSafeApiPathChecker`. `boundContext` is a host assertion trusted after transport authentication and Agent or organization authorization.

## Reference

Type signatures: `node_modules/@nia-teams/mcp-sdk/dist/**/*.d.ts`.
Runnable examples: `examples/` or `node_modules/@nia-teams/mcp-sdk/examples/`; run TypeScript with `npx tsx`.
Protocol: `docs/SPECIFICATION.md` or `node_modules/@nia-teams/mcp-sdk/docs/SPECIFICATION.md`.
Mounting: use the Agent's `mcp_servers` tool with a public HTTPS endpoint and leave `Authorization` unset for Workload OIDC injection.
Offline fixtures: `@nia-teams/mcp-sdk/testing`; use ephemeral keys and the upstream `InMemoryTransport`.
