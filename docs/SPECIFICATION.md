# Nia Teams MCP extensions specification

Version 0.1.0. Public origin: <https://nia-teams.com>. Repository:
<https://github.com/nia-teams/mcp-sdk>. The words MUST, SHOULD, and MAY describe
relying-party requirements. These extensions add metadata to standard MCP; they
do not replace the official MCP SDK or MCP Apps (SEP-1865).

## 1. Workload OIDC

### 1.1 Trust and wire claims

An MCP HTTP request carries `Authorization: Bearer <JWT>`. RS256 tokens use a
public RSA key published by the issuer. Defaults:

| Setting                        | Value                                                    |
| ------------------------------ | -------------------------------------------------------- |
| `NIA_DEFAULT_ISSUER`           | `https://nia-teams.com`                                  |
| `NIA_WORKLOAD_AUDIENCE`        | `nia-teams-workload`                                     |
| OIDC discovery                 | `https://nia-teams.com/.well-known/openid-configuration` |
| JWKS URL                       | `${issuer}/oauth2/jwks`                                  |
| `NIA_PLATFORM_SERVICE_SUBJECT` | `nia-teams-platform`                                     |

Example payload (times illustrative):

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "example-agent",
  "principal_type": "workload",
  "iat": 1790812800,
  "nbf": 1790812800,
  "exp": 1790813100,
  "jti": "unique-id",
  "groups": ["team:example-agent", "org:example", "role:logs.reader"]
}
```

`createWorkloadOidcVerifier` uses `jose.createRemoteJWKSet`, or
`createLocalJWKSet` for an explicitly supplied public `jwks`, and `jwtVerify`.
It enforces RS256, issuer, audience, required `sub` and `exp`, expiration and
optional not-before. There is no algorithm fallback and no default clock skew.
The `now` clock option exists for deterministic tests. `fetchImpl` is passed to
jose's official custom-fetch hook; jose owns JWKS caching and refresh.

The identity has `issuer`, `subject`, `principalType`, `groups`, `claims`, and
prefix-stripped, deduplicated `teams`, `orgs`, `roles`, `elevatedRoles` arrays.
The elevated prefix is `nia:elevated:role:`. Parsing a group is **not** a role
permission check. Missing groups yield `[]`; malformed group arrays are denied.
Principal type MUST be `workload` or `service`. The reserved platform subject
MUST be classified as `service`.

`verifyBearerHeader(header, options)`:

- `allowedSubjects`: if supplied, the subject MUST be a member. `[]` denies all.
- `requiredGroups`: all exact strings MUST be present.
- `allowServicePrincipal`: default false. A service bearer is transport identity,
  not blanket human or administrative authority.

`WorkloadOidcError.statusCode`: missing/malformed bearer or expired token → 401;
invalid signature/algorithm/issuer/audience/claims or policy denial → 403.
No token text is included in errors. Unexpected infrastructure errors propagate.
Consumers SHOULD send `WWW-Authenticate: Bearer` on authentication failures and
MUST apply their own data/operation authorization after successful verification.

### 1.2 Bounded signed request contexts

All context JWTs bind one exact RPC:

```json
{
  "context_server": "changes",
  "context_tool": "apply_change",
  "context_arguments_sha256": "lower-case SHA-256 hex digest"
}
```

`expected.arguments` MUST be the exact arguments dispatched to the tool, not a
subset, a reconstructed identity, or an unrelated browser payload.
`context_destination` MAY additionally be signed by the platform, but this SDK
does not treat URL equality as authorization or require it for verification.

`iat` and `exp` MUST be integers. With `now` in Unix seconds:
`iat <= now < exp`, `exp > iat`, `exp - iat <= maxAgeSeconds`,
`now - iat <= maxAgeSeconds`. The default and absolute maximum is 300 seconds;
a relying party MAY reduce `maxAgeSeconds`. `jti` MUST be a nonblank string.
Future `nbf` is rejected by jose.

### 1.3 Canonical JSON and identity digest

`canonicalJson` recursively sorts object keys by JavaScript lexicographic
ordering and directly serializes keys, including integer-like keys (`"10"`
before `"2"`). Arrays preserve order. Strings/numbers use JSON serialization;
only finite numbers, strings, booleans, null, arrays, and plain/null-prototype
objects are accepted. Sparse slots, undefined, functions, symbols, BigInt,
non-plain objects, and cycles are errors. Repeated acyclic references are allowed.
It performs no Unicode normalization and does not invoke object `toJSON` methods.
This is the platform's JSON binding algorithm, not an implementation of every
possible RFC 8785 constraint.

`canonicalJsonSha256(value)` is lower-case hex SHA-256 of the canonical UTF-8
bytes. Do not substitute ordinary `JSON.stringify` for argument binding.
Identity binding instead hashes the **raw UTF-8 token string**, without JSON
quotes: `SHA256(identityToken)`.

### 1.4 Human confirmation and viewer contexts

`verifyHumanActionContext(meta, expected)` reads exactly one metadata key:

| `expected.intent`   | Metadata key             | `human_confirmed` |
| ------------------- | ------------------------ | ----------------- |
| absent or `confirm` | `nia/confirmationToken`  | `true`            |
| `view`              | `nia/viewerContextToken` | `false`           |

The JWT MUST have `sub: "nia-teams-platform"`, `principal_type: "service"`,
the configured issuer/audience, the bounded lifetime above, and these claims:

```json
{
  "human_confirmed": true,
  "confirmed_by": "0123456789abcdef01234567",
  "confirmed_by_name": "Example User",
  "confirmation_card_id": "changes:change-123",
  "context_server": "changes",
  "context_tool": "apply_change",
  "context_arguments_sha256": "..."
}
```

The confirmed ID, name, card ID, and `jti` MUST be nonblank. When
`expected.expectedCardId` is supplied it MUST match `confirmation_card_id`.
The verifier does not infer the card ID from untrusted metadata.

If either `_meta["nia/identityToken"]` or the signed
`context_identity_token_sha256` claim exists, BOTH MUST exist and the digest MUST
match. Return values: `confirmedBy`, `confirmedByName`, `cardId`, `jti`, optional
`identityToken`, optional validated `sourceTeam`, and original `claims`.
An identity digest proves binding, not that the external credential is valid.
Viewer contexts MUST NOT be used to authorize a mutation.

The five-minute window limits token age; it is **not** single-use enforcement.
The business operation MUST implement durable replay protection, normally an
atomic pending-state/version transition. Replays with new `jti` values still
need that same durable gate. Do not rely only on an in-process nonce cache.

### 1.5 Source contexts for role-mounted service/App calls

`verifySourceContext(meta, expected)` reads `nia/sourceContextToken`, validates
its signature/lifetime/exact RPC binding and returns `sourceTeam`, optional
`humanActorUserId`, `jti`, and `claims`.

Required source claims:

- `source_team_id`: lower-case 24-hex Team ID.
- `source_team_subject`: non-reserved alphanumeric/underscore/hyphen subject,
  starting alphanumeric. A 24-hex subject MUST equal the Team ID.
- `source_team_groups`: strings limited to ordinary `team:`, `org:`, `role:`
  groups, including `team:<source_team_subject>`, never elevated role groups.
- Optional `source_team_role`: owner/admin/member.
- Optional `human_actor_user_id`: 24-hex actor ID; mandatory for App workloads.

Supported signed principal forms:

1. Platform service subject + `principal_type: "service"` (AI/service call).
2. `principal_type: "workload"`, `sub === source_team_subject`, matching ordinary
   `groups`, and a signed human actor (ordinary App call).
3. Explicit elevated App form: workload `sub: "role:<key>:elevated"`,
   `human_app_elevation: true`, signed human actor, groups exactly
   `role:<key>` and `nia:elevated:role:<key>`, and ordinary source grants
   including `role:<key>`.

A source context never silently turns a service principal into global/root
business permissions. Consumers MUST independently authorize the source grants,
actor, mounted server and operation. Human action contexts can carry the same
validated ordinary source claims; confirmation does not imply an admin role.

## 2. TaskBar confirmation cards

### 2.1 Envelope and tool result

```json
{
  "content": [{ "type": "text", "text": "Review this change." }],
  "structuredContent": {
    "_niaCard": true,
    "card": {
      "id": "changes:change-123",
      "title": "Apply change",
      "subtitle": "Version 7",
      "status": "pending",
      "action": {
        "label": "Confirm",
        "handler": {
          "kind": "mcp",
          "server": "changes",
          "toolName": "apply_change",
          "arguments": { "changeId": "change-123", "expectedVersion": 7 }
        }
      }
    }
  }
}
```

Nia Teams consumes `_niaCard` from `CallToolResult.structuredContent` for TaskBar
rendering. Standard clients still receive `content[].text`. Card IDs identify
the same card across sessions; use a producer-specific prefix.

`CardSpec` required fields: `id`, `title`, `subtitle`, `status`.
Status is `pending | running | success | failed`. Optional fields:
`description`, `icon`, `statusLabel`, `action`, `pendingInput`, `errorMessage`,
`metadata`. `pendingInput` and `metadata` are JSON-like records.
`action` contains `label`, `handler`, optional
`requiresIdentity: { provider: string, instance?: string }`.

Handler variants:

- `{ kind: "mcp", server, toolName, arguments }` — exact signed human RPC.
- `{ kind: "webhook", url, mcpServerName }` — HMAC-signed callback.
- `{ kind: "builtin", name }` — reserved platform in-process action.
- `{ kind: "open-url", url }` — client navigation, not a confirmation callback.

Only the first two have SDK confirm-card builders. Builders start `pending`,
default subtitle to `""`, and default the action label to `"Confirm"`.
`createMcpConfirmCard` moves `detailTool`, `detailArguments`, and
`detailRequiresIdentity` into card `metadata`. Detail tools use viewer contexts.
External identities are orchestration declarations, never secrets in a card.

`cardId` takes precedence over generated IDs. Otherwise `idempotency` generates
`<prefix>:<floor(now/bucketMs)>-<canonical-input-sha256-first-16>` (default bucket
60,000ms); without it, a UUID is generated. IDs only deduplicate display, never
prove authorization. `withConfirmCard` wraps only a card producer.

### 2.2 Action results

Success results MUST contain:

```json
{
  "content": [{ "type": "text", "text": "Action succeeded" }],
  "structuredContent": {
    "ok": true,
    "status": "success",
    "statusLabel": "Applied",
    "result": { "changeId": "change-123" }
  }
}
```

`status` MUST be `success` or `running`. `statusLabel` and record `result` are
optional. `cardActionSuccess` defaults status to success and keeps optional
human-facing `text` outside `structuredContent`.

Errors: `structuredContent: { ok: false, error, errorKind? }` with `isError: true`
and text content. `errorKind` is `auth_expired | auth_forbidden | network_error`.
Execution consumes only this result contract, not returned CardSpec/actions.
An action result MUST NOT redirect authority to a different server or handler.

### 2.3 Webhook signatures

Header name: `x-nia-signature` (`X-Nia-Signature` on the wire is equivalent).

```text
signature = "sha256=" + lowercase_hex(HMAC_SHA256(secret, raw_body_bytes))
```

`signCardBody` accepts Buffer or UTF-8 string. `verifyCardSignature` requires the
exact signature shape, then compares equal-length buffers with `timingSafeEqual`.
Missing/malformed/wrong-body/wrong-secret signatures return false. Hosts MUST
capture raw bytes before JSON parsing. Reserializing changes the signature.
This scheme has no timestamp or nonce; hosts MUST enforce card binding, current
state, business authorization and durable replay protection themselves. Never
put a webhook secret or access token in card `pendingInput` or `metadata`.

## 3. Workspace MCP Apps (SEP-1865)

### 3.1 Official protocol integration

Use `@modelcontextprotocol/ext-apps/server` helpers for tool/resource registration
and `@modelcontextprotocol/ext-apps` for `App` and `PostMessageTransport`.
`registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`,
`RESOURCE_URI_META_KEY`, `getUiCapability`, `EXTENSION_ID` are re-exported unchanged
from `/apps`. React hooks are provided by the official `/react` export.

Resources use `ui://...` and MIME **`text/html;profile=mcp-app`**. Official
`registerAppTool` handles current/legacy resource URI metadata normalization.
Capability negotiation uses `EXTENSION_ID` (`io.modelcontextprotocol/ui`).
`App.connect()` performs `ui/initialize`; `App.callServerTool` sends standard
`tools/call` via the official postMessage bridge. Do not reimplement that bridge.

### 3.2 Nia workspace/thread metadata

`niaWorkspaceMeta(options)` returns the value of `_meta`:

```json
{
  "ui": { "resourceUri": "ui://example/dashboard", "visibility": ["app"] },
  "nia/workspace": true,
  "nia/requireTeamAdmin": true,
  "openai/ui.entrypoints": [{ "type": "thread" }]
}
```

`resourceUri` is required. `workspace` defaults true. Visibility is omitted unless
specified (`model`/`app`). Admin metadata is omitted unless explicitly set.
Thread entrypoints are emitted only when `threadEntrypoint: true`. An absent
entrypoint does not advertise a thread menu entry.

`registerNiaWorkspaceApp(server, options)` registers:

1. One resource with HTML from `html: string | (() => string | Promise<string>)`,
   optional `resourceName`/`resourceConfig`, and official MIME type.
2. An `entryTool` (`name`, optional title/description/Zod raw input shape,
   `handler`) with workspace metadata.
3. Optional `apiTool` (`name`, optional description, `handler`) with app-only
   visibility and arguments `method: GET|POST`, `path: string`, optional `body`.

Returns official `{ resource, entryTool, apiTool? }` registration handles.
Security/CSP metadata MAY be configured via official `resourceConfig._meta.ui`.
Registration does not cache HTML or enforce authentication/authorization.

### 3.3 Bound viewers and trust boundary

The authenticated host injects `_meta.boundContext` into App calls:

```json
{
  "boundContext": {
    "viewerUserId": "0123456789abcdef01234567",
    "viewerTeamRole": "admin"
  }
}
```

`verifyBoundViewer` trims/normalizes the 24-hex user ID, checks role
`owner | admin | member`, optionally requires owner/admin, and returns
`viewerUserId`, `viewerTeamRole`, and audit actor `user:<lowercase-id>`.
Malformed input or a denied role throws 403.

This is a host assertion, **not a cryptographic credential**. The relying server
MUST authenticate and authorize the platform transport and its Team/role mount
before trusting this field. An arbitrary MCP client can supply metadata; merely
seeing `boundContext` or `nia/requireTeamAdmin` is insufficient. Apply business
permissions in every handler, including the entry tool and each API bridge call.
Use signed source/human contexts where available and necessary.

### 3.4 Safe REST allowlists

`createSafeApiPathChecker({ get?, post? })` returns `(method, rawPath) => boolean`.
GET routes have `{ pattern: RegExp, queryKeys?: readonly string[] }`; POST routes
are regexes. Use anchored patterns (`^...$`). Stateful regex flags do not affect
results. Method names are case-insensitive; only GET and POST are allowed.

Paths MUST be relative `/api/` paths of at most 2048 characters. The checker
rejects raw whitespace, controls, DEL, fragments, backslashes; invalid percent
escapes; raw/decoded `.`/`..` segments; encoded dots, separators and nested
percent escaping. A single route MUST match both raw and decoded pathname.
GET query keys MUST be explicitly allowlisted, unique after decoding, and free
of control characters in key/value. POST MUST NOT have a query, even empty.
The checker is deliberately stricter than URL normalization: malicious raw paths
are rejected, not repaired into an allowed route. It does not validate body
schemas, apply business authorization, choose an upstream, or prevent a broad
consumer-supplied regex from allowing unintended business endpoints.

### 3.5 Browser adapter response contract

`createMcpAppFetch({ app?, appInfo?, apiToolName })` returns an async fetch-like
function `(path, init?) => Promise<Response>`. If no App is supplied, it creates
an official App (`appInfo` default: Nia Workspace App, version 1.0.0).
Initialization is lazy, shared across concurrent calls, reuses connected Apps,
and retries a failed connection on the next call.

Request arguments: `{ method, path, body? }`. GET forbids a body. POST bodies
MUST be JSON strings and are parsed to JSON values. The signal is forwarded to
the official request API. This adapter does not proxy HTTP headers, credentials,
cookies, arbitrary origins, streaming, or binary bodies.

Bridge results MUST contain `structuredContent: { status, body? }`, with integer
HTTP status 200–599. The adapter returns JSON `Response` data and preserves HTTP
error statuses (callers check `response.ok`). Status 204/205/304 has no body.
Malformed responses or MCP tool failures without an HTTP result throw. Server
errors SHOULD use the same HTTP result contract, even when `isError: true`.

`isMcpAppEmbedded()` checks `window.parent !== window` and is false without a
window. It is only a rendering heuristic, not proof of a valid MCP host.

### 3.6 Bundling

Use Vite plus `vite-plugin-singlefile` (see `examples/workspace-ui`) or a standard
single-file esbuild pipeline. The resource MUST contain its required JS/CSS;
relative chunks do not reliably resolve in sandboxed HTML/blob contexts.
Declare any intentional network/resource origins through the official MCP Apps
CSP configuration. Do not manually rewrite asset imports or replace official
initialization/transport code. Ordinary MCP clients SHOULD retain a text fallback.

## 4. Offline testing issuer

`createWorkloadOidcProvider({ issuer, audience, tokenTtlSeconds, activeKey,
previousKey?, additionalClaimsSupported?, now? })` is in-process, not a listening
HTTP server. Keys have `{ kid, privateKeyPem }` (RSA PKCS#8). Issuer terminal
slashes are normalized. Active/previous key IDs MUST differ; TTL MUST be positive.

Methods:

- `signIdToken({ subject, groups?, claims? })`: RS256, active kid, `iss/sub/aud`,
  integer current `iat/nbf`, configured `exp`, fresh UUID `jti`.
- `getJwks()`: public-only keys, active then optional previous; defensive copies.
- `getDiscoveryMetadata()`: issuer, `/oauth2/jwks`, response/subject/algorithm
  support and standard plus configured additional claim names.
- `verifyIdToken(token, { audience?, currentDate?, clockToleranceSeconds? })`:
  official local JWKS verification, fixed RS256/issuer.

Standard claims and `groups` cannot be overridden via `claims`. Provider errors
use `WorkloadOidcProviderError.code`, without disclosing key material or tokens.
`generateTestRsaKeyPair(kid?)` returns a fresh test signing-key object.
`signTestConfirmationToken`/`signTestViewerContextToken` take a provider plus
`{ server, tool, arguments, cardId, confirmedBy?, confirmedByName?, identityToken?,
claims? }` and return JWT strings with the appropriate platform service claims.
Use TTL <= 300 for human contexts. Extra `claims` cannot override generated human
binding fields. Hosts MAY expose discovery/JWKS on a local test HTTP server or
supply the public JWKS directly; no live Nia Teams connection is required.

## 5. Deployment lifecycle and mount resolution

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
   See [the complete HTTP example](../examples/01-readonly-workload-oidc.ts).
   Use a separate, explicitly authorized callback policy for platform service
   requests; do not indiscriminately allow service principals on read/write routes.
3. **Register your capabilities.** Read tools use the verified Agent scope.
   Write tools propose `createMcpConfirmCard` and execute only after
   `verifyHumanActionContext` plus durable business CAS. Workspace Apps use
   `registerNiaWorkspaceApp`, `verifyBoundViewer`, a strict API allowlist, and
   Vite + `vite-plugin-singlefile`. The [README scenarios](../README.md) provide integration code.
4. **Test offline before deploying.** Put a Vitest test around the local issuer
   example in [Offline testing issuer](#4-offline-testing-issuer), then `npx vitest run`. Use
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

### 5.1 Mounting scopes, endpoint rules, and tool names

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

## 6. HTTP identity versus human authority

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

## 7. Host permission matrix and relying-party gates

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

### 7.1 A. Agent read / proposal tool

Verify outer HTTP OIDC, then check `identity.subject` with `allowedSubjects`,
organization scope through `identity.orgs`, and required Agent grants through
`requiredGroups` / `identity.roles`. `_meta.boundContext` may accompany a
Routine/App-bound call but is not human consent by itself. AI calls must not
silently execute the proposed mutation.

### 7.2 B. Human confirms a TaskBar card

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

### 7.3 C. Human opens and uses a Workspace App

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
available. See section 3.4 for `createSafeApiPathChecker` and the [workspace example](../examples/03-workspace-mcp-app.ts).

### 7.4 D. Mount administration is a separate privilege

A user may request a mount change without being authorized to apply it. The
`mcp_servers` built-in proposal and its owner/admin-gated executor are separate
from enterprise card executors and provider OAuth permissions. Neither an
external admin token nor an Agent's `role:*` group grants the clicking human
permission to change Agent wiring. Revalidate live Team membership/role and
Blueprint conflicts at apply time; apply the corresponding platform-management
policy only on explicitly authorized platform-management routes.
