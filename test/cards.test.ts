import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { canonicalJsonSha256 } from "../src/auth/index.js";
import {
  createMcpConfirmCard,
  createWebhookConfirmCard,
  createCardId,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
  signCardBody,
  verifyCardSignature,
  withConfirmCard,
  CARD_SIGNATURE_HEADER,
} from "../src/cards/index.js";
describe("cards", () => {
  it("matches MCP and detail/identity wire metadata", async () => {
    const identity = { provider: "example", instance: "https://example.com" };
    const card = createMcpConfirmCard({
      cardId: "demo:1",
      title: "Approve",
      server: "demo",
      toolName: "apply",
      arguments: { id: 1 },
      requiresIdentity: identity,
      detailTool: "inspect",
      detailArguments: { id: 1 },
      detailRequiresIdentity: identity,
      metadata: { kind: "demo" },
    });
    expect(card).toEqual({
      _niaCard: true,
      card: {
        id: "demo:1",
        title: "Approve",
        subtitle: "",
        status: "pending",
        action: {
          label: "Confirm",
          requiresIdentity: identity,
          handler: {
            kind: "mcp",
            server: "demo",
            toolName: "apply",
            arguments: { id: 1 },
          },
        },
        metadata: {
          kind: "demo",
          detailTool: "inspect",
          detailArguments: { id: 1 },
          detailRequiresIdentity: identity,
        },
      },
    });
    expect(cardToolResult("Review", card)).toEqual({
      content: [{ type: "text", text: "Review" }],
      structuredContent: card,
    });
    expect(
      await withConfirmCard((title: string) => ({
        ...card,
        card: { ...card.card, title },
      }))("Review"),
    ).toEqual(
      cardToolResult("Review", {
        ...card,
        card: { ...card.card, title: "Review" },
      }),
    );
  });
  it("builds webhook pending input and stable minute bucket ids", () => {
    const id = createCardId({
      prefix: "demo:apply",
      input: { b: 2, a: 1 },
      now: 120_001,
    });
    expect(id).toBe(
      `demo:apply:2-${canonicalJsonSha256({ a: 1, b: 2 }).slice(0, 16)}`,
    );
    expect(
      createCardId({
        prefix: "demo:apply",
        input: { a: 1, b: 2 },
        now: 179_999,
      }),
    ).toBe(id);
    expect(
      createCardId({
        prefix: "demo:apply",
        input: { a: 1, b: 2 },
        now: 180_000,
      }),
    ).not.toBe(id);
    expect(createCardId()).not.toBe(createCardId());
    const card = createWebhookConfirmCard({
      cardId: id,
      title: "Apply",
      url: "https://example.com/confirm",
      mcpServerName: "demo",
      pendingInput: { id: 1 },
    });
    expect(card.card).toMatchObject({
      id,
      pendingInput: { id: 1 },
      action: {
        handler: {
          kind: "webhook",
          url: "https://example.com/confirm",
          mcpServerName: "demo",
        },
      },
    });
    expect(() =>
      createCardId({ prefix: "x", input: {}, bucketMs: 0 }),
    ).toThrow();
  });
  it("returns exact execute contract without leaking text into structuredContent", () => {
    expect(cardActionSuccess()).toMatchObject({
      structuredContent: { ok: true, status: "success" },
    });
    expect(
      cardActionSuccess({
        status: "running",
        statusLabel: "Queued",
        result: { job: 1 },
        text: "Started",
      }),
    ).toEqual({
      content: [{ type: "text", text: "Started" }],
      structuredContent: {
        ok: true,
        status: "running",
        statusLabel: "Queued",
        result: { job: 1 },
      },
    });
    expect(cardActionError("Denied", { errorKind: "auth_forbidden" })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Denied" }],
      structuredContent: {
        ok: false,
        error: "Denied",
        errorKind: "auth_forbidden",
      },
    });
  });
  it("HMAC signs exact raw UTF-8 bytes and rejects malformed or changed signatures", () => {
    const body = '{"value":"雪"}',
      sig = signCardBody("test-secret", body);
    expect(CARD_SIGNATURE_HEADER).toBe("x-nia-signature");
    expect(sig).toBe(
      "sha256=" +
        createHmac("sha256", "test-secret").update(body).digest("hex"),
    );
    expect(verifyCardSignature("test-secret", Buffer.from(body), sig)).toBe(
      true,
    );
    for (const header of [
      undefined,
      "",
      "bad",
      sig.replace(/.$/, "g"),
      sig.toUpperCase(),
      "sha256=" + "é".repeat(64),
    ])
      expect(verifyCardSignature("test-secret", body, header)).toBe(false);
    expect(verifyCardSignature("other", body, sig)).toBe(false);
    expect(verifyCardSignature("test-secret", body + " ", sig)).toBe(false);
  });
});
