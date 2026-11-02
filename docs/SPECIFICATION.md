# Nia Teams MCP Extensions Specification

**Version:** 0.1.0  
**Issuer Origin:** `https://nia-teams.com`  
**SDK Repository:** `https://github.com/nia-teams/mcp-sdk`

This document defines the wire formats, JWT claims, MCP `_meta` fields, `structuredContent` schemas, and verification rules implemented by `@nia-teams/mcp-sdk` on top of the Model Context Protocol (`@modelcontextprotocol/sdk`) and MCP Apps (`@modelcontextprotocol/ext-apps`, SEP-1865).

The keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be interpreted as described in RFC 2119.

---

## 1. Outer HTTP Authentication (Workload OIDC)

### 1.1 Discovery & Cryptographic Parameters

Nia Teams authenticates outbound MCP HTTP requests with RS256 Bearer JWTs in `Authorization: Bearer <token>`.

| Constant / Endpoint | Default Value |
| --- | --- |
| `NIA_DEFAULT_ISSUER` | `https://nia-teams.com` |
| `NIA_WORKLOAD_AUDIENCE` | `nia-teams-workload` |
| OIDC Discovery URL | `${issuer}/.well-known/openid-configuration` |
| Public JWKS URL | `${issuer}/oauth2/jwks` |
| `NIA_PLATFORM_SERVICE_SUBJECT` | `nia-teams-platform` |
| Signing Algorithm | `RS256` (no algorithm fallback permitted) |
| Host Token Cache | 300s TTL, refreshed 30s prior to expiration |

*Note:* If an MCP server mount explicitly configures a static `Authorization` HTTP header (case-insensitive), Nia Teams disables automatic Workload OIDC injection on ordinary workload requests for that mount.

### 1.2 Bearer Token Claims

Workload call example (`principal_type: "workload"`):

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "ops-agent",
  "principal_type": "workload",
  "iat": 1790812800,
  "nbf": 1790812800,
  "exp": 1790813100,
  "jti": "c9f7e120-531b-45c4-98d4-9ef8a3a01234",
  "groups": ["team:ops-agent", "org:acme", "role:ops.reader"]
}
```

Platform callback example (used when Nia Teams invokes a TaskBar card's MCP handler):

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "nia-teams-platform",
  "principal_type": "service",
  "iat": 1790812800,
  "nbf": 1790812800,
  "exp": 1790813100,
  "jti": "38a1b544-89ef-4a0e-b8c1-7640219c5511"
}
```

### 1.3 Verification Rules (`verifyBearerHeader`)

1. The `Authorization` header MUST match `/^Bearer ([^\s]+)$/i`. Missing, malformed, or expired tokens raise `WorkloadOidcError` with `statusCode: 401`.
2. Signature, `iss`, `aud`, `exp`, optional `nbf`, and `alg === "RS256"` MUST pass verification against the configured JWKS. Any invalid signature or claim raises `WorkloadOidcError` with `statusCode: 403`.
3. `sub` MUST be a non-empty string. `principal_type` MUST be `"workload"` or `"service"`.
4. If `sub === "nia-teams-platform"`, `principal_type` MUST be `"service"`.
5. If `principal_type === "service"`, verification MUST fail with `403` unless `allowServicePrincipal: true` was explicitly passed.
6. If `allowedSubjects` is provided, `sub` MUST be included in `allowedSubjects` (an empty array denies all subjects).
7. `groups`, when present, MUST be an array of strings. If `requiredGroups` is provided, every entry in `requiredGroups` MUST appear verbatim in `groups`.
8. Prefix-stripped helper arrays on `VerifiedWorkloadIdentity` are deduplicated in encounter order:
   - `teams`: values stripped of `"team:"`
   - `orgs`: values stripped of `"org:"`
   - `roles`: values stripped of `"role:"`
   - `elevatedRoles`: values stripped of `"nia:elevated:role:"`

---

## 2. Canonical JSON & Bounded Call Contexts

### 2.1 Canonical JSON Digest (`canonicalJson`, `canonicalJsonSha256`)

Signed call contexts bind exact MCP tool arguments via `canonicalJsonSha256(arguments)`:

1. **Primitives**: Strings, booleans, `null`, and finite numbers serialize via `JSON.stringify` (`-0` serializes as `"0"`). `NaN`, `Infinity`, `-Infinity`, `undefined`, `bigint`, `symbol`, and `function` values MUST throw `TypeError`.
2. **Arrays**: Dense arrays serialize in index order (`[a,b,...]`). Sparse array holes (`!(i in value)`) MUST throw `TypeError`.
3. **Objects**: Only plain objects (`Object.prototype` or `null` prototype) are accepted; class instances (`Date`, `Map`, `Set`, `Buffer`, `RegExp`, etc.) MUST throw `TypeError` (`toJSON` methods are never called). Own enumerable string keys are sorted using standard UTF-16 code-unit order (`Array.prototype.sort()`, so `"10"` precedes `"2"`).
4. **Cycles**: Circular references MUST throw `TypeError`; shared acyclic references are allowed.
5. **Digest**: `canonicalJsonSha256(value)` computes the lowercase 64-character hex SHA-256 of the UTF-8 canonical JSON string.

### 2.2 Common Context Lifetime & RPC Binding

Every signed `_meta` context JWT (`nia/confirmationToken`, `nia/viewerContextToken`, `nia/sourceContextToken`) MUST satisfy:

- `iat` and `exp` are integers (Unix seconds) with `iat <= now < exp`, `exp - iat <= maxAgeSeconds`, and `now - iat <= maxAgeSeconds`, where `maxAgeSeconds` defaults to `300` and MUST be in `(0, 300]`.
- `jti` is a non-blank string.
- `context_server === expected.server` (the Agent's configured MCP mount name).
- `context_tool === expected.tool` (the unprefixed tool name registered on the MCP server).
- `context_arguments_sha256 === canonicalJsonSha256(expected.arguments)`.

### 2.3 Human Action & Viewer Contexts (`verifyHumanActionContext`)

| `expected.intent` | `_meta` Key Read | Required `human_confirmed` | Purpose |
| --- | --- | --- | --- |
| `"confirm"` (default) | `_meta["nia/confirmationToken"]` | `true` | Human clicked a TaskBar confirmation button |
| `"view"` | `_meta["nia/viewerContextToken"]` | `false` | Human opened a read-only card detail view (`detailTool`) |

Additional verification rules:

1. The JWT MUST be signed for `sub: "nia-teams-platform"` and `principal_type: "service"`.
2. `confirmed_by` (clicker's user ID), `confirmed_by_name`, and `confirmation_card_id` MUST be non-blank strings.
3. If `expected.expectedCardId` is provided, `confirmation_card_id` MUST equal `expected.expectedCardId`.
4. **External OAuth token binding**: If either `_meta["nia/identityToken"]` or the JWT claim `context_identity_token_sha256` is present, BOTH MUST be present, `_meta["nia/identityToken"]` MUST be a non-blank string, and `SHA256(UTF8(identityToken))` (lowercase hex, raw string without JSON quotes) MUST equal `context_identity_token_sha256`.
5. **Optional source Team claims**: When `source_team_id`, `source_team_subject`, or `source_team_groups` is present (attached by Nia Teams on platform role-managed approval flows), all three MUST be valid:
   - `source_team_id`: lowercase 24-hex ObjectId.
   - `source_team_subject`: `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`, not `"nia-teams-platform"`, and if 24-hex it MUST equal `source_team_id`.
   - `source_team_groups`: string array containing `"team:" + source_team_subject`, restricted to `team:*`, `org:*`, and non-elevated `role:*` entries.
   - `source_team_role` (optional): `"owner" | "admin" | "member"`.
6. **Replay boundary**: The 5-minute TTL bounds token age, not single execution. Executors MUST enforce idempotency / replay prevention using durable state transitions (such as database version CAS or a committed `jti`/operation ledger).

### 2.4 Source Contexts (`verifySourceContext`)

On platform role-mounted MCP calls, Nia Teams passes `_meta["nia/sourceContextToken"]`. `verifySourceContext(meta, expected)` validates the common RPC binding, `sourceTeam` claims (Section 2.3 rule 5), optional 24-hex `human_actor_user_id`, and accepts exactly three principal forms:

1. **Service call**: `sub === "nia-teams-platform"` and `principal_type === "service"`.
2. **Ordinary App call**: `principal_type === "workload"`, `sub === source_team_subject`, `human_actor_user_id` present, and `groups` set-equal to `source_team_groups`.
3. **Elevated App call**: `principal_type === "workload"`, `sub === "role:<key>:elevated"`, `human_app_elevation === true`, `human_actor_user_id` present, `source_team_groups` includes `"role:<key>"`, and `groups` has exact length 2 containing `"role:<key>"` and `"nia:elevated:role:<key>"`.

---

## 3. TaskBar Confirmation Cards

### 3.1 Proposal Result Schema (`_niaCard`)

A proposal tool returns a standard MCP `CallToolResult` with `content` (text fallback for generic MCP clients) and `structuredContent` matching `NiaCardEnvelope`:

```json
{
  "content": [
    { "type": "text", "text": "Confirmation card created to restart payments-api." }
  ],
  "structuredContent": {
    "_niaCard": true,
    "card": {
      "id": "restart:payments-api:v3",
      "title": "Restart payments-api",
      "subtitle": "v3",
      "description": "Drain connections and roll pods",
      "status": "pending",
      "action": {
        "label": "Confirm Restart",
        "requiresIdentity": { "provider": "gitlab", "instance": "prod" },
        "handler": {
          "kind": "mcp",
          "server": "ops",
          "toolName": "execute_restart",
          "arguments": { "service": "payments-api", "expectedVersion": 3 }
        }
      },
      "metadata": {
        "detailTool": "inspect_restart_plan",
        "detailArguments": { "service": "payments-api", "expectedVersion": 3 }
      }
    }
  }
}
```

Card builder behavior:

- `createMcpConfirmCard` sets `status: "pending"`, defaults `subtitle` to `""`, defaults `action.label` to `"Confirm"`, and places optional `detailTool`, `detailArguments`, and `detailRequiresIdentity` into `card.metadata`.
- `createWebhookConfirmCard` sets `action.handler` to `{ kind: "webhook", url, mcpServerName }` and stores `pendingInput` on `card.pendingInput`.
- `createCardId({ prefix, input, bucketMs = 60_000, now = Date.now() })` produces `${prefix}:${Math.floor(now / bucketMs)}-${canonicalJsonSha256(input).slice(0, 16)}`. Omitting options returns `crypto.randomUUID()`.

### 3.2 Execution Result Schema (`CardActionResult`)

MCP card execution tools return `CallToolResult` produced by `cardActionSuccess` or `cardActionError`:

- **Success**:
  ```json
  {
    "content": [{ "type": "text", "text": "Restarted" }],
    "structuredContent": {
      "ok": true,
      "status": "success",
      "statusLabel": "Restarted",
      "result": { "service": "payments-api" }
    }
  }
  ```
  `status` MUST be `"success"` (terminal) or `"running"` (async operation started; button cleared while awaiting external completion).
- **Failure**:
  ```json
  {
    "content": [{ "type": "text", "text": "Insufficient permissions" }],
    "isError": true,
    "structuredContent": {
      "ok": false,
      "error": "Insufficient permissions",
      "errorKind": "auth_forbidden"
    }
  }
  ```
  Optional `errorKind` values: `"auth_expired"` (triggers OAuth re-authorization when `requiresIdentity` is configured on the card), `"auth_forbidden"`, or `"network_error"`.

### 3.3 Webhook Card Dispatch & Signatures

When a human clicks a card whose handler has `kind: "webhook"`, Nia Teams sends `POST <handler.url>` with `Content-Type: application/json` and body:

```json
{
  "cardId": "restart:payments-api:v3",
  "clicker": { "userId": "65f000000000000000000001", "name": "Alice" },
  "input": { "service": "payments-api" },
  "identity": { "accessToken": "...", "meta": {} }
}
```

Authentication header selection by Nia Teams:

1. **HMAC mode** (when `webhookSecret` is configured on the MCP server mount): Nia Teams attaches `X-Nia-Signature: sha256=<hex>`, where `<hex>` is lowercase HMAC-SHA256 over the exact raw UTF-8 request body bytes. `verifyCardSignature(secret, rawBody, header)` validates the `^sha256=[a-f0-9]{64}$` format and compares digests with `crypto.timingSafeEqual`.
2. **Workload OIDC mode** (when `webhookSecret` is omitted, no static `Authorization` header is configured, and `new URL(handler.url).origin === new URL(server.url).origin`): Nia Teams attaches `Authorization: Bearer <JWT>` signed for the Agent's workload identity with `human_confirmed: true` and `confirmed_by: "<clicker.userId>"`.

---

## 4. Workspace MCP Apps

### 4.1 Tool `_meta` & Registration (`niaWorkspaceMeta`, `registerNiaWorkspaceApp`)

Workspace Apps use SEP-1865 (`@modelcontextprotocol/ext-apps`) `ui://` resources with MIME type `text/html;profile=mcp-app`. `niaWorkspaceMeta` constructs the entry tool's `_meta`:

```json
{
  "ui": {
    "resourceUri": "ui://ops/console",
    "visibility": ["app"]
  },
  "nia/workspace": true,
  "nia/requireTeamAdmin": true,
  "openai/ui.entrypoints": [{ "type": "thread" }]
}
```

- `nia/workspace` (default `true`): Opens the UI in the Nia Teams desktop right-hand split workspace (or mobile full-screen sheet) instead of an inline chat card.
- `openai/ui.entrypoints`: Emitted as `[{ "type": "thread" }]` when `threadEntrypoint: true`, adding the App to the GroupChat header **Apps** menu.
- `nia/requireTeamAdmin`: When `true`, Nia Teams hides the App from `member` users in the GroupChat **Apps** menu and rejects `/apps/open` with `403`.
- `registerNiaWorkspaceApp(server, options)` registers the `ui://` resource, the `entryTool`, and an optional `apiTool` (configured with `visibility: ["app"]` and input schema `{ method: "GET" | "POST", path: string, body?: unknown }`).

### 4.2 Bound Viewer Context (`verifyBoundViewer`)

When a human opens an Agent-mounted Workspace App or invokes tools from its iframe via `POST /api/teams/:teamId/mcp-app-tool-call`, Nia Teams resolves the user's live membership on that Agent and injects:

```json
{
  "_meta": {
    "boundContext": {
      "viewerUserId": "65f000000000000000000001",
      "viewerTeamRole": "admin"
    }
  }
}
```

`verifyBoundViewer(meta, { requireTeamAdmin? })`:

- Validates that `viewerUserId` is a 24-character hex string (normalized to lowercase) and `viewerTeamRole` is `"owner"`, `"admin"`, or `"member"`.
- Throws `WorkloadOidcError(403, ...)` if missing, malformed, or if `requireTeamAdmin === true` and `viewerTeamRole === "member"`.
- Returns `{ viewerUserId, viewerTeamRole, actor: "user:<viewerUserId>" }`.
- **Trust requirement**: `_meta.boundContext` is a host-injected JSON object, not a signed JWT. Servers MUST authenticate the outer Nia Teams HTTP Bearer token and restrict allowed Agent subjects/groups before trusting `boundContext`.

### 4.3 Safe API Path Allowlist (`createSafeApiPathChecker`)

`createSafeApiPathChecker({ get?, post? })` validates relative paths passed to `apiTool` without normalizing malicious inputs into valid routes:

1. `rawPath` MUST be a string of length `<= 2048` starting with `"/api/"` and containing no whitespace, ASCII control characters (`0x00–0x1F`, `0x7F`), `#`, or `\`.
2. `pathname` MUST decode cleanly via `decodeURIComponent`, MUST NOT contain percent-encoded dots, slashes, backslashes, or nested percent signs (`%2e`, `%2f`, `%5c`, `%25`, case-insensitive), and MUST NOT contain `.` or `..` path segments.
3. Both raw `pathname` and decoded `pathname` MUST match an allowlisted `RegExp` (`g`/`y` flags stripped to prevent stateful matching).
4. For `GET`: every query parameter key in `URLSearchParams` MUST be listed in the matched route's `queryKeys`, MUST appear at most once, and neither keys nor values may contain control characters.
5. For `POST`: query strings are forbidden (`?` MUST NOT appear in `rawPath`). All methods other than `GET` and `POST` return `false`.

### 4.4 Browser Fetch Adapter (`createMcpAppFetch`)

`createMcpAppFetch({ app?, appInfo?, apiToolName })` wraps `app.callServerTool` in a browser `(path: string, init?: RequestInit) => Promise<Response>` function:

- Lazily calls `app.connect()` on first request, deduplicates concurrent initialization, and resets connection state if `connect()` rejects so subsequent calls can retry.
- Supports `GET` (no body) and `POST` (JSON string `init.body`, parsed via `JSON.parse` before tool invocation) to relative `/api/...` paths; forwards `init.signal`.
- Expects `result.structuredContent` with integer `status` in `200..599` and optional JSON `body`, returning a standard `Response` (`null` body for `204`, `205`, `304`; `application/json` otherwise).

---

## 5. Offline Testing Primitives (`@nia-teams/mcp-sdk/testing`)

- `generateTestRsaKeyPair(kid = "test-key")`: Generates an ephemeral RS256 PKCS#8 `SigningKey`.
- `createWorkloadOidcProvider({ issuer, audience, tokenTtlSeconds, activeKey, previousKey?, additionalClaimsSupported?, now? })`: In-memory OIDC issuer providing `signIdToken`, `getJwks` (defensive copies of public keys only), `getDiscoveryMetadata`, and `verifyIdToken`. Standard claims (`iss`, `sub`, `aud`, `iat`, `nbf`, `exp`, `jti`, `groups`) cannot be overridden via custom `claims`.
- `signTestConfirmationToken(provider, options)` / `signTestViewerContextToken(provider, options)`: Signs a platform service context JWT (`sub: "nia-teams-platform"`, `principal_type: "service"`) with `canonicalJsonSha256(options.arguments)` and optional `context_identity_token_sha256`. Configure `tokenTtlSeconds <= 300` on `provider` so tokens satisfy `verifyHumanActionContext`.
