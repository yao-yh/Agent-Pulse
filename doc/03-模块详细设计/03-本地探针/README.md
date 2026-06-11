# 本地探针与判断工具层方案

## 1. 功能定位

AgentPulse 需要抽象一个“本地探针与判断工具层”，用于封装各种底层事实判断能力。

建议包名：

```text
packages/probes
```

或：

```text
packages/local-tools
```

推荐使用：

```text
packages/probes
```

因为它更准确表达“探测、判断、采集本地事实”的职责，不容易和 AI Agent 的 tool call 混淆。

该层不直接负责 Codex、Claude Code、OpenCode 等具体工具适配，也不负责业务分析。它只提供可复用的基础判断能力。

一句话：

> 本地探针层负责回答“本地环境里的事实是什么”，集成、能力盘点和分析器再决定“这些事实意味着什么”。

## 2. 为什么需要本地探针层

如果没有本地探针层，很多判断逻辑会散落在集成、能力盘点、安装器和分析器中。

典型重复逻辑：

- 当前系统是 Windows、macOS 还是 Linux。
- 某个命令是否存在。
- 某个路径是否存在。
- 某个文件是否像 `SKILL.md`。
- 某个配置是否符合 MCP 服务器配置特征。
- 某个 JSONC/TOML/YAML 文件如何安全解析。
- 某个环境变量字段是否是敏感信息。
- 某个目录是否是 Agent 配置目录。
- 某个工具版本如何读取。

这些能力应该下沉到本地探针层，避免上层重复实现。

## 3. 分层关系

推荐分层：

```text
apps/cli
apps/server
  -> packages/installer
  -> packages/inventory
  -> packages/integrations
  -> packages/analyzers
       -> packages/probes
       -> packages/core
```

关系说明：

- `probes` 只依赖 `core` 中的基础类型，尽量少依赖其他包。
- `inventory` 使用 `probes` 扫描技能、MCP 和插件。
- `integrations` 使用 `probes` 判断工具是否安装、配置是否存在、命令是否可用。
- `installer` 使用 `probes` 做路径、权限、备份前检查。
- `analyzers` 可以使用 `probes` 的分类器判断某个配置或事件是否高风险。

## 4. 本地探针层职责

### 4.1 系统探针

判断当前系统环境。

能力：

- 判断 OS：Windows、macOS、Linux。
- 判断命令行环境：PowerShell、cmd、bash、zsh、fish。
- 判断 home 目录。
- 判断当前工作区。
- 判断常见配置目录。
- 判断路径分隔符和可执行文件扩展名。

接口示例：

```ts
export interface SystemProbe {
  getPlatform(): PlatformInfo;
  getHomeDir(): string;
  getWorkspaceDir(): string;
  getConfigDirs(): ConfigDir[];
  getShellInfo(): ShellInfo;
}
```

### 4.2 文件系统探针

安全读取和判断文件。

能力：

- 判断路径是否存在。
- 判断路径是文件还是目录。
- 获取文件大小、修改时间、权限。
- 限制扫描深度。
- 跳过大文件、二进制文件、隐藏目录、依赖目录。
- 安全读取小型文本文件。

接口示例：

```ts
export interface FileProbe {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  listDir(path: string, options?: ListDirOptions): Promise<FileEntry[]>;
  readText(path: string, options?: ReadTextOptions): Promise<string>;
}
```

注意：

- 不要默认全盘扫描。
- 不要默认读取大文件。
- 不要默认读取 `.env` 明文内容。
- 读取失败应返回结构化错误，不应直接抛到最上层导致扫描中断。

### 4.3 命令探针

判断本地命令是否存在、版本是什么。

能力：

- 检查 `codex` 是否存在。
- 检查 `claude` 是否存在。
- 检查 `opencode` 是否存在。
- 检查 Node、pnpm、git 等基础命令。
- 读取版本号。
- 判断命令路径。

接口示例：

```ts
export interface CommandProbe {
  which(command: string): Promise<CommandLocation | null>;
  getVersion(command: string, args?: string[]): Promise<CommandVersionResult>;
  isExecutable(path: string): Promise<boolean>;
}
```

安全要求：

- 版本检查命令必须由 integration 明确声明。
- 不允许根据未校验的用户输入拼接任意命令。
- 命令执行需要 timeout。
- 更严格的命令探针安全边界暂时记录为待办事项，第一版优先实现低风险的命令存在性判断。

### 4.4 配置解析探针

统一解析常见配置格式。

支持格式：

- JSON
- JSONC
- TOML
- YAML
- INI，可选
- env file，可选且默认脱敏

接口示例：

```ts
export interface ConfigProbe {
  parseJson(path: string): Promise<ParseResult<unknown>>;
  parseJsonc(path: string): Promise<ParseResult<unknown>>;
  parseToml(path: string): Promise<ParseResult<unknown>>;
  parseYaml(path: string): Promise<ParseResult<unknown>>;
}
```

原则：

- 解析失败要带上文件路径、错误行列、错误原因。
- JSONC 修改要尽量保留注释和格式。
- TOML/YAML 修改也应尽量结构化处理。
- 不要使用字符串替换修改配置。

### 4.5 技能判断器

判断某个目录或文件是否符合技能定义。

判断依据：

- 是否存在 `SKILL.md`。
- 是否存在 manifest。
- `SKILL.md` 是否包含名称、描述、触发规则等结构。
- 是否位于已知技能目录下。
- 是否被 Agent 配置引用。

接口示例：

```ts
export interface SkillProbe {
  isSkillDirectory(path: string): Promise<SkillProbeResult>;
  readSkillMetadata(path: string): Promise<SkillMetadataResult>;
}
```

结果示例：

```ts
export interface SkillProbeResult {
  isSkill: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
  entryFile?: string;
}
```

注意：

- “符合技能定义”不等于“已加载”。
- “配置中引用”不等于“运行时成功加载”。
- 判断结果需要包含置信度。

### 4.6 MCP 判断器

判断某段配置是否符合 MCP 服务器配置特征。

判断依据：

- 是否包含服务器名称。
- 是否包含 command/args。
- 是否包含 url。
- 是否包含 transport。
- 是否出现在已知 MCP 配置字段下。
- 是否包含 env 配置。

接口示例：

```ts
export interface McpProbe {
  isMcpConfig(value: unknown): McpProbeResult;
  extractMcpServers(config: unknown): McpServerCandidate[];
}
```

结果示例：

```ts
export interface McpServerCandidate {
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  sourcePath?: string;
  confidence: 'low' | 'medium' | 'high';
}
```

注意：

- 默认不返回环境变量值。
- 如果命令不存在，应标记风险。
- 如果地址使用非本地 HTTP，需要标记外部连接风险。

### 4.7 插件判断器

判断目录是否符合 AgentPulse 插件或第三方 Agent 插件特征。

判断依据：

- 是否存在 manifest。
- 是否存在 package.json。
- 是否声明通知渠道、分析器、集成或策略。
- 是否被配置文件引用。

接口示例：

```ts
export interface PluginProbe {
  isPluginDirectory(path: string): Promise<PluginProbeResult>;
  readPluginManifest(path: string): Promise<PluginManifestResult>;
}
```

### 4.8 敏感信息判断器

提供统一脱敏和风险识别能力。

能力：

- 判断字段名是否敏感。
- 判断字符串是否像 API Key。
- 判断 env key 是否敏感。
- 对对象做递归脱敏。
- 保留 env key，隐藏 env value。

接口示例：

```ts
export interface SecretProbe {
  isSensitiveKey(key: string): boolean;
  containsSecret(value: string): SecretFinding[];
  redactValue(value: unknown): unknown;
  redactObject(value: unknown): unknown;
}
```

### 4.9 进程探针

判断某个 Agent 进程是否仍在运行，用于任务进度通知的进程存活兜底（见 [产品需求 4.3.1](../../01-需求/01-产品需求.md)）。

能力：

- 判断给定 pid 是否存活。
- 尽量获取进程的命令行或可执行名，用于弱关联到某个工具/会话。
- 跨平台实现：Windows 用 `tasklist` 或原生 API，类 Unix 用 `kill -0` 或 `/proc`。

接口示例：

```ts
export interface ProcessProbe {
  isAlive(pid: number): Promise<boolean>;
  describe(pid: number): Promise<ProcessInfo | null>;
}
```

注意：

- 第一版只需要"进程是否存在"这一最低能力，不做完整进程树分析。
- 拿不到可靠 pid 时降级为时间窗口弱关联，并标记低置信度。
- 只读不杀进程；AgentPulse 不主动结束任何 Agent 进程。

## 5. ProbeResult 标准模型

本地探针层的所有判断都应返回结构化结果，而不是只返回布尔值。

```ts
export interface ProbeResult<T> {
  ok: boolean;
  value?: T;
  confidence?: 'low' | 'medium' | 'high';
  reasons?: string[];
  warnings?: ProbeWarning[];
  errors?: ProbeError[];
}
```

这样上层可以解释“为什么认为这是技能”或“为什么认为这个 MCP 配置有风险”。

## 6. 上层如何使用本地探针

### 6.1 能力盘点使用本地探针

```text
能力盘点扫描器
  -> 系统探针查找配置目录
  -> 文件探针扫描候选文件
  -> 配置探针解析配置
  -> 技能探针判断技能
  -> MCP 探针判断 MCP
  -> 敏感信息探针脱敏
  -> 存储
```

### 6.2 集成适配器使用本地探针

```text
Codex 适配器
  -> 命令探针检查 codex
  -> 配置探针读取 Codex 配置
  -> 文件探针检查配置路径
  -> MCP/技能探针发现相关能力
```

### 6.3 分析器使用本地探针

```text
安全分析器
  -> 敏感信息探针检查敏感信息
  -> MCP 探针判断 MCP 外联风险
  -> 命令探针判断命令是否存在或可疑
```

## 7. 不确定功能的扩展方向

当前“系统判断、是否为技能判断”等功能还不完全明确，因此本地探针层应设计成可扩展。

未来可以新增：

- `AgentConfigProbe`：判断某个配置是否属于某个 Agent。
- `ProjectProbe`：判断项目类型、包管理器、语言栈。
- `NetworkProbe`：检查本地端口、代理连通性。
- `PermissionProbe`：判断文件是否可读写、配置是否可备份。
- `VersionProbe`：判断工具版本是否兼容某个适配器。
- `PortProbe`：检查 `localhost:8080` 是否可用。
- `PathRiskProbe`：判断配置是否引用危险路径或不存在路径。

## 8. 目录结构建议

```text
packages/probes/
├─ src/
│  ├─ index.ts
│  ├─ system/
│  ├─ file/
│  ├─ command/
│  ├─ config/
│  ├─ skill/
│  ├─ mcp/
│  ├─ plugin/
│  ├─ secret/
│  ├─ process/
│  └─ types.ts
└─ package.json
```

## 9. MVP 范围

第一版本地探针层建议只做：

- 系统探针
- 文件探针
- 命令探针
- 配置探针
- 技能探针
- MCP 探针
- 敏感信息探针
- 进程探针（仅“进程是否存在”，用于任务终态兜底）

暂不做：

- 网络探针
- 复杂项目探针
- 全量插件风险分析
- 自动修复配置
- 复杂命令安全策略

## 10. 实现原则

1. 本地探针层只采集事实和给出判断，不做业务决策。
2. 所有判断尽量返回置信度和判断理由。
3. 不要全盘扫描。
4. 不要读取无关大文件。
5. 不要保存敏感明文。
6. 不要把某个 Agent 的配置规则写死在通用探针里。
7. 工具特定路径由集成适配器提供，探针负责执行通用判断。
8. 扫描失败不应中断整体流程。
9. 配置解析要使用结构化解析器。
10. 上层 UI 应能展示判断依据，方便用户信任结果。

## 11. 代码目录映射

- `packages/probes/src/system`：系统、用户目录、工作区和命令行环境判断。
- `packages/probes/src/file`：文件状态、目录枚举和受限文本读取。
- `packages/probes/src/command`：命令存在性、可执行路径和受控版本探测。
- `packages/probes/src/config`：JSON、JSONC、TOML、YAML 等配置解析。
- `packages/probes/src/skill`：技能目录识别和元数据读取。
- `packages/probes/src/mcp`：MCP 服务器候选提取和风险判断。
- `packages/probes/src/plugin`：插件目录和清单识别。
- `packages/probes/src/secret`：敏感字段识别与递归脱敏。
- `packages/probes/src/process`：进程存活与最小进程信息读取。

## 12. 测试设计

- 系统和文件探针：覆盖跨平台路径、缺失文件、权限错误、扫描深度和大文件限制。
- 命令探针：覆盖命令存在、不存在、超时和未列入允许范围的版本参数。
- 配置探针：覆盖有效配置、语法错误、错误行列信息和 JSONC 注释保留要求。
- 技能、MCP 和插件探针：覆盖高、中、低置信度结果及判断理由。
- 敏感信息探针：覆盖常见密钥模式、嵌套对象脱敏和环境变量值隐藏。
- 进程探针：覆盖存活、不存在、权限不足和无法可靠关联时的降级行为。

## 13. 风险与待办

- 跨平台命令和权限语义不同，探针结果必须保留平台信息和错误原因。
- 版本探测命令必须由集成适配器明确声明，不能拼接未经校验的用户输入。
- 置信度模型需要随真实样本校准，不能把启发式判断当成确定事实。
- 网络探针、复杂项目识别和主动修复配置暂不进入第一版。
