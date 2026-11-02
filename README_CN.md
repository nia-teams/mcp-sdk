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

**建议阅读顺序：** [五步开发与挂载](#从零开发到挂载进-nia-teams五步走) ·
[OIDC 声明](#oidcagent-身份和人的权限是两回事) ·
[权限矩阵](#权限矩阵每一层究竟验证谁) · [代码示例](#场景一验证工作负载查询只读数据)

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

## 从零开发到挂载进 Nia Teams：五步走

1. **初始化企业 MCP 项目并安装依赖。**
   ```sh
   mkdir enterprise-mcp && cd enterprise-mcp
   npm init -y
   npm pkg set type=module
   npm install @nia-teams/mcp-sdk @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps zod
   npm install --save-dev typescript @types/node vitest
   ```
2. **在 HTTP `/mcp` 边界先认证，再分发 MCP。** HTTP 传输使用官方
   `StreamableHTTPServerTransport`，本 SDK 不替你启动 HTTP 服务。
   ```ts
   const auth = createWorkloadOidcVerifier(); // 从 /auth 导入
   const identity = await auth.verifyBearerHeader(req.headers.authorization, {
     allowedSubjects: ["sec-ops"],
     requiredGroups: ["role:logs.reader"],
   });
   // 把业务查询限制在 identity 的授权范围内，再 handleRequest(req, res)。
   ```
   参考[完整 HTTP 示例](examples/01-readonly-workload-oidc.ts)。平台 service 回调需要独立、明确的
   授权策略，不要在所有读写接口上无差别放行 service principal。
3. **注册能力。** 只读工具使用已验证的 Agent 范围；写工具先 `createMcpConfirmCard` 产卡，
   通过 `verifyHumanActionContext` 和持久化业务 CAS 后才执行；工作区使用
   `registerNiaWorkspaceApp`、`verifyBoundViewer`、严格 API 白名单，以及 Vite +
   `vite-plugin-singlefile`。下文三个场景提供代码。
4. **先离线测试，再上线。** 把下文“离线测试”的本地 issuer 示例放进 Vitest 测试，运行
   `npx vitest run`。使用 `createWorkloadOidcProvider`、`generateTestRsaKeyPair`、
   `signTestConfirmationToken`，把公开 `jwks` 传给 verifier；再用官方 `InMemoryTransport`
   测试真实服务端 / 客户端往返。覆盖错误凭据、参数篡改、member/admin/owner 权限和重放 / CAS。
   无需连接真实 Nia Teams，通常秒级完成，但不是所有机器都保证“一秒完成”。
5. **部署、挂载、批准连接。** 暴露可从 Nia Teams 访问的 HTTPS MCP 地址，例如
   `https://ops.example.com/mcp`，在 Agent 聊天中说：
   **“连接名为 `my-ops` 的 MCP 服务，地址是 `https://ops.example.com/mcp`。”**
   由这个 **Agent Team 的 owner 或 admin** 点击 TaskBar 确认卡。
   也可使用 Agent Settings UI 配置。之后让 Agent 调用只读 / 提案工具，并从 Apps 打开工作区验证角色限制。

### 三种挂载范围、URL 规则和工具名

| 范围                  | 配置与生效范围                                                                                                    | 覆盖规则                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Agent Team 自定义挂载 | Team 的 `mcpServers`；通过聊天 `mcp_servers` 提案或 Agent Settings 配置，作用于这个 Agent Team                    | 按名称更新 Team 自增配置，不能覆盖 Blueprint 内置项               |
| Routine 覆盖层        | Routine 的 `mcpServers`；仅作用于带该 Routine 来源的 Session，连接缓存键为 `${teamId}:${routineId}:${serverName}` | 可局部覆盖同名 Team 自增项或追加新名称，不能覆盖 Blueprint 内置项 |
| Blueprint 内置挂载    | 平台目录保存连接事实，Blueprint `mcpManifest` 引用；对使用它的 Team / Routine 锁定                                | Team / Routine 不能移除、禁用或覆盖；平台目录管理是另一套授权操作 |

普通成员可以提出挂载请求，但**提案不等于批准，更不等于获取管理员权限**。
Agent 调用内置 `mcp_servers` 工具：

```json
{
  "action": "update",
  "upsert": [{ "name": "my-ops", "url": "https://ops.example.com/mcp" }]
}
```

它只产生 TaskBar 确认卡，批准后才修改配置。若使用 webhook 卡片，可额外配置可选的
`webhookSecret`；OIDC MCP 执行回调不需要这个密钥。密钥必须通过可信管理入口配置，不要放入公开聊天、
截图或调试日志。应用修改时会重新读取当前配置，而不是盲目信任产卡时的快照。

**挂载卡当前要求实时 Team owner / admin 身份。** 平台管理员是独立的平台管理权限，
不是自动获得任何 Team 角色；当前挂载卡处理器检查 Team owner/admin 成员资格，
不能假设“平台管理员但不是 Team 成员”也能确认此卡。独立的平台管理 API 可能有各自明确的授权策略。

URL 必须是 `http://` 或 `https://` 的 **Streamable HTTP** MCP 端点（常见为 `POST /mcp`），
不是普通 REST URL、stdio 命令或仅提供旧式 SSE 的地址。生产使用 HTTPS，避免 Bearer 凭据明文传输。
可达性是指**从 Nia Teams 可达**，不是只在开发者笔记本上可访问。
自定义挂载的 SSRF 防护拒绝 `localhost`、`127.0.0.0/8`、RFC1918 的
`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16`、链路本地 `169.254.0.0/16`，
以及 `.local` / `.internal` 主机名；还会拦截其他特殊 IPv4 / IPv6 地址范围。
私有网络接入需要平台管理方明确安排网络 / 目录集成。**目录登记不是通用 SSRF 绕过开关**：
当前客户端同样会校验目录解析后的 URL。不要用 URL 技巧或关闭认证绕过限制。

Agent 默认看到的工具名是 `mcp__<serverName>__<toolName>`，例如 `my-ops` 的 `query_logs`
显示为 `mcp__my-ops__query_logs`。挂载名必须匹配 `^[a-zA-Z0-9-]+$`。
部分 Host 表面可对唯一工具名做扁平显示，但不会改变 MCP 线上的原始工具名。
服务端注册 `query_logs` 即可；卡片 handler 与签名上下文检查使用**挂载名 `my-ops` + 原始工具名**，
不是 Agent 可见的带前缀名称，也不是 `serverInfo.name`。

**自动凭据注入：** 普通挂载配置不要写自定义 `Authorization` Header。
Host 会在**每个 HTTP 请求**注入当前有效的 RS256 Workload Bearer JWT：TTL 为 **300 秒**，
在**到期前 30 秒**刷新，与 MCP 长连接缓存独立。它会复用缓存 Token，并非每个请求重新签发 JWT。
显式配置任意大小写的 Authorization Header 会关闭普通挂载的自动注入；出现旧静态 Token 时，
先移除这个 Header，而不是误判为 SDK 的 JWKS 问题。平台代理的 service / 卡片连接使用独立的服务凭据策略。

## OIDC：Agent 身份和人的权限是两回事

这里的 OIDC 是：Host 用 RSA 私钥签发身份 JWT，企业服务端用 issuer 的**公开 JWKS**验证签名和声明。
不需要获得平台签名私钥，也不需要为每个 Agent 配置长期 API Key。
发现地址：`https://nia-teams.com/.well-known/openid-configuration`；
公钥地址：`https://nia-teams.com/oauth2/jwks`；仅接受 **RS256**。

普通 HTTP Bearer 载荷示例（时间戳仅为示意）：

```json
{
  "iss": "https://nia-teams.com",
  "aud": "nia-teams-workload",
  "sub": "sec-ops",
  "principal_type": "workload",
  "iat": 1790812800,
  "nbf": 1790812800,
  "exp": 1790813100,
  "jti": "example-unique-token-id",
  "groups": ["team:sec-ops", "org:example", "role:logs.reader"]
}
```

| 声明 / 分组                                               | 含义，不代表自动获得业务权限                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sub: <agentTeamSlug>`                                    | Agent Team 身份，例如 `sec-ops`、`luca-root-agent`，**不是聊天的人**                                                 |
| `principal_type: "workload"`                              | 普通 Agent 执行                                                                                                      |
| `sub: "nia-teams-platform"` + `principal_type: "service"` | 平台代理传输，包括卡片回调；不是无限写权限                                                                           |
| `team:<agentSlug>`                                        | Agent Team 标识                                                                                                      |
| `org:<orgSlug>`                                           | Agent 所属组织（存在时）                                                                                             |
| `role:<roleKey>`                                          | 绑定给 Agent 的平台 `AuthorizationRole`，例如 `logs.reader`、`nia.infra-agent`；**不是人的 owner/admin/member 角色** |
| `nia:elevated:role:<roleKey>`                             | 显式、临时、经过人授权的提权，例如 `request_session_elevation`；普通角色绑定不等于提权                               |

`verifyBearerHeader(header, { allowedSubjects, requiredGroups, allowServicePrincipal })`
同时验证 JWT 和调用者策略。`requiredGroups` 要求**全部**精确分组都存在。
返回的 `identity.teams`、`.orgs`、`.roles`、`.elevatedRoles` 是去前缀、去重的数组；
例如 `role:logs.reader` 对应 `identity.roles.includes('logs.reader')`。

普通 role 分组不证明提权；专用提权凭据可能使用 `sub: role:<roleKey>:elevated`，必须按设计检查 subject。
自动注入的通用 Team Bearer **不保证携带某个 Session 的提权**；经过批准的 Session 专用凭据、
以及显式的平台人类 App 提权，是单独的路径，不能混为一谈。

外层 Bearer 回答**“哪个 Agent / 服务在调用？”**；签名的 `nia/confirmationToken` /
`nia/viewerContextToken` 回答**“哪个人确认 / 查看了这次精确卡片 RPC？”**；
`nia/sourceContextToken` 在受支持的角色挂载调用中承载有界的来源 Team / actor 上下文。
它们绑定 server / tool / `context_arguments_sha256`，上下文最长 5 分钟。
并非每个自定义挂载都有来源 Token 或签名的 Team 角色；App 的 `boundContext` 本身也**不是签名 JWT**。

## 权限矩阵：每一层究竟验证谁？

人的 Team 角色、Agent 工作负载分组、平台管理权限、GroupChat 成员资格、外部 OAuth 权限是**不同的权限域**。
Team owner 最初是创建者，后续可按所有权转移规则变更，负责这个 Agent Team 的所有权与成员管理；admin 管理获准的 Team 配置；
member 可以聊天、访问被授权的 Session 与 App。所有权敏感操作、私密 Session 仍有额外规则。
任何角色名称或有效签名，都不能替代企业自己的资源 ACL。

| 操作 / 场景                  | Team owner                    | Team admin     | Team member            | 外部身份 / 非本 Team 用户                    |
| ---------------------------- | ----------------------------- | -------------- | ---------------------- | -------------------------------------------- |
| 聊天 / 获准执行记录          | 可，受聊天 / Session 规则限制 | 同左           | 同左                   | 仅加入群聊不等于可访问 Agent 执行记录        |
| 确认 `mcp_servers` 配置变更  | 可                            | 可             | 不可，但可提案         | OAuth 身份不是挂载批准权                     |
| 无外部身份的普通确认卡       | 默认成员检查通过              | 通过           | 通过                   | 通常须为产卡 Agent Team 成员                 |
| 特权确认卡                   | 按该卡具体策略                | 按该卡具体策略 | owner/admin 限制时拒绝 | 可能以外部资源 / provider ACL 为准           |
| 未限制管理员的群聊 App       | 可\*                          | 可\*           | 可\*                   | 仅群聊成员身份不够                           |
| `requireTeamAdmin: true` App | 可\*                          | 可\*           | 顶部菜单隐藏，打开被拒 | 不自动绕过                                   |
| 企业自定义 owner-only 操作   | 显式 owner 校验通过           | 拒绝           | 拒绝                   | 仅明确配置的替代企业 ACL 可授权              |
| `action.requiresIdentity` 卡 | 适用 provider ACL             | 同左           | 同左                   | 可支持跨 Team，但仍须满足外部资源 / 业务 ACL |

\* GroupChat 中的 App 要求用户**同时是群聊成员与 Agent Team 成员**，且 Agent 本身在该群聊中
（`isAgentExecutionAccessible`）。未限制管理员不代表 App 公开。
平台管理员身份不自动绕过 Team 成员 / 工作区控制规则。

### A. AI 调用只读 / 提案工具

校验外层 HTTP OIDC；用 `allowedSubjects` 限制 `identity.subject`，
用 `identity.orgs` 限制组织范围，用 `requiredGroups` / `identity.roles` 限制 Agent 权限。
Routine / App 绑定调用可能还有 `_meta.boundContext`，但它本身不是人的同意。
AI 工具调用不能悄悄直接执行本应人工确认的变更。

### B. 人点击 TaskBar 确认卡

**平台侧：** 普通卡通过 `checkTeamMembership` 检查产卡 Agent Team 成员资格；
owner、admin、member 默认都能确认。特权内置卡再增加更严格的操作策略。
少数平台专用卡有资源特定例外，不能把它们当成企业执行器的通用绕过规则。

声明 `action.requiresIdentity: { provider, instance? }` 时，`clickBypassesTeamCheck`
跳过普通的来源 Team 成员门槛。Host 获取点击者的 provider 凭据（未授权则引导授权），
并传入 `_meta['nia/identityToken']`，其 SHA-256 摘要签入 `context_identity_token_sha256`。
这支持合法的跨 Team 审批，**不是凭“绑定了 OAuth”就自动获得上游写权限**。
执行端仍要验证外部 Token 和资源 ACL，例如仓库 Maintainer。其他聊天 / 卡片可见性与资源特定检查仍然存在。

**企业服务端：** 调用 `verifyHumanActionContext(extra._meta, { server, tool,
arguments: args, expectedCardId })`，得到 `confirmedBy`（Nia Teams 用户 ID，例如虚构的
`0123456789abcdef01234567`）、`confirmedByName`、`cardId`、`jti`、可选 `identityToken`，
以及可选的 `sourceTeam: { id, subject, groups, role? }`。
确认签名有效，**不代表点击者一定是 admin 或 owner**。

```ts
const human = await auth.verifyHumanActionContext(extra._meta, {
  server: "my-ops",
  tool: "apply_change",
  arguments: args,
  expectedCardId,
});
// 只允许 owner 或 admin：前提是 Host 确实把角色绑定进了签名上下文。
if (human.sourceTeam?.role !== "owner" && human.sourceTeam?.role !== "admin") {
  throw new WorkloadOidcError(
    403,
    "Signed Team owner or admin authority required",
  );
}
// 只允许 owner 的操作：要求 human.sourceTeam?.role === "owner"。
// 之后仍检查资源 ACL，并在副作用前完成持久化 CAS。
```

`WorkloadOidcError` 从 `/auth` 导入。`sourceTeam.role` 是可选字段，**当前并非每张自定义卡都会携带**。
没有角色时应默认拒绝，或按 `human.confirmedBy` 查可信的企业 admin / owner 名单，
或验证 `human.identityToken` 与上游 ACL。不能通过显示名、Agent groups 或生产者提供的 metadata 推断人的角色。
不要仅为“让授权不再报错”而增加 `requiresIdentity`：它确实会扩大 Host 原来的成员检查范围。

### C. 人打开并使用 Workspace App

群聊 Apps 目录与打开路径先检查执行访问权。
`_meta['nia/requireTeamAdmin']: true` 会让普通 member 在顶部 Apps 菜单中看不到入口，
且 `/apps/open` 返回 403：`Only Team owner or admin can open this App`。
省略 / 设为 false 时，owner/admin/member 都可打开，但仍须满足群聊与 Agent 的访问条件。

对于 Agent 绑定 App 的入口调用，以及 iframe 经
`POST /api/teams/:teamId/mcp-app-tool-call` 发起的调用，Host 用 `roleFromTeam`
重新解析用户的实时 Team 角色，并注入：

```json
{
  "_meta": {
    "boundContext": {
      "viewerUserId": "0123456789abcdef01234567",
      "viewerTeamRole": "owner"
    }
  }
}
```

只有先认证并授权平台传输，才可在**每个 entryTool 和 apiTool** 中检查：

```ts
// 所有 Team 角色：owner / admin / member。
const viewer = verifyBoundViewer(extra._meta);
// 仅 owner 或 admin；member 抛出 403。
const privileged = verifyBoundViewer(extra._meta, { requireTeamAdmin: true });
// 仅 owner：没有内置 owner-only 布尔参数。
if (viewer.viewerTeamRole !== "owner") {
  throw new WorkloadOidcError(403, "Team owner required");
}
// 以上是备选策略，按操作选择一种。
// 用 viewer.actor（"user:<viewerUserId>"）审计；另外检查路径、请求体和业务 ACL。
```

元数据声明的是**打开权限**，`verifyBoundViewer` 执行的是你的处理器权限。
没有 owner-only 元数据开关，因此 owner-only 处理器可能仍向 admin 展示入口，但必须在调用时拒绝 admin。
任意 MCP 客户端可以伪造 metadata；来自普通客户端的有效 Agent Token 也不能证明其 `boundContext`
一定由 Host 注入。需要可信 Host 传输边界，并在可用时使用签名上下文。
下文工作区示例展示 `createSafeApiPathChecker` 的实际用法。

### D. 修改 Agent 连接配置是独立权限

能聊天的人可以请求 `mcp_servers` 提案，但只有实时 Team owner/admin 才能批准其配置卡。
企业管理员名单、OAuth 凭据或 Agent 的 `role:*` 分组，都不替代这个 Host 侧权限门槛。

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
