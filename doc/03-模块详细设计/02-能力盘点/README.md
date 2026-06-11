# 技能与 MCP 本地盘点方案

## 1. 功能定位

AgentPulse 需要检查当前 Agent 实际可加载或已配置的技能、MCP 服务器、插件和相关能力。这个能力不应依赖 Agent 的提示词、Hook 载荷或自报结果，而应由 AgentPulse 直接读取本地文件系统和配置文件。

该能力的核心目的：

- 建立当前 Agent 能力清单的独立事实基线。
- 防止 Agent 自身 bug、上下文遗漏或配置读取异常导致能力清单不可信。
- 为后续分析技能与 MCP 是否被使用、是否失效、是否影响某次任务提供依据。

一句话：

> AgentPulse 不能只听 Agent 说自己加载了什么，还要自己去本地配置和目录里查。

## 2. 为什么需要独立盘点

仅依赖 Agent 自报存在明显风险：

- Agent 可能漏报已加载的技能。
- Agent 可能声称某个技能可用，但本地目录不存在。
- Agent 可能没有感知到用户级或项目级 MCP 配置。
- Hook 事件可能只包含调用结果，不包含完整可用能力清单。
- 提示词上下文可能被截断，导致技能与 MCP 信息缺失。
- Agent 工具本身可能存在 bug，无法准确报告加载状态。

因此 AgentPulse 需要增加一个独立模块：

```text
packages/inventory
```

该模块专门负责从本地配置、目录和 manifest 中扫描能力清单。

## 3. 能力盘点与 Hook、代理、会话记录的关系

AgentPulse 的采集模型应扩展为：

```text
能力盘点扫描    建立能力基线：技能、MCP、插件和配置来源
Hook 采集       采集运行事件：任务进度、工具调用和权限请求
代理采集        采集模型请求：提示词、响应、耗时和错误
会话记录导入    补充历史记录：会话日志和导出文件
```

它们的职责不同：

- 能力盘点回答“当前可用什么能力”。
- Hook 回答“运行过程中发生了什么”。
- 代理回答“模型请求和回复是什么”。
- 会话记录回答“历史记录里留下了什么”。

不要用代理或 Hook 替代能力盘点。代理和 Hook 只能证明某些能力被提到或被调用过，不能完整证明当前配置中有哪些技能与 MCP。

## 4. 第一版扫描范围

第一版应优先扫描：

- 当前工作区下的 Agent 配置。
- 用户级 Agent 配置目录。
- 常见全局配置目录。
- 技能目录。
- MCP 服务器配置。
- 插件或扩展 manifest。

具体路径应由各集成适配器声明，核心模块不要硬编码某个工具的路径。

示例：

```ts
export interface InventorySource {
  id: string;
  integration: string;
  scope: 'workspace' | 'user' | 'global';
  kind: 'skill-dir' | 'mcp-config' | 'plugin-dir' | 'tool-config';
  path: string;
  exists: boolean;
  lastModifiedAt?: string;
}
```

## 5. 技能盘点

技能扫描需要尽量读取元数据，而不是盲目读取所有文件。

优先识别：

- 技能名称
- 技能描述
- 技能目录
- `SKILL.md` 路径
- 来源范围：工作区、用户级或全局级
- 是否启用
- 最后修改时间
- 所属集成，如果能判断

建议模型：

```ts
export interface SkillInventoryItem {
  id: string;
  name: string;
  description?: string;
  integration?: string;
  scope: 'workspace' | 'user' | 'global';
  directory: string;
  entryFile?: string;
  enabled: boolean;
  sourcePath: string;
  lastModifiedAt?: string;
  hash?: string;
}
```

注意：

- 默认不要读取技能目录下所有内容。
- 优先读取 `SKILL.md`、manifest、配置文件等元数据。
- 大文件、二进制文件、生成文件应跳过。
- 如果读取失败，应记录错误而不是中断整个扫描。

## 6. MCP 服务器盘点

MCP 服务器扫描需要识别：

- 服务器名称
- 配置来源
- transport 类型
- command
- args
- url
- env keys
- 是否启用
- 是否可能包含敏感信息

第一版只做静态配置扫描，不主动启动或连接 MCP 服务器。主动探测 MCP 工具、资源和提示词的能力暂时记录为待办事项。

建议模型：

```ts
export interface McpServerInventoryItem {
  id: string;
  name: string;
  integration?: string;
  scope: 'workspace' | 'user' | 'global';
  transport?: 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  enabled: boolean;
  sourcePath: string;
  lastModifiedAt?: string;
  riskLevel?: 'none' | 'low' | 'medium' | 'high' | 'critical';
}
```

敏感信息处理：

- 不保存 env 的明文 value。
- 只保存 env key。
- 如果必须展示 value，默认脱敏。
- Authorization、API Key、token、cookie、secret 等字段必须脱敏。

## 7. 状态模型

AgentPulse 应区分以下状态：

```ts
export type CapabilityStatus =
  | 'discovered'
  | 'configured'
  | 'reported-by-agent'
  | 'observed-used'
  | 'missing'
  | 'error';
```

说明：

- `discovered`：本地扫描发现。
- `configured`：配置中声明启用。
- `reported-by-agent`：Agent 自报存在。
- `observed-used`：运行事件或日志中观察到实际使用。
- `missing`：配置引用了路径或命令，但本地不存在。
- `error`：扫描或解析失败。

这个状态模型很重要，因为“配置了”和“实际使用了”不是一回事。

## 8. Agent 自报结果对比

如果某些 Agent 能通过 Hook、提示词或命令输出自报的技能与 MCP，AgentPulse 可以记录，但不能直接信任。

对比结果建议分为：

```ts
export type CapabilityDiffType =
  | 'matched'
  | 'only-in-local-inventory'
  | 'only-reported-by-agent'
  | 'path-mismatch'
  | 'disabled-but-reported'
  | 'configured-but-missing';
```

典型告警：

- Agent 自报存在，但本地没扫描到。
- 本地配置启用，但 Agent 没有自报。
- 配置引用路径不存在。
- MCP 命令不存在。
- MCP env key 看起来是敏感凭证。
- 同名技能在多个作用域下重复出现。

## 9. 使用分析

技能与 MCP 使用分析应分两步做。

第一步：能力基线。

- 当前有哪些技能。
- 当前有哪些 MCP 服务器。
- 来源路径是什么。
- 是否启用。
- 是否配置异常。

第二步：运行时使用分析。

- 某个会话是否调用了某个 MCP 工具。
- 某个会话是否触发了某个技能相关行为。
- 某个 MCP 服务器的调用次数。
- 某个技能是否长期未使用。
- 某个工具失败是否和 MCP 配置异常有关。

使用分析的数据来源：

- Hook 事件中的工具调用。
- 会话记录中的 MCP 或工具调用记录。
- 代理请求中提到的工具上下文，仅作为弱证据。
- Agent 自报，仅作为弱证据。

## 10. Web 页面

Web 页面应增加：

```text
Inventory
  - Skills
  - MCP Servers
  - Plugins
  - Diff
```

技能页面展示：

- 名称
- 描述
- 来源作用域
- 路径
- 是否启用
- 最后修改时间
- 状态
- 最近使用情况，如果可得

MCP 服务器页面展示：

- 名称
- transport
- command 或 url
- env keys
- 来源路径
- 是否启用
- 风险等级
- 最近调用次数，如果可得

Diff 页面展示：

- 本地扫描结果
- Agent 自报结果
- 不一致项
- 需要修复的配置

## 11. API 建议

```text
GET  /api/inventory
GET  /api/inventory/sources
GET  /api/inventory/skills
GET  /api/inventory/mcp-servers
GET  /api/inventory/plugins
GET  /api/inventory/diff
POST /api/inventory/scan
```

CLI 建议：

```bash
agent-pulse inventory
agent-pulse inventory --skills
agent-pulse inventory --mcp
agent-pulse inventory --diff
```

也可以让 `agent-pulse scan` 默认包含能力盘点扫描。

## 12. 存储建议

SQLite 表建议：

```text
inventory_sources
inventory_items
skills
mcp_servers
plugins
capability_reports
capability_diffs
capability_usage
```

字段注意：

- `sourcePath` 需要保存。
- `envKeys` 可以保存。
- `envValues` 默认不保存。
- `rawConfig` 如需保存必须脱敏。
- 大段文件内容不应保存。

## 13. MVP 调整

AgentPulse 最小可行产品应加入技能与 MCP 本地盘点。

MVP 必须做：

- Hook 回调接入。
- 任务状态模型。
- 通知渠道。
- 本地事件服务。
- Web 事件流。
- scan / plan / install / rollback。
- 技能与 MCP 本地盘点。

MVP 可选做：

- Proxy 捕获。
- 提示词与响应分析。
- 会话记录导入。
- 复杂使用频率分析。
- MCP 主动探测。

## 14. 实现注意项

1. 不要全盘扫描。
2. 不要默认读取敏感文件内容。
3. 不要保存 env 明文值。
4. 不要相信 Agent 自报。
5. 不要把某个工具的路径规则写进 core。
6. JSONC、TOML、YAML 等配置应使用结构化解析。
7. 扫描失败要记录错误并继续。
8. 同名技能或 MCP 服务器要保留作用域和来源路径。
9. 使用分析要区分强证据和弱证据。
10. UI 上要明确展示“已配置”和“已使用”的区别。

## 15. 与本地探针层的关系

能力盘点模块不应自己实现所有底层判断逻辑，而应调用 `packages/probes`。

职责边界：

- 本地探针判断某个目录是否符合技能目录特征。
- 本地探针判断某段配置是否符合 MCP 服务器配置特征。
- 本地探针解析 JSONC、TOML 和 YAML。
- 本地探针判断命令是否存在。
- 本地探针对敏感字段脱敏。
- 能力盘点模块负责组织扫描流程、汇总结果、持久化和生成差异。

详细设计见 [本地探针模块详细设计](../03-本地探针/README.md)。

## 16. 代码目录映射

- `packages/inventory`：组织扫描流程、合并来源、生成能力差异并写入存储。
- `packages/integrations`：声明各工具的工作区级、用户级和全局级配置来源。
- `packages/probes`：执行文件、配置、技能、MCP、插件和敏感信息判断。
- `packages/storage`：持久化来源、技能、MCP 服务器、插件和差异结果。
- `apps/server`：提供能力盘点查询与重新扫描接口。
- `apps/cli`、`apps/web`：分别提供命令行输出和可视化页面。

## 17. 测试设计

- 覆盖工作区级、用户级和全局级来源发现及优先级。
- 覆盖技能元数据提取、MCP 静态配置提取、插件清单读取和缺失路径警告。
- 覆盖扫描失败继续执行、重复条目保留来源作用域和稳定标识生成。
- 验证环境变量值、令牌、请求头和原始敏感配置不会以明文持久化。
- 覆盖本地盘点与 Agent 自报结果的匹配、仅本地存在、仅自报存在和路径不一致。

## 18. 风险与待办

- 工具配置路径和格式可能随版本变化，应由集成适配器维护版本兼容规则。
- 第一版不主动启动或连接 MCP 服务器，无法证明静态配置对应的服务当前可用。
- 技能已配置不等于运行时已加载，界面必须区分发现、配置、自报和实际使用状态。
- 主动 MCP 探测、复杂使用频率分析和跨会话能力影响归因暂不进入第一版。
