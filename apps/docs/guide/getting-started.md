# 快速开始

AgentPulse 提供本地 Web 控制台和 `agent-pulse` 命令，用来观察 AI 编程工具事件、扫描本地配置，并安全地把工具请求路由到本地代理。

## 本地开发启动

```bash
pnpm install
pnpm build
pnpm --filter @cashew-dev/agent-pulse start -- start
```

启动后打开：

- 控制台：`http://127.0.0.1:8080`
- 使用文档：`http://127.0.0.1:8080/docs/`

## npm 安装启动

发布后可以这样安装和启动：

```bash
npm install -g @cashew-dev/agent-pulse
agent-pulse start
```

默认监听 `127.0.0.1:8080`。可以通过环境变量或参数调整：

```bash
agent-pulse start --host 127.0.0.1 --port 8090
```

## 常用流程

1. 运行 `agent-pulse start` 打开本地服务。
2. 在 Web 控制台进入 Agents 页面，点击扫描。
3. 查看计划和目标配置文件，确认后再替换工具配置。
4. 如需恢复，使用页面上的回滚按钮，或运行 `agent-pulse rollback`。
