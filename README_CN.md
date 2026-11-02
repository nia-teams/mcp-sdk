[English](./README.md) | 简体中文

# @nia-teams/mcp-sdk

把企业数据库、日志、发布流水线、审批系统或管理后台通过 MCP 接入 [Nia Teams](https://nia-teams.com)：自带 **Agent OIDC 免密认证**、**人工确认卡（TaskBar Card）** 和 **右侧分屏工作台（Workspace App）**。

`@nia-teams/mcp-sdk` 构建在官方开源库 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 和 [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) 之上。标准 JSON-RPC、Streamable HTTP、`tools/call`、`resources/read` 和 `ui://` iframe 通信直接交给官方包，本包只补齐接入 Nia Teams 所需的 3 项扩展能力：

1. **零静态密钥的 OIDC 验签（`/auth`）** —— Nia Teams 发出的每个 HTTP 请求都自动携带 RS256 Bearer JWT（`iss: https://nia-teams.com`、`aud: nia-teams-workload`），服务端通过公开的 `/oauth2/jwks` 验签，不需要给每个 Agent 发静态 API Key 或做定期轮换。
2. **人在回路的 TaskBar 确认卡（`/cards`）** —— 把写操作拆成「提案工具」和「执行工具」：AI 调提案工具只产确认卡、绝不改数据；只有授权的人在聊天/TaskBar 点击确认后，平台才会附带 5 分钟有效的签名 `nia/confirmationToken`（锁死本次调用的 server、tool、cardId 和参数的 Canonical SHA-256 哈希）调用执行工具。
3. **右侧分屏 Workspace App（`/apps`、`/apps/client`）** —— 在标准 `ui://` 单文件 HTML 应用之上，支持挂进 Nia Teams 右侧分屏工作台和群聊顶部 **Apps** 菜单，实时透传当前打开人身份与角色（`owner` / `admin` / `member`），并提供 40 行的 `createMcpAppFetch` 把前端现成的 `fetch('/api/...')` 直接映射到 `app.callServerTool()`。

## 安装与模块入口

环境要求：**Node.js 20+**（ESM + TypeScript 类型声明）。

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| 导入路径 | 运行环境 | 作用 |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | 校验外层 HTTP Bearer JWT、人类确认/查看上下文 Token、Canonical JSON 摘要 |
| `@nia-teams/mcp-sdk/cards` | Node.js | 构建 TaskBar 确认卡（`_niaCard`）、执行回执、Webhook HMAC 签名校验 |
| `@nia-teams/mcp-sdk/apps` | Node.js | 注册 Workspace App（`ui://`）、校验当前查看者角色（`verifyBoundViewer`）与 API 路由白名单 |
| `@nia-teams/mcp-sdk/apps/client` | 浏览器 | 原样重导出官方 `App` / `PostMessageTransport`，附带 `createMcpAppFetch` 适配器 |
| `@nia-teams/mcp-sdk/testing` | Node.js（单测） | 内存态 OIDC Provider、测试 RSA 密钥生成与人类上下文 Token 签发器 |
| `@nia-teams/mcp-sdk` | Node.js | 服务端聚合入口（重导出 `auth`、`cards`、`apps`、`testing`） |

---

## 5 分钟上手：从写第一个服务到挂上 Agent

### 第一步：启动带 OIDC 验签的 MCP 服务

用官方 `StreamableHTTPServerTransport` 暴露 `/mcp` 接口，并在分发 MCP 请求前校验 Bearer Token：

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
    //    - 人类点确认卡回调：principal_type="service"，sub="nia-teams-platform"
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
      const status = err instanceof WorkloadOidcError ? err.statusCode : 500;
      res.writeHead(status, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
    }
  } finally {
    await transport?.close();
    await server?.close();
  }
}).listen(3000);
```

### 第二步：把 MCP 服务挂载到 Nia Teams 的 Agent 上

把服务部署到 Nia Teams 可访问的 HTTPS 地址（例如 `https://ops.acme.com/mcp`），然后打开目标 Agent 的对话框直接说：

> 帮我连接名为 `ops` 的 MCP 服务，地址是 `https://ops.acme.com/mcp`

接下来会发生四件事：

1. Agent 自动调用内置 `mcp_servers` 工具（`action: "update"`, `upsert: [{ name: "ops", url: "https://ops.acme.com/mcp" }]`），在聊天底部生成一张**挂载确认卡**。
2. 该 Agent 的 **`owner` 或 `admin`** 点击确认卡上的「确认修改」（也可以在 **Agent 设置 → MCP** 里直接添加）。
3. **不要手动填 `Authorization` 请求头**——留空时，Nia Teams 会在每次 HTTP 请求上自动注入最新的 RS256 Bearer JWT（有效期 5 分钟，到期前 30 秒自动续签；填了静态 `Authorization` 头反而会关掉自动 OIDC 注入）。
4. 挂载生效后，Agent 看到的工具名为 `mcp__ops__<toolName>`（例如 `mcp__ops__query_service_logs`），而你的服务端只需注册原始名字 `query_service_logs`。

> **挂载范围与网络规则**
> - **3 种挂载粒度**：① **Agent 级挂载**（对该 Agent 所有会话生效）；② **Routine 例程级挂载**（配在单条 `routine` 的 `mcpServers` 上，只对该例程拉起的会话生效，适合隔离高敏工具）；③ **Blueprint 内置挂载**（平台模板锁定，不可被覆盖或删除）。
> - **SSRF 拦截**：自定义挂载要求公网可达的 `https://`（或 `http://`）Streamable HTTP 地址，平台会拦截 `localhost`、`127.0.0.0/8`、私网网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、链路本地地址（`169.254.0.0/16`）以及 `.local` / `.internal` 域名。

---

## 核心场景一：让人类点卡确认写操作（TaskBar 确认卡）

重启生产服务、执行数据库变更、修改权限这类写操作，不能让大模型自己决定调一下就生效。标准做法是注册一对工具：

1. **提案工具（`propose_restart`）** —— 给 AI 调的。只把待执行计划存库并返回 `_niaCard`，**不做任何真实副作用**。
2. **执行工具（`execute_restart`）** —— 只有人在 TaskBar 点了确认按钮后，Nia Teams 才会附带签名的 `nia/confirmationToken` 来调它。

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// 1. AI 调用提案工具 -> 在群聊/TaskBar 发出一张确认卡
server.registerTool(
  "propose_restart",
  {
    description: "提议重启线上服务（生成人工确认卡，不会直接重启）",
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

// 2. 人点击「确认重启」后，Nia Teams 携带签名确认上下文回调此工具
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

    // 校验点击人（`human.confirmedBy` 是 24 位 Nia Teams 用户 ID）是否有业务操作权限
    if (!(await db.canUserRestartService(human.confirmedBy, args.service))) {
      return cardActionError("只有服务负责人可以批准重启生产实例", {
        errorKind: "auth_forbidden",
      });
    }

    // 用数据库原子 CAS / 版本号推进状态，防止并发连点或重放
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

## 核心场景二：把管理界面嵌进右侧边栏（Workspace App）

如果你想在群聊右侧分屏打开一个交互式面板（比如监控看板、工单审核台、配置编辑器），直接基于官方 `@modelcontextprotocol/ext-apps` 打包成单文件 HTML 即可，iframe 内不需要碰任何 Token 或密钥。

### 1. 前端：用 `vite-plugin-singlefile` 打包单文件 HTML

```ts
// ui/vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
});
```

前端代码只导入浏览器专用入口 `@nia-teams/mcp-sdk/apps/client`（不要导入服务端总入口）：

```ts
// ui/src/main.ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";

const app = new App({ name: "运维控制台", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "ops_console_api" });

// 像普通 fetch 一样调相对路径 GET/POST JSON 接口，底层自动走官方 postMessage 调 MCP 工具
const res = await apiFetch("/api/incidents?status=open");
const { incidents } = await res.json();
```

如果是 React 项目，还可以直接搭配官方 `@modelcontextprotocol/ext-apps/react` 的 `useApp`、`useHostStyleVariables`、`useDocumentTheme` 自动对齐宿主主题。

### 2. 服务端：注册 Workspace App 与 API 桥接工具

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

## 把身份与权限彻底理清：Agent、Owner、Admin、Member 各验什么？

接入时最容易混淆的一件事：**外层 HTTP Token 代表的是「哪个 Agent 或平台服务在发请求」，内层 `_meta` 代表的才是「哪个人点了按钮或打开了面板」**。

### 1. 外层 HTTP `Authorization: Bearer <JWT>` —— 验调用方（Agent / 平台服务）

Nia Teams 发来的请求用平台私钥签发，你的服务端用公开 JWKS（`https://nia-teams.com/oauth2/jwks`）验签，典型载荷长这样：

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "luca-ops",
  "principal_type": "workload",
  "groups": ["team:luca-ops", "org:luca", "role:ops.reader"],
  "iat": 1790812800,
  "exp": 1790813100
}
```

- `identity.subject`（`sub`）：普通工具调用和 Workspace App 调用时，这里是 **Agent 的 slug**（如 `"luca-ops"`），**不是聊天的人**。当人类点击 TaskBar 确认卡触发 MCP 回调时，外层 Token 是平台回调身份：`sub: "nia-teams-platform"`、`principal_type: "service"`。
- `identity.orgs` / `identity.teams` / `identity.roles`：从 `groups` 自动剥离前缀得到。注意 `role:ops.reader` 是平台绑定给**这个 Agent** 的 `AuthorizationRole`，**跟人类是 `owner` / `admin` / `member` 完全是两码事**。
- `identity.elevatedRoles`：只有人类点过 `request_session_elevation` 临时提权卡后才会出现的 `nia:elevated:role:<key>`。

### 2. 人类的角色（`owner` / `admin` / `member` / 外部 OAuth）—— 每一层怎么控权限？

Nia Teams 里每个 Agent 都有自己的成员表，分三档角色：**`owner`**（创建者或受让者，管所有权与成员）、**`admin`**（管理员，管 Agent 配置）、**`member`**（普通成员，日常对话与使用）。

下面这张表直接对应你在代码里每一层该怎么写权限判断：

| 交互环节 | Nia Teams 平台侧自动拦什么 | 你的 MCP 服务端收到什么、怎么判 `member` / `admin` / `owner` |
| --- | --- | --- |
| **挂载 / 修改 MCP 配置**（`mcp_servers`） | 群里普通 `member` 可以让 AI 发起挂载提案，但**只有该 Agent 的 `owner` 或 `admin`** 能点击挂载确认卡生效。 | 无需处理（连接建立前由平台拦截）。 |
| **AI 调只读 / 提案工具** | 自动注入该 Agent 的 Workload JWT（`sub: "<agentSlug>"`、`groups`）。 | 用 `verifyBearerHeader` 校验 `identity.subject`、`identity.orgs` 和 `identity.roles`，把数据查询限制在该组织/角色范围内。 |
| **人类点击 TaskBar 确认卡** | • 默认门槛：点击者必须是发出这张卡的 Agent 的成员（`owner`、`admin`、`member` 均可点）。<br>• 若卡片声明 `requiresIdentity: { provider: "gitlab" }`：跳过 Agent 成员门槛（允许跨团队审批），拉取或引导授权点击者的外部 OAuth Token 放入 `_meta["nia/identityToken"]`。 | 调 `verifyHumanActionContext(extra._meta, ...)` 拿到经过签名的点击人 `human.confirmedBy`（24 位用户 ID）：<br>• **允许任意 Agent 成员确认**：验签通过即可。<br>• **限制管理员 / 负责人确认（自定义挂载）**：用 `human.confirmedBy` 查你企业内部的管理员/负责人权限表，或拿 `human.identityToken` 去上游系统（如 GitLab/GitHub）验真实权限。*（注：`human.sourceTeam?.role` 仅在平台内置角色托管审批卡上附带，普通自定义挂载卡不带该字段。）* |
| **人类打开并使用右侧 Workspace App** | 要求当前用户**同时在群聊里且是该 Agent 成员**。若注册时设了 `requireTeamAdmin: true`，普通 `member` 在顶部 Apps 菜单里直接看不见该应用，强行调 `/apps/open` 返回 403。 | 在已验签的 Agent 连接上，平台每次调 `entryTool` 和 `apiTool` 都会实时查询并注入 `_meta.boundContext = { viewerUserId, viewerTeamRole }`：<br>• **放行 `owner` + `admin` + `member`**：`const v = verifyBoundViewer(extra._meta)`<br>• **仅放行 `owner` + `admin`**：`const v = verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`<br>• **仅放行 `owner`（高危操作）**：再加一行 `if (v.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "仅 Agent Owner 可操作")` |

> **关于 `_meta.boundContext` 的信任边界**：和带 RSA 签名的 `nia/confirmationToken` 不同，`boundContext` 是 Nia Teams 宿主在已认证连接上注入的普通 JSON 字段。你的服务端必须**先通过 `verifyBearerHeader` 验证外层 Nia Teams Workload JWT 并限制允许的 Agent `allowedSubjects` / `requiredGroups`**，之后才能信任 `verifyBoundViewer(extra._meta)` 里的角色。

---

## 本地离线单测（不连线上环境）

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

## 示例工程与参考文档

- **可直接参考的完整示例**：
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) —— 带 OIDC 鉴权的 Streamable HTTP 只读日志查询服务
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) —— 提案 + TaskBar 人工确认执行双步写入与版本 CAS
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) 与 [`examples/workspace-ui/`](./examples/workspace-ui) —— 右侧边栏 Workspace App 服务端 + Vite 单文件前端工程
- **给 AI 编码助手的指引**：[`AGENTS.md`](./AGENTS.md) —— 让编码 Agent 帮你开发或审查 Nia Teams MCP 服务时的上下文规范
- **底层协议规范**：[`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md) —— 完整的 JWT 字段定义、Canonical JSON 序列化算法、`_niaCard` 数据结构与安全边界

## 开源协议

[MIT](./LICENSE) © Nia Teams
