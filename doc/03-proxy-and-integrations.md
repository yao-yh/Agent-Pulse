# AgentPulse 代理与集成方案

## 1. 总体采集策略

AgentPulse 应采用四类采集和盘点能力：

```text
1. Hook capture       产品主路径：获取任务进度、生命周期、工具调用、本地行为
2. Inventory scan     能力基线：扫描 skills、MCP、插件和配置
3. Proxy capture      上下文增强：获取模型请求、响应、耗时、错误
4. Transcript import  兜底补充：导入历史记录、日志或会话文件
```

产品实现优先级：

```text
Hook/通知 > Inventory/Probes > Proxy > Transcript
```

上下文完整度优先级：

```text
Proxy > Hook > Transcript
```

原因：

- Hook 层最贴近任务进度通知，是第一版主路径。
- Inventory 层不依赖 Agent 自报，是 Skills/MCP 分析的事实基线。
- Proxy 层最可能拿到完整 prompt 和 response，但属于上下文分析增强能力。
- Hook 层不一定能拿到完整上下文，但能补充工具调用和权限事件。
- Transcript 层不稳定，只适合补充。

## 2. Hook 层定位

Hook 层适合获取事件边界，不适合作为完整上下文来源。

适合的事件：

- session start
- session end
- user prompt submit
- pre tool use
- post tool use
- permission request
- stop
- error

Hook 层的价值：

- 识别本地工具调用。
- 识别命令执行。
- 识别权限请求。
- 识别用户何时开始和结束任务。
- 关联 proxy 请求形成完整会话视图。

Hook 层的限制：

- 不一定包含完整 system prompt。
- 不一定包含历史上下文。
- 不一定包含完整 response。
- 不同工具 hook schema 差异较大。
- 工具版本升级可能改变字段。

## 3. Proxy 层定位

Proxy 层是 AgentPulse 的上下文分析增强能力，不是第一版任务进度通知的必要前提。

用户期望：

1. 本地启动服务：

```text
http://localhost:8080
```

2. AgentPulse 读取 Codex、Claude Code 等工具配置。

3. AgentPulse 生成配置修改计划，把工具模型请求路由到本地代理。

4. 本地代理捕获请求和响应，再转发到真实模型服务。

### 3.1 适用范围假设

第一版 proxy 只考虑 **API base URL + API key** 的接入场景：工具配置里能改 base URL，且用 API key 鉴权。

明确不在第一版 proxy 范围内：

- 工具默认的订阅/账号 OAuth 登录通道（例如 ChatGPT、claude.ai 登录），这类模式通常没有可改的 base URL，也没有可透传的 API key。
- 这种情况下 proxy 不保证覆盖，应回退到 hook / inventory / transcript 采集，并在 UI 上标记该工具"未走代理"。

因此 Codex、Claude Code 等工具的 proxy 接入，第一版只针对其 API+key 模式做适配，不为 OAuth 登录通道投入额外工作。

## 4. 为什么不能统一叫 entrypoint

不同工具的模型入口配置不统一，不能假设都叫 `entrypoint`。

可能出现的配置形式：

- `base_url`
- `api_base`
- `endpoint`
- `model_provider`
- `provider.base_url`
- `ANTHROPIC_BASE_URL`
- `OPENAI_BASE_URL`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- CLI 启动参数
- 项目级配置文件
- 用户级配置文件

因此核心系统不应直接处理这些字段。每个 integration adapter 负责自己的配置逻辑。

## 5. 推荐代理路由

不建议只提供：

```text
http://localhost:8080/codex
http://localhost:8080/claude
```

更推荐同时支持协议级和工具级路由：

```text
http://localhost:8080/proxy/openai
http://localhost:8080/proxy/anthropic
http://localhost:8080/proxy/codex
http://localhost:8080/proxy/claude-code
http://localhost:8080/proxy/opencode
```

说明：

- `/proxy/openai`：OpenAI-compatible 协议。
- `/proxy/anthropic`：Anthropic-compatible 协议。
- `/proxy/codex`：Codex 工具级适配，内部再判断真实 provider。
- `/proxy/claude-code`：Claude Code 工具级适配，处理工具特有 header、stream、beta 参数。
- `/proxy/opencode`：OpenCode 工具级适配。

## 6. 代理必须支持的能力

### 6.1 Streaming

必须支持：

- SSE
- chunked response
- 流式 response 捕获
- 流式 response 透传
- 客户端取消
- 上游请求取消
- 超时处理

如果 streaming 做不好，AI 工具可能出现：

- 响应卡住
- UI 不刷新
- 工具误判失败
- 中途取消无效
- response 记录不完整

### 6.2 错误透传

代理不能把上游错误包装成不可识别格式。

需要保留：

- HTTP status code
- response headers
- provider error body
- request id
- rate limit headers，如果有

### 6.3 Header 处理

需要谨慎处理：

- Authorization
- API Key
- Anthropic version header
- Beta feature header
- OpenAI organization/project header
- User-Agent
- Content-Type
- Accept
- Accept-Encoding

默认不应把敏感 header 明文落盘。

### 6.4 Body 捕获

需要支持：

- JSON 请求
- SSE 响应
- 非 JSON 错误响应
- 大体积响应截断
- 二进制内容跳过或摘要化

### 6.5 脱敏

默认脱敏：

- API Key
- Bearer token
- session token
- 邮箱
- 手机号
- `.env` 内容
- 常见云厂商密钥
- GitHub token
- 内部域名，可配置

## 7. 请求转发配置

代理需要知道真实上游地址。

推荐配置模型：

```ts
export interface UpstreamProviderConfig {
  id: string;
  protocol: 'openai-compatible' | 'anthropic-compatible' | 'custom';
  baseUrl: string;
  authMode: 'pass-through' | 'env' | 'configured';
  apiKeyEnv?: string;
  apiKeyRef?: string;
  defaultHeaders?: Record<string, string>;
}
```

认证模式说明：

- `pass-through`：使用工具请求里原有 Authorization。
- `env`：从环境变量读取真实 API Key。
- `configured`：从 AgentPulse 安全配置读取。

第一版推荐优先支持 `pass-through` 和 `env`。

## 8. 配置安装流程

任何配置修改都必须走计划模式。

流程：

```text
scan
  -> detect integrations
  -> read current routing
  -> plan route through proxy
  -> show plan
  -> user confirm
  -> backup
  -> apply
  -> verify
```

回滚流程：

```text
rollback
  -> find backup
  -> restore files
  -> verify restored config
  -> write rollback log
```

## 9. InstallPlan 模型

```ts
export interface InstallPlan {
  id: string;
  integration: string;
  createdAt: string;
  actions: InstallAction[];
  risks: PlanRisk[];
  rollback: RollbackPlan;
}

export type InstallAction =
  | FilePatchAction
  | EnvUpdateAction
  | CommandSuggestionAction;

export interface FilePatchAction {
  type: 'file.patch';
  filePath: string;
  description: string;
  before?: unknown;
  after: unknown;
  backupRequired: true;
}

export interface EnvUpdateAction {
  type: 'env.update';
  scope: 'project' | 'user' | 'process';
  key: string;
  oldValue?: string;
  newValue: string;
  backupRequired: boolean;
}

export interface CommandSuggestionAction {
  type: 'command.suggestion';
  command: string;
  reason: string;
}
```

注意：

- 有些配置不能或不应该由 AgentPulse 直接改。
- 对这类场景，应输出 command suggestion 或 manual instruction。

## 10. 工具适配思路

### 10.1 Codex

目标能力：

- 检测 Codex 配置文件。
- 读取 provider/base_url 相关配置。
- 生成路由到 AgentPulse proxy 的计划。
- 支持 Codex lifecycle hooks，如果可用。
- 保留原 provider 配置，用于回滚。

注意点：

- Codex 可能使用 provider abstraction。
- 可能存在项目级和用户级配置。
- 不能假设只使用 OpenAI 官方 API。
- 需要兼容 OpenAI-compatible provider。

### 10.2 Claude Code

目标能力：

- 检测 Claude Code 配置。
- 读取 Anthropic base URL 或代理相关配置。
- 写入 hook 配置。
- 写入本地 proxy base URL。
- 支持 Anthropic-compatible 协议代理。

注意点：

- Claude Code hook 能力较完整，但不能假设 hook 给出完整模型上下文。
- Claude API 常见路径为 `/v1/messages`，base URL 是否包含 `/v1` 需要 adapter 明确处理。
- Anthropic 相关 header 需要透传。
- 流式响应必须保持兼容。

### 10.3 OpenCode

目标能力：

- 检测 OpenCode 配置。
- 支持 provider 配置接入本地 proxy。
- 支持插件或 hook，如果工具提供。
- 支持 transcript 导入，如果可用。

注意点：

- OpenCode 可能支持多 provider。
- JSON/JSONC 配置修改要保留注释和格式，优先使用结构化解析库。

### 10.4 Hermes / OpenClaw

目标能力：

- 作为 agent-cli 类型 integration。
- 优先调查其是否支持 base URL、hook、plugin 或日志导出。
- 如果缺少 hook，则优先走 proxy。
- 如果缺少 proxy 配置，则考虑 HTTP_PROXY/HTTPS_PROXY 或 wrapper 启动方式。

注意点：

- 不要在核心代码里硬编码 Hermes 或 OpenClaw。
- 先实现 integration adapter 骨架。
- 每个 adapter 声明支持能力：

```ts
export interface IntegrationCapabilities {
  hook: boolean;
  proxy: boolean;
  transcript: boolean;
  configInstall: boolean;
  rollback: boolean;
}
```

## 11. 路径拼接问题

路径拼接是代理方案的高风险点。

示例：

- 有的工具要求 base URL 是 `https://api.example.com`，自己拼 `/v1/messages`。
- 有的工具要求 base URL 是 `https://api.example.com/v1`，自己拼 `/chat/completions`。
- 有的工具会把配置里的路径和请求路径直接拼接。

因此 adapter 必须明确：

- 写入工具配置的 URL 是否包含协议路径。
- AgentPulse 收到请求后如何映射到真实 upstream。
- upstream base URL 是否包含 `/v1`。

## 12. 关联 Hook 与 Proxy

Hook 事件和 proxy 请求需要关联到同一会话。

可用策略：

- integration 在 hook payload 中提取 session id。
- proxy 根据请求 header、cwd、process 信息或时间窗口关联 session。
- AgentPulse 注入 correlation id，如果工具支持。
- 无法精确关联时，使用时间窗口和 source 进行弱关联。

注意：弱关联结果需要标记置信度。

## 13. 推荐接口

### 13.1 Hook Ingest

```text
POST /ingest/hook/:integration/:event
```

### 13.2 Proxy

```text
ANY /proxy/openai/*
ANY /proxy/anthropic/*
ANY /proxy/:integration/*
```

### 13.3 Web API

```text
GET  /api/integrations
GET  /api/events
GET  /api/sessions
GET  /api/proxy-requests
GET  /api/analysis-results
POST /api/channels/test
POST /api/install/plan
POST /api/install/apply
POST /api/install/rollback
```
