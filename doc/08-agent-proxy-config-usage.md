# Agent 代理配置使用文档

本文说明如何使用 AgentPulse 扫描本地 AI Agent 工具，并通过配置计划把支持 API-key 模式的工具请求路由到 AgentPulse 本地代理。

当前支持的工具：

- Codex
- Claude Code
- OpenCode

当前适用范围：

- 只支持可以修改 `base_url`、`apiBaseUrl`、`ANTHROPIC_BASE_URL`、`endpoint` 等配置的 API-key 模式。
- 不支持 OAuth、订阅账号登录、ChatGPT/claude.ai 网页账号通道等不可直接改 base URL 的模式。
- Web 控制台默认修改当前用户级配置。CLI 默认仍只修改当前 workspace 配置，用户级配置必须显式使用 `--scope user --yes`。

## 1. 启动本地代理服务

在配置工具前，建议先启动 AgentPulse 服务：

```powershell
pnpm --filter @agent-pulse/cli start -- start
```

默认监听地址：

```text
http://127.0.0.1:8080
```

启动后可以在浏览器打开：

```text
http://127.0.0.1:8080
```

Web 控制台的 `Agents` 页面提供扫描、替换和回滚操作；CLI 操作仍然保留。

工具配置完成后，请求会被路由到以下本地代理入口。`/proxy/` 后面的部分是本地映射标识 `proxyKey`，proxy 会用它查找真实 upstream 和 API 标准：

```text
http://127.0.0.1:8080/proxy/codex
http://127.0.0.1:8080/proxy/claude-code
http://127.0.0.1:8080/proxy/opencode
```

如果某个 `proxyKey` 没有对应映射，proxy 会返回 `404 proxy_mapping_not_found`，不会自动转发到官方默认上游。

## 2. 扫描当前 Agent 状态

### 2.1 Web 控制台扫描

打开 `Agents` 页面后，确认代理地址，点击页面右上角的“扫描”按钮。Web 控制台固定扫描当前用户级配置，例如：

- `~/.codex/config.toml`
- `~/.claude/settings.json`
- `~/.config/opencode/config.json`

扫描结果会以列表展示：

- `Agent`：工具名称，例如 `codex`、`claude-code`、`opencode`。
- `检测状态`：是否发现该工具或配置来源。
- `路由状态`：是否已经指向 AgentPulse 本地代理。
- `用户级目标文件`：点击“替换”时将要修改的真实用户级配置文件。
- `原始上游`：替换前读取到的上游地址；未配置时会按对应官方上游处理。
- `提示`：缺失配置、无法解析、schema 未识别或操作结果。
- `操作`：支持“替换”和“回滚”。

当前阶段，“扫描 PC 上所有 agent”指扫描 AgentPulse 已注册 adapter 支持的工具。新增 adapter 后会自动进入该列表。

### 2.2 CLI 扫描

执行：

```powershell
pnpm --filter @agent-pulse/cli start -- scan
```

输出中重点查看：

- `integration`：工具名称，例如 `codex`、`claude-code`、`opencode`。
- `detected`：是否检测到该工具或其配置来源。
- `configSources`：相关配置文件路径。
- `routeState`：当前是否已经路由到 AgentPulse。
- `warnings`：配置缺失、无法解析或 schema 未识别等提示。

## 3. 生成配置修改计划

Web 控制台点击“替换”时会自动执行生成计划，不需要手动调用本节命令。本节适用于 CLI 或调试场景。

生成 workspace 级配置计划：

```powershell
pnpm --filter @agent-pulse/cli start -- plan --scope workspace --proxy-base-url http://127.0.0.1:8080
```

这一步只生成计划，不会修改文件。

输出中重点查看：

- `summary`：计划说明。
- `preflight`：修改前的代理状态。
- `actions`：即将执行的配置 patch 或手动建议。
- `actions[].filePath`：将要修改的真实配置文件。
- `actions[].before`：脱敏后的修改前摘要。
- `actions[].after`：修改后的配置内容。
- `risks`：风险提示。
- `rollback`：回退相关信息。
- `proxyRoute`：后续 proxy 层可使用的路由 profile。

如果某个工具配置 schema 无法可靠识别，计划会降级为 `command.suggestion`，不会强行写入配置。

## 4. 应用配置修改

### 4.1 Web 控制台替换

在 `Agents` 页面中：

1. 确认 `配置范围` 显示为“用户级配置”。
2. 确认 `代理地址`，默认是 `http://127.0.0.1:8080`。
3. 在目标 agent 行点击“替换”。
4. 在确认弹窗中检查目标配置文件、原始上游、新代理地址、文件状态和备份说明。
5. 点击“确认替换”。

确认后会直接修改当前用户目录下的真实 agent 配置文件。页面点击“替换”本身就是显式授权，后端会为本次用户级写入携带确认标记，但不会跳过备份、验证和回滚记录。

点击“替换”后，后端会执行：

```text
scan state -> plan -> backup -> apply -> verify -> refresh list
```

对于 Claude Code，AgentPulse 会优先解析：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "原始上游地址"
  }
}
```

如果没有解析到 `env.ANTHROPIC_BASE_URL` 或其它兼容 base URL 字段，则认为原始上游是官方 Claude：

```text
https://api.anthropic.com
```

替换时会把 Claude Code 配置中的 `env.ANTHROPIC_BASE_URL` 写成：

```text
http://127.0.0.1:8080/proxy/claude-code
```

同时持久化一份代理映射：

```text
claude-code: http://127.0.0.1:8080/proxy/claude-code -> 原始上游地址
```

proxy 层会把这份映射加载到内存。后续请求进入 `/proxy/claude-code` 时，会优先按内存映射转发到原始上游，而不是只依赖环境变量。

映射中还会记录 `apiProtocol`：

- `openai-compatible`：OpenAI-compatible API，例如 Codex、OpenCode。
- `anthropic-compatible`：Anthropic-compatible API，例如 Claude Code。

替换成功后，该行提示会显示“替换完成，配置已验证。”；如果验证失败或无法识别配置，会在该行提示中显示失败原因。

如果用户级配置文件不存在，但 adapter 可以安全创建配置文件，确认弹窗会显示“将创建配置文件”。此时回滚会删除本次新建的配置文件。

### 4.2 CLI 应用

应用最近生成的计划：

```powershell
pnpm --filter @agent-pulse/cli start -- install --scope workspace
```

执行过程：

1. 对每个 `file.patch` 目标文件创建备份。
2. 写入备份元数据。
3. 修改目标配置文件。
4. 调用对应 integration adapter 验证配置是否已指向 AgentPulse proxy。

成功输出中重点查看：

- `ok`：整体是否成功。
- `appliedActions`：实际应用的文件 patch 数量。
- `verification.ok`：配置验证是否成功。
- `verification.checkedFiles`：验证过的文件。
- `warnings`：验证失败或跳过项说明。

## 5. CLI 用户级配置修改

CLI 默认不允许静默修改用户级配置。若要通过 CLI 修改用户目录下的配置，例如：

- `~/.codex/config.toml`
- `~/.claude/settings.json`
- `~/.config/opencode/config.json`

先生成用户级计划：

```powershell
pnpm --filter @agent-pulse/cli start -- plan --scope user --proxy-base-url http://127.0.0.1:8080
```

再显式确认应用：

```powershell
pnpm --filter @agent-pulse/cli start -- install --scope user --yes
```

注意：`--yes` 只用于允许非 workspace scope 写入，不代表跳过备份或验证。

## 6. 备份文件位置

每次 `install` 应用文件 patch 前都会创建备份。

备份目录：

```text
<AgentPulse data dir>/backups/
```

默认数据目录：

```text
~/.agent-pulse
```

如果设置了环境变量，则使用：

```text
AGENT_PULSE_DATA_DIR
```

备份文件格式：

```text
<AgentPulse data dir>/backups/<backupId>-<encodedTargetPath>
<AgentPulse data dir>/backups/<backupId>-<encodedTargetPath>.meta.json
```

`.meta.json` 中记录：

```json
{
  "existedBefore": true,
  "filePath": "目标配置文件路径",
  "planId": "安装计划 ID",
  "createdAt": "备份创建时间"
}
```

`existedBefore` 的含义：

- `true`：目标文件原本存在，rollback 时恢复原内容。
- `false`：目标文件是 install 创建的，rollback 时删除该文件。

## 7. 回退配置修改

### 7.1 Web 控制台回滚

在 `Agents` 页面中，点击目标 agent 行的“回滚”。

后端会按当前 agent 查询最近一次已应用计划的备份，只回滚该 agent，不会回滚其它 agent 的最近备份。

回滚成功后，AgentPulse 会删除该 agent 的代理映射，避免配置已经恢复但 proxy 仍继续使用旧映射。

如果该 agent 没有可用备份，按钮会显示“无备份”或接口返回 `backup_not_found`。

回滚行为：

- 原文件存在：恢复备份内容。
- 原文件不存在：删除 install 创建的新文件。
- 缺少 `.meta.json`：兼容旧逻辑，按备份文件恢复。

### 7.2 CLI 回滚

回退最近一次已应用计划：

```powershell
pnpm --filter @agent-pulse/cli start -- rollback
```

回退行为：

- 如果原文件存在：复制备份内容覆盖回目标文件。
- 如果原文件不存在：删除 install 创建的新文件。
- 如果缺少 `.meta.json`：按旧逻辑复制备份内容恢复。

输出中重点查看：

- `ok`：回退是否成功。
- `restoredFiles`：已恢复的文件。
- `deletedFiles`：已删除的新建文件。
- `warnings`：无法恢复或无法删除的原因。

## 8. 验证代理是否生效

建议按以下顺序检查：

Web 控制台场景：

1. 在 `Agents` 页面点击“扫描”。
2. 确认目标 agent 的 `路由状态` 为“已代理”。
3. 使用对应 agent 发起一次模型请求。
4. 在 `Proxy` 页面查看代理请求记录。

CLI 场景：

1. 重新扫描：

```powershell
pnpm --filter @agent-pulse/cli start -- scan
```

确认对应工具的 `routeState.routed` 为 `true`。

2. 启动 AgentPulse 服务：

```powershell
pnpm --filter @agent-pulse/cli start -- start
```

3. 使用对应 agent 发起一次模型请求。

4. 查看代理请求记录：

```powershell
curl http://127.0.0.1:8080/api/proxy/requests
```

如果请求成功经过代理，应能看到对应 provider、method、path、status 和 duration。

## 9. 常见问题

### plan 只有 command.suggestion，没有 file.patch

说明 AgentPulse 没有可靠识别该工具的可写 base URL 字段。此时不会强行修改配置，需要人工检查工具配置 schema。

### install 后 verification.ok 为 false

说明配置文件写入后没有验证到预期代理地址。可能原因：

- 工具配置字段名称不符合当前 adapter 识别规则。
- 配置文件被其它进程修改。
- plan 对应的目标文件不是工具实际加载的配置文件。

可以先执行 rollback，再检查 scan 输出和配置文件内容。

### Web 页面点击替换后失败

常见原因：

- 当前配置文件 schema 无法识别，后端只生成了手动建议。
- 确认弹窗中展示的目标文件不可写。
- 写入后 verification 未检测到预期代理地址。

建议先查看该行 `提示` 字段，再执行 CLI `scan` 对照输出。

### Web 页面点击回滚后提示无备份

说明该 agent 没有已应用计划对应的备份。行级回滚不会回滚其它 agent 的备份，以避免误恢复错误配置。

### 工具请求没有出现在代理记录里

可能原因：

- AgentPulse 服务没有启动。
- 工具实际使用的是 OAuth/订阅账号通道。
- 工具没有加载被修改的配置文件。
- 工具请求使用了其它 provider 或环境变量覆盖了配置文件。

## 10. 安全注意事项

- AgentPulse 不会在计划摘要和 storage 中保存明文 API key、token、cookie、password。
- 修改第三方工具配置前必须生成 plan。
- 应用配置前必须备份。
- 回退优先使用备份和备份元数据恢复原状态。
- 对无法识别的配置 schema，不进行猜测写入。
