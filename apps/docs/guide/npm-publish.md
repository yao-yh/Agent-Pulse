# npm 发布

面向用户发布的包名是：

```text
@cashew-dev/agent-pulse
```

它提供命令：

```bash
agent-pulse start
```

## 发布前检查

```bash
pnpm install
pnpm build
pnpm test
pnpm pack:npm
```

## 发布

需要先登录有 `@cashew-dev` scope 发布权限的 npm 账号：

```bash
npm login
pnpm publish:npm
```

发布成功后，用户可以执行：

```bash
npm install -g @cashew-dev/agent-pulse
agent-pulse start
```
