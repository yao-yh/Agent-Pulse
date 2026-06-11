# AgentPulse Agent Workflow

## Strong Implementation Workflow

- Before implementing concrete business code, update `doc/02-架构/02-实现计划与代码结构.md` with the intended implementation details.
- `doc/02-架构/02-实现计划与代码结构.md` must mirror the real business code folder structure. If a business directory is added, moved, renamed, or removed, update the document in the same change.
- Each documented business folder must state its responsibility, primary entry files, key public types or APIs, data flow, and test coverage expectations.
- After implementation, complete the following documentation workflow:
  1. Finish and verify the code changes.
  2. Update the relevant design documents under `doc/` to reflect the actual implementation.
  3. If the changes affect user-visible interactions or operating procedures, update the relevant usage documentation under `apps/docs/`.
- Do not place tool-specific logic in `packages/core`; keep Codex, Claude Code, OpenCode, and future tool behavior inside integration adapters.
- Any configuration-changing feature must support plan, backup, apply, and rollback. Do not silently modify third-party tool configuration.
- Default to local-first storage and redact secrets by default. Never store cleartext API keys, tokens, cookies, passwords, or secret values.
- If proxy capture is changed, preserve streaming compatibility and avoid buffering the user-facing response path.

