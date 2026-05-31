# AgentPulse 架构文档

## 1. 架构目标

AgentPulse 的架构目标是：

1. 核心能力不绑定某个具体 AI 工具。
2. 通过 integration adapter 适配不同工具。
3. 通过 hook/回调采集任务进度、生命周期和本地行为上下文。
4. 通过 channel 及时通知用户任务进展、失败和等待确认。
5. 通过 inventory/probes 直接扫描本地 skills、MCP、插件和配置，避免完全依赖 Agent 自报。
6. 通过 proxy 捕获模型请求和响应，作为上下文分析增强能力。
7. 通过 transcript 导入补充历史记录。
8. 通过 plugin 扩展通知、分析、策略和工具适配。
9. 默认本地运行、本地存储、本地分析。

## 2. 推荐技术栈

### 2.1 包管理与仓库

- pnpm workspace
- monorepo
- TypeScript

可选构建工具：

- tsup：构建 Node 子包
- Vite：构建 Web 页面
- Vitest：测试
- Turbo：任务编排

### 2.2 服务端

推荐：

- Node.js
- Fastify 或 Hono
- SQLite
- better-sqlite3 或 drizzle

### 2.3 Web

推荐：

- React
- Vite
- TanStack Query
- Zustand 或 Jotai
- lucide-react

Web 页面应是工具型界面，避免做成营销落地页。

## 3. Monorepo 目录结构

```text
agent-pulse/
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ README.md
├─ .env.example
│
├─ apps/
│  ├─ cli/
│  │  └─ src/
│  ├─ server/
│  │  └─ src/
│  └─ web/
│     └─ src/
│
├─ packages/
│  ├─ core/
│  │  └─ src/
│  ├─ integrations/
│  │  ├─ ai-coding/
│  │  │  ├─ codex/
│  │  │  ├─ claude-code/
│  │  │  └─ opencode/
│  │  ├─ agent-cli/
│  │  │  ├─ hermes/
│  │  │  └─ openclaw/
│  │  └─ mcp/
│  ├─ channels/
│  │  ├─ webhook/
│  │  ├─ windows-message/
│  │  ├─ dingtalk/
│  │  └─ feishu/
│  ├─ analyzers/
│  │  ├─ basic/
│  │  ├─ security/
│  │  ├─ cost/
│  │  └─ quality/
│  ├─ proxy/
│  │  └─ src/
│  ├─ installer/
│  │  └─ src/
│  ├─ inventory/
│  │  └─ src/
│  ├─ probes/
│  │  └─ src/
│  ├─ storage/
│  │  └─ src/
│  ├─ policy/
│  │  └─ src/
│  ├─ plugin-sdk/
│  │  └─ src/
│  └─ ui/
│     └─ src/
│
├─ plugins/
│  ├─ example-channel/
│  ├─ example-analyzer/
│  └─ example-integration/
│
└─ docs/
   ├─ architecture.md
   ├─ adapter-spec.md
   ├─ plugin-spec.md
   └─ security.md
```

## 4. 核心模块职责

### 4.1 apps/cli

提供命令行入口。

核心命令：

```bash
agent-pulse scan
agent-pulse plan
agent-pulse install
agent-pulse start
agent-pulse rollback
agent-pulse doctor
```

职责：

- 调用 installer 扫描工具。
- 展示配置变更计划。
- 应用配置变更。
- 启动本地服务。
- 触发回滚。
- 检查环境健康状态。

### 4.2 apps/server

本地常驻服务。

默认地址：

```text
http://localhost:8080
```

职责：

- 接收 hook 事件。
- 提供本地代理入口。
- 提供 Web API。
- 调用 analyzer。
- 调用 channel。
- 写入 storage。

### 4.3 apps/web

本地管理页面。

职责：

- 展示工具接入状态。
- 展示事件流。
- 展示会话。
- 展示请求和响应。
- 配置通知渠道。
- 配置 analyzer 和 policy。
- 展示风险事件。
- 展示 Skills/MCP Inventory。

### 4.4 packages/core

核心类型和基础能力。

职责：

- 标准事件模型。
- 标准会话模型。
- 标准配置模型。
- 风险等级定义。
- 工具类型定义。
- 通用错误类型。

核心原则：

- 不出现 Codex、Claude Code、OpenCode 等具体工具逻辑。
- 不直接读写第三方工具配置。
- 不依赖 UI、storage、channel 的具体实现。

### 4.5 packages/integrations

工具适配层。

职责：

- 检测工具是否存在。
- 读取工具当前配置。
- 生成接入 AgentPulse 的配置修改计划。
- 应用配置修改。
- 回滚配置。
- 将工具原始事件转换为标准事件。

### 4.6 packages/proxy

本地请求代理。

职责：

- 接收 OpenAI-compatible 请求。
- 接收 Anthropic-compatible 请求。
- 接收工具级代理请求。
- 转发到真实模型服务。
- 捕获请求和响应。
- 支持 streaming。
- 支持脱敏。
- 记录耗时和错误。

### 4.7 packages/channels

通知渠道。

职责：

- 将标准事件转换成通知消息。
- 发送到不同渠道。
- 管理渠道配置。
- 返回发送结果。

### 4.8 packages/analyzers

分析器。

职责：

- 分析标准事件。
- 分析请求和响应。
- 生成风险结果。
- 生成统计信息。
- 生成标签和摘要。

### 4.9 packages/installer

配置安装器。

职责：

- 聚合 integrations 的扫描结果。
- 生成全局安装计划。
- 创建备份。
- 应用变更。
- 记录安装历史。
- 执行回滚。

### 4.10 packages/storage

本地存储。

职责：

- 存储事件。
- 存储会话。
- 存储请求和响应摘要。
- 存储配置。
- 存储安装备份元数据。

第一版推荐 SQLite。

### 4.11 packages/policy

策略引擎。

职责：

- 根据标准事件判断是否告警。
- 根据请求内容判断是否阻断。
- 根据工具调用判断是否需要升级确认。

注意：第一版可以只做告警，不做阻断。

### 4.12 packages/plugin-sdk

插件 SDK。

职责：

- 定义插件 manifest。
- 定义 channel 插件接口。
- 定义 analyzer 插件接口。
- 定义 integration 插件接口。
- 提供插件加载和校验能力。

## 5. 标准事件模型

建议核心事件模型如下：

```ts
export type AgentSourceType =
  | 'ai-coding'
  | 'agent-cli'
  | 'mcp-client'
  | 'mcp-server'
  | 'automation'
  | 'custom';

export type AgentEventType =
  | 'session.start'
  | 'session.end'
  | 'message.input'
  | 'message.output'
  | 'tool.call'
  | 'tool.result'
  | 'permission.request'
  | 'network.request'
  | 'network.response'
  | 'error'
  | 'custom';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface AgentEvent {
  id: string;
  source: string;
  sourceType: AgentSourceType;
  eventType: AgentEventType;
  timestamp: string;
  projectId?: string;
  workspace?: string;
  sessionId?: string;
  correlationId?: string;
  raw: unknown;
  normalized: Record<string, unknown>;
  riskLevel?: RiskLevel;
  tags?: string[];
}
```

关键字段说明：

- `source`：具体来源，例如 `codex`、`claude-code`、`opencode`。
- `sourceType`：来源类型，不绑定具体工具。
- `eventType`：标准事件类型。
- `correlationId`：用于关联 hook 事件、proxy 请求和 transcript 记录。
- `raw`：原始事件，可能需要脱敏后存储。
- `normalized`：标准化后的结构，供 Web、analyzer、policy 使用。

## 6. Integration Adapter 接口

```ts
export interface IntegrationAdapter {
  name: string;
  sourceType: AgentSourceType;

  detect(input: DetectInput): Promise<DetectResult>;

  readCurrentRouting(input: RoutingReadInput): Promise<RoutingConfig>;

  planInstall(input: InstallInput): Promise<InstallPlan>;

  applyInstall(plan: InstallPlan): Promise<InstallResult>;

  rollback(input: RollbackInput): Promise<RollbackResult>;

  normalizeEvent?(input: NormalizeEventInput): Promise<AgentEvent>;
}
```

重要原则：

- 核心系统不假设配置字段叫 `entrypoint`。
- 每个 adapter 自己知道工具的配置文件、环境变量、base URL 和路径规则。
- adapter 只生成计划，不直接静默修改。
- apply 前必须有备份。

## 7. Channel 插件接口

```ts
export interface Channel {
  name: string;

  send(input: ChannelSendInput): Promise<ChannelSendResult>;

  validateConfig?(config: unknown): Promise<ValidationResult>;
}
```

第一版 channel：

- webhook
- windows-message
- dingtalk
- feishu

## 8. Analyzer 插件接口

```ts
export interface Analyzer {
  name: string;

  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
}
```

分析输入应是标准事件、请求摘要、响应摘要，而不是某个工具的私有格式。

## 9. 数据流

### 9.0 任务进度通知数据流

```text
AI 工具 hook / callback
  -> AgentPulse /ingest/hook/:integration/:event
  -> normalize event
  -> update task/session status
  -> storage
  -> notification rule
  -> channel
  -> user
```

这是 AgentPulse 第一版的主数据流。

### 9.1 Hook 数据流

```text
AI 工具 hook
  -> AgentPulse /ingest/hook/:integration/:event
  -> integration normalize
  -> storage
  -> analyzer
  -> policy
  -> channel
  -> web event stream
```

### 9.2 Proxy 数据流

```text
AI 工具模型请求
  -> AgentPulse /proxy/...
  -> proxy capture request
  -> real model provider
  -> proxy capture response
  -> AI 工具
  -> storage
  -> analyzer
  -> policy
  -> channel
```

### 9.3 Transcript 数据流

```text
本地 transcript / log
  -> integration importer
  -> normalize
  -> storage
  -> analyzer
  -> web
```

## 10. 存储建议

第一版 SQLite 表建议：

```text
projects
integrations
sessions
events
proxy_requests
proxy_responses
analysis_results
notifications
install_plans
backups
settings
inventory_sources
inventory_items
skills
mcp_servers
plugins
```

注意：

- request body 和 response body 需要支持关闭存储。
- 敏感字段必须脱敏。
- 原始数据和标准化数据分开存储。
- 大体积 response 可以只存摘要和截断内容。

## 11. 补充架构：Inventory 模块

AgentPulse 需要增加 `packages/inventory`，用于独立扫描本地 skills、MCP servers、插件和 Agent 配置。

该模块职责：

- 扫描项目级、用户级、全局级 Agent 配置。
- 发现 skills、MCP servers、插件和工具扩展。
- 读取 `SKILL.md`、MCP 配置、插件 manifest 等元数据。
- 记录来源路径、启用状态、配置摘要、最后修改时间。
- 对比 Agent 自报能力与本地扫描结果。
- 为 analyzer 提供 Skills/MCP 使用分析基线。

该模块原则：

- 不依赖 Agent 自报。
- 不把某个工具的路径规则写进 core。
- 只读取必要元数据。
- env、token、headers 等敏感配置必须脱敏。

详细方案见 [Skills 和 MCP 本地盘点方案](./05-skills-mcp-inventory.md)。

## 12. 补充架构：Probes 本地探针层

AgentPulse 需要增加 `packages/probes`，用于封装系统判断、文件判断、命令判断、配置解析、skill 判断、MCP 判断、插件判断和敏感信息判断等通用能力。

该层职责：

- 判断当前系统、shell、workspace 和配置目录。
- 判断文件、目录、权限、大小和修改时间。
- 判断命令是否存在以及版本信息。
- 解析 JSON、JSONC、TOML、YAML 等配置文件。
- 判断某个目录是否像 skill。
- 判断某段配置是否像 MCP server。
- 判断某个目录是否像插件。
- 对敏感字段和配置进行脱敏。

该层原则：

- 只采集事实和给出判断，不做业务决策。
- 判断结果需要包含 confidence 和 reasons。
- 不全盘扫描。
- 不保存敏感明文。
- 工具特定路径由 integration 提供，probe 负责执行通用判断。

详细方案见 [本地探针与判断工具层方案](./06-local-probes-layer.md)。
