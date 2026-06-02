# AgentPulse

AgentPulse is a local-first event center for AI agent tools. It provides hook ingest, local inventory scanning, install plans with backup/rollback, a basic OpenAI/Anthropic-compatible proxy, notification channels, and a small web console.

## Quick Start

```bash
pnpm install
pnpm build
pnpm --filter @agent-pulse/cli start -- scan
pnpm --filter @agent-pulse/cli start -- inventory
pnpm --filter @agent-pulse/cli start -- start
```

Open `http://127.0.0.1:8080` after starting the server.

If `better-sqlite3` native bindings are missing after install, run:

```bash
$dir=(Get-ChildItem node_modules\.pnpm -Directory -Filter 'better-sqlite3@*' | Select-Object -First 1).FullName + '\node_modules\better-sqlite3'
npm run install --prefix $dir
```

## CLI

```bash
agent-pulse scan
agent-pulse inventory
agent-pulse plan
agent-pulse install
agent-pulse rollback
agent-pulse start
agent-pulse doctor
```

`install` defaults to workspace scope. User-level changes require explicit confirmation flags in the implementation path.

For Chinese CLI and Web Console usage instructions about routing Codex, Claude Code, and OpenCode through the local AgentPulse proxy, see `doc/08-agent-proxy-config-usage.md`.

## Local APIs

- `GET /api/health`
- `POST /ingest/hook/:integration/:event`
- `GET /api/events`
- `GET /api/tasks`
- `GET /api/inventory`
- `POST /api/inventory/scan`
- `ANY /proxy/openai/*`
- `ANY /proxy/anthropic/*`

Example hook:

```bash
curl -X POST http://127.0.0.1:8080/ingest/hook/codex/session.start ^
  -H "content-type: application/json" ^
  -d "{\"eventId\":\"demo\",\"sessionId\":\"demo\",\"title\":\"hello\"}"
```

## Development

```bash
pnpm build
pnpm test
pnpm check:docs
```

## Dependency Policy

Dependencies are kept as new as possible while preserving the current local runtime target, Node.js `20.9.x`. Some absolute latest packages are intentionally not used because their engines require Node.js `20.19+` or `22.12+`:

- `vite` stays on `6.4.x`; Vite `7+` / `8+` requires Node `20.19+` or `22.12+`.
- `@vitejs/plugin-react` stays on `4.7.x`; `5+` requires Node `20.19+` or `22.12+`.
- `commander` stays on `14.x`; `15+` requires Node `22.12+`.

Concrete implementation details live in `doc/07-implementation-plan.md`; keep that file synchronized with the real business directory structure as required by `AGENTS.md`.
