# Nia Teams MCP Extensions Specification

Protocol contract between Nia Teams (`https://nia-teams.com`) and MCP servers built on `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` (SEP-1865).

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

When an MCP server mount has no static `Authorization` HTTP header configured, Nia Teams injects the Workload OIDC Bearer token on outbound requests; configuring a static `Authorization` header disables Workload OIDC injection on ordinary workload requests.

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

1. Signed by the OIDC issuer with `sub: "nia-teams-platform"` and `principal_type: "service"`; `token_use: "card_callback"` is rejected.
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
  "callbackToken": "<two-hour card status JWT>",
  "clicker": { "userId": "65f000000000000000000001", "name": "Alice" },
  "input": { "service": "payments-api" },
  "identity": { "accessToken": "...", "meta": {} }
}
```

- **HMAC mode** (when `webhookSecret` is set on the MCP server mount via `mcp_servers`): Nia Teams attaches `X-Nia-Signature: sha256=<hex>`, where `<hex>` is lowercase HMAC-SHA256 over the raw UTF-8 request body bytes (`verifyCardSignature` checks `^sha256=[a-f0-9]{64}$` with `crypto.timingSafeEqual`).
- **Workload OIDC mode** (when `webhookSecret` and static `Authorization` headers are unset and `new URL(handler.url).origin === new URL(server.url).origin`): Nia Teams attaches `Authorization: Bearer <JWT>` signed for the Agent's workload identity with `human_confirmed: true` and `confirmed_by: "<clicker.userId>"`.

A queued webhook job responds with HTTP 2xx and JSON:

```json
{ "status": "running", "statusLabel": "Queued #42", "action": null }
```

Nia Teams applies this response only while the card is still `running`. `action: null` clears the button; an omitted response action also clears it. A non-2xx response marks a still-running card as failed. Nia Teams uses a 30-second (30,000 ms) webhook dispatch timeout. The webhook endpoint must return its HTTP response within this window; a dispatch request that times out marks a still-running card as failed. A 2xx response without a recognized `status` leaves its state unchanged.

After dispatch authentication, the receiver verifies the supplied `callbackToken` with `auth.verifyCardCallbackContext({ callbackToken: body.callbackToken }, { server, expectedCardId: body.cardId })` for subsequent status updates.

### 3.4 Asynchronous Card Status Callback

MCP execution metadata contains `nia/cardCallbackToken`; webhook dispatch JSON contains `callbackToken`. Read-only views receive no status credential.

The RS256 JWT uses the configured issuer and audience. Its payload includes:

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "nia-teams-platform",
  "principal_type": "service",
  "token_use": "card_callback",
  "confirmation_card_id": "build:11",
  "context_server": "jenkins",
  "context_config_sha256": "<emitter configuration digest>",
  "callback_url": "https://nia-teams.com/api/cards/build%3A11/webhook",
  "iat": 1794268800,
  "exp": 1794276000
}
```

Verification conditions:

1. Signature, issuer, audience, expiration, and optional `nbf` pass OIDC verification.
2. `sub === "nia-teams-platform"`, `principal_type === "service"`, and `token_use === "card_callback"`.
3. `confirmation_card_id` is non-blank and matches the expected card ID when supplied; `context_server` matches the expected mount name.
4. `iat` and `exp` are integer Unix seconds satisfying `iat <= now < exp`, `0 < exp - iat <= 7200`, and `now - iat <= 7200`.
5. `context_config_sha256` is a non-blank string; Nia Teams checks its binding to the current mount configuration when receiving updates.
6. The callback URL is `${issuer}/api/cards/${encodeURIComponent(confirmation_card_id)}/webhook`; an optional `callback_url` claim equals that URL.

Status credentials authorize updates to the bound card. Human confirmation and viewer proofs retain the 300-second limit from Section 2.2.

Status requests use `POST /api/cards/:id/webhook` with `Content-Type: application/json` and `Authorization: Bearer <callbackToken>`. Redirects are rejected. The SDK applies a 30-second timeout when no caller signal is supplied.

```json
{
  "status": "running",
  "statusLabel": "Stage 2/4",
  "result": { "buildNumber": 11 }
}
```

- `status` is `"running"`, `"success"`, or `"failed"` for SDK updates.
- Optional `statusLabel` is a string or `null`; omission preserves the label, while `null` or `""` clears it.
- Optional `result` is a JSON object; optional `errorMessage` is a string.

Endpoint authentication and responses:

1. An unknown card ID returns `404 Not Found`.
2. With an `Authorization` header, Nia Teams requires a Bearer status JWT and verifies its signature, issuer, audience, service subject, `token_use === "card_callback"`, lifetime, and `confirmation_card_id === card.cardId`.
3. `context_server` and `context_config_sha256` match the card's emitting mount; Nia Teams resolves that Agent's current enabled mount and compares its configuration fingerprint. Removed, disabled, or fingerprint-changed mounts, including changed URL or headers, invalidate the credential.
4. Malformed Bearer headers, invalid JWTs, and revoked mount bindings return `401 Unauthorized` with `{ "error": "invalid callback authorization" }`. The endpoint does not fall back to HMAC when `Authorization` is present.
5. Without `Authorization`, the endpoint verifies the raw request body HMAC with the mount's webhook secret; missing or invalid HMAC authorization returns `401 Unauthorized`.
6. A non-object body, unsupported `status`, or invalid `statusLabel` returns `400 Bad Request`.
7. If the card is already `success` or `failed`, a late `running` update returns `200 OK` with `{ "ok": true }` and leaves the card unchanged.
8. A status change between reading and updating the card returns `409 Conflict` with `{ "error": "card changed during callback; retry" }`; no completion event is published for that rejected update.
9. An accepted patch broadcasts the updated card and returns `200 OK` with `{ "ok": true }`.
10. A `success` or `failed` patch without an `action` field clears the card action button. `postCardStatus` sends no `action` field. A raw request may supply a replacement action; `action: null` clears it.
11. Accepted terminal updates publish a completion event to the originating group chat's current session to wake the Agent when that session can be resolved. Running updates do not publish a completion event.

Worker failure handling:

- Verify human confirmation at enqueue time inside the execute tool; the worker uses the separate status credential.
- Serialize updates for each card. Drop a `running` update that receives `409`; retry a terminal (`success` or `failed`) update once on `409`. If that retry fails, report the error without further retries.
- Callback tokens are issued for 7200 seconds with no refresh. For jobs that may exceed two hours, send terminal `failed` with a timeout summary before the token's `exp` deadline.
- Stop updates when mount removal, disabling, reconfiguration, or token expiry causes authorization rejection.
- `postCardStatus` sends each update once. Non-2xx responses throw `CardStatusError` with numeric `status` and response-text `body` (`""` if the body cannot be read).
- `CardStatusError.message` is `Card status callback failed (HTTP <status>)` and excludes `body`. Treat the body as private diagnostic data; transport failures propagate the underlying fetch error.

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

`viewerUserId` is a 24-character hex user ID (normalized to lowercase) and `viewerTeamRole` is `"owner"`, `"admin"`, or `"member"`. Servers authenticate the outer HTTP Workload OIDC token for the expected Agent or organization before trusting the plaintext host assertion `boundContext`.
