# @nia-teams/mcp-sdk

[English](./README.md) | 简体中文

面向 [Nia Teams](https://nia-teams.com) 的 MCP Server 扩展 SDK，基于 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 与 [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) 实现 Workload OIDC 验签、TaskBar 确认卡与 Workspace App。

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

使用 AI 编程助手（Nia Teams Agent、Claude Code、Codex 等）开发时，可直接加载 `node_modules/@nia-teams/mcp-sdk/skills/nia-teams-mcp/SKILL.md`（或仓库内 [`skills/nia-teams-mcp/SKILL.md`](./skills/nia-teams-mcp/SKILL.md)）。

## 一、背景

### Nia Teams

Nia Teams 是人与 AI Agent 协作的群聊应用。每个 Agent 有独立的成员列表，成员角色分为 `owner`、`admin`、`member`。企业将内部日志系统、数据库、发布系统封装为 MCP Server 并挂载到 Agent 后，群聊成员即可 `@` Agent 调用其中的 Tool。

MCP 规范定义了 client 与 server 之间的工具调用协议。接入多人群聊后，还有三方面规范未覆盖：

- **调用方身份**：MCP Server 需要识别调用方是哪个 Agent、属于哪个组织（`org`）、被授予了哪些权限标识（`role`）；
- **人工确认**：高危写操作需在人工确认后执行，即 Human-in-the-loop；
- **交互式 UI**：表单、看板等 UI 需要在群聊中有固定的呈现位置和访问入口。

Nia Teams 针对这三点分别提供 Workload OIDC、TaskBar 和 Workspace App，本 SDK 提供三者的服务端实现。

![Nia Teams 群聊界面（TaskBar 确认卡、Workspace 侧边栏与 Apps 菜单）](./docs/assets/group-chat-overview.png)

### Workload OIDC

Nia Teams 作为 OIDC Issuer（`https://nia-teams.com`），调用 MCP Server 时在 `Authorization` header 中携带 RS256 签名的 JWT。claims 包含 Agent 标识（`sub`）及其所属 `team`、`org` 与权限标识 `role`（放在 `groups` 数组中）。MCP Server 使用公开的 JWKS（`https://nia-teams.com/oauth2/jwks`）验证签名，无需分发或轮换静态 API Key。

JWT 有效期 5 分钟，到期前由 Nia Teams 自动刷新。完整 claims 定义见第六章及 [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md)。

### TaskBar

TaskBar 位于群聊输入框上方，展示待确认的操作卡片。

![TaskBar 确认卡](./docs/assets/taskbar-card.png)

接入 TaskBar 的写操作需拆分为两个 Tool：

1. **Propose tool**：由 Agent 调用，返回 `_niaCard` 结构，Nia Teams 将其渲染为 TaskBar 中的确认卡。该 Tool 不应产生副作用。
2. **Execute tool**：有权限的成员点击确认后，由 Nia Teams 回调。请求的 `_meta` 中携带 `nia/confirmationToken`，该 JWT 绑定确认人、card ID、目标 server 与 tool，以及参数的 SHA-256 摘要（基于 canonical JSON），用于防止参数篡改和审计追溯。

### Workspace App

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps)（SEP-1865，`@modelcontextprotocol/ext-apps`）是 MCP 的 UI 扩展协议：Tool 可声明一个 `ui://` HTML resource，由客户端以 iframe 渲染，页面通过 `postMessage` 调用 server 端 Tool。多数客户端将其内联渲染在消息流中。

Nia Teams 在 MCP Apps 之上增加了以下能力：

- **Workspace 侧边栏**：声明 `_meta["nia/workspace"]` 后，App 在群聊右侧以独立面板打开，移动端全屏显示；
- **Apps 菜单入口**：声明 `_meta["openai/ui.entrypoints"]` 后，App 固定在群聊顶部的 Apps 菜单中，成员可直接打开，无需经由 Agent 调用；
- **Viewer context**：每次 tool call 由 Nia Teams 注入当前操作者的 user ID 与成员角色（`owner` / `admin` / `member`）；声明 `_meta["nia/requireTeamAdmin"]` 后，该 App 对 `member` 不可见。

![Workspace 侧边栏中打开的运维控制台](./docs/assets/workspace-app.png)

### MCP 基础协议与 Nia Teams 扩展的分工

| 模块 | `@modelcontextprotocol/sdk` & `@modelcontextprotocol/ext-apps` | Nia Teams 扩展 |
| --- | --- | --- |
| 传输与工具调用 | Streamable HTTP、JSON-RPC、`McpServer` | 无 |
| 身份认证 | 预留 `Authorization` header 与 `_meta` | Workload OIDC JWT、confirmation token 验签 |
| 人工确认 | `structuredContent` | `_niaCard` 构建、TaskBar 渲染、execute tool 回调 |
| 交互式 UI | MCP Apps（`ui://` resource、iframe、`postMessage`） | Workspace 侧边栏、Apps 菜单入口、viewer context |

传输层与 MCP Apps 直接使用 `@modelcontextprotocol/sdk` 和 `@modelcontextprotocol/ext-apps`；`@nia-teams/mcp-sdk` 提供右列中 MCP Server 侧需要的构建与校验。

---

## 二、安装与子路径

环境要求：Node.js 20+（ESM + TypeScript 类型声明）。

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

使用 AI 编程助手（Nia Teams Agent、Claude Code、Codex 等）开发时，可直接加载 `node_modules/@nia-teams/mcp-sdk/skills/nia-teams-mcp/SKILL.md`（或仓库内 [`skills/nia-teams-mcp/SKILL.md`](./skills/nia-teams-mcp/SKILL.md)）。

| 子路径 | 运行环境 | 职责 |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | 验证 `Authorization` Bearer JWT、`nia/confirmationToken` 与参数 canonical JSON 摘要 |
| `@nia-teams/mcp-sdk/cards` | Node.js | 构建 `_niaCard` 确认卡、生成执行结果、验证 Webhook HMAC 签名 |
| `@nia-teams/mcp-sdk/apps` | Node.js | 注册 Workspace App（`ui://`）、验证 viewer context、配置 API 路径白名单 |
| `@nia-teams/mcp-sdk/apps/client` | 浏览器 | 重导出 `@modelcontextprotocol/ext-apps` 的 `App` / `PostMessageTransport`，提供 `createMcpAppFetch` 适配器 |
| `@nia-teams/mcp-sdk/testing` | Node.js（单测） | 内存态 OIDC Provider、测试密钥对与 confirmation token 签发工具 |
| `@nia-teams/mcp-sdk` | Node.js | 服务端聚合入口（重导出 `auth`、`cards`、`apps`、`testing`） |

---

## 三、快速接入

### 1. 启动带 OIDC 验签的 MCP Server

使用 `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport` 暴露 `/mcp` 端点，在分发 MCP 请求前调用 `auth.verifyBearerHeader` 验证请求头：

```ts
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createWorkloadOidcVerifier, WorkloadOidcError } from "@nia-teams/mcp-sdk/auth";

const auth = createWorkloadOidcVerifier();

createServer(async (req, res) => {
  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  let server: McpServer | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  try {
    // 验证 Authorization Bearer JWT：
    // 默认仅接受 Agent 调用（principalType: "workload"），
    // 解析出 identity.subject（Agent slug）与 identity.orgs（所属组织 slug）
    const identity = await auth.verifyBearerHeader(req.headers.authorization);

    server = new McpServer({ name: "ops-service", version: "1.0.0" });

    server.registerTool(
      "query_service_logs",
      {
        description: "查询指定服务的错误日志",
        inputSchema: {
          service: z.string(),
          limit: z.number().int().min(1).max(100).default(20),
        },
      },
      async ({ service, limit }) => {
        if (!identity.orgs.includes("acme")) {
          throw new WorkloadOidcError(403, "仅允许 acme 组织下的 Agent 调用");
        }
        const rows = await queryLogsFromDb({
          agent: identity.subject,
          orgs: identity.orgs,
          service,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );

    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      if (err instanceof WorkloadOidcError) {
        res.writeHead(err.statusCode, { "WWW-Authenticate": "Bearer" }).end(err.message);
      } else {
        res.writeHead(500).end("Internal Server Error");
      }
    }
  } finally {
    await transport?.close();
    await server?.close();
  }
}).listen(3000);
```

### 2. 挂载至 Agent

将服务部署至公网可达的 HTTPS 地址（如 `https://ops.acme.com/mcp`，不支持 `localhost` 及私网地址），在群聊中向目标 Agent 发送指令：

> 连接名为 `ops` 的 MCP Server，地址为 `https://ops.acme.com/mcp`

Agent 调用内置 `mcp_servers` Tool（`action: "update"`）在 TaskBar 生成配置变更确认卡，由该 Agent 的 `owner` 或 `admin` 点击「确认修改」后生效。

挂载时不要配置自定义 `Authorization` header：保持为空时，Nia Teams 自动在每次请求中注入 Workload OIDC JWT；若配置了静态 `Authorization` header，Nia Teams 将不再注入 Workload OIDC JWT。服务端注册的 Tool 名称 `query_service_logs` 在 Agent 侧映射为 `mcp__ops__query_service_logs`。

---

## 四、TaskBar 确认卡

将写操作拆分为两个 Tool：`propose_restart` 作为 propose tool 由 Agent 调用，返回确认卡且不修改业务状态；`execute_restart` 作为 execute tool，在成员点击确认后由 Nia Teams 回调执行。

Nia Teams 回调 execute tool 时，外层 HTTP `Authorization` header 携带的是服务身份（`sub: "nia-teams-platform"`，`principal_type: "service"`）。因此接收确认卡回调的 `/mcp` 入口需在 `verifyBearerHeader` 中开启 `allowServicePrincipal: true`，并在普通只读/提议 Tool 内检查 `identity.principalType === "workload"`：

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// HTTP 入口验签时开启 allowServicePrincipal: true，以允许 Nia Teams 回调 execute_restart：
// const identity = await auth.verifyBearerHeader(req.headers.authorization, { allowServicePrincipal: true });

// 1. Propose tool：由 Agent 调用，向 TaskBar 返回确认卡
server.registerTool(
  "propose_restart",
  {
    description: "发起服务重启提议，生成 TaskBar 确认卡等待人工批准",
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
  },
  async (args) => {
    if (identity.principalType !== "workload") {
      throw new WorkloadOidcError(403, "Requires Agent workload principal");
    }
    await db.savePendingRestart(args);
    return cardToolResult(
      `已创建重启 ${args.service} 的确认卡，等待人工确认。`,
      createMcpConfirmCard({
        cardId: `restart:${args.service}:v${args.expectedVersion}`,
        title: `重启 ${args.service}`,
        subtitle: `v${args.expectedVersion}`,
        description: args.reason,
        actionLabel: "确认重启",
        server: "ops", // 对应 Agent 上的 MCP 挂载名称
        toolName: "execute_restart",
        arguments: args,
      }),
    );
  },
);

// 2. Execute tool：成员在 TaskBar 点击确认后由 Nia Teams 回调
server.registerTool(
  "execute_restart",
  {
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
    annotations: { destructiveHint: true },
  },
  async (args, extra) => {
    // 验证 nia/confirmationToken，校验 server、tool、cardId 与参数摘要
    const human = await auth.verifyHumanActionContext(extra._meta, {
      server: "ops",
      tool: "execute_restart",
      arguments: args,
      expectedCardId: `restart:${args.service}:v${args.expectedVersion}`,
    });

    // human.confirmedBy 为确认人的 24 位十六进制 Nia Teams user ID
    if (!(await db.canUserRestartService(human.confirmedBy, args.service))) {
      return cardActionError("仅服务负责人可执行重启", {
        errorKind: "auth_forbidden",
      });
    }

    // 通过数据库版本号 CAS 保证幂等，防止并发点击或重放
    const applied = await db.applyRestartCas(args.service, args.expectedVersion, {
      approvedBy: human.confirmedBy,
      approvedByName: human.confirmedByName,
      jti: human.jti,
    });
    if (!applied) {
      return cardActionError("该操作已执行或版本号已变更");
    }

    return cardActionSuccess({
      statusLabel: "已重启",
      result: { service: args.service, approvedBy: human.confirmedBy },
    });
  },
);
```

若需在确认后触发异步 HTTP Webhook 而非回调 MCP Tool，可使用 `createWebhookConfirmCard({ title, url, mcpServerName: "ops", pendingInput })`。挂载或更新该 MCP Server 时，通过内置 `mcp_servers` Tool 在 `upsert` 项中传入 `webhookSecret` 字段（如 `{ name: "ops", url: "https://ops.acme.com/mcp", webhookSecret: "whsec_..." }`），并在 Webhook 接收端通过 `verifyCardSignature(secret, rawBodyBuffer, req.headers["x-nia-signature"])` 验证原始请求体签名。

---

## 五、Workspace App

前端通过 `vite-plugin-singlefile` 构建为单文件 HTML，服务端通过 `registerNiaWorkspaceApp` 注册 `ui://` resource 与对应的 Tool。iframe 内无需处理任何认证凭据。

### 1. 前端构建与调用

```ts
// ui/vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
});
```

前端代码仅导入浏览器入口 `@nia-teams/mcp-sdk/apps/client`：

```ts
// ui/src/main.ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";

const app = new App({ name: "运维控制台", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "ops_console_api" });

// 首次请求自动完成 app.connect()，通过 postMessage 调用服务端的 ops_console_api
const res = await apiFetch("/api/incidents?status=open");
const { incidents } = await res.json();
```

### 2. 服务端注册

`registerNiaWorkspaceApp` 的 `workspace`（默认 `true`）、`threadEntrypoint`、`requireTeamAdmin` 选项会自动生成第一章所述的 `_meta["nia/workspace"]`、`_meta["openai/ui.entrypoints"]` 与 `_meta["nia/requireTeamAdmin"]` 字段：

```ts
import { readFile } from "node:fs/promises";
import {
  registerNiaWorkspaceApp,
  verifyBoundViewer,
  createSafeApiPathChecker,
} from "@nia-teams/mcp-sdk/apps";

const isAllowedRoute = createSafeApiPathChecker({
  get: [{ pattern: /^\/api\/incidents$/, queryKeys: ["status", "limit"] }],
  post: [/^\/api\/incidents\/[a-z0-9-]+\/ack$/],
});

registerNiaWorkspaceApp(server, {
  resourceUri: "ui://ops/console",
  html: () => readFile(new URL("../ui/dist/index.html", import.meta.url), "utf8"),
  threadEntrypoint: true, // 写入 _meta["openai/ui.entrypoints"]，固定在群聊顶部 Apps 菜单
  requireTeamAdmin: true, // 写入 _meta["nia/requireTeamAdmin"]，仅对该 Agent 的 owner 与 admin 可见
  visibility: ["app"], // 仅允许群聊 Apps 菜单与 iframe 调用，不对 Agent 模型暴露该 Tool
  entryTool: {
    name: "open_ops_console",
    title: "运维控制台",
    handler: async (extra) => {
      verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      return { content: [{ type: "text", text: "运维控制台已就绪" }] };
    },
  },
  apiTool: {
    name: "ops_console_api",
    handler: async ({ method, path, body }, extra) => {
      const viewer = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });

      if (!isAllowedRoute(method, path)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Forbidden route" }],
          structuredContent: { status: 403, body: { error: "Forbidden route" } },
        };
      }

      const result = await handleIncidentApi({ method, path, body, actorId: viewer.viewerUserId });
      return {
        content: [{ type: "text", text: `HTTP ${result.status}` }],
        structuredContent: { status: result.status, body: result.body },
      };
    },
  },
});
```

---

## 六、Token 结构与角色鉴权

MCP 请求包含两层身份信息：外层 HTTP `Authorization` header 标识调用方（Agent 或 Nia Teams 回调服务），内层 MCP `_meta` 标识触发确认或访问页面的具体群聊成员。

### 1. Workload OIDC JWT（HTTP Header）

`verifyBearerHeader` 验证并解析的 JWT payload 示例：

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "ops-agent",
  "principal_type": "workload",
  "groups": ["team:ops-agent", "org:acme", "role:ops.reader"],
  "iat": 1790812800,
  "exp": 1790813100
}
```

- `identity.subject`（`sub`）与 `identity.teams`（`team:<slug>`）：Agent 的唯一标识（`slug`），创建 Agent 时生成（可在群聊中询问该 Agent，或从其分享链接 `/f/<slug>/...` 查看）。当成员点击 TaskBar 确认卡触发回调时，外层 JWT 为 Nia Teams 回调服务身份：`sub: "nia-teams-platform"`、`principal_type: "service"`。
- `identity.orgs`（`org:<slug>`）：Agent 所属组织的标识（`slug`），创建组织时生成（个人 Agent 无 `org:*` 项）。
- `identity.roles`（`role:<key>`）：绑定在该 Agent 上的权限标识（如 `role:ops.reader`），与人类成员在 Agent 上的 `owner` / `admin` / `member` 角色相互独立。`role:*` 由 Nia Teams 创建并绑定到 Agent，接入方如需使用请联系 Nia Teams；常规接入使用 `sub`（`team:*`）和 `org:*` 即可。

### 2. Confirmation Token（`_meta["nia/confirmationToken"]`）

成员点击 TaskBar 确认按钮后，Nia Teams 在 `extra._meta["nia/confirmationToken"]` 中传入的签名 JWT 示例：

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "nia-teams-platform",
  "principal_type": "service",
  "human_confirmed": true,
  "confirmed_by": "65f000000000000000000001",
  "confirmed_by_name": "Alice",
  "confirmation_card_id": "restart:payments-api:v3",
  "context_server": "ops",
  "context_tool": "execute_restart",
  "context_arguments_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "iat": 1790812860,
  "exp": 1790813160,
  "jti": "38a1b544-89ef-4a0e-b8c1-7640219c5511"
}
```

`verifyHumanActionContext` 校验签名、5 分钟有效期、`context_server`、`context_tool`、`confirmation_card_id` 与参数摘要，返回 `confirmedBy`（user ID）与 `confirmedByName`。

### 3. 成员角色（`owner` / `admin` / `member`）鉴权方式

- **MCP Server 挂载配置**：群聊成员均可要求 Agent 发起挂载提议，但仅该 Agent 的 `owner` 或 `admin` 可确认生效。
- **TaskBar 确认卡回调**：Nia Teams 默认校验点击者为发出卡片的 Agent 成员（`owner`、`admin`、`member`）。如需限制特定审批人，可在服务端根据 `human.confirmedBy` 查询业务权限表；若需转发点击者在外部系统的 OAuth 凭证，可在构建卡片时声明 `requiresIdentity: { provider: "gitlab", instance: "gitlab.example.com" }`（当前内置支持 `"gitlab"`，对应 GitLab 实例需已在 Nia Teams 完成 OAuth App 接入，如需接入自建实例请联系 Nia Teams；Nia Teams 会在成员点击时校验或引导绑定，并将 access token 注入 `human.identityToken`）。
- **Workspace App 访问控制**：Nia Teams 在每次调用 `entryTool` 与 `apiTool` 时于 `extra._meta.boundContext` 中注入当前操作者的 `viewerUserId` 与 `viewerTeamRole`。服务端须先在 HTTP 入口通过 `verifyBearerHeader` 验证外层连接（并限制 `allowedSubjects` / `requiredGroups`），再调用 `verifyBoundViewer` 校验成员角色：
  - 允许 `owner`、`admin`、`member`：`verifyBoundViewer(extra._meta)`
  - 仅允许 `owner` 与 `admin`：`verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`
  - 仅允许 `owner`：校验 `if (viewer.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "Owner required")`

---

## 七、离线单元测试

`@nia-teams/mcp-sdk/testing` 提供内存态 OIDC Provider 与 token 签发函数，可配合 `@modelcontextprotocol/sdk` 的 `InMemoryTransport` 在本地运行单元测试：

```ts
import { expect, test } from "vitest";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";

test("verifies workload JWT and confirmation token offline", async () => {
  const provider = createWorkloadOidcProvider({
    issuer: "https://nia-teams.com",
    audience: "nia-teams-workload",
    tokenTtlSeconds: 300,
    activeKey: await generateTestRsaKeyPair(),
  });

  const auth = createWorkloadOidcVerifier({ jwks: await provider.getJwks() });

  const agentJwt = await provider.signIdToken({
    subject: "ops-agent",
    groups: ["team:ops-agent", "org:acme", "role:ops.reader"],
    claims: { principal_type: "workload" },
  });
  const identity = await auth.verifyBearerHeader(`Bearer ${agentJwt}`, {
    requiredGroups: ["role:ops.reader"],
  });
  expect(identity.subject).toBe("ops-agent");

  const args = { service: "payments-api", expectedVersion: 3 };
  const confirmationToken = await signTestConfirmationToken(provider, {
    server: "ops",
    tool: "execute_restart",
    arguments: args,
    cardId: "restart:payments-api:v3",
    confirmedBy: "65f000000000000000000001",
    confirmedByName: "Alice",
  });

  const human = await auth.verifyHumanActionContext(
    { "nia/confirmationToken": confirmationToken },
    { server: "ops", tool: "execute_restart", arguments: args, expectedCardId: "restart:payments-api:v3" },
  );
  expect(human.confirmedByName).toBe("Alice");
});
```

---

## 八、示例与规范文档

- 可运行示例：
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) —— 带 Workload OIDC 鉴权的只读日志查询服务
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) —— Propose / Execute 双步确认卡与版本 CAS
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) 与 [`examples/workspace-ui/`](./examples/workspace-ui) —— Workspace App 服务端与单文件前端工程
- AI 编码 Skill（供接入方 AI 加载）：`node_modules/@nia-teams/mcp-sdk/skills/nia-teams-mcp/SKILL.md`（[`skills/nia-teams-mcp/SKILL.md`](./skills/nia-teams-mcp/SKILL.md)）
- 协议规范（底层 Wire 格式参考）：[`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md)

## 开源协议

[MIT](./LICENSE) © Nia Teams
