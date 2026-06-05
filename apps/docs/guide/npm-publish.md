# npm 发布

面向用户发布的包名是：

```text
@cashew-dev/agent-pulse
```

它提供命令：

```bash
agent-pulse start
```

## 发布策略

当前仓库使用 GitHub Actions 发布 npm 包：

- `CI`：对所有分支 push 和 Pull Request 执行文档结构检查、构建、测试和 npm 打包检查。
- `Publish npm package`：只允许发布 `origin/main` 已包含提交上的 `vX.Y.Z` tag；其他分支即使推送 tag，也会在发布前被阻断。

发布 tag 必须和 `apps/cli/package.json` 中的版本一致，例如版本是 `0.0.3` 时，tag 必须是 `v0.0.3`。

## 发布前检查

```bash
pnpm install
pnpm check:docs
pnpm build
pnpm test
pnpm pack:npm
```

## GitHub Actions 发布

推荐通过 npm Trusted Publishing 发布，不在 GitHub 中保存 npm token。

需要在 npm 上配置：

1. 登录 npm，确认账号或组织对 `@cashew-dev/agent-pulse` 有发布权限。
2. 进入 `@cashew-dev/agent-pulse` 包的 Trusted Publisher 设置。
3. 选择 GitHub Actions，配置仓库 `yao-yh/Agent-Pulse`。
4. Workflow 文件名填写 `npm-publish.yml`。
5. Environment 填写 `npm`。

发布一个新版本时：

1. 同步更新根 `package.json` 和 `apps/cli/package.json` 的 `version`。
2. 合并代码到 `main` 并确认 CI 通过。
3. 在 `main` 最新提交上创建并推送匹配版本的 tag。

```bash
git switch main
git pull origin main
git tag v0.0.3
git push origin v0.0.3
```

也可以在 GitHub Actions 页面手动运行 `Publish npm package`，输入已经存在的 tag。

## Token 备选方案

如果暂时不使用 Trusted Publishing，可以在 npm 创建 Automation token，然后在 GitHub 仓库配置 secret：

- 名称：`NPM_TOKEN`
- 值：npm Automation token

然后把 `.github/workflows/npm-publish.yml` 中的发布步骤改为带 `NODE_AUTH_TOKEN`：

```yaml
- name: Publish to npm
  working-directory: apps/cli
  run: npm publish --access public --provenance
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Token 不要写进仓库，不要提交到 `.npmrc`，也不要放在文档或 issue 中。

发布成功后，用户可以执行：

```bash
npm install -g @cashew-dev/agent-pulse
agent-pulse start
```
