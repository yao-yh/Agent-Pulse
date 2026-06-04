# 安全与回滚

AgentPulse 默认本地优先，敏感信息默认脱敏。

## 不保存明文秘密

API keys、tokens、cookies、passwords 等敏感值不应以明文存储。事件、代理请求和 inventory 结果进入本地存储前需要脱敏。

## 不静默修改配置

第三方工具配置只能在用户明确执行 apply 或页面确认后修改。任何配置变更功能都必须保留 plan、backup、apply、rollback 能力。

## 回滚语义

如果目标文件原本存在，回滚会恢复备份内容。如果目标文件是本次 apply 创建的，回滚会删除该文件。
