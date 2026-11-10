# Repository maintenance

This repository adds Nia Teams authentication, cards, and Workspace metadata to `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps`. Upstream packages own MCP transport, resource registration, and iframe messaging.

## Runtime and protocol boundaries

- Server exports target Node.js 20+; `src/apps/client.ts` uses browser APIs and `@modelcontextprotocol/ext-apps`.
- Canonical JSON sorts plain-object keys by UTF-16 code units, preserves dense-array order, and hashes UTF-8 bytes. It rejects unsupported values and cycles; `-0` serializes as `0`.
- Human confirmation and viewer proofs have a 300-second lifetime limit. Card status credentials have a 7200-second limit and are rejected as human contexts.
- Callback URLs derive from the configured verified issuer and encoded card ID; status requests reject redirects.
- Workspace metadata is registration data; authenticated handlers enforce viewer and business permissions.

## Contract updates

Update `README.md`, `README_CN.md`, `skills/nia-teams-mcp/SKILL.md`, `docs/SPECIFICATION.md`, tests, and runnable examples when changing public contracts. Type declarations derive from source.

Consumer integration guidance lives in `skills/nia-teams-mcp/SKILL.md`; protocol schemas live in `docs/SPECIFICATION.md`.

## Verification

Run `npm test`, `npm run typecheck`, `npm run build`, and `npm pack --dry-run`.
Run `npm --prefix examples/workspace-ui run typecheck` and `npm --prefix examples/workspace-ui run build` for browser changes.
Keep executable README TypeScript blocks identical to their `examples/` scripts and include example build configuration in the tarball.
