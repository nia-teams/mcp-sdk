import { App } from "@modelcontextprotocol/ext-apps";
export { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

export function isMcpAppEmbedded(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}
export interface McpAppFetchOptions {
  app?: App;
  appInfo?: { name: string; version: string };
  apiToolName: string;
}
/** Thin JSON REST adapter. MCP Apps owns initialization, transport, and JSON-RPC. */
export function createMcpAppFetch(
  options: McpAppFetchOptions,
): (path: string, init?: RequestInit) => Promise<Response> {
  const app =
    options.app ??
    new App(options.appInfo ?? { name: "Nia Workspace App", version: "1.0.0" });
  let connected: Promise<void> | undefined;
  const connect = () => {
    if (app.getHostCapabilities()) return Promise.resolve();
    connected ??= app.connect().catch((error) => {
      connected = undefined;
      throw error;
    });
    return connected;
  };
  return async (path, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST")
      throw new TypeError("Only GET and POST are supported");
    if (!path.startsWith("/api/") || /[\x00-\x1f\\#]/.test(path))
      throw new TypeError("Expected a relative /api/ path");
    init.signal?.throwIfAborted();
    if (method === "GET" && init.body != null)
      throw new TypeError("GET cannot carry a body");
    let body: unknown;
    if (init.body != null) {
      if (typeof init.body !== "string")
        throw new TypeError("MCP App fetch supports JSON string bodies only");
      body = JSON.parse(init.body);
    }
    await connect();
    init.signal?.throwIfAborted();
    const result = await app.callServerTool(
      {
        name: options.apiToolName,
        arguments: { method, path, ...(body !== undefined ? { body } : {}) },
      },
      init.signal ? { signal: init.signal } : undefined,
    );
    const data = result.structuredContent;
    if (
      !data ||
      !Number.isInteger(data.status) ||
      (data.status as number) < 200 ||
      (data.status as number) > 599
    ) {
      throw new Error(
        result.isError
          ? "MCP App API tool failed"
          : "Invalid MCP App API response",
      );
    }
    const status = data.status as number;
    const empty = status === 204 || status === 205 || status === 304;
    return new Response(empty ? null : JSON.stringify(data.body ?? null), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}
