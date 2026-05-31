# AgentPulse 文档索引

AgentPulse 首先是面向本地 AI Agent、AI CLI、AI Coding 工具链的任务进度通知与事件中心；在此基础上，逐步扩展本地能力盘点、请求代理、上下文分析、审计和插件治理能力。

本目录用于指导后续 AI 或工程师开发 AgentPulse。文档按职责拆分，建议按以下顺序阅读：

1. [需求文档](./01-requirements.md)
   - 项目定位
   - 用户目标
   - 核心功能
   - MVP 范围
   - 非目标

2. [架构文档](./02-architecture.md)
   - pnpm monorepo 结构
   - 核心模块职责
   - 事件模型
   - 插件模型
   - 数据流

3. [代理与集成方案](./03-proxy-and-integrations.md)
   - Hook、Proxy、Transcript 三层采集模型
   - 本地代理设计
   - Codex、Claude Code、OpenCode、Hermes、OpenClaw 等工具适配思路
   - 配置扫描、安装、备份、回滚流程

4. [风险、注意项与开发计划](./04-risks-and-roadmap.md)
   - 关键技术风险
   - 隐私和安全注意事项
   - 兼容性问题
   - 分阶段开发计划

5. [Skills 和 MCP 本地盘点方案](./05-skills-mcp-inventory.md)
   - 独立扫描当前 Agent 可加载的 skills、MCP servers、插件和配置
   - 对比 Agent 自报与本地文件系统事实
   - 支持后续分析 skills/MCP 是否被实际使用

6. [本地探针与判断工具层方案](./06-local-probes-layer.md)
   - 抽象系统判断、文件判断、命令判断、配置解析
   - 抽象 skill/MCP/plugin 判定能力
   - 为 inventory、integration、analyzer 提供统一本地事实判断能力

## 推荐项目名称

项目名称：`AgentPulse`

推荐命令：

```bash
agent-pulse scan
agent-pulse plan
agent-pulse install
agent-pulse start
agent-pulse rollback
```

## 一句话定位

AgentPulse 通过本地服务、工具 hook、通知渠道、Skills/MCP 本地盘点、请求代理、会话记录导入和插件机制，为 Codex、Claude Code、OpenCode、Hermes、OpenClaw 等本地 AI Agent 工具提供统一的任务进度通知、事件采集、能力清单审计、上下文分析和可视化管理能力。
