# AgentPulse Agent Workflow

## Strong Implementation Workflow

- Before implementing concrete business code, update `doc/07-implementation-plan.md` with the intended implementation details.
- `doc/07-implementation-plan.md` must mirror the real business code folder structure. If a business directory is added, moved, renamed, or removed, update the document in the same change.
- Each documented business folder must state its responsibility, primary entry files, key public types or APIs, data flow, and test coverage expectations.
- Do not place tool-specific logic in `packages/core`; keep Codex, Claude Code, OpenCode, and future tool behavior inside integration adapters.
- Any configuration-changing feature must support plan, backup, apply, and rollback. Do not silently modify third-party tool configuration.
- Default to local-first storage and redact secrets by default. Never store cleartext API keys, tokens, cookies, passwords, or secret values.
- If proxy capture is changed, preserve streaming compatibility and avoid buffering the user-facing response path.

