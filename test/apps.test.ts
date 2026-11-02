import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { App } from "@modelcontextprotocol/ext-apps";
import { createMcpAppFetch, isMcpAppEmbedded } from "../src/apps/client.js";
import {
  registerNiaWorkspaceApp,
  niaWorkspaceMeta,
  verifyBoundViewer,
  createSafeApiPathChecker,
  RESOURCE_MIME_TYPE,
  getUiCapability,
  EXTENSION_ID,
} from "../src/apps/index.js";

const boundContext = {
  viewerUserId: "ABCDEF0123456789ABCDEF01",
  viewerTeamRole: "admin",
};
describe("workspace metadata and viewer", () => {
  it("emits exact platform extension keys and reexports official helpers", () => {
    expect(
      niaWorkspaceMeta({
        resourceUri: "ui://demo/app",
        visibility: ["app"],
        threadEntrypoint: true,
        requireTeamAdmin: true,
      }),
    ).toEqual({
      ui: { resourceUri: "ui://demo/app", visibility: ["app"] },
      "nia/workspace": true,
      "nia/requireTeamAdmin": true,
      "openai/ui.entrypoints": [{ type: "thread" }],
    });
    expect(
      niaWorkspaceMeta({ resourceUri: "ui://demo/app", workspace: false }),
    ).toEqual({ ui: { resourceUri: "ui://demo/app" }, "nia/workspace": false });
    expect(() =>
      niaWorkspaceMeta({ resourceUri: "https://example.com" }),
    ).toThrow();
    expect(
      getUiCapability({
        extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
      }),
    ).toEqual({ mimeTypes: [RESOURCE_MIME_TYPE] });
  });
  it.each(["owner", "admin", "member"])(
    "validates bound viewer role %s",
    (role) => {
      expect(
        verifyBoundViewer({
          boundContext: { ...boundContext, viewerTeamRole: role },
        }),
      ).toMatchObject({
        viewerUserId: boundContext.viewerUserId.toLowerCase(),
        viewerTeamRole: role,
        actor: `user:${boundContext.viewerUserId.toLowerCase()}`,
      });
      if (role === "member")
        expect(() =>
          verifyBoundViewer(
            { boundContext: { ...boundContext, viewerTeamRole: role } },
            { requireTeamAdmin: true },
          ),
        ).toThrow();
      else
        expect(
          verifyBoundViewer(
            { boundContext: { ...boundContext, viewerTeamRole: role } },
            { requireTeamAdmin: true },
          ).viewerTeamRole,
        ).toBe(role);
    },
  );
  it.each([
    undefined,
    {},
    { boundContext: [] },
    { boundContext: { viewerUserId: "not-an-id", viewerTeamRole: "owner" } },
    { boundContext: { ...boundContext, viewerTeamRole: "root" } },
  ])("fails closed for malformed viewer %j", (meta) => {
    expect(() => verifyBoundViewer(meta)).toThrow();
  });
});
describe("safe API paths", () => {
  const allowed = createSafeApiPathChecker({
    get: [
      { pattern: /^\/api\/items(?:\/[^/]+)?$/g, queryKeys: ["limit", "q"] },
    ],
    post: [/^\/api\/items\/[^/]+\/apply$/],
  });
  it("permits exact allowlisted GET/POST including declared query keys", () => {
    for (let i = 0; i < 2; i++)
      expect(allowed("GET", "/api/items?limit=2&q=hello%20world")).toBe(true);
    expect(allowed("post", "/api/items/1/apply")).toBe(true);
  });
  it.each([
    "/api/items/../items",
    "/api/items/.",
    "/api/items/%2e%2e",
    "/api/items/%2fhidden",
    "/api/items/%5cfoo",
    "/api/items/%252e%252e",
    "/api/items/\\evil",
    "/api/items/%00",
    "/api/items/%7f",
    "/api/items/%ZZ",
    "/api/items#x",
    "/api/items?limit=1&limit=2",
    "/api/items?x=1",
    "/api/items?limit=%00",
    "/api/items?limit=%ZZ",
    "//example.com/api/items",
    "https://example.com/api/items",
    "/api/items\n",
    "/api/other",
  ])("rejects unsafe path %s", (path) => {
    expect(allowed("GET", path)).toBe(false);
  });
  it("rejects post queries, unsupported methods and nonstrings", () => {
    expect(allowed("POST", "/api/items/1/apply?")).toBe(false);
    expect(allowed("DELETE", "/api/items")).toBe(false);
    expect(allowed("GET", null)).toBe(false);
  });
});
describe("MCP + App integration using official in-memory transports", () => {
  it("lists registered UI resources/tools and initializes official App through AppBridge before REST calls", async () => {
    const server = new McpServer({ name: "demo", version: "1.0.0" });
    registerNiaWorkspaceApp(server, {
      resourceUri: "ui://demo/app",
      html: async () => "<!doctype html><title>Demo</title>",
      requireTeamAdmin: true,
      threadEntrypoint: true,
      entryTool: {
        name: "open_demo",
        title: "Demo",
        handler: async () => ({
          content: [{ type: "text", text: "Open Demo" }],
        }),
      },
      apiTool: {
        name: "demo_api",
        handler: async (args, extra) => {
          const viewer = verifyBoundViewer(extra._meta, {
            requireTeamAdmin: true,
          });
          return {
            content: [{ type: "text", text: "HTTP 200" }],
            structuredContent: {
              status: 200,
              body: { ...args, actor: viewer.actor },
            },
          };
        },
      },
    });
    const client = new Client({ name: "test-host", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const app = new App(
      { name: "demo-ui", version: "1.0.0" },
      {},
      { autoResize: false },
    );
    const [at, bt] = InMemoryTransport.createLinkedPair();
    const bridge = new AppBridge(
      null,
      { name: "test-host", version: "1.0.0" },
      { serverTools: {} },
    );
    try {
      await server.connect(st);
      await client.connect(ct);
      const tools = await client.listTools();
      expect(
        tools.tools.find((t) => t.name === "open_demo")?._meta,
      ).toMatchObject(
        niaWorkspaceMeta({
          resourceUri: "ui://demo/app",
          requireTeamAdmin: true,
          threadEntrypoint: true,
        }),
      );
      expect(
        tools.tools.find((t) => t.name === "demo_api")?._meta,
      ).toMatchObject({ ui: { visibility: ["app"] } });
      expect((await client.listResources()).resources[0]?.mimeType).toBe(
        RESOURCE_MIME_TYPE,
      );
      expect(
        (await client.readResource({ uri: "ui://demo/app" })).contents[0],
      ).toMatchObject({
        mimeType: RESOURCE_MIME_TYPE,
        text: "<!doctype html><title>Demo</title>",
      });
      expect(
        (await client.callTool({ name: "open_demo", arguments: {} })).content,
      ).toEqual([{ type: "text", text: "Open Demo" }]);
      bridge.oncalltool = async (params) =>
        (await client.callTool({
          ...params,
          _meta: { boundContext },
        })) as Awaited<ReturnType<App["callServerTool"]>>;
      await bridge.connect(bt);
      const actualConnect = app.connect.bind(app);
      const connect = vi
        .spyOn(app, "connect")
        .mockImplementation(() => actualConnect(at));
      const fetchApi = createMcpAppFetch({ app, apiToolName: "demo_api" });
      const [get, post] = await Promise.all([
        fetchApi("/api/items"),
        fetchApi("/api/items", { method: "POST", body: '{"name":"Item"}' }),
      ]);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(await get.json()).toMatchObject({
        method: "GET",
        path: "/api/items",
        actor: `user:${boundContext.viewerUserId.toLowerCase()}`,
      });
      expect(await post.json()).toMatchObject({
        method: "POST",
        body: { name: "Item" },
      });
    } finally {
      await at.close();
      await bt.close();
      await client.close();
      await server.close();
    }
  });
});
it("registers typed entry input schemas and static HTML without an API bridge", async () => {
  const { z } = await import("zod");
  const server = new McpServer({ name: "typed", version: "1" });
  const handles = registerNiaWorkspaceApp(server, {
    resourceUri: "ui://demo/typed",
    html: "<html></html>",
    entryTool: {
      name: "typed",
      inputSchema: { name: z.string() },
      handler: async ({ name }) => ({
        content: [{ type: "text", text: name }],
      }),
    },
  });
  expect(handles.apiTool).toBeUndefined();
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    expect(
      (await client.callTool({ name: "typed", arguments: { name: "World" } }))
        .content,
    ).toEqual([{ type: "text", text: "World" }]);
    expect(
      (await client.readResource({ uri: "ui://demo/typed" })).contents[0],
    ).toMatchObject({ text: "<html></html>" });
  } finally {
    await client.close();
    await server.close();
  }
});

it("constructs an official App when omitted and detects iframe embedding without treating it as auth", async () => {
  const connect = vi.spyOn(App.prototype, "connect").mockResolvedValue();
  const call = vi
    .spyOn(App.prototype, "callServerTool")
    .mockResolvedValue({
      content: [],
      structuredContent: { status: 200, body: [] },
    });
  try {
    const fetchApi = createMcpAppFetch({
      appInfo: { name: "Auto", version: "2" },
      apiToolName: "auto_api",
    });
    expect(await (await fetchApi("/api/items")).json()).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      { name: "auto_api", arguments: { method: "GET", path: "/api/items" } },
      undefined,
    );
    vi.stubGlobal("window", { parent: {} });
    expect(isMcpAppEmbedded()).toBe(true);
  } finally {
    connect.mockRestore();
    call.mockRestore();
    vi.unstubAllGlobals();
  }
});

describe("browser fetch adapter", () => {
  function setup() {
    const app = new App(
      { name: "test", version: "1" },
      {},
      { autoResize: false },
    );
    const connect = vi.spyOn(app, "connect").mockResolvedValue();
    const call = vi.spyOn(app, "callServerTool").mockResolvedValue({
      content: [],
      structuredContent: { status: 200, body: { ok: true } },
    });
    return {
      app,
      connect,
      call,
      fetchApi: createMcpAppFetch({ app, apiToolName: "api" }),
    };
  }
  it("is SSR safe and serializes JSON REST calls only", async () => {
    expect(isMcpAppEmbedded()).toBe(false);
    const { fetchApi, call } = setup();
    expect(
      await (
        await fetchApi("/api/items", { method: "POST", body: '{"a":1}' })
      ).json(),
    ).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith(
      {
        name: "api",
        arguments: { method: "POST", path: "/api/items", body: { a: 1 } },
      },
      undefined,
    );
  });
  it("preserves HTTP errors, empty response semantics and rejects malformed tool results", async () => {
    const { fetchApi, call } = setup();
    call.mockResolvedValueOnce({
      content: [],
      isError: true,
      structuredContent: { status: 403, body: { error: "Forbidden" } },
    });
    const denied = await fetchApi("/api/items");
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(403);
    call.mockResolvedValueOnce({
      content: [],
      structuredContent: { status: 204 },
    });
    expect(await (await fetchApi("/api/items")).text()).toBe("");
    call.mockResolvedValueOnce({ content: [] });
    await expect(fetchApi("/api/items")).rejects.toThrow("Invalid");
  });
  it("does not reconnect an initialized app and retries failed initialization", async () => {
    const { app, fetchApi, connect } = setup();
    vi.spyOn(app, "getHostCapabilities").mockReturnValue({ serverTools: {} });
    await fetchApi("/api/items");
    expect(connect).not.toHaveBeenCalled();
    vi.mocked(app.getHostCapabilities).mockReturnValue(undefined);
    connect.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(fetchApi("/api/items")).rejects.toThrow("Disconnected");
    await fetchApi("/api/items");
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("rejects unsupported requests and forwards cancellation", async () => {
    const { fetchApi, call } = setup();
    for (const init of [
      { method: "DELETE" },
      { body: "{}" },
      { method: "POST", body: "not-json" },
      { method: "POST", body: new URLSearchParams() },
    ])
      await expect(fetchApi("/api/items", init)).rejects.toThrow();
    await expect(fetchApi("https://example.com/api/items")).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchApi("/api/items", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});
