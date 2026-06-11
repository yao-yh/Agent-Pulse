# AgentPulse 代理与集成方案

## 1. 总体采集策略

AgentPulse 应采用四类采集和盘点能力：

```text
1. Hook 采集       产品主路径：获取任务进度、生命周期、工具调用和本地行为
2. 能力盘点扫描    能力基线：扫描技能、MCP、插件和配置
3. 代理采集        上下文增强：获取模型请求、响应、耗时和错误
4. 会话记录导入    兜底补充：导入历史记录、日志或会话文件
```

产品实现优先级：

```text
Hook/通知 > 能力盘点/本地探针 > 代理 > 会话记录
```

上下文完整度优先级：

```text
代理 > Hook > 会话记录
```

原因：

- Hook 层最贴近任务进度通知，是第一版主路径。
- 能力盘点层不依赖 Agent 自报，是技能与 MCP 分析的事实基线。
- 代理层最可能拿到完整提示词和响应，但属于上下文分析增强能力。
- Hook 层不一定能拿到完整上下文，但能补充工具调用和权限事件。
- 会话记录层不稳定，只适合补充。

## 2. Hook（钩子）层定位

Hook 层适合获取事件边界，不适合作为完整上下文来源。

适合的事件：

- 会话开始
- 会话结束
- 用户提交提示词
- 工具调用前
- 工具调用后
- 权限请求
- 停止
- 错误

Hook 层的价值：

- 识别本地工具调用。
- 识别命令执行。
- 识别权限请求。
- 识别用户何时开始和结束任务。
- 关联代理请求形成完整会话视图。

Hook 层的限制：

- 不一定包含完整系统提示词。
- 不一定包含历史上下文。
- 不一定包含完整响应。
- 不同工具的 Hook 数据结构差异较大。
- 工具版本升级可能改变字段。

## 3. 代理层定位

代理层是 AgentPulse 的上下文分析增强能力，不是第一版任务进度通知的必要前提。

用户期望：

1. 本地启动服务：

```text
http://localhost:8080
```

2. AgentPulse 读取 Codex、Claude Code 等工具配置。

3. AgentPulse 生成配置修改计划，把工具模型请求路由到本地代理。

4. 本地代理捕获请求和响应，再转发到真实模型服务。

### 3.1 适用范围假设

第一版代理只考虑 **API 基础地址 + API 密钥** 的接入场景：工具配置里能修改基础地址，且使用 API 密钥鉴权。

明确不在第一版代理范围内：

- 工具默认的订阅或账号 OAuth 登录通道（例如 ChatGPT、claude.ai 登录），这类模式通常没有可修改的基础地址，也没有可透传的 API 密钥。
- 这种情况下代理不保证覆盖，应回退到 Hook、能力盘点或会话记录采集，并在界面上标记该工具“未走代理”。

因此 Codex、Claude Code 等工具的代理接入，第一版只针对其 API 密钥模式做适配，不为 OAuth 登录通道投入额外工作。

## 4. 为什么不能统一称为入口字段

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

因此核心系统不应直接处理这些字段。每个集成适配器负责自己的配置逻辑。

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

- `/proxy/openai`：OpenAI 兼容协议。
- `/proxy/anthropic`：Anthropic 兼容协议。
- `/proxy/codex`：Codex 工具级适配，内部再判断真实模型提供方。
- `/proxy/claude-code`：Claude Code 工具级适配，处理工具特有请求头、流式传输和 beta 参数。
- `/proxy/opencode`：OpenCode 工具级适配。

## 6. 代理必须支持的能力

### 6.1 流式传输

必须支持：

- SSE
- 分块响应
- 流式响应捕获
- 流式响应透传
- 客户端取消
- 上游请求取消
- 超时处理

如果流式传输处理不当，AI 工具可能出现：

- 响应卡住
- UI 不刷新
- 工具误判失败
- 中途取消无效
- 响应记录不完整

### 6.2 错误透传

代理不能把上游错误包装成不可识别格式。

需要保留：

- HTTP status code
- 响应头
- 模型提供方错误响应体
- 请求标识
- 限流响应头，如果有

### 6.3 请求头处理

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

默认不应把敏感请求头明文落盘。

### 6.4 请求体与响应体捕获

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

- `pass-through`：使用工具请求里原有的 Authorization。
- `env`：从环境变量读取真实 API 密钥。
- `configured`：从 AgentPulse 安全配置读取。

第一版推荐优先支持 `pass-through` 和 `env`。

## 8. 配置安装流程

任何配置修改都必须走计划模式。

流程：

```text
scan
  -> 检测集成
  -> 读取当前路由
  -> 生成代理路由计划
  -> 展示计划
  -> 用户确认
  -> 备份
  -> 应用
  -> 验证
```

回滚流程：

```text
rollback
  -> 查找备份
  -> 恢复文件
  -> 验证恢复后的配置
  -> 写入回滚日志
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
- 对这类场景，应输出命令建议或人工操作说明。

## 10. 工具适配思路

### 10.1 Codex

目标能力：

- 检测 Codex 配置文件。
- 读取 provider/base_url 相关配置。
- 生成路由到 AgentPulse 代理的计划。
- 支持 Codex 生命周期 Hook（如果可用）。
- 保留原模型提供方配置，用于回滚。

注意点：

- Codex 可能使用模型提供方抽象。
- 可能存在项目级和用户级配置。
- 不能假设只使用 OpenAI 官方 API。
- 需要兼容 OpenAI 兼容模型提供方。

### 10.2 Claude Code

目标能力：

- 检测 Claude Code 配置。
- 读取 Anthropic 基础地址或代理相关配置。
- 写入 Hook 配置。
- 写入本地代理基础地址。
- 支持 Anthropic 兼容协议代理。

注意点：

- Claude Code 的 Hook 能力较完整，但不能假设 Hook 给出完整模型上下文。
- Claude API 常见路径为 `/v1/messages`，基础地址是否包含 `/v1` 需要适配器明确处理。
- Anthropic 相关请求头需要透传。
- 流式响应必须保持兼容。

### 10.3 OpenCode

目标能力：

- 检测 OpenCode 配置。
- 支持模型提供方配置接入本地代理。
- 支持插件或 Hook（如果工具提供）。
- 支持会话记录导入（如果可用）。

注意点：

- OpenCode 可能支持多个模型提供方。
- JSON/JSONC 配置修改要保留注释和格式，优先使用结构化解析库。

### 10.4 Hermes / OpenClaw

目标能力：

- 作为 agent-cli 类型 integration。
- 优先调查其是否支持基础地址、Hook、插件或日志导出。
- 如果缺少 Hook，则优先走代理。
- 如果缺少代理配置，则考虑 HTTP_PROXY/HTTPS_PROXY 或包装器启动方式。

注意点：

- 不要在核心代码里硬编码 Hermes 或 OpenClaw。
- 先实现集成适配器骨架。
- 每个适配器声明支持能力：

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

因此适配器必须明确：

- 写入工具配置的 URL 是否包含协议路径。
- AgentPulse 收到请求后如何映射到真实 upstream。
- 上游基础地址是否包含 `/v1`。

## 12. 关联 Hook 与代理请求

Hook 事件和代理请求需要关联到同一会话。

可用策略：

- 集成适配器从 Hook 载荷中提取会话标识。
- 代理根据请求头、当前目录、进程信息或时间窗口关联会话。
- 如果工具支持，由 AgentPulse 注入关联标识。
- 无法精确关联时，使用时间窗口和 source 进行弱关联。

注意：弱关联结果需要标记置信度。

## 13. 推荐接口

### 13.1 Hook 事件接收

```text
POST /ingest/hook/:integration/:event
```

### 13.2 代理

```text
ANY /proxy/openai/*
ANY /proxy/anthropic/*
ANY /proxy/:integration/*
```

### 13.3 Web 接口

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

## 14. 代码目录映射

- `packages/integrations`：工具检测、配置读取、计划生成、事件标准化和代理路由配置。
- `packages/installer`：计划聚合、备份、应用、验证和回滚。
- `packages/proxy`：请求转发、协议序列化、响应解析、流式透传和脱敏捕获。
- `apps/server`：注册 Hook 接收、代理和安装相关 HTTP 接口。
- `apps/cli`：提供扫描、计划、安装和回滚命令。
- `apps/web`：展示 Agent 状态、安装计划和代理请求详情。

## 15. 测试设计

- 集成适配器：覆盖 Codex TOML、Claude JSON/JSONC、OpenCode 模型提供方配置和无法识别结构时的命令建议降级。
- 安装器：覆盖计划阶段无副作用、备份元数据、应用后验证、按集成回滚和新建文件回滚删除。
- 代理：覆盖路由映射、未知映射 404、非流式响应、SSE/分块透传、客户端取消、上游错误透传和敏感信息脱敏。
- 关联逻辑：覆盖会话标识提取、精确关联、时间窗口弱关联和置信度标记。
- 端到端：覆盖“扫描 -> 计划 -> 备份 -> 应用 -> 发起请求 -> 查看记录 -> 回滚”完整流程。

## 16. 风险与待办

- OAuth 或订阅账号通道不保证经过代理，需要在界面明确展示覆盖状态。
- 不同工具对基础地址和路径的拼接规则可能随版本变化，适配器需要声明兼容版本。
- Hook 与代理请求的弱关联可能误配，必须保存关联依据和置信度。
- 动态解析器加载、插件化协议支持和更复杂的鉴权模式暂不进入第一版。
