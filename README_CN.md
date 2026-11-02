# @nia-teams/mcp-sdk

[English](./README.md) | 简体中文

把企业内部服务（数据库、日志、发布流水线、审批单、运维控制台）通过 MCP 接入 [Nia Teams](https://nia-teams.com)。

在开始看代码前，先把 **Nia Teams 里这三项能力本身是什么**、**哪些是标准 MCP 协议原生的、哪些是 Nia Teams 的扩展**、以及 **OIDC Token 长什么样** 讲清楚。

---

## 一、背景：Nia Teams 的这三项能力到底是什么？

在 Nia Teams 里，人类和 AI Agent 在同一个群聊（GroupChat）里协作。当你的 MCP 服务挂载到某个 Agent 上之后，除了让 AI 调普通工具查数据，还会直接参与 Nia Teams 的三个核心产品界面与认证机制：

### 1. OIDC 免密工作负载认证（Workload OIDC）是什么？

在传统接入里，每给一个 Agent 挂载外部服务，管理员都要去生成静态 API Key、手动配进 Agent 的请求头，还要操心密钥泄露和定期轮换。

Nia Teams 内置了 **Workload OIDC 身份签发器**（Issuer 为 `https://nia-teams.com`）：
- 只要挂载 MCP 服务时不填静态 `Authorization` 请求头，Nia Teams 向你的 MCP 服务发起的**每一次 HTTP 请求**，都会自动在 `Authorization: Bearer <JWT>` 里附带一枚由平台私钥签发的短效 RS256 JWT（有效期 5 分钟，到期前 30 秒自动刷新）。
- 你的服务端不需要保存任何共享密钥，只需拉取 Nia Teams 公开的 JWKS 公钥（`https://nia-teams.com/oauth2/jwks`）即可验签，并直接从 Token 里读出**当前是哪个 Agent 在调、属于哪个组织（`org:*`）、绑了什么权限角色（`role:*`）**。

#### OIDC Token 到底长什么样？

Nia Teams 在整个生命周期里会签发 **两类** RS256 JWT（同一个 Issuer 与 JWKS 公钥，通过 `principal_type` 和所处位置区分）：

**(1) 外层 HTTP `Authorization: Bearer <JWT>` —— 当 Agent 调用工具或打开面板时（`principal_type: "workload"`）**

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "ops-agent",
  "principal_type": "workload",
  "groups": [
    "team:ops-agent",
    "org:acme",
    "role:ops.reader"
  ],
  "iat": 1790812800,
  "nbf": 1790812800,
  "exp": 1790813100,
  "jti": "c9f7e120-531b-45c4-98d4-9ef8a3a01234"
}
```
- `sub`：发起调用的 **Agent 标识（slug）**，注意它代表的是 Agent，不是群里说话的人类。
- `groups`：该 Agent 归属的团队（`team:<slug>`）、所属组织（`org:<slug>`）以及平台授予该 Agent 的角色（`role:<roleKey>`；若人类刚批准过会话临时提权，还会带上 `nia:elevated:role:<roleKey>`）。

**(2) 内层 MCP `_meta["nia/confirmationToken"]` —— 当人类在界面上点击确认卡按钮后，平台回调执行工具时（`principal_type: "service"`）**

此时外层 HTTP Bearer Token 的身份会变成平台回调服务（`sub: "nia-teams-platform"`, `principal_type: "service"`），同时在 MCP `tools/call` 的 `params._meta["nia/confirmationToken"]` 里附带下面这枚**专门锁死本次人工点击与参数摘要**的签名 JWT：

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
  "nbf": 1790812860,
  "exp": 1790813160,
  "jti": "38a1b544-89ef-4a0e-b8c1-7640219c5511"
}
```
- `confirmed_by` / `confirmed_by_name`：真实点击确认按钮的人类用户 ID（24 位十六进制）与姓名。
- `context_server` / `context_tool` / `context_arguments_sha256`：把这枚 Token 死死绑定在目标 MCP 服务名、执行工具名、以及参数对象的 Canonical JSON SHA-256 哈希上——哪怕 AI 或中间人篡改了一个字段，验签都会直接报 403。

---

### 2. TaskBar（人工确认卡栏）是什么？

在 Nia Teams 群聊界面里，**消息时间线的正下方、输入框与 Agent 执行状态区的上方**，有一条常驻的任务栏，叫 **TaskBar**。

TaskBar 是 Nia Teams 里**「AI 提议 → 人类拍板」的唯一受控闸门**：
- 当涉及重启生产服务、执行数据库变更、合并代码、修改权限等不可逆写操作时，AI 不能直接改线上状态，而是调用一个「提案工具」向群聊返回一张结构化的确认卡（`_niaCard: true`）。
- 卡片会挂在群聊底部的 TaskBar 上（在会话列表也会显示待点击角标），展示操作标题、原因说明和「确认」按钮（还可以带「查看详情」按钮，或者要求点击人先完成 GitLab/GitHub 等外部 OAuth 授权）。
- **在人类点击按钮之前，没有任何副作用发生**。只有当有权限的人类在 TaskBar 上亲手点击确认后，Nia Teams 才会签发上面那枚 `nia/confirmationToken`，去调用你指定的 MCP 执行工具（或发送签名 Webhook），并把卡片状态实时更新为「执行中 / 已完成 / 失败」。

---

### 3. MCP App 与右侧边栏控制台（Workspace App）是什么？

标准 MCP 社区通过官方扩展包 [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps)（SEP-1865）引入了 **MCP App** 的概念：允许 MCP 服务端提供一个 `ui://` 协议的 HTML 资源（MIME 类型为 `text/html;profile=mcp-app`），并通过浏览器 `postMessage` 让 iframe 里的前端页面调用宿主暴露的 `app.callServerTool(...)`。

在普通的聊天客户端里，MCP App 往往只是嵌在某条聊天消息气泡里的一个小卡片，随着聊天滚动就找不到了。**Nia Teams 在兼容标准 MCP App 的基础上，把它升级成了「右侧边栏工作台（Workspace App）」**：
- **桌面端右侧分屏 / 移动端全屏抽屉**：当工具声明了 `nia/workspace: true` 时，打开这个 MCP App 不会塞进狭窄的聊天流里，而是在群聊**右侧直接展开为独立的工作台分屏面板**——左边继续和同事、Agent 讨论，右边同时操作监控大盘、工单审批台或配置控制台。
- **群聊顶部 Apps 菜单常驻入口**：声明 `threadEntrypoint: true` 后，这个控制台会直接出现在群聊右上角的 **Apps** 下拉菜单里。群成员随时点一下就能拉开右侧控制台，不需要每次都在聊天里求 AI 调工具才能打开页面。
- **实时透传当前打开面板的人类角色**：当不同的人在右侧边栏里点按钮发请求时，Nia Teams 宿主会自动查出这个人在该 Agent 上的角色（`owner` / `admin` / `member`）并注入请求上下文，还可以配置 `requireTeamAdmin: true` 对普通成员直接隐藏管理后台。

---

### 4. 一张表看懂：哪些是 MCP 协议原生的，哪些是 Nia Teams 的扩展？

`@nia-teams/mcp-sdk` **不重复造轮子**。底层通信全走官方 `@modelcontextprotocol/sdk` 与 `@modelcontextprotocol/ext-apps`，本 SDK 只封装表格右半边的 Nia Teams 扩展层：

| 能力模块 | 标准 MCP 协议 / 官方包已有的部分 | Nia Teams 扩展的部分（由 `@nia-teams/mcp-sdk` 提供） |
| --- | --- | --- |
| **网络传输与基础原语** | JSON-RPC 2.0、`StreamableHTTPServerTransport`、`McpServer.registerTool` / `registerResource`、`CallToolResult`（来自 `@modelcontextprotocol/sdk`） | 无需扩展，100% 原生兼容 |
| **身份与认证（`/auth`）** | 协议仅留了 HTTP Header 与 JSON-RPC `_meta` 扩展槽位，未规定工作负载 OIDC 或人工确认签名格式 | • 外层 HTTP 自动注入 Workload OIDC RS256 JWT（`iss=https://nia-teams.com`）与 `createWorkloadOidcVerifier`<br>• 内层 `_meta["nia/confirmationToken"]` / `_meta["nia/viewerContextToken"]` 人工动作签名与 `canonicalJsonSha256` 参数防篡改校验 |
| **TaskBar 人工确认卡（`/cards`）** | 标准 `CallToolResult.structuredContent` 字段 | • `structuredContent: { _niaCard: true, card }` 确认卡协议与 TaskBar 渲染<br>• 提案工具 + 执行工具双步回调、外部 OAuth 身份绑定（`requiresIdentity`）、Webhook `X-Nia-Signature` HMAC 验签 |
| **右侧边栏控制台（`/apps`、`/apps/client`）** | `ui://` 资源（`text/html;profile=mcp-app`）、`registerAppTool` / `registerAppResource`、iframe `App` 与 `PostMessageTransport`（来自 `@modelcontextprotocol/ext-apps`） | • 右侧分屏工作台展示（`_meta["nia/workspace"]`）与群聊顶部 Apps 菜单入口（`threadEntrypoint`）<br>• 按 Agent 管理员过滤可见性（`_meta["nia/requireTeamAdmin"]`）与实时查看者身份校验（`verifyBoundViewer`）<br>• 前端 `createMcpAppFetch`（把 `fetch('/api/...')` 映射到 `app.callServerTool`）与服务端 `createSafeApiPathChecker` 路由白名单 |

---

## 二、安装与模块入口

环境要求：**Node.js 20+**（原生 ESM + TypeScript 类型声明）。

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| 导入路径 | 运行环境 | 作用 |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | 校验外层 HTTP Bearer JWT、人类确认/查看上下文 Token、Canonical JSON 摘要 |
| `@nia-teams/mcp-sdk/cards` | Node.js | 构建 TaskBar 确认卡（`_niaCard`）、执行回执、Webhook HMAC 签名校验 |
| `@nia-teams/mcp-sdk/apps` | Node.js | 注册右侧边栏 Workspace App（`ui://`）、校验查看者角色（`verifyBoundViewer`）与 API 路由白名单 |
| `@nia-teams/mcp-sdk/apps/client` | 浏览器 | 原样重导出官方 `App` / `PostMessageTransport`，附带 `createMcpAppFetch` 适配器 |
| `@nia-teams/mcp-sdk/testing` | Node.js（单测） | 内存态 OIDC Provider、测试 RSA 密钥生成与人类上下文 Token 签发器 |
| `@nia-teams/mcp-sdk` | Node.js | 服务端聚合入口（重导出 `auth`、`cards`、`apps`、`testing`） |

---

## 三、5 分钟快速接入：从写第一个服务到挂上 Agent

### 第一步：启动带 OIDC 验签的 MCP 服务

用官方 `StreamableHTTPServerTransport` 暴露 `/mcp` 接口，并在分发 MCP 请求前用 `verifyBearerHeader` 校验 Nia Teams 发来的 OIDC Token：

```ts
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createWorkloadOidcVerifier, WorkloadOidcError } from "@nia-teams/mcp-sdk/auth";

const auth = createWorkloadOidcVerifier(); // 默认信任 iss=https://nia-teams.com, aud=nia-teams-workload

createServer(async (req, res) => {
  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  let server: McpServer | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  try {
    // 1. 在 HTTP 入口验签：
    //    - 普通 Agent 调用：principal_type="workload"，sub="<agentSlug>"
    //    - 人类点 TaskBar 确认卡回调：principal_type="service"，sub="nia-teams-platform"
    const identity = await auth.verifyBearerHeader(req.headers.authorization, {
      allowServicePrincipal: true,
    });

    server = new McpServer({ name: "ops-service", version: "1.0.0" });

    server.registerTool(
      "query_service_logs",
      {
        description: "查询指定服务的线上错误日志",
        inputSchema: {
          service: z.string(),
          limit: z.number().int().min(1).max(100).default(20),
        },
      },
      async ({ service, limit }) => {
        if (identity.principalType !== "workload" || !identity.roles.includes("ops.reader")) {
          throw new WorkloadOidcError(403, "当前 Agent 需要绑定 role:ops.reader");
        }
        const rows = await queryLogsFromDb({ orgs: identity.orgs, service, limit });
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

### 第二步：把 MCP 服务挂载到 Nia Teams 的 Agent 上

把服务部署到 Nia Teams 可访问的 HTTPS 地址（例如 `https://ops.acme.com/mcp`），然后打开目标 Agent 的群聊直接说：

> 帮我连接名为 `ops` 的 MCP 服务，地址是 `https://ops.acme.com/mcp`

接下来会发生四件事：

1. Agent 自动调用内置 `mcp_servers` 工具（`action: "update"`, `upsert: [{ name: "ops", url: "https://ops.acme.com/mcp" }]`），在聊天底部 TaskBar 生成一张**挂载确认卡**。
2. 该 Agent 的 **`owner` 或 `admin`** 点击确认卡上的「确认修改」（也可以在 **Agent 设置 → MCP** 里直接添加）。
3. **不要手动填 `Authorization` 请求头**——留空时，Nia Teams 会在每次 HTTP 请求上自动注入最新的 RS256 Bearer JWT（填了静态 `Authorization` 头反而会关掉自动 OIDC 注入）。
4. 挂载生效后，Agent 看到的工具名为 `mcp__ops__<toolName>`（例如 `mcp__ops__query_service_logs`），而你的服务端只需注册原始名字 `query_service_logs`。

> **挂载范围与网络规则**
> - **3 种挂载粒度**：① **Agent 级挂载**（对该 Agent 所有会话生效）；② **Routine 例程级挂载**（配在单条 `routine` 的 `mcpServers` 上，只对该例程拉起的会话生效，适合隔离高敏工具）；③ **Blueprint 内置挂载**（平台模板锁定，不可被覆盖或删除）。
> - **SSRF 拦截**：自定义挂载要求公网可达的 `https://`（或 `http://`）Streamable HTTP 地址，平台会拦截 `localhost`、`127.0.0.0/8`、私网网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、链路本地地址（`169.254.0.0/16`）以及 `.local` / `.internal` 域名。

---

## 四、接入场景一：用 TaskBar 确认卡保护写操作

把任何高危或写操作拆成一对工具：**提案工具**（给 AI 调，只发卡不改数据）+ **执行工具**（只有人在 TaskBar 点了确认按钮后，平台才会带 `nia/confirmationToken` 来调）。

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// 1. AI 调用提案工具 -> 在群聊底部 TaskBar 发出一张确认卡
server.registerTool(
  "propose_restart",
  {
    description: "提议重启线上服务（生成 TaskBar 人工确认卡，不会直接重启）",
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
  },
  async (args) => {
    await db.savePendingRestart(args);
    return cardToolResult(
      `已生成重启 ${args.service} 的确认卡，等待人工审批。`,
      createMcpConfirmCard({
        cardId: `restart:${args.service}:v${args.expectedVersion}`,
        title: `重启服务 ${args.service}`,
        subtitle: `版本 v${args.expectedVersion}`,
        description: args.reason,
        actionLabel: "确认重启",
        // 注意：这里的 server 必须填挂载到 Agent 时的名字（如 "ops"），不是 McpServer 构造函数里的 name
        server: "ops",
        toolName: "execute_restart",
        arguments: args,
      }),
    );
  },
);

// 2. 人在 TaskBar 点击「确认重启」后，Nia Teams 携带签名确认上下文回调此工具
server.registerTool(
  "execute_restart",
  {
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
    annotations: { destructiveHint: true },
  },
  async (args, extra) => {
    // 密码学验签：
    // - 校验 Nia Teams 平台签发（sub="nia-teams-platform"，有效期 <= 5 分钟）
    // - 严格比对 server="ops"、tool="execute_restart"、cardId 以及 canonicalJsonSha256(args)，防参数篡改
    const human = await auth.verifyHumanActionContext(extra._meta, {
      server: "ops",
      tool: "execute_restart",
      arguments: args,
      expectedCardId: `restart:${args.service}:v${args.expectedVersion}`,
    });

    // 校验点击人（`human.confirmedBy` 是 24 位十六进制 Nia Teams 用户 ID）是否有业务操作权限
    if (!(await db.canUserRestartService(human.confirmedBy, args.service))) {
      return cardActionError("只有服务负责人可以批准重启生产实例", {
        errorKind: "auth_forbidden",
      });
    }

    // 用数据库原子 CAS / 版本号推进状态，防止并发连点或 5 分钟窗口内重放
    const applied = await db.applyRestartCas(args.service, args.expectedVersion, {
      approvedBy: human.confirmedBy,
      approvedByName: human.confirmedByName,
      jti: human.jti,
    });
    if (!applied) {
      return cardActionError("该变更已执行或版本号已过期");
    }

    return cardActionSuccess({
      statusLabel: "已重启",
      result: { service: args.service, approvedBy: human.confirmedBy },
    });
  },
);
```

如果你的执行链路是异步 HTTP Webhook（而不是 MCP 工具回调），可以用 `createWebhookConfirmCard({ title, url, mcpServerName: "ops", pendingInput })`：
- 如果挂载时配了 `webhookSecret`，在解析 JSON 前对原始请求体字节调 `verifyCardSignature(secret, rawBodyBuffer, req.headers["x-nia-signature"])` 验签；
- 如果没配 `webhookSecret` 且 Webhook URL 与 MCP 服务同源（同 origin），Nia Teams 会自动签发带 `human_confirmed: true` 和 `confirmed_by: "<userId>"` 的 Workload OIDC Bearer Token 发过来。

---

## 五、接入场景二：开发右侧边栏控制台（Workspace App）

如果你想在群聊右侧分屏打开一个交互式控制台（比如监控看板、工单审核台、配置编辑器），前端基于 `@modelcontextprotocol/ext-apps` 打包成单文件 HTML，服务端用 `registerNiaWorkspaceApp` 注册即可，iframe 内不需要碰任何 Token 或密钥。

### 1. 前端：用 `vite-plugin-singlefile` 打包单文件 HTML

```ts
// ui/vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
});
```

前端代码只导入浏览器专用入口 `@nia-teams/mcp-sdk/apps/client`（不要在浏览器包里导入服务端总入口）：

```ts
// ui/src/main.ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";

const app = new App({ name: "运维控制台", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "ops_console_api" });

// 首次调用自动完成 app.connect() 握手，像普通 fetch 一样调相对路径 GET/POST JSON 接口
const res = await apiFetch("/api/incidents?status=open");
const { incidents } = await res.json();
```

如果是 React 项目，还可以直接搭配官方 `@modelcontextprotocol/ext-apps/react` 的 `useApp`、`useHostStyleVariables`、`useDocumentTheme` 自动对齐 Nia Teams 亮暗色主题与 CSS 变量。

### 2. 服务端：注册右侧边栏 Workspace App 与 API 桥接工具

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
  threadEntrypoint: true,   // 出现在群聊顶部的「Apps」下拉菜单里
  requireTeamAdmin: true,   // 对普通 member 隐藏，仅该 Agent 的 owner / admin 可打开
  visibility: ["app"],
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
      // 每次请求都校验当前打开面板的人的角色（这里要求 owner 或 admin）
      const viewer = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });

      if (!isAllowedRoute(method, path)) {
        return {
          isError: true,
          content: [{ type: "text", text: "路由未开放" }],
          structuredContent: { status: 403, body: { error: "路由未开放" } },
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

## 六、权限对照表：Agent、Owner、Admin、Member 在每一层怎么验？

Nia Teams 里每个 Agent 都有自己的成员表，分三档角色：**`owner`**（创建者或受让者，管所有权与成员）、**`admin`**（管理员，管 Agent 配置）、**`member`**（普通成员，日常对话与使用）。

请注意区分：**外层 HTTP JWT 里的 `role:*` 是平台赋给 Agent 这个机器身份的权限角色；而人类的 `owner` / `admin` / `member` 是在内层 `_meta` 里传递的**。下面这张表汇总了每一层的权限校验方式：

| 交互环节 | Nia Teams 平台侧自动拦什么 | 你的 MCP 服务端收到什么、怎么判 `member` / `admin` / `owner` |
| --- | --- | --- |
| **挂载 / 修改 MCP 配置**（`mcp_servers`） | 群里普通 `member` 可以让 AI 发起挂载提案，但**只有该 Agent 的 `owner` 或 `admin`** 能点击挂载确认卡生效。 | 无需处理（连接建立前由平台拦截）。 |
| **AI 调只读 / 提案工具** | 自动注入该 Agent 的 Workload JWT（`sub: "<agentSlug>"`、`groups`）。 | 用 `verifyBearerHeader` 校验 `identity.subject`、`identity.orgs` 和 `identity.roles`，把数据查询限制在该组织/角色范围内。 |
| **人类点击 TaskBar 确认卡** | • 默认门槛：点击者必须是发出这张卡的 Agent 的成员（`owner`、`admin`、`member` 均可点）。<br>• 若卡片声明 `requiresIdentity: { provider: "gitlab" }`：跳过 Agent 成员门槛（允许跨团队审批），拉取或引导授权点击者的外部 OAuth Token 放入 `_meta["nia/identityToken"]`。 | 调 `verifyHumanActionContext(extra._meta, ...)` 拿到经过签名的点击人 `human.confirmedBy`（24 位十六进制用户 ID）：<br>• **允许任意 Agent 成员确认**：验签通过即可。<br>• **限制管理员 / 负责人确认（自定义挂载）**：用 `human.confirmedBy` 查你企业内部的管理员/负责人权限表，或拿 `human.identityToken` 去上游系统（如 GitLab/GitHub）验真实权限。*（注：`human.sourceTeam?.role` 仅在平台内置角色托管审批卡上附带，普通自定义挂载卡不带该字段。）* |
| **人类打开并使用右侧 Workspace App** | 要求当前用户**同时在群聊里且是该 Agent 成员**。若注册时设了 `requireTeamAdmin: true`，普通 `member` 在顶部 Apps 菜单里直接看不见该应用，强行调 `/apps/open` 返回 403。 | 在已验签的 Agent 连接上，平台每次调 `entryTool` 和 `apiTool` 都会实时查询并注入 `_meta.boundContext = { viewerUserId, viewerTeamRole }`：<br>• **放行 `owner` + `admin` + `member`**：`const v = verifyBoundViewer(extra._meta)`<br>• **仅放行 `owner` + `admin`**：`const v = verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`<br>• **仅放行 `owner`（高危操作）**：再加一行 `if (v.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "仅 Agent Owner 可操作")` |

> **关于 `_meta.boundContext` 的信任边界**：和带 RSA 签名的 `nia/confirmationToken` 不同，`boundContext` 是 Nia Teams 宿主在已认证连接上注入的普通 JSON 字段。你的服务端必须**先通过 `verifyBearerHeader` 验证外层 Nia Teams Workload JWT 并限制允许的 Agent `allowedSubjects` / `requiredGroups`**，之后才能信任 `verifyBoundViewer(extra._meta)` 里的角色。

---

## 七、本地离线单测（不连线上环境）

`@nia-teams/mcp-sdk/testing` 提供了纯内存的 OIDC 签发器和人类确认上下文签名工具，配合官方 `InMemoryTransport` 在本地 Vitest 里秒级跑通全链路：

```ts
import { expect, test } from "vitest";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";

test("本地离线验证 Agent Token 与人类点卡确认 Token", async () => {
  const provider = createWorkloadOidcProvider({
    issuer: "https://nia-teams.com",
    audience: "nia-teams-workload",
    tokenTtlSeconds: 300,
    activeKey: await generateTestRsaKeyPair(),
  });

  const auth = createWorkloadOidcVerifier({ jwks: await provider.getJwks() });

  // 1. 模拟 Agent 发起只读调用
  const agentJwt = await provider.signIdToken({
    subject: "ops-agent",
    groups: ["team:ops-agent", "org:acme", "role:ops.reader"],
    claims: { principal_type: "workload" },
  });
  const identity = await auth.verifyBearerHeader(`Bearer ${agentJwt}`, {
    requiredGroups: ["role:ops.reader"],
  });
  expect(identity.subject).toBe("ops-agent");

  // 2. 模拟人类在 TaskBar 点击确认卡
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

## 八、示例工程与参考文档

- **可直接参考的完整示例**：
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) —— 带 OIDC 鉴权的 Streamable HTTP 只读日志查询服务
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) —— 提案 + TaskBar 人工确认执行双步写入与版本 CAS
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) 与 [`examples/workspace-ui/`](./examples/workspace-ui) —— 右侧边栏 Workspace App 服务端 + Vite 单文件前端工程
- **给 AI 编码助手的指引**：[`AGENTS.md`](./AGENTS.md) —— 让编码 Agent 帮你开发或审查 Nia Teams MCP 服务时的上下文规范
- **底层协议规范**：[`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md) —— 完整的 JWT 字段定义、Canonical JSON 序列化算法、`_niaCard` 数据结构与安全边界

## 开源协议

[MIT](./LICENSE) © Nia Teams
