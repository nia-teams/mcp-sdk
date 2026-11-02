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

**Start here:** [five-step deployment guide](#from-zero-to-mounted-in-nia-teams-five-steps) ·
[OIDC claims](#oidc-agent-identity-is-not-human-authority) ·
[permission matrix](#permission-matrix-whose-authority-do-you-check) ·
[code examples](#1-authenticate-a-workload)

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

## From zero to mounted in Nia Teams: five steps

1. **Initialize your enterprise MCP project.**
   ```sh
   mkdir enterprise-mcp && cd enterprise-mcp
   npm init -y
   npm pkg set type=module
   npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
   npm install --save-dev typescript @types/node vitest
   ```
2. **Authenticate your HTTP `/mcp` boundary before dispatching MCP.** Use the
   official `StreamableHTTPServerTransport`; this SDK does not serve HTTP for you.
   ```ts
   const auth = createWorkloadOidcVerifier(); // import from /auth
   const identity = await auth.verifyBearerHeader(req.headers.authorization, {
     allowedSubjects: ["sec-ops"],
     requiredGroups: ["role:logs.reader"],
   });
   // Bind authorized business queries to identity, then handleRequest(req, res).
   ```
   See [the complete HTTP example](examples/01-readonly-workload-oidc.ts).
   Use a separate, explicitly authorized callback policy for platform service
   requests; do not indiscriminately allow service principals on read/write routes.
3. **Register your capabilities.** Read tools use the verified Agent scope.
   Write tools propose `createMcpConfirmCard` and execute only after
   `verifyHumanActionContext` plus durable business CAS. Workspace Apps use
   `registerNiaWorkspaceApp`, `verifyBoundViewer`, a strict API allowlist, and
   Vite + `vite-plugin-singlefile`. The three scenarios below provide code.
4. **Test offline before deploying.** Put a Vitest test around the local issuer
   example in [Offline tests](#offline-tests), then `npx vitest run`. Use
   `createWorkloadOidcProvider`, `generateTestRsaKeyPair`, and
   `signTestConfirmationToken`, with public `jwks` passed to the verifier.
   Add a real official `InMemoryTransport` Server/Client test, including rejected
   credentials, tampered arguments, member/admin/owner gates, and replay/CAS.
   Tests need no live Nia Teams connection and normally run in seconds; runtime
   is hardware-dependent, not a guaranteed one-second service-level promise.
5. **Deploy, mount, and approve the wiring.** Expose a reachable HTTPS MCP
   endpoint, for example `https://ops.example.com/mcp`. Ask your Nia Teams Agent:
   **“Connect MCP server `my-ops` at `https://ops.example.com/mcp`.”** Confirm the
   resulting TaskBar card as that **Agent Team's owner or admin**. Alternatively
   use the Agent Settings UI. Then ask the Agent to call a read/proposal tool;
   open the workspace from Apps and verify the expected role restrictions.

### Mounting scopes, endpoint rules, and tool names

| Mount                   | Configuration and lifetime                                                                                                     | What it may override                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Agent Team custom mount | Team `mcpServers`, proposed through `mcp_servers` or configured in Agent Settings; applies to that Agent Team                  | Other Team-added entries by name, never Blueprint built-ins                                         |
| Routine overlay         | Routine `mcpServers`; only sessions spawned with that Routine's scope; connection cache `${teamId}:${routineId}:${serverName}` | Same-named Team-added entry locally, or append a new name; never Blueprint built-ins                |
| Blueprint built-in      | Platform catalog connection referenced by Blueprint `mcpManifest`; locked for consuming Teams/Routines                         | Team/Routine config cannot remove, disable, or override it; platform catalog management is separate |

A chat request proposes a mount; **it does not grant the requester's authority**.
A regular member can request a change. The built-in `mcp_servers` call is:

```json
{
  "action": "update",
  "upsert": [{ "name": "my-ops", "url": "https://ops.example.com/mcp" }]
}
```

It emits a TaskBar confirmation card and does not change wiring until approved.
For webhook cards, an entry may additionally set `webhookSecret`; it is optional
and unnecessary for OIDC-based MCP callbacks. Treat it as a real secret, not
public chat/debug output. Configure secrets only through an appropriate trusted
management surface. Re-read current configuration before applying changes.

**Mount confirmation requires a live Team `owner` or `admin`.** Platform admin
is a separate platform-management privilege, not an automatic Team role: the
current mount-card handler checks Team owner/admin membership, so do not assume
that platform-admin status alone can confirm this card. Separate platform
management endpoints may have their own explicit authorization.

The endpoint must use `http://` or `https://` and speak **Streamable HTTP** at the
actual MCP path (commonly `POST /mcp`), not an arbitrary REST API, stdio command,
or legacy SSE-only endpoint. Use HTTPS in production because HTTP exposes Bearer
credentials. It must be reachable **from Nia Teams**, not merely from your laptop.
Custom mounts reject SSRF targets including `localhost`, `127.0.0.0/8`, RFC1918
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local `169.254.0.0/16`,
and `.local` / `.internal` names; additional IPv4/IPv6 special ranges are blocked.
A private enterprise integration needs an explicitly platform-managed network /
catalog arrangement. **Catalog registration is not a documented blanket SSRF
bypass**; current client URL validation also runs for resolved catalog entries.
Do not try to work around it with URL tricks or disable authentication.

Default Agent-visible tool names are `mcp__<serverName>__<toolName>`:
`query_logs` on `my-ops` becomes `mcp__my-ops__query_logs`. The mount name must
match `^[a-zA-Z0-9-]+$`. Some host surfaces can flatten unique tool names; this
is a presentation policy, not a wire-name change. Register raw `query_logs` on
your server. Card handlers and signed context checks use **mount name `my-ops`**
and raw tool name, not the prefixed Agent-visible name or `serverInfo.name`.

**Automatic credentials:** omit a custom `Authorization` header from a normal
mount entry. The host injects a valid RS256 workload Bearer token on **every HTTP
request**, caches it with a **300-second TTL**, and refreshes it **30 seconds
before expiry**, independently of the MCP connection. It does not mint a new JWT
for every request. An explicitly configured Authorization header (any casing)
opts normal mounts out of automatic injection; remove a stale static header
rather than debugging it as an SDK JWKS problem. Platform-brokered service/card
transports have their own service-token policy.

## OIDC: Agent identity is not human authority

OIDC here means the host signs an identity JWT with its private RSA key; your
server verifies its signature and claims using the issuer's **public** JWKS.
You do not need the signing secret or a per-Agent static API key. Discovery is
`https://nia-teams.com/.well-known/openid-configuration`; public keys are at
`https://nia-teams.com/oauth2/jwks`. Only **RS256** is accepted.

Illustrative normal HTTP Bearer payload (times are examples):

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "sec-ops",
  "principal_type": "workload",
  "iat": 1790812800,
  "nbf": 1790812800,
  "exp": 1790813100,
  "jti": "example-unique-token-id",
  "groups": ["team:sec-ops", "org:example", "role:logs.reader"]
}
```

| Claim / group                                            | Meaning, not an implied permission                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sub: <agentTeamSlug>`                                   | Agent Team workload, e.g. `sec-ops` or `luca-root-agent`; **not** the chatting human                                                 |
| `principal_type: "workload"`                             | Normal Agent execution                                                                                                               |
| `sub: "nia-teams-platform"`, `principal_type: "service"` | Platform-brokered transport, including card callbacks; no blanket write permission                                                   |
| `team:<agentSlug>`                                       | Agent Team identity                                                                                                                  |
| `org:<orgSlug>`                                          | Agent Team's Organization, if present                                                                                                |
| `role:<roleKey>`                                         | Platform `AuthorizationRole` bound to this Agent, e.g. `logs.reader` or `nia.infra-agent`; **not** a human `owner/admin/member` role |
| `nia:elevated:role:<roleKey>`                            | Explicit temporary human-approved role elevation, e.g. via `request_session_elevation`; not an ordinary role grant                   |

`verifyBearerHeader(header, { allowedSubjects, requiredGroups,
allowServicePrincipal })` verifies the JWT and policy. `requiredGroups` requires
**all** exact group strings; returned `identity.teams`, `.orgs`, `.roles`, and
`.elevatedRoles` contain deduplicated, prefix-stripped values. For example,
`role:logs.reader` yields `identity.roles.includes('logs.reader')`. An ordinary
role group alone never proves elevation. Role-specific elevated credentials can
have `sub: role:<roleKey>:elevated`; apply the intended subject policy, do not
assume every valid token has a Team slug. The generic automatically injected
Team Bearer does **not** promise to carry a Session's elevation; approved Session
credentials and explicitly brokered human-App elevation are separate paths.

The outer Bearer answers **“which Agent/service is calling?”** A signed
`nia/confirmationToken` / `nia/viewerContextToken` answers **“which human confirmed
or viewed this exact card RPC?”** `nia/sourceContextToken` carries bounded source
Team/actor context on supported role-mounted calls. All bind server/tool/
`context_arguments_sha256`, and context TTL is at most five minutes. Not every
custom mount receives a source-context token or a signed Team role. An App's
`boundContext` is a host assertion, **not a signed JWT by itself**.

## Permission matrix: whose authority do you check?

Human Team roles, Agent workload groups, platform administration, GroupChat
membership, and external OAuth permissions are **different authority domains**.
The Agent Team owner (initially its creator, transferable under ownership rules)
controls the Team and ownership/member administration;
admins manage allowed Team configuration; members chat and access permitted
sessions/apps. Ownership-sensitive actions and private-session visibility still
have separate gates. Neither a role title nor a valid signature bypasses your
enterprise business ACL.

| Action / surface                                 | Team owner                          | Team admin                        | Team member                        | External identity / outsider                                     |
| ------------------------------------------------ | ----------------------------------- | --------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Chat / permitted execution records               | Yes, subject to chat/session access | Same                              | Same                               | GroupChat membership alone does not open Agent execution records |
| Confirm `mcp_servers` configuration change       | Yes                                 | Yes                               | No; may propose                    | External OAuth is not mount authority                            |
| Ordinary confirmation card, no external identity | Default membership gate passes      | Passes                            | Passes                             | Source-Team membership normally required                         |
| Privileged card                                  | Only if that card's policy allows   | Only if that card's policy allows | No when owner/admin is required    | Upstream/provider policy may be decisive                         |
| GroupChat App, no admin flag                     | Yes\*                               | Yes\*                             | Yes\*                              | No, not merely because they are in the chat                      |
| GroupChat App with `requireTeamAdmin: true`      | Yes\*                               | Yes\*                             | Hidden from Apps menu; open denied | No implicit bypass                                               |
| Owner-only enterprise operation                  | Passes explicit owner check         | Denied                            | Denied                             | Only an explicitly configured alternative enterprise ACL         |
| Card with `action.requiresIdentity`              | Provider ACL applies                | Provider ACL applies              | Provider ACL applies               | Can be eligible cross-Team; must satisfy provider/business ACL   |

\* For GroupChat-bound Apps the user must belong to **both the GroupChat and the
Agent Team**, and the Agent must be in that GroupChat (`isAgentExecutionAccessible`).
Non-admin Apps are not public Apps. Platform-admin status is not an implicit
Team membership / workspace-control override.

### A. Agent read / proposal tool

Verify outer HTTP OIDC, then check `identity.subject` with `allowedSubjects`,
organization scope through `identity.orgs`, and required Agent grants through
`requiredGroups` / `identity.roles`. `_meta.boundContext` may accompany a
Routine/App-bound call but is not human consent by itself. AI calls must not
silently execute the proposed mutation.

### B. Human confirms a TaskBar card

**Host gate:** ordinary cards use `checkTeamMembership`: owner, admin, or member
of the emitting Agent Team may confirm by default. Privileged built-ins add
narrower checks. Some platform-special cards have resource-specific exceptions;
do not copy their bypasses into an enterprise executor.

If `action.requiresIdentity: { provider, instance? }` is declared,
`clickBypassesTeamCheck` bypasses the ordinary source-Team membership gate. The
host resolves the clicker's provider credential or prompts authorization, and
passes `_meta['nia/identityToken']`, whose SHA-256 digest is signed as
`context_identity_token_sha256`. This supports legitimate cross-Team approval;
it is **not** automatic permission to mutate upstream resources. The executor
must validate the external token and upstream ACL (e.g. repository Maintainer).
Other chat/card visibility and resource-specific checks still apply.

**Your gate:** call `verifyHumanActionContext(extra._meta, { server, tool,
arguments: args, expectedCardId })`. It returns `confirmedBy` (a Nia Teams user
ID, e.g. dummy `0123456789abcdef01234567`), `confirmedByName`, `cardId`, `jti`,
optional `identityToken`, and optional `sourceTeam: { id, subject, groups, role? }`.
A verified ordinary confirmation is **not** proof of admin or owner status.

```ts
const human = await auth.verifyHumanActionContext(extra._meta, {
  server: "my-ops",
  tool: "apply_change",
  arguments: args,
  expectedCardId,
});
// Owner OR admin, only when the host bound that role into the signed context:
if (human.sourceTeam?.role !== "owner" && human.sourceTeam?.role !== "admin") {
  throw new WorkloadOidcError(
    403,
    "Signed Team owner or admin authority required",
  );
}
// For owner-only operations use: human.sourceTeam?.role === "owner".
// Then enforce your resource ACL and a durable CAS before any side effect.
```

Import `WorkloadOidcError` from `/auth`. `sourceTeam.role` is optional and is
**not currently attached to every custom card**. If absent, fail closed or use
an authoritative enterprise admin/owner roster keyed by `human.confirmedBy`, or
validate `human.identityToken` and the upstream ACL. Never infer a missing role
from `confirmedByName`, Agent `groups`, or producer-supplied metadata. A
`requiresIdentity` declaration can widen the host's default membership gate;
do not add it merely to make an authorization error disappear.

### C. Human opens and uses a Workspace App

The GroupChat Apps catalog and launch path check execution access. With
`_meta['nia/requireTeamAdmin']: true`, ordinary members do not see the App in the
top Apps menu and `/apps/open` rejects them with 403:
`Only Team owner or admin can open this App`. Without the flag, all three Team
roles can open it, subject to the GroupChat/Agent access checks above.

For Agent-bound App entry and iframe calls through
`POST /api/teams/:teamId/mcp-app-tool-call`, the host re-resolves the live Team
role with `roleFromTeam` and injects:

```json
{
  "_meta": {
    "boundContext": {
      "viewerUserId": "0123456789abcdef01234567",
      "viewerTeamRole": "owner"
    }
  }
}
```

After authenticating/authorizing the platform transport, check **every entryTool
and apiTool** (not just the initial HTML load):

```ts
// All Team roles: owner / admin / member.
const viewer = verifyBoundViewer(extra._meta);
// Owner or admin; throws 403 for member.
const privileged = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
// Owner only; no built-in owner-only boolean exists.
if (viewer.viewerTeamRole !== "owner") {
  throw new WorkloadOidcError(403, "Team owner required");
}
// These are alternative policies; choose one per operation.
// Audit viewer.actor: "user:<viewerUserId>"; enforce route/body/business ACLs too.
```

The metadata flag advertises a **launch** restriction; `verifyBoundViewer`
enforces your handler's role restriction. There is no owner-only metadata flag;
an owner-only handler may still be advertised to admins, who must be denied
when they invoke it. A raw MCP client can forge metadata; do not trust a
workload token from an arbitrary client as proof that its `boundContext` came
from the host. Use a trusted host transport boundary and signed contexts where
available. See the workspace code below for `createSafeApiPathChecker`.

### D. Changing Agent wiring is not an enterprise write permission

The built-in `mcp_servers` proposal can be requested by a chatting user, but
only the live Team owner/admin may apply its card. An external admin roster,
OAuth credential, or Agent `role:*` grant does not replace that host-side gate.

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
