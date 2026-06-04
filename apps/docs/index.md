---
layout: home

hero:
  name: AgentPulse
  text: 本地优先的 AI Agent 事件中心
  tagline: 统一观察 Codex、Claude Code、OpenCode 等工具的事件、配置代理、任务和通知。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: CLI 命令
      link: /guide/cli

features:
  - title: 本地优先
    details: 数据默认写入本机 SQLite，敏感字段在入库前脱敏。
  - title: 可回滚配置
    details: 所有配置变更都走 plan、backup、apply、rollback 流程。
  - title: 代理观测
    details: 本地代理记录脱敏摘要，同时保持流式响应兼容。
---
