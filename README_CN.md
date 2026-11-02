# @nia-teams/mcp-sdk

[English](./README.md) | 简体中文

把内部日志、数据库、发布系统或管理后台做成 MCP 服务，挂到 [Nia Teams](https://nia-teams.com) 的 Agent 上。

## Nia Teams 是什么

Nia Teams 是一个人和 AI Agent 在同一个群里干活的协作平台。每个 Agent 有自己的成员，分 `owner`、`admin`、`member` 三档。群里的人 `@` 它，它就去查数据、写代码、改配置。

Agent 能做什么，取决于给它挂了哪些工具。工具通过 MCP 协议挂上来：你把公司内部的日志、数据库、发布系统包成一个 MCP 服务，Agent 就能用。

标准 MCP 只管「AI 调工具」这一件事。放进一个多人协作的群里，会多出三个问题：

- 你的服务怎么知道是哪个 Agent 在调、该给它看哪些数据？
- 重启生产、改数据库这种操作，怎么保证有人点头了才执行？
- 有些事用表单、看板比聊天快，页面放哪？

Nia Teams 对这三个问题各有一套做法。这个 SDK 帮你在服务端把它们接上。

【截图：一个群聊界面，标出 TaskBar、右侧边栏、顶部 Apps 菜单三处】

### 1. 身份：不用发 API Key

Agent 每次调你的服务，请求头里都带一个 Nia Teams 签发的 token，写明「我是哪个 Agent、属于哪个组织、有什么角色」。你的服务用 Nia Teams 公开的公钥验一下就行，不用给每个 Agent 发 key，也不用管轮换。

token 5 分钟过期，平台自己续。

### 2. TaskBar：人点了才执行

TaskBar 是群聊输入框上方那一条，放等人处理的卡片。

【截图：TaskBar 上挂着一张「重启 payments-api」的确认卡】

高危操作这样走：AI 只负责提议，它调你的「提案工具」，往 TaskBar 发一张卡，写清要做什么、为什么。这时候什么都还没发生。

群里有权限的人点了「确认」，平台才去调你的「执行工具」，同时附上一张签名凭证：谁点的、点的哪张卡、参数是什么。参数被改过一个字，凭证就对不上，你的服务直接拒绝。

### 3. 右侧边栏：给 Agent 配一个控制台

MCP 社区有个官方扩展叫 [MCP App](https://github.com/modelcontextprotocol/ext-apps)，允许工具附带一个网页界面。多数客户端把这个网页塞在聊天消息里，聊几句就滚没了。

Nia Teams 把它放到群聊右侧单独一栏：左边接着聊，右边看监控、批工单。也可以挂到群聊顶部的 Apps 菜单里，谁要用自己点开，不用每次叫 AI。

【截图：右侧边栏打开一个运维控制台】

页面里每发一次请求，平台都会告诉你的服务当前是谁在操作、是 `owner`、`admin` 还是 `member`。你也可以设成只有管理员看得到这个面板。

### 哪些是标准 MCP，哪些是 Nia Teams 加的

| | 标准 MCP 已有 | Nia Teams 加的 |
| --- | --- | --- |
| 调工具、传输 | 全部 | 不改 |
| 身份 | 只留了放 token 的位置 | Agent token、人工确认凭证 |
| 确认卡 | 工具能返回结构化数据 | 渲染成 TaskBar 卡片，点了回调执行工具 |
| 页面 | MCP App（工具附带网页） | 右侧边栏、Apps 菜单入口、告知操作者角色 |

底层通信全用官方 `@modelcontextprotocol/sdk` 和 `@modelcontextprotocol/ext-apps`，本包只做右边这一列。

---

## 安装

需要 Node.js 20+。

```sh
npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
```

| 子路径 | 运行环境 | 用途 |
| --- | --- | --- |
| `@nia-teams/mcp-sdk/auth` | Node.js | 验请求头 token、验人工确认凭证、算参数哈希 |
| `@nia-teams/mcp-sdk/cards` | Node.js | 拼 TaskBar 确认卡、返回执行结果、验 Webhook 签名 |
| `@nia-teams/mcp-sdk/apps` | Node.js | 注册右侧边栏页面、校验操作者角色、检查 API 路径 |
| `@nia-teams/mcp-sdk/apps/client` | 浏览器 | 前端页面里发请求用的 `App` 和 `createMcpAppFetch` |
| `@nia-teams/mcp-sdk/testing` | Node.js（单测） | 本地单测签假 token 用 |

---

## 快速接入

### 1. 写一个带验签的只读服务

用官方 `StreamableHTTPServerTransport` 暴露 `/mcp` 接口，进工具前先调 `auth.verifyBearerHeader` 验请求头：

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
    // 验请求头里的 Bearer token：
    // Agent 调工具时 principalType 是 "workload"；平台回调确认卡时是 "service"
    const identity = await auth.verifyBearerHeader(req.headers.authorization, {
      allowServicePrincipal: true,
    });

    server = new McpServer({ name: "ops-service", version: "1.0.0" });

    server.registerTool(
      "query_service_logs",
      {
        description: "查询服务的线上错误日志",
        inputSchema: {
          service: z.string(),
          limit: z.number().int().min(1).max(100).default(20),
        },
      },
      async ({ service, limit }) => {
        if (identity.principalType !== "workload" || !identity.roles.includes("ops.reader")) {
          throw new WorkloadOidcError(403, "需要 role:ops.reader 权限");
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

### 2. 挂到 Agent 上

把服务部署到公网能访问的 HTTPS 地址（比如 `https://ops.acme.com/mcp`，不能是 `localhost` 或内网 IP），到群里对 Agent 说：

> 帮我连接名为 `ops` 的 MCP 服务，地址是 `https://ops.acme.com/mcp`

Agent 会在 TaskBar 发出一张修改配置的确认卡，该 Agent 的 `owner` 或 `admin` 点确认就挂上了（也可以在「Agent 设置 → MCP」里手填）。

挂载时不用填 `Authorization` 请求头——留空平台才会自动附带上面说的 OIDC token。挂好后，你代码里注册的 `query_service_logs` 在 Agent 那边会显示成 `mcp__ops__query_service_logs`。

---

## 发 TaskBar 确认卡

把写操作拆成两个工具：`propose_restart` 给 AI 调，只发卡不干活；`execute_restart` 等人点完确认由平台来调。

```ts
import { z } from "zod";
import {
  createMcpConfirmCard,
  cardToolResult,
  cardActionSuccess,
  cardActionError,
} from "@nia-teams/mcp-sdk/cards";

// 1. 提案工具：AI 调这个，往 TaskBar 发一张确认卡
server.registerTool(
  "propose_restart",
  {
    description: "提议重启线上服务，生成确认卡等人工批准",
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
  },
  async (args) => {
    await db.savePendingRestart(args);
    return cardToolResult(
      `已生成重启 ${args.service} 的确认卡，等待人工确认。`,
      createMcpConfirmCard({
        cardId: `restart:${args.service}:v${args.expectedVersion}`,
        title: `重启 ${args.service}`,
        subtitle: `v${args.expectedVersion}`,
        description: args.reason,
        actionLabel: "确认重启",
        server: "ops", // 填挂到 Agent 上时的名字
        toolName: "execute_restart",
        arguments: args,
      }),
    );
  },
);

// 2. 执行工具：人在 TaskBar 点了「确认重启」后，平台调这个
server.registerTool(
  "execute_restart",
  {
    inputSchema: { service: z.string(), reason: z.string(), expectedVersion: z.number().int() },
    annotations: { destructiveHint: true },
  },
  async (args, extra) => {
    // 验平台附带的签名凭证，核对服务名、工具名、cardId 和参数哈希
    const human = await auth.verifyHumanActionContext(extra._meta, {
      server: "ops",
      tool: "execute_restart",
      arguments: args,
      expectedCardId: `restart:${args.service}:v${args.expectedVersion}`,
    });

    // human.confirmedBy 是点击人的 24 位十六进制用户 ID
    if (!(await db.canUserRestartService(human.confirmedBy, args.service))) {
      return cardActionError("只有服务负责人可以重启生产实例", {
        errorKind: "auth_forbidden",
      });
    }

    // 用数据库版本号防连点或重复提交
    const applied = await db.applyRestartCas(args.service, args.expectedVersion, {
      approvedBy: human.confirmedBy,
      approvedByName: human.confirmedByName,
      jti: human.jti,
    });
    if (!applied) {
      return cardActionError("已执行过或版本号已变");
    }

    return cardActionSuccess({
      statusLabel: "已重启",
      result: { service: args.service, approvedBy: human.confirmedBy },
    });
  },
);
```

如果想让平台点卡后调 HTTP Webhook 而不是调 MCP 工具，改用 `createWebhookConfirmCard({ title, url, mcpServerName: "ops", pendingInput })`，收到请求时用 `verifyCardSignature(secret, rawBodyBuffer, req.headers["x-nia-signature"])` 验签。

---

## 做右侧边栏页面

前端用 `vite-plugin-singlefile` 打成单个 HTML 文件，服务端用 `registerNiaWorkspaceApp` 挂上去。页面里不用管任何 token。

### 1. 前端页面

```ts
// ui/vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
});
```

前端代码只引 `@nia-teams/mcp-sdk/apps/client`：

```ts
// ui/src/main.ts
import { App, createMcpAppFetch } from "@nia-teams/mcp-sdk/apps/client";

const app = new App({ name: "运维控制台", version: "1.0.0" });
const apiFetch = createMcpAppFetch({ app, apiToolName: "ops_console_api" });

// 像普通 fetch 一样发请求，底层自动走 postMessage 调服务端的 ops_console_api
const res = await apiFetch("/api/incidents?status=open");
const { incidents } = await res.json();
```

### 2. 服务端注册

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
  threadEntrypoint: true, // 放到群聊顶部的 Apps 菜单里
  requireTeamAdmin: true, // 只让 Agent 的 owner 和 admin 看到
  visibility: ["app"],
  entryTool: {
    name: "open_ops_console",
    title: "运维控制台",
    handler: async (extra) => {
      verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
      return { content: [{ type: "text", text: "运维控制台已打开" }] };
    },
  },
  apiTool: {
    name: "ops_console_api",
    handler: async ({ method, path, body }, extra) => {
      const viewer = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });

      if (!isAllowedRoute(method, path)) {
        return {
          isError: true,
          content: [{ type: "text", text: "路径未开放" }],
          structuredContent: { status: 403, body: { error: "路径未开放" } },
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

## Token 字段与角色权限

请求里涉及两层身份：外层 HTTP 请求头代表「哪个 Agent 在调」，内层 `_meta` 代表「哪个人点了按钮或打开了页面」。

### 1. 请求头里的 Agent Token

`verifyBearerHeader` 解出来的 token 长这样：

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

- `identity.subject`（`sub`）：Agent 的标识（如 `"ops-agent"`）。当人点确认卡触发回调时，外层 token 会变成平台身份：`sub: "nia-teams-platform"`、`principal_type: "service"`。
- `identity.orgs` / `identity.teams` / `identity.roles`：从 `groups` 拆出来的数组。这里的 `role:*` 是绑定给这个 Agent 的机器权限，不是人类的 `owner` / `admin` / `member`。

### 2. 点确认卡时的人工确认凭证

人在 TaskBar 点确认后，平台放在 `extra._meta["nia/confirmationToken"]` 里的 token 长这样：

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

`verifyHumanActionContext` 会帮你验完签名、5 分钟有效期、服务名、工具名、`cardId` 和参数哈希，返回 `confirmedBy`（用户 ID）和 `confirmedByName`。

### 3. 各处怎么卡人类的 `owner` / `admin` / `member`

- **挂 MCP 服务**：群里谁都能让 AI 发起挂载，但只有该 Agent 的 `owner` 或 `admin` 点得动那张挂载确认卡。
- **点 TaskBar 确认卡**：平台默认要求点击人是该 Agent 的成员（`owner`、`admin`、`member` 都能点）。如果你要限制只有某几个人能点，拿到 `human.confirmedBy` 后查你自己的权限表；或者建卡时传 `requiresIdentity: { provider: "gitlab" }`，让平台把点击人的外部 OAuth token 放到 `human.identityToken` 里交给你验。（注：`human.sourceTeam?.role` 只在平台内置托管审批流里才有，自定义挂载的卡片不带这个字段。）
- **打开右侧边栏页面**：平台每次调 `entryTool` 和 `apiTool` 都会在 `extra._meta.boundContext` 里带上当前操作人的角色。先在 HTTP 入口调 `verifyBearerHeader` 验过外层连接并限制 `allowedSubjects` / `requiredGroups`，再用 `verifyBoundViewer` 卡角色：
  - `owner` / `admin` / `member` 都能用：`verifyBoundViewer(extra._meta)`
  - 只让 `owner` 和 `admin` 用：`verifyBoundViewer(extra._meta, { requireTeamAdmin: true })`
  - 只让 `owner` 用：再加一句 `if (viewer.viewerTeamRole !== "owner") throw new WorkloadOidcError(403, "仅 owner 可操作")`

---

## 本地单测

`@nia-teams/mcp-sdk/testing` 可以在内存里直接签发测试 token，不用连线上环境：

```ts
import { expect, test } from "vitest";
import { createWorkloadOidcVerifier } from "@nia-teams/mcp-sdk/auth";
import {
  createWorkloadOidcProvider,
  generateTestRsaKeyPair,
  signTestConfirmationToken,
} from "@nia-teams/mcp-sdk/testing";

test("离线验 Agent token 与人工确认凭证", async () => {
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

## 示例与文档

- 完整示例：
  - [`examples/01-readonly-workload-oidc.ts`](./examples/01-readonly-workload-oidc.ts) —— 只读日志查询服务
  - [`examples/02-taskbar-confirm-card.ts`](./examples/02-taskbar-confirm-card.ts) —— 发 TaskBar 确认卡与点卡执行
  - [`examples/03-workspace-mcp-app.ts`](./examples/03-workspace-mcp-app.ts) 与 [`examples/workspace-ui/`](./examples/workspace-ui) —— 右侧边栏控制台与前端工程
- 给编码 Agent 看的说明：[`AGENTS.md`](./AGENTS.md)
- 协议字段与校验细节：[`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md)

## 开源协议

[MIT](./LICENSE) © Nia Teams
