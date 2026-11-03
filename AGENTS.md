# AGENTS.md

Repository context for AI coding agents maintaining `@nia-teams/mcp-sdk`.

- Building an MCP server with `@nia-teams/mcp-sdk`: read `skills/nia-teams-mcp/SKILL.md`.
- Wire-level JWT claims, canonical JSON rules, and `_niaCard` / `_meta` schemas: read `docs/SPECIFICATION.md`.

## Scope & Layering

`@nia-teams/mcp-sdk` layers Nia Teams group-chat primitives onto `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` (SEP-1865). Standard MCP transport, tool schemas, `ui://` resource serving, and `postMessage` bridging stay in the upstream `@modelcontextprotocol/*` packages; this repository maintains only Workload OIDC and call-context verification (`src/auth`), TaskBar card envelopes and webhook HMAC (`src/cards`), Workspace App registration and viewer verification (`src/apps`), the browser-only client adapter (`src/apps/client.ts`), and offline OIDC fixtures (`src/testing`).

## Invariants

- **Browser runtime boundary**: `src/apps/client.ts` depends strictly on web-standard APIs and `@modelcontextprotocol/ext-apps`, validated by `tsconfig.check.json` (`types: []`, `DOM` lib). Server subpaths target Node.js 20+.
- **Canonical JSON wire parity**: `src/canonical-json.ts` matches the Nia Teams host digest implementation byte-for-byte — plain objects with UTF-16 code-unit sorted keys (`Array.prototype.sort()`), dense arrays, finite numbers (`-0` serialized as `"0"`), throwing `TypeError` on `undefined`, class instances, sparse arrays, non-finite numbers, and circular references.
- **Contract sync**: Changes to exported APIs, JWT claims, `_meta` keys, or card envelopes update `docs/SPECIFICATION.md`, `skills/nia-teams-mcp/SKILL.md`, `README.md`, and `README_CN.md` together.
- **Verification**: Run `npm test`, `npm run typecheck`, and `npm run build` (plus `npm --prefix examples/workspace-ui run typecheck` and `build` when modifying `src/apps/client.ts` or `examples/workspace-ui/`), and check `npm pack --dry-run` against `package.json` `files` before release.
