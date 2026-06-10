# AgentPulse Implementation Plan and Code Structure

This file is the implementation index for AgentPulse. It must stay aligned with the real business code folder structure whenever business folders are added, moved, renamed, or removed.

## Root Configuration

- Responsibility: workspace orchestration, shared TypeScript settings, package scripts, and documentation structure checks.
- Primary files: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`, `AGENTS.md`, `.github/workflows/*.yml`, `scripts/check-doc-structure.mjs`, `scripts/check-release-version.mjs`.
- Public APIs: root scripts `build`, `test`, `dev`, `start`, `agent-pulse`, `check:docs`; publish helper scripts for the npm package.
- Data flow: root scripts delegate work to apps and packages through pnpm filters and Turbo; GitHub Actions runs CI on all branch pushes and Pull Requests, while npm publishing is limited to version-matching `vX.Y.Z` tags whose commits are already reachable from `origin/main`.
- Test coverage expectations: root build/test/check scripts must validate all business packages and the implementation-plan structure.

## apps/cli

- Responsibility: provide the `agent-pulse` command and the publishable user-facing npm package.
- Primary files: `src/index.ts`, `package.json`.
- Public APIs: commands `scan`, `inventory`, `plan`, `install`, `rollback`, `start`, `doctor`, and `--version`; npm bin `agent-pulse`.
- Data flow: CLI calls inventory, installer, storage, and server modules. `start` launches the Fastify app and resolves packaged Web/docs static assets before listening.
- Test coverage expectations: version/help output, read-only scan/inventory/plan behavior, backup/apply/rollback semantics, and packaged `agent-pulse start` serving the console and docs.

## apps/server

- Responsibility: local Fastify service, API surface, proxy routes, SSR/static serving for the Web console, and static serving for the documentation site.
- Primary files: `src/index.ts`, `src/app.ts`.
- Public APIs: `/api/health`, hook ingest, events/tasks/sessions, inventory, install plans, agents scan/replace/rollback, proxy capture list/detail/session summaries, notification test, `/docs/` static documentation, and SSR fallback for the console.
- Data flow: API requests write to storage, analyzers label risk, channels send notifications, proxy routes forward traffic without buffering streaming responses, and static requests read built assets.
- Test coverage expectations: health, hook idempotency, inventory scan, agents plan/backup/apply/rollback, proxy passthrough including streaming compatibility, proxy request detail lookup, docs static route, and SSR fallback.

## apps/web

- Responsibility: local operational Web console.
- Primary files: `src/entry-client.tsx`, `src/entry-server.tsx`, `src/Root.tsx`, `src/App.tsx`, `src/styles.css`.
- Public APIs: user-facing pages Agents, Sessions, Events, Tasks, Inventory, Plans, Proxy request list/detail, Notifications, Doctor, plus a documentation link to `/docs/`.
- Data flow: the browser talks to `/api/*` only; it does not read local files directly. Sessions page reads proxy session summaries, then filters proxy request captures by selected `sessionId`. Proxy detail views show request body and response content from redacted captures while suppressing captured headers in the UI. The server renders the initial shell and the client hydrates with TanStack Query.
- Test coverage expectations: Vite client build, Vite SSR build, primary page rendering, Sessions page rendering with proxy-session selection, Proxy detail drawer rendering, empty states, and the documentation link.

## apps/docs

- Responsibility: VitePress usage documentation for installation, startup, Web console workflows, CLI commands, proxy configuration, and safe rollback.
- Primary files: `index.md`, `guide/*.md`, `.vitepress/config.ts`, `package.json`.
- Public APIs: built static site under `/docs/` when served by `agent-pulse start`; local docs dev server through the package `dev` script.
- Data flow: markdown files build into `.vitepress/dist`; the server serves that directory as static assets without touching local user configuration.
- Test coverage expectations: VitePress build succeeds and links resolve for the main guide pages.

## packages/core

- Responsibility: standard types, state models, IDs, timestamps, and redaction utilities.
- Primary files: `src/index.ts`.
- Public APIs: `AgentEvent`, `TaskStatus`, `InstallPlan`, inventory item types, probe result types, `newId`, `nowIso`, `redactSecrets`, `stableId`.
- Data flow: shared by server, storage, inventory, integrations, installer, proxy, and analyzers.
- Test coverage expectations: event normalization helpers, ID generation, task state derivation, and secret redaction. Tool-specific logic must not live here.

## packages/storage

- Responsibility: local-first SQLite-compatible storage and schema initialization using pure JS/WASM dependencies for npm install compatibility.
- Primary files: `src/index.ts`.
- Public APIs: `createStorage`, `AgentPulseStorage`, event/task/session/proxy list/detail/session-summary/inventory/install-plan/backup/settings methods.
- Data flow: CLI, server, installer, inventory, and proxy share the same storage API. Proxy captures may carry a normalized `sessionId` extracted by integration adapters before persistence. Secrets are redacted before persistence.
- Test coverage expectations: schema initialization and additive migrations, idempotent event writes, backups, inventory upsert, proxy detail retrieval including session IDs, proxy session summaries, route mappings, and queries for latest applied backups.

## packages/probes

- Responsibility: read-only local fact probes.
- Primary files: `src/index.ts`.
- Public APIs: filesystem/config/skill/MCP/secret/process probe helpers.
- Data flow: inventory, integrations, and installer gather facts through probes rather than duplicating environment checks.
- Test coverage expectations: skill discovery, MCP config extraction, secret-field redaction, and command existence checks.

## packages/inventory

- Responsibility: scan local skills, MCP servers, plugins, and config sources.
- Primary files: `src/index.ts`.
- Public APIs: `scanInventory`, `diffInventory`.
- Data flow: pulls config source declarations from integration adapters, probes metadata, and writes sanitized results to storage.
- Test coverage expectations: workspace/user/global source discovery, missing-path warnings, and no cleartext secret storage.

## packages/integrations

- Responsibility: tool integration adapters and shared adapter helpers.
- Primary files: `src/index.ts`, `src/types.ts`, `src/adapters/*`, `src/helpers/*`.
- Public APIs: adapter registry, scan/plan/verify helpers, proxy-route profiles.
- Data flow: each adapter owns its tool-specific config discovery and patching logic; installer consumes standard plans and proxy profiles.
- Test coverage expectations: Codex TOML patching, Claude JSON/JSONC patching, OpenCode provider patching, registry behavior, route-state verification, and command-suggestion fallback.

## packages/installer

- Responsibility: scan, plan, backup, apply, verify, and rollback configuration changes.
- Primary files: `src/index.ts`.
- Public APIs: `scan`, `planInstall`, `applyInstall`, `rollbackLatest`, `rollbackIntegration`.
- Data flow: configuration changes must always follow plan -> backup -> apply -> verify, and rollback restores or deletes files based on backup metadata.
- Test coverage expectations: plan side-effect freedom, backup metadata, apply verification, rollback restoration/deletion, and integration-scoped rollback.

## packages/proxy

- Responsibility: local proxy under `/proxy/{proxyKey}/*`.
- Primary files: `src/index.ts`, `src/serializers.ts`, `src/parsers.ts`.
- Public APIs: `registerProxyRoutes`.
- Data flow: requests resolve route mappings from storage, preserve method/path/query/headers/body, select a request serializer by API protocol plus model/provider hint, extract agent-specific request metadata such as Claude Code session IDs and prompt parts, forward to upstream, stream user-facing responses directly, select a response parser by agent plus MAJOR.MINOR version, and store redacted request/response detail captures for Web console context views. Serializer parents cover OpenAI-compatible and Anthropic-compatible defaults; model-company subclasses such as GPT/ChatGPT, DeepSeek, and GLM can override only when special request serialization is needed, otherwise they inherit default behavior. Parser classes are agent-specific and version-aware, with latest-version fallback when no exact MAJOR.MINOR match exists; future dynamic parser loading can be added at the parser registry boundary without changing the proxy route handler. Claude Code request metadata parsing reads `body.metadata.user_id.session_id`, including the case where `user_id` is itself a JSON string, and normalizes that value onto the proxy request record as `sessionId` while preserving redacted body capture. Claude Code prompt parsing summarizes request body content into `promptParts` for system, user, assistant, tool call/result, MCP call/result, and skill references; raw body capture remains the source of truth. Request capture uses the actual forwarded body and stores the full redacted request body without the display-length cap; captured headers and response bodies remain separately bounded so oversized metadata cannot hide request body or response content in the UI. Non-stream text/JSON responses capture redacted body detail; SSE responses keep the user-facing stream on a cheap passthrough path by buffering only bounded raw response bytes during streaming, then parse and insert the structured model/usage/thinking/text/tool-call summary after the stream finishes; usage token counts are preserved while secret-bearing token fields remain redacted; binary responses capture metadata only.
- Test coverage expectations: mapping hits, unknown-key 404, protocol/model serializer selection and fallback, Claude Code request session extraction from object and JSON-string `metadata.user_id`, Claude Code prompt-part extraction for system/user/assistant/tool/MCP/skill categories, agent MAJOR.MINOR parser selection and latest fallback, non-stream request/response detail captures, raw request body capture, full redacted request body capture for oversized inputs, SSE/chunked passthrough with deferred structured model/usage/thinking/text/tool-call extraction and preserved usage counts, upstream 4xx/5xx passthrough, local 502 handling, sensitive header/body redaction, and response/header truncation that never stores cleartext secrets.

## packages/channels

- Responsibility: notification channels.
- Primary files: `src/index.ts`.
- Public APIs: webhook and Windows notification sender through `sendNotification`.
- Data flow: server asks channels to send notifications and stores the result in storage.
- Test coverage expectations: webhook payload, timeout/error behavior, and Windows notification fallback.

## packages/analyzers

- Responsibility: basic event and request analysis.
- Primary files: `src/index.ts`.
- Public APIs: `analyzeEvent`.
- Data flow: server ingest/proxy capture calls analyzers and stores analysis results and risk levels.
- Test coverage expectations: API-key pattern recognition, dangerous command recognition, normal low-risk events, and failure categorization.

## plugins

- Responsibility: MVP placeholder for example plugin content; no untrusted dynamic plugins are loaded at runtime.
- Primary files: plugin directories when present.
- Public APIs: none for runtime.
- Test coverage expectations: directory presence only unless plugin runtime loading is intentionally introduced.
