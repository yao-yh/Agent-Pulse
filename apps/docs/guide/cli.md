# CLI 命令

所有命令都通过 `agent-pulse` 入口执行。

```bash
agent-pulse scan
agent-pulse inventory
agent-pulse plan
agent-pulse install
agent-pulse rollback
agent-pulse start
agent-pulse doctor
```

## scan

扫描本地 AI agent 集成和配置来源，不修改文件。

## inventory

扫描 skills、MCP servers、plugins 和配置来源。

```bash
agent-pulse inventory --skills
agent-pulse inventory --mcp
agent-pulse inventory --diff
```

## plan

生成配置变更计划，不写入第三方工具配置。

```bash
agent-pulse plan --scope workspace
agent-pulse plan --scope user --proxy-base-url http://127.0.0.1:8080
```

## install

应用最近生成的计划。默认只允许 workspace 范围；用户级配置需要显式确认。

```bash
agent-pulse install --scope user --yes
```

## rollback

回滚最近一次已应用计划的备份。

## start

启动本地服务、Web 控制台和 `/docs/` 使用文档。

## doctor

输出本地健康状态、集成扫描摘要和近期任务。
