[English](./README.md) | 简体中文

# @nia-teams/mcp-sdk

**让企业系统接入 Nia Teams：验证 Agent 身份、让人确认写操作、把管理界面嵌入工作区，而不是重新实现 MCP。**

企业把数据库、日志、部署流水线、审批流程或管理后台通过 **Model Context Protocol（MCP）** 接入
[Nia Teams](https://nia-teams.com) 时，基础协议应交给官方 SDK：
`@modelcontextprotocol/sdk` 负责 Streamable HTTP 上的 JSON-RPC、`tools/call`、`resources/read`；
`@modelcontextprotocol/ext-apps` 负责标准 MCP Apps、`ui://` 资源、初始化与 iframe postMessage 桥接。

**`@nia-teams/mcp-sdk` 是构建在这些官方 SDK 之上的一层轻量 Nia Teams 扩展**，补齐三个企业接入能力：

1. **无需静态 Agent 密钥的工作负载与人类操作 OIDC**（`/auth`）。Agent 的 MCP 请求携带
   RS256 OIDC Bearer JWT：`iss: https://nia-teams.com`、`aud: nia-teams-workload`、
   `sub: <agentSlug>`，以及 `["team:...", "org:...", "role:..."]` 等分组。
   服务端通过 `/oauth2/jwks` 验签，无需分发、轮换长期 Agent API Key。
   卡片确认、详情查看以及受支持的角色挂载工作区调用，还会按场景携带
   `_meta["nia/confirmationToken"]`、`_meta["nia/viewerContextToken"]` 或
   `_meta["nia/sourceContextToken"]` 中的短期签名上下文：最长 **5 分钟**，并绑定确切的
   server、工具名和参数的规范 JSON SHA-256 摘要（`context_arguments_sha256`）。
   平台回调的服务主体使用单独的 subject；服务主体身份本身不代表人的同意。
2. **人在回路中的 TaskBar 确认卡片**（`/cards`）。把写操作拆成“提案工具”和“执行工具”。
   AI 调用提案工具时，不直接执行破坏性副作用，而是在 `structuredContent` 返回 `_niaCard`。
   Nia Teams 在群聊 / TaskBar 渲染确认卡片；只有获得授权的人点击 **Confirm（确认）** 后，
   平台才会携带签名的 `nia/confirmationToken` 调用执行工具，或向 webhook POST 原始请求体，
   并以 `X-Nia-Signature` HMAC-SHA256 签名。执行端仍须校验业务权限，并使用持久化 CAS 防止重复副作用。
3. **侧边 Workspace MCP Apps**（`/apps` 与 `/apps/client`）。直接复用官方
   `ui://` 资源和 `text/html;profile=mcp-app` MIME 类型。
   `_meta["nia/workspace"]: true` 让应用在桌面右侧分屏工作区 / 移动端全屏面板打开；
   `_meta["openai/ui.entrypoints"]: [{ type: "thread" }]` 把入口放到群聊顶部 Apps 菜单；
   `_meta["nia/requireTeamAdmin"]: true` 声明管理员入口。
   SDK 提供 `_meta.boundContext` 查看者角色校验、严格的路径穿越与路由白名单检查，
   以及轻量浏览器适配器 `createMcpAppFetch`，把已有前端的 `fetch('/api/...')` 风格调用转成
   官方 `app.callServerTool()`。初始化与 postMessage 仍由官方 App 负责；元数据本身不是授权。

“无静态密钥”指工作负载认证无需长期 Agent API 密钥。可选的 webhook 卡片回调仍然**需要共享 HMAC 密钥**；
如果希望确认链路也基于 OIDC、无需 webhook 密钥，请使用 MCP 执行工具回调。

由 **Nia Teams** 维护 · [GitHub](https://github.com/nia-teams/mcp-sdk) · [MIT](LICENSE) ·
[AI 编码 Agent 指南](./AGENTS.md) · [完整协议规范（英文）](./docs/SPECIFICATION.md)

## 端到端架构：三个流程，一个企业 MCP 服务

```text
Nia Teams Host                       Enterprise MCP Server           Enterprise systems
(Agent + authenticated human)        (official MCP SDK + this SDK)

1. READ / 只读查询
Agent -- tools/call + OIDC Bearer --> verifyBearerHeader + policy ---> scoped database/log query
      <-- text / structured data --- standard MCP result <----------- result

2. WRITE / 人工确认后写入
Agent -- proposal tools/call ------> build _niaCard; NO mutation
Host  <-- text + _niaCard ---------- cardToolResult
Human -- Confirm in TaskBar -------> Host authorizes the click
Host  -- execution tools/call -----> verifyHumanActionContext -------> permissions + durable CAS
         + confirmationToken        (server/tool/arguments/card)      then apply change
      <-- action result ----------- cardActionSuccess / cardActionError
      (Alternative: Host -- raw POST + X-Nia-Signature --> verified webhook)

3. WORKSPACE / 侧边工作区
Host  -- resources/read ui:// -----> single-file HTML resource
      <-- text/html;profile=mcp-app
  |
  +-- Sandbox Iframe (desktop split workspace / mobile full-screen)
      official App.connect() <----> Host's official ui/initialize / postMessage bridge
      createMcpAppFetch('/api/...')
        -> App.callServerTool() ---> Host -- tools/call -------------> API bridge
                                           + authenticated context   verifyBoundViewer
                                                                     + safe path allowlist
                                                                     + business authorization
      <--------------------------- { status, body } <--------------- enterprise API result
```

沙箱 iframe 不需要获取 Agent 的 Bearer Token 或 webhook 密钥。
Host 管理凭据与查看者上下文；企业服务端决定业务授权与实际副作用。

## 官方开源 SDK 负责什么，本 SDK 增加什么？

| 职责                                                             | 官方包 / 工具                                                                     | `@nia-teams/mcp-sdk` 增加的内容                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| MCP 服务端、客户端、Schema、传输、`tools/call`、`resources/read` | `@modelcontextprotocol/sdk`：`McpServer`、Streamable HTTP、`InMemoryTransport`    | 不替代，直接使用官方实现                                                            |
| RS256、JWT/JWK 验证、本地与远程 JWKS                             | `jose`                                                                            | Nia issuer/audience 默认值、主体与分组策略、精确调用绑定的短期人类 / 来源上下文校验 |
| `ui://` HTML 资源与 UI 工具注册                                  | `@modelcontextprotocol/ext-apps/server`：`registerAppTool`、`registerAppResource` | 原样重新导出；增加工作区 / Thread / 管理员元数据和便捷注册                          |
| `App`、`ui/initialize`、iframe postMessage JSON-RPC、React hooks | `@modelcontextprotocol/ext-apps` 及其 `/react` 导出                               | JSON REST 到工具调用的薄适配器；不自建消息桥或 React hooks                          |
| 单文件 HTML / JS / CSS 打包                                      | Vite + `vite-plugin-singlefile`                                                   | 可构建示例；不使用正则表达式拼装 HTML                                               |
| 人工确认卡片渲染与回调                                           | Nia Teams Host                                                                    | `_niaCard` 构建、执行结果与 HMAC 工具；不自建卡片渲染器                             |
| 工作区查看者与 REST 桥接安全                                     | 已认证的 Host + 企业应用                                                          | 查看者检查，以及严格的路径 / 查询参数 / 路由白名单                                  |
| 离线扩展测试                                                     | 官方 SDK 的 `InMemoryTransport` + `jose`                                          | 本地测试 issuer、RSA 密钥、确认 / 查看上下文签名工具                                |

本包不替代 MCP、不实现 Apps Host，也不内嵌上游 SDK。标准 MCP 客户端仍可正常读取 `content[].text`。
官方 React hooks 请直接从 `@modelcontextprotocol/ext-apps/react` 使用。

## 安装与模块入口

需要 **Node.js 20+**。本包提供 ESM 与 TypeScript 声明，不提供 CommonJS 构建。

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| 导入路径                         | 内容                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `@nia-teams/mcp-sdk`             | 服务端总入口：auth、cards、apps、testing                  |
| `@nia-teams/mcp-sdk/auth`        | JWT 校验、规范 JSON、常量                                 |
| `@nia-teams/mcp-sdk/cards`       | 卡片类型 / 构建器、执行结果、HMAC                         |
| `@nia-teams/mcp-sdk/apps`        | 官方服务端辅助函数、工作区注册、查看者 / 路径校验         |
| `@nia-teams/mcp-sdk/apps/client` | 浏览器侧 `App`、`PostMessageTransport`、JSON fetch 适配器 |
| `@nia-teams/mcp-sdk/testing`     | 离线 issuer、RSA 测试密钥、人类上下文签名                 |

**浏览器必须导入 `/apps/client`，不要导入服务端总入口。** 官方 SDK 作为 peer dependencies 使用，不做分叉。

## 场景一：验证工作负载，查询只读数据

```ts
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";

const auth = createWorkloadOidcVerifier();
// 在 HTTP 边界验证，先认证，再分发 MCP 请求。
const identity = await auth.verifyBearerHeader(request.headers.authorization, {
  requiredGroups: ["role:logs.reader"],
  allowedSubjects: ["example-agent"], // 可选；空数组表示拒绝所有主体。
});
// 后续数据库 / 日志查询必须限定到 identity.subject 与 identity.groups 的授权范围。
```

默认 issuer 为 `https://nia-teams.com`，audience 为 `nia-teams-workload`，JWKS 为
`https://nia-teams.com/oauth2/jwks`。可配置 `issuer`、`audience`、`jwksUrl`、`fetchImpl`，
或传入离线公钥 `jwks`。只接受 RS256。

`WorkloadOidcError.statusCode`：缺失 / 过期凭据为 401，签名或声明无效 / 授权不通过为 403；
基础设施网络错误继续抛出。默认拒绝 service principal，只有显式设置 `allowServicePrincipal: true`
才接受；这只证明传输身份，不是全局写权限或人的同意。必须另行检查主体 / 角色 / 业务范围。

## 场景二：先产卡，再由人确认执行

提案工具只返回卡片，不修改系统：

```ts
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
} from "@nia-teams/mcp-sdk/cards";

const envelope = createMcpConfirmCard({
  cardId: "changes:change-123",
  title: "应用变更",
  subtitle: "版本 7",
  server: "changes",
  toolName: "apply_change",
  arguments: { changeId: "change-123", expectedVersion: 7 },
});
return cardToolResult("请审阅并确认本次变更。", envelope);
```

在独立的 `apply_change` 执行工具中：

```ts
const human = await auth.verifyHumanActionContext(extra._meta, {
  server: "changes",
  tool: "apply_change",
  arguments: args,
  expectedCardId: `changes:${args.changeId}`,
});
// 重新检查业务权限，并通过持久化版本 CAS / 事务原子执行。
// 记录 human.confirmedBy 与 human.jti；拒绝已经处理的变更。
return cardActionSuccess({ result: { changeId: args.changeId } });
```

签名同时绑定 server / 工具 / 参数 / 卡片 / 人。`intent: 'view'` 只接受
`human_confirmed: false` 的 `nia/viewerContextToken`，不能用于写授权。
可选的 `nia/identityToken` 与签名上下文以 SHA-256 绑定，但仍需检查外部身份提供方的令牌有效性与权限。

其他辅助函数：

- `createWebhookConfirmCard({ title, url, mcpServerName, pendingInput, ... })`：创建 webhook 卡片。
  在解析 JSON 前，用原始请求体字节校验 `x-nia-signature`。
- `createCardId({ prefix, input, now?, bucketMs? })`：规范输入摘要 + 默认 60 秒时间桶；不传参数则生成 UUID。
- `withConfirmCard(producer, text?)`：把同步 / 异步产卡函数包装成 MCP 回调，不是执行器包装器。
- `cardActionSuccess({ status?, statusLabel?, result?, text? })` 与
  `cardActionError(message, { errorKind? })`：返回平台要求的执行结果。

**卡片 ID、5 分钟窗口与 JWT `jti` 都不等于内置防重放存储。** 需要持久化业务 CAS、事务或 nonce 账本。
HMAC 本身不含时间戳。

## 场景三：注册侧边 Workspace App

```ts
import {
  registerNiaWorkspaceApp,
  verifyBoundViewer,
  createSafeApiPathChecker,
} from "@nia-teams/mcp-sdk/apps";

const allowed = createSafeApiPathChecker({
  get: [{ pattern: /^\/api\/reports$/, queryKeys: ["limit"] }],
  post: [/^\/api\/reports\/refresh$/],
});

registerNiaWorkspaceApp(server, {
  resourceUri: "ui://example/dashboard",
  html: () => readSingleFileHtml(),
  threadEntrypoint: true,
  requireTeamAdmin: true,
  visibility: ["app"],
  entryTool: {
    name: "open_dashboard",
    title: "报表工作区",
    handler: async (extra) => {
      verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      return { content: [{ type: "text", text: "报表工作区已就绪" }] };
    },
  },
  apiTool: {
    name: "dashboard_api",
    handler: async ({ method, path, body }, extra) => {
      const viewer = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      if (!allowed(method, path)) {
        return {
          isError: true,
          content: [{ type: "text", text: "禁止访问此路由" }],
          structuredContent: { status: 403, body: { error: "禁止访问此路由" } },
        };
      }
      // 调用应用现有、带业务授权的处理逻辑，不要任意转发 URL。
      const response = await dispatchAuthorizedApi({
        method,
        path,
        body,
        viewer,
      });
      return {
        content: [{ type: "text", text: `HTTP ${response.status}` }],
        structuredContent: { status: response.status, body: response.body },
      };
    },
  },
});
```

注册函数只添加元数据，不自动授权。只有**先认证平台传输，并限定允许的 Team / 角色挂载**，
才能信任 Host 注入的 `boundContext`；任意 MCP 客户端也能自行传元数据。
`verifyBoundViewer` 检查 24 位十六进制用户 ID 与 owner / admin / member 角色；
`requireTeamAdmin: true` 拒绝 member。入口工具和每个桥接调用都要验证。

浏览器端：

```ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";
const app = new App({ name: "报表工作区", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "dashboard_api" });
const response = await apiFetch("/api/reports?limit=20");
const reports = await response.json();
```

首次请求会等待官方 `app.connect()`；已初始化的 App 会复用，并发请求共享初始化。
适配器仅支持 JSON REST 风格调用：GET / POST、相对 `/api/` 路径、JSON 字符串 POST 请求体、取消信号，
以及含 HTTP 状态和 JSON 请求结果的 `Response`。不代理 Cookie、自定义 Header、凭据、上传、流式内容或任意域名。
服务端必须再次校验路径与业务权限。`isMcpAppEmbedded()` 只是 iframe 环境判断，不是能力协商或认证。

单文件打包交给现有工具：

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({ plugins: [viteSingleFile()] });
```

把构建后的 HTML 以 `text/html;profile=mcp-app` 提供。
不要手工重写脚本分块，不要自己实现 `ui/initialize` / postMessage 桥。

## 离线测试：不需要连接真实 Nia Teams

```ts
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";

const provider = createWorkloadOidcProvider({
  issuer: "https://nia-teams.com",
  audience: "nia-teams-workload",
  tokenTtlSeconds: 300,
  activeKey: await generateTestRsaKeyPair(),
});
const verifier = createWorkloadOidcVerifier({ jwks: await provider.getJwks() });
const token = await provider.signIdToken({
  subject: "example-agent",
  groups: ["team:example-agent"],
  claims: { principal_type: "workload" },
});
await verifier.verifyBearerHeader(`Bearer ${token}`);

const confirmationToken = await signTestConfirmationToken(provider, {
  server: "changes",
  tool: "apply_change",
  arguments: { changeId: "change-123", expectedVersion: 7 },
  cardId: "changes:change-123",
});
await verifier.verifyHumanActionContext(
  { "nia/confirmationToken": confirmationToken },
  {
    server: "changes",
    tool: "apply_change",
    arguments: { changeId: "change-123", expectedVersion: 7 },
    expectedCardId: "changes:change-123",
  },
);
```

`signTestViewerContextToken(...)` 以相同方式签署查看上下文。
签名辅助函数返回 JWT 字符串，不是外层 `_meta` 对象；人类上下文的 provider TTL 必须不超过 300 秒。
再配合官方 SDK 的 `InMemoryTransport` 做真实 MCP 服务端 / 客户端往返测试。
测试密钥与本地 issuer 绝不能变成生产信任来源。

## 示例与开发命令

- [OIDC 认证的只读 HTTP MCP 服务](examples/01-readonly-workload-oidc.ts)
- [TaskBar 提案与人工确认写入](examples/02-taskbar-confirm-card.ts)
- [Workspace 服务端](examples/03-workspace-mcp-app.ts) 与 [单文件 UI](examples/workspace-ui)

```sh
npm ci
npm test
npm run typecheck
npm run build
# 可选：先构建 SDK，再构建单文件 UI 示例。
cd examples/workspace-ui && npm install && npm run build
```

服务端示例使用公开的 `@nia-teams/mcp-sdk/*` 入口。
示例 01 仅在 `RUN_EXAMPLE=1` 且通过 TypeScript runner 运行时监听端口；
示例 02 / 03 导出服务，需挂载到你自己的已认证 MCP HTTP 边界。
示例业务数据是占位逻辑，生产接入时替换成受授权的数据查询、持久化事务与审计存储。

AI 编码 Agent 请阅读 [AGENTS.md](./AGENTS.md)，包括仓库边界、接入准则与验证要求。
完整声明与安全边界见 [协议规范](./docs/SPECIFICATION.md)。上游 SDK 独立维护，本仓库采用 MIT 许可证。
