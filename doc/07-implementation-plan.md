# AgentPulse 实现方案与代码结构

本文件是 AgentPulse 的具体实现方案索引，必须与真实业务代码目录结构保持一致。新增、移动、删除业务目录时，应在同一变更中同步更新本文件。

## 根目录配置

- `package.json`：pnpm workspace 根脚本，统一 `build`、`test`、`dev`、`start` 命令。
- `pnpm-workspace.yaml`：声明 `apps/*`、`packages/*`、`plugins/*`。
- `tsconfig.base.json`：所有 TypeScript 项目的基础编译配置。
- `turbo.json`：统一编排 build/test/dev。
- `AGENTS.md`：强制开发工作流，要求实现文档与代码结构同步。
- 依赖策略：在当前 Node.js `20.9.x` 运行目标下尽可能使用最新依赖；若绝对最新版要求 Node `20.19+` 或 `22.12+`，保留最高兼容主版本并在 README 记录原因。

## apps/cli

- 职责：提供 `agent-pulse` 命令入口。
- 入口：`src/index.ts`。
- 命令：`scan`、`inventory`、`plan`、`install`、`rollback`、`start`、`doctor`、`--version`。
- 数据流：CLI 调用 `packages/inventory`、`packages/installer`、`packages/storage`，`start` 启动 `apps/server`。
- 测试点：版本输出、scan/inventory/plan 不修改文件、install 默认 workspace-only、rollback 恢复备份。

## apps/server

- 职责：本地 Fastify 服务，默认监听 `127.0.0.1:8080`。
- 入口：`src/index.ts`，应用构造：`src/app.ts`。
- API：health、hook ingest、events/tasks/sessions 查询、inventory、install plans、agents scan/replace/rollback、proxy、notification test。
- SSR：非 `/api`、`/ingest`、`/proxy` 路由优先加载 `apps/web/dist/server/entry-server.js` 渲染 React HTML，再由 `apps/web/dist/client` 提供静态资源。
- 数据流：HTTP 请求进入 server；API 写入 `packages/storage`，经 `packages/analyzers` 标记风险，经 `packages/channels` 发送通知；页面请求走 SSR fallback。
- 测试点：health、hook 幂等、inventory scan、agents 行级 scan/replace/rollback、proxy 透传、通知测试、SSR fallback 返回已渲染 HTML。

## apps/web

- 职责：本地工具型控制台。
- 入口：客户端 `src/entry-client.tsx`，服务端 `src/entry-server.tsx`，共享根组件 `src/Root.tsx`，主页面 `src/App.tsx`。
- 页面：Agents、Events、Tasks、Inventory、Install Plans、Proxy Requests、Notifications、Doctor。
- 组件库：使用 Ant Design，不手搓表格、按钮、表单、状态标签等通用控件。
- 数据流：通过 `/api/*` 拉取本地服务数据，不直接读取本地文件系统。
- Agents 数据流：`POST /api/agents/scan` 按传入 scope 获取列表；Web 默认传 `scope=user` 并展示用户级真实配置路径，`POST /api/agents/:integration/replace` 执行 plan -> backup -> apply -> verify -> persist route mapping，`POST /api/agents/:integration/rollback` 按 agent 回滚最近备份并删除 route mapping。
- Agents 操作语义：页面点击“替换”是显式用户操作，默认直接修改当前用户目录下的真实 agent 配置文件；替换前必须通过 Ant Design `Modal.confirm` 展示目标文件、原始上游、新代理地址、备份和回滚说明。
- SSR：Vite build 生成 `dist/client` 和 `dist/server`；server 端渲染首屏 shell，client 端 hydrate 后继续用 TanStack Query 拉取本地 API。
- 测试点：Vite client build、Vite SSR build、Agents 页面扫描/替换/回滚状态、核心页面渲染、空数据状态。

## packages/core

- 职责：标准类型、状态模型、通用工具函数。
- 入口：`src/index.ts`。
- 关键类型：`AgentEvent`、`TaskStatus`、`InstallPlan`、`InventorySource`、`SkillInventoryItem`、`McpServerInventoryItem`、`ProbeResult<T>`。
- 约束：不得包含 Codex、Claude Code、OpenCode 等具体工具逻辑。
- 测试点：事件规范化、ID 生成、任务状态推导、脱敏工具。

## packages/storage

- 职责：SQLite 本地存储和 schema 初始化。
- 入口：`src/index.ts`。
- 数据表：events、sessions、tasks、proxy_requests、analysis_results、notifications、install_plans、backups、inventory_sources、skills、mcp_servers、plugins、settings。
- 数据流：server、CLI、installer、inventory 共享同一个 storage API。
- 测试点：schema 初始化、事件幂等写入、备份记录、按 integration 查询最近已应用备份、inventory upsert。

## packages/probes

- 职责：只读本地事实探针。
- 入口：`src/index.ts`。
- 能力：system、file、command、config、skill、mcp、secret、process。
- 数据流：inventory/integrations/installer 通过 probes 获取事实，不直接散落系统判断逻辑。
- 测试点：SKILL.md 识别、MCP 配置提取、敏感字段脱敏、命令存在性判断。

## packages/inventory

- 职责：扫描本地 skills、MCP servers、plugins 和配置来源。
- 入口：`src/index.ts`。
- 扫描范围：workspace、用户级、全局常见路径；具体路径由 integration adapter 声明。
- 数据流：调用 `packages/integrations` 获取 sources，调用 `packages/probes` 读取元数据，结果写入 `packages/storage`。
- 测试点：Codex/Claude source 发现、env value 不保存、缺失路径记录 warning。

## packages/integrations

- 职责：工具适配器集合。
- 入口：`src/index.ts` 只负责公共导出、adapter registry、scan/plan/verify 聚合，不承载具体工具逻辑。
- 适配器目录：`src/adapters/`，Codex、Claude Code、OpenCode 分别维护独立 adapter 文件，便于后续按工具版本定制。
- Helper 目录：`src/helpers/`，封装配置解析/合并、TOML 写回、代理路由 profile 等可复用能力。
- 数据流：adapter detect/readConfigState/planProxyInstall/verifyInstall 只处理自身工具配置，向 installer 输出标准 scan、真实配置 patch、proxy route profile 和验证结果。
- Proxy 预设计：adapter 输出 `ProxyRouteProfile`，包含 local route、upstream env、默认 upstream、streaming mode、敏感 header 和 path mode；本阶段不改 proxy streaming 转发行为。
- 代理映射：adapter 生成计划时保留原始上游地址；installer apply 验证成功后持久化 `原始上游地址 -> 本地代理地址` 映射；proxy 层启动时加载映射到内存，并在请求转发时优先使用内存映射决定 upstream。
- 测试点：adapter registry、Codex 配置发现与 TOML patch、Claude JSON/JSONC patch、OpenCode provider patch、无法识别 schema 时降级为 command suggestion。

## packages/installer

- 职责：聚合扫描、生成计划、备份、应用和回滚。
- 入口：`src/index.ts`。
- 安全默认值：CLI `install` 默认只允许 workspace scope；用户级需要显式 `--scope user --yes`。Web Agents 页面默认 user scope，点击确认弹窗后由 agents replace API 强制带 `yes=true`，但仍必须先备份、再写入、再验证。
- 数据流：scan -> plan -> backup -> apply -> verify -> rollback log。
- 备份位置：`<AgentPulse data dir>/backups/<backupId>-<encodedTargetPath>`，旁路写入 `<backupPath>.meta.json` 记录 `{ existedBefore, filePath, planId, createdAt }`。
- 回退语义：原文件存在则恢复原内容；原文件不存在则 rollback 删除 apply 创建的文件；缺少 meta 时兼容旧逻辑，按备份文件复制恢复。
- 行级回退：保留 `rollbackLatest` 给 CLI 使用，提供按 integration 回退能力给 Web Agents 页面使用，避免误回滚其它 agent。
- 代理映射：apply 成功后写入持久化映射；rollback 成功后删除对应 integration 映射，避免 proxy 继续使用已回退配置。
- 测试点：plan 无副作用、install 创建备份和 meta、verify 失败不自动 rollback、rollback 恢复原文件、rollback 删除本次创建的新文件、按 integration 回滚不误伤其它 agent。

## packages/proxy

- 职责：标识驱动的本地代理，通过 `/proxy/{proxyKey}/*` 查找本地 route mapping 后转发到真实 upstream。
- 入口：`src/index.ts`。
- 路由：`/proxy/:proxyKey/*`；`openai`、`anthropic`、`codex`、`claude-code`、`opencode` 只是内置 adapter 默认使用的 proxyKey，不再等同于固定 provider。
- 映射语义：route mapping 必须包含 `proxyKey`、`upstreamBaseUrl`、`apiProtocol`；`apiProtocol` 取值为 `openai-compatible` 或 `anthropic-compatible`，用于记录和后续协议差异处理。
- 数据流：请求进入 proxy 后按 proxyKey 查 mapping；未命中返回 `404 proxy_mapping_not_found`；命中后保留 method/path/query/header/body 转发上游，响应 status/header/body 原样回传客户端。
- Streaming：SSE 和 chunked/未知长度响应直接透传，不为了响应摘要阻塞用户-facing response path；非流式 JSON/text 响应保存脱敏摘要。
- 测试点：映射命中转发、未知 proxyKey 404、非流式 JSON、SSE/chunked passthrough、上游 4xx/5xx 原样透传、AgentPulse 自身异常 502、敏感 header/body 不落库。

## packages/channels

- 职责：通知渠道。
- 入口：`src/index.ts`。
- 渠道：Webhook、Windows notification。
- 数据流：server/policy 生成通知请求，channel 返回统一结果并写入 storage。
- 测试点：Webhook payload、超时错误、Windows 通知降级。

## packages/analyzers

- 职责：基础事件和请求分析。
- 入口：`src/index.ts`。
- 能力：敏感信息检测、危险命令检测、长文本检测、失败归类。
- 数据流：server ingest/proxy capture 后调用 analyzer，结果写入 analysis_results 并更新 riskLevel。
- 测试点：API key 样式识别、危险命令识别、低风险正常事件。

## plugins

- 职责：MVP 暂保留示例插件目录，不加载不可信动态插件。
- 测试点：目录存在即可，不纳入运行时关键路径。
