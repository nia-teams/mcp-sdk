import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJsonSha256 } from "../canonical-json.js";

export type CardStatus = "pending" | "running" | "success" | "failed";
export type CardActionHandler =
  | { kind: "builtin"; name: string }
  | { kind: "webhook"; url: string; mcpServerName: string }
  | {
      kind: "mcp";
      server: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { kind: "open-url"; url: string };
export interface CardRequiresIdentity {
  provider: string;
  instance?: string;
}
export interface CardAction {
  label: string;
  handler: CardActionHandler;
  requiresIdentity?: CardRequiresIdentity;
}
export interface CardSpec {
  id: string;
  title: string;
  subtitle: string;
  description?: string;
  icon?: string;
  status: CardStatus;
  statusLabel?: string;
  action?: CardAction;
  pendingInput?: Record<string, unknown>;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}
export interface NiaCardEnvelope extends Record<string, unknown> {
  _niaCard: true;
  card: CardSpec;
}
export type CardActionResult =
  | {
      ok: true;
      status: "success" | "running";
      statusLabel?: string;
      result?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
      errorKind?: "auth_expired" | "auth_forbidden" | "network_error";
    };
export interface CardIdempotencyOptions {
  prefix: string;
  input: unknown;
  bucketMs?: number;
  now?: number;
}
/** Stable within a bucket for semantically identical JSON. Not a replay/authorization gate. */
export function createCardId(options?: CardIdempotencyOptions): string {
  if (!options) return randomUUID();
  const bucketMs = options.bucketMs ?? 60_000,
    now = options.now ?? Date.now();
  if (!Number.isFinite(bucketMs) || bucketMs <= 0 || !Number.isFinite(now))
    throw new TypeError("Invalid card id bucket or time");
  return `${options.prefix}:${Math.floor(now / bucketMs)}-${canonicalJsonSha256(options.input).slice(0, 16)}`;
}
interface ConfirmCardOptions {
  cardId?: string;
  idempotency?: CardIdempotencyOptions;
  title: string;
  subtitle?: string;
  description?: string;
  icon?: string;
  statusLabel?: string;
  actionLabel?: string;
  requiresIdentity?: CardRequiresIdentity;
  metadata?: Record<string, unknown>;
}
export interface McpConfirmCardOptions extends ConfirmCardOptions {
  server: string;
  toolName: string;
  arguments: Record<string, unknown>;
  detailTool?: string;
  detailArguments?: Record<string, unknown>;
  detailRequiresIdentity?: CardRequiresIdentity;
}
export interface WebhookConfirmCardOptions extends ConfirmCardOptions {
  url: string;
  mcpServerName: string;
  pendingInput: Record<string, unknown>;
}
function baseCard(
  options: ConfirmCardOptions,
  handler: CardActionHandler,
): CardSpec {
  return {
    id: options.cardId ?? createCardId(options.idempotency),
    title: options.title,
    subtitle: options.subtitle ?? "",
    status: "pending",
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    ...(options.icon !== undefined ? { icon: options.icon } : {}),
    ...(options.statusLabel !== undefined
      ? { statusLabel: options.statusLabel }
      : {}),
    action: {
      label: options.actionLabel ?? "Confirm",
      handler,
      ...(options.requiresIdentity
        ? { requiresIdentity: options.requiresIdentity }
        : {}),
    },
    ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
  };
}
export function createMcpConfirmCard(
  options: McpConfirmCardOptions,
): NiaCardEnvelope {
  const card = baseCard(options, {
    kind: "mcp",
    server: options.server,
    toolName: options.toolName,
    arguments: options.arguments,
  });
  if (
    options.detailTool !== undefined ||
    options.detailArguments !== undefined ||
    options.detailRequiresIdentity !== undefined
  ) {
    card.metadata = {
      ...card.metadata,
      ...(options.detailTool !== undefined
        ? { detailTool: options.detailTool }
        : {}),
      ...(options.detailArguments !== undefined
        ? { detailArguments: options.detailArguments }
        : {}),
      ...(options.detailRequiresIdentity !== undefined
        ? { detailRequiresIdentity: options.detailRequiresIdentity }
        : {}),
    };
  }
  return { _niaCard: true, card };
}
export function createWebhookConfirmCard(
  options: WebhookConfirmCardOptions,
): NiaCardEnvelope {
  return {
    _niaCard: true,
    card: {
      ...baseCard(options, {
        kind: "webhook",
        url: options.url,
        mcpServerName: options.mcpServerName,
      }),
      pendingInput: options.pendingInput,
    },
  };
}
export function cardToolResult(
  text: string,
  envelope: NiaCardEnvelope,
): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: envelope };
}
/** Wrap a producer, not an executor: this callback can only return a proposal card. */
export function withConfirmCard<Args extends unknown[]>(
  producer: (...args: Args) => NiaCardEnvelope | Promise<NiaCardEnvelope>,
  text?: string,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args) => {
    const envelope = await producer(...args);
    return cardToolResult(
      text ?? envelope.card.description ?? envelope.card.title,
      envelope,
    );
  };
}
export function cardActionSuccess(
  options: {
    status?: "success" | "running";
    statusLabel?: string;
    result?: Record<string, unknown>;
    text?: string;
  } = {},
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: options.text ?? options.statusLabel ?? "Action succeeded",
      },
    ],
    structuredContent: {
      ok: true,
      status: options.status ?? "success",
      ...(options.statusLabel !== undefined
        ? { statusLabel: options.statusLabel }
        : {}),
      ...(options.result !== undefined ? { result: options.result } : {}),
    } satisfies CardActionResult,
  };
}
export function cardActionError(
  error: string,
  options: {
    errorKind?: "auth_expired" | "auth_forbidden" | "network_error";
  } = {},
): CallToolResult {
  return {
    content: [{ type: "text", text: error }],
    isError: true,
    structuredContent: {
      ok: false,
      error,
      ...(options.errorKind ? { errorKind: options.errorKind } : {}),
    } satisfies CardActionResult,
  };
}
export const CARD_SIGNATURE_HEADER = "x-nia-signature";
export function signCardBody(secret: string, body: Buffer | string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}
export function verifyCardSignature(
  secret: string,
  body: Buffer | string,
  headerValue: string | undefined,
): boolean {
  if (
    typeof headerValue !== "string" ||
    !/^sha256=[a-f0-9]{64}$/.test(headerValue)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signCardBody(secret, body)),
    Buffer.from(headerValue),
  );
}
