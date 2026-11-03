# Nia Teams MCP Extensions Specification

Wire-level contract between Nia Teams (`https://nia-teams.com`) and MCP servers built on `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` (SEP-1865).

## 1. Outer HTTP Authentication (Workload OIDC)

### 1.1 Discovery & Cryptographic Parameters

Nia Teams authenticates outbound MCP HTTP requests with RS256 Bearer JWTs in `Authorization: Bearer <token>`:

- **Default issuer (`NIA_DEFAULT_ISSUER`)**: `https://nia-teams.com`
- **Audience (`NIA_WORKLOAD_AUDIENCE`)**: `nia-teams-workload`
- **OIDC discovery URL**: `${issuer}/.well-known/openid-configuration`
- **Public JWKS URL**: `${issuer}/oauth2/jwks`
- **Callback service subject (`NIA_PLATFORM_SERVICE_SUBJECT`)**: `nia-teams-platform`
- **Signing algorithm**: `RS256`
- **Host token lifetime**: 300s TTL, refreshed 30s before expiration

When an MCP server mount has no static `Authorization` HTTP header configured, Nia Teams automatically injects the Workload OIDC Bearer token on outbound requests; configuring a static `Authorization` header disables automatic Workload OIDC injection on ordinary workload requests.

### 1.2 Bearer Token Payloads

Agent workload call (`principal_type: "workload"`):

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

Callback service call (used when Nia Teams invokes a TaskBar card's MCP handler):

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

1. `Authorization` header matches `/^Bearer ([^\s]+)$/i`; missing, malformed, or expired tokens raise `WorkloadOidcError` with `statusCode: 401`.
2. Signature (`alg === "RS256"`), `iss`, `aud`, `exp`, and optional `nbf` validate against the issuer JWKS; invalid signatures or claims raise `WorkloadOidcError` with `statusCode: 403`.
3. `sub` is a non-empty string and `principal_type` is `"workload"` or `"service"`.
4. When `sub === "nia-teams-platform"`, `principal_type` equals `"service"`.
5. When `principal_type === "service"`, verification requires `allowServicePrincipal: true` (otherwise `403`).
6. When `allowedSubjects` is provided, `sub` appears in `allowedSubjects` (an empty array rejects all subjects).
7. `groups`, when present, is an array of strings; when `requiredGroups` is provided, every entry appears verbatim in `groups`.
8. `VerifiedWorkloadIdentity` exposes deduplicated prefix-stripped arrays in encounter order: `teams` (`"team:"`), `orgs` (`"org:"`), and `roles` (`"role:"`).

## 2. Canonical JSON & Signed Call Contexts

### 2.1 Canonical JSON Digest (`canonicalJson`, `canonicalJsonSha256`)

Signed call contexts bind exact MCP tool arguments via `canonicalJsonSha256(arguments)`:

1. **Primitives**: Strings, booleans, `null`, and finite numbers serialize via `JSON.stringify` (`-0` serializes as `"0"`). `NaN`, `Infinity`, `-Infinity`, `undefined`, `bigint`, `symbol`, and `function` values throw `TypeError`.
2. **Arrays**: Dense arrays serialize in index order (`[a,b,...]`). Sparse array holes (`!(i in value)`) throw `TypeError`.
3. **Objects**: Plain objects (`Object.prototype` or `null` prototype) serialize with own enumerable string keys sorted in UTF-16 code-unit order (`Array.prototype.sort()`, where `"10"` precedes `"2"`). Class instances (`Date`, `Map`, `Set`, `Buffer`, `RegExp`, etc.) and circular references throw `TypeError` (`toJSON` is ignored). Shared acyclic references are valid.
4. **Digest**: `canonicalJsonSha256(value)` returns the lowercase 64-character hex SHA-256 of the UTF-8 canonical JSON string.

### 2.2 Signed `_meta` Action & Viewer Contexts (`verifyHumanActionContext`)

- **Confirm intent (`expected.intent: "confirm"`, default)**: Reads `_meta["nia/confirmationToken"]` and requires `human_confirmed === true` (emitted when a member clicks a TaskBar confirmation button).
- **View intent (`expected.intent: "view"`)**: Reads `_meta["nia/viewerContextToken"]` and requires `human_confirmed === false` (emitted when a member opens a read-only card `detailTool`).

Verification invariants:

1. Signed by the OIDC issuer with `sub: "nia-teams-platform"` and `principal_type: "service"`.
2. `iat` and `exp` are integer Unix seconds satisfying `iat <= now < exp`, `exp - iat <= maxAgeSeconds`, and `now - iat <= maxAgeSeconds`, where `maxAgeSeconds` defaults to `300` and lies in `(0, 300]`.
3. `jti`, `confirmed_by` (clicker's 24-hex user ID), `confirmed_by_name`, and `confirmation_card_id` are non-blank strings. When `expected.expectedCardId` is provided, `confirmation_card_id === expected.expectedCardId`.
4. `context_server === expected.server` (the Agent's configured MCP mount name), `context_tool === expected.tool` (the unprefixed tool name on the MCP server), and `context_arguments_sha256 === canonicalJsonSha256(expected.arguments)`.
5. **External OAuth token binding**: `_meta["nia/identityToken"]` and JWT claim `context_identity_token_sha256` appear together; `_meta["nia/identityToken"]` is non-blank and `SHA256(UTF8(identityToken))` (lowercase hex) equals `context_identity_token_sha256`.
6. **Idempotency boundary**: The 5-minute TTL bounds token age; executors enforce single execution via durable state transitions (such as database version CAS or a unique `jti` ledger).

## 3. TaskBar Confirmation Cards

### 3.1 Proposal Result Envelope (`_niaCard`)

Proposal tools return an MCP `CallToolResult` with text `content` and `structuredContent` matching `NiaCardEnvelope`:

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
        "requiresIdentity": { "provider": "gitlab", "instance": "gitlab.example.com" },
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

- **MCP handler (`createMcpConfirmCard`)**: Sets `status: "pending"`, defaults `subtitle` to `""` and `action.label` to `"Confirm"`, and stores optional `detailTool`, `detailArguments`, and `detailRequiresIdentity` on `card.metadata`.
- **Webhook handler (`createWebhookConfirmCard`)**: Sets `action.handler` to `{ kind: "webhook", url, mcpServerName }` and stores `pendingInput` on `card.pendingInput`.

### 3.2 Execution Result Schema (`CardActionResult`)

Success (`status` is `"success"` for terminal completion, or `"running"` when an asynchronous operation has started):

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

Failure (`errorKind` is optional: `"auth_expired"` triggers OAuth re-authorization when `requiresIdentity` is set, `"auth_forbidden"`, or `"network_error"`):

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

### 3.3 Webhook Card Dispatch & Signatures

When a member confirms a card with `handler.kind === "webhook"`, Nia Teams sends `POST <handler.url>` with `Content-Type: application/json`:

```json
{
  "cardId": "restart:payments-api:v3",
  "clicker": { "userId": "65f000000000000000000001", "name": "Alice" },
  "input": { "service": "payments-api" },
  "identity": { "accessToken": "...", "meta": {} }
}
```

- **HMAC mode** (when `webhookSecret` is set on the MCP server mount via `mcp_servers`): Nia Teams attaches `X-Nia-Signature: sha256=<hex>`, where `<hex>` is lowercase HMAC-SHA256 over the raw UTF-8 request body bytes (`verifyCardSignature` checks `^sha256=[a-f0-9]{64}$` with `crypto.timingSafeEqual`).
- **Workload OIDC mode** (when `webhookSecret` and static `Authorization` headers are unset and `new URL(handler.url).origin === new URL(server.url).origin`): Nia Teams attaches `Authorization: Bearer <JWT>` signed for the Agent's workload identity with `human_confirmed: true` and `confirmed_by: "<clicker.userId>"`.

## 4. Workspace MCP Apps

### 4.1 Entry Tool `_meta` & Resource

Workspace Apps serve HTML resources at `ui://` URIs with MIME type `text/html;profile=mcp-app`. Entry tool `_meta` fields:

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

- **`nia/workspace`** (default `true`): Renders the App in the desktop right-hand Workspace split pane (or full-screen sheet on mobile).
- **`openai/ui.entrypoints`**: Set to `[{ "type": "thread" }]` when `threadEntrypoint: true`, pinning the App to the GroupChat header Apps menu.
- **`nia/requireTeamAdmin`**: When `true`, the Nia Teams host hides the App from `member` users in the Apps menu and rejects host launch requests from `member` users with `403`; server `entryTool` and `apiTool` handlers enforce server-side access independently via `verifyBoundViewer`.
- **`apiTool` RPC convention (`registerNiaWorkspaceApp` / `createMcpAppFetch`)**: Accepts `{ method: "GET" | "POST", path: string, body?: unknown }` (`visibility: ["app"]`) and returns `structuredContent: { status: 200..599, body?: unknown }`.

### 4.2 Bound Viewer Context (`verifyBoundViewer`)

When a member opens an Agent-mounted Workspace App or calls tools from its iframe, Nia Teams resolves the member's live role on that Agent and injects:

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

`viewerUserId` is a 24-character hex user ID (normalized to lowercase) and `viewerTeamRole` is `"owner"`, `"admin"`, or `"member"`. Because `_meta.boundContext` is a plaintext host assertion, servers authenticate the outer HTTP Workload OIDC token for the expected Agent or organization before trusting `boundContext`.
