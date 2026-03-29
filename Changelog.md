# Changelog

All notable changes to CLaDOS will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0-alpha] — 2026-03-29

Initial implementation of CLaDOS v1. Everything listed here is present in the codebase. Nothing listed in the v1 spec has been deferred — all scope items are accounted for and all out-of-scope items have been explicitly excluded.

### Added

#### CLI
- `clados new <name>` — creates project directory, runs interactive setup (idea, project type, agent loadout, spend cap), starts the Express server, opens the browser, and kicks off the pipeline
- `clados resume <name>` — reads existing session state, restarts the server, and resumes from the last gate or running agent
- SIGINT handler that writes in-flight `pipeline_status` to session state before exit, preserving crash recovery context
- `bin/clados.js` shebang stub registered as the `clados` binary in `package.json`

#### Orchestrator
- **Conductor** (`conductor.ts`) — deterministic TypeScript orchestration engine driving agents through the fixed 5-phase sequence (Concept → Architecture → Build → Document → Ship)
- **Phase 0 — Concept:** PM writes `00-concept.md`; Validator produces `00-validator.json`
- **Phase 1 — Architecture:** PM writes `01-prd.md`; Architect writes `01-architecture.md`, `01-api-spec.yaml`, `01-schema.yaml`; Engineer scaffolds `src/`, `infra/docker-compose.test.yml`, and `.env.test`; Validator produces `01-validator.json`
- **Phase 2 — Build:** Engineer (backend and frontend concurrently for full-stack) writes manifest + implementation + `test-context.json`; Contract Validator, QA Agent, and Test Runner run in parallel; optional Security Agent and Wrecker; Validator consolidates all findings into `02-build/validator.json`
- **Phase 3 — Document:** Docs agent writes `docs/README.md` and `docs/CHANGELOG.md`; PM writes `03-prd.md` and `03-api-spec.yaml`; Validator produces `03-validator.json`
- **Phase 4 — Ship:** DevOps writes Dockerfiles, `.github/workflows/ci.yml`, and `docs/runbook.md`; Validator produces `04-validator.json`
- Human approval gate between every phase (`approve | revise | abort | goto`)
- Revision counter per gate; after 3 unresolved consecutive revision cycles, the `conductor.reason()` escape hatch fires an Opus LLM call for strategic guidance; if the guided re-run still fails, a terminal gate forces a human decision
- Phase rollback (`goto`) archives all affected artifacts and phase state to `.clados/history/rollback-{ts}/` before resetting
- Per-agent error recovery: user-facing `retry` and `skip` actions (skip available only for `wrecker`, `security`, `docs`); exponential backoff retries at 2s / 8s / 30s before surfacing the error UI

#### Agent Registry
- `agent-registry.json` defining all 9 agents with model IDs, `context_artifacts`, `expected_output_tokens_per_turn`, `expected_tool_turns`, and `enabled_when` guards
- Default model: `claude-sonnet-4-20250514`; escalation model: `claude-opus-4-20250514` (Haiku `claude-haiku-3-5-20241022` for summarizer only)
- `isAgentEnabled()` evaluating `always | config.security | config.wrecker` with no expression parser
- Model escalation to Opus when `gate_revision_count ≥ 3` or `is_high_complexity` is set
- `system_prompt_tokens` populated at startup via `anthropic.beta.messages.countTokens` with `Math.ceil(chars / 3.5)` fallback

#### Agent System Prompts
- **PM** (`agents/pm.md`) — concept doc (Phase 0), full PRD with user stories and acceptance criteria (Phase 1), final PRD and canonical API spec reflecting the as-built codebase (Phase 3)
- **Architect** (`agents/architect.md`) — architecture doc, complete OpenAPI 3.0 spec, and structured DB schema (Phase 1); mandates `express-openapi-validator` middleware
- **Engineer** (`agents/engineer.md`) — Phase 1 scaffold; Phase 2 three-pass flow: pre-flight manifest → batched implementation with living manifest → `test-context.json`; supports `{{project_type}}` and `{{engineer_role}}` variable injection for full-stack bifurcation
- **QA** (`agents/qa.md`) — asymmetric context: reads PRD + OpenAPI spec + `test-context.json` only, no access to source code or schema; writes Supertest integration tests (backend/library/CLI) or Playwright e2e tests (full-stack) based on `project_type`
- **Validator** (`agents/validator.md`) — structured JSON findings (`must_fix | should_fix | suggestion`) with `finding_id` continuity across re-reviews; classifies prior findings as `resolved | partially_resolved | unresolved | new_discovery`; phase-specific validation guidance for all 5 phases
- **Security** (`agents/security.md`) — OWASP Top 10 threat model + dependency audit; enabled only when `security_enabled = true`; outputs `02-build/security-report.md`
- **Wrecker** (`agents/wrecker.md`) — adversarial edge-case tests targeting boundary conditions, auth bypass, race conditions, and sequence attacks; enabled only when `wrecker_enabled = true`; outputs `02-build/wrecker.json`
- **DevOps** (`agents/devops.md`) — multi-stage Dockerfile (non-root user), `.env.example`, `docker-compose.yml` for local dev, GitHub Actions CI pipeline, runbook; per-service Dockerfiles for full-stack projects
- **Docs** (`agents/docs.md`) — reads source code before writing; produces `docs/README.md`, `docs/CHANGELOG.md`, and `03-api-spec-draft.yaml`

#### Automated Subagents
- **Contract Validator** (`agents/_subagents/contract-validator.ts`) — deterministic TypeScript compiler API AST walk; cross-checks spec endpoints against route registrations in `src/index.ts`, following `app.use` compositions and import chains; emits `missing_route` and `undeclared_route` findings; outputs `02-build/contract-validator.json`
- **Test Runner** (`agents/_subagents/test-runner.ts`) — `npm install` → `docker compose up` with health check polling (60s timeout) → `.env.test` load → server startup via TCP probe (30s timeout) → test suite execution (120s default) → teardown; isolated server environment (env inherited from `.env.test` only, not parent process); parses Jest/Vitest JSON output with TAP fallback; supports `wreckerOnly` mode; outputs `02-build/test-runner.json`
- **Summarizer** (`agents/_subagents/summarizer.md`) — Haiku-tier side-call producing ≤150-word prose summaries of files for context compression

#### Context Management
- Two-tier artifact context injection: `required` artifacts in full, `reference` artifacts as compressed summaries
- 80K token context threshold with downgrade cascade: `reference` → Haiku summaries first, then `required` → summaries with `read_file` note injected; all downgrades logged to session state
- Tree-sitter AST export extraction (`extractTypeScriptExports()`) for structural context; graceful fallback to empty string if `tree-sitter` is unavailable
- Haiku semantic summarizer for intent + structure combined summaries (`summarizeFile()`)
- 5% summarizer budget cap to prevent token-on-token spending spirals
- `injectVariables()` replacing `{{variable_name}}` placeholders in system prompts
- `validateSystemPromptSections()` enforcing required sections (Identity, Inputs, Task, Output schema, Constraints) at startup

#### Session State
- `SessionManager` (`orchestrator/session.ts`) with atomic JSON writes via `write-file-atomic`
- Full `SessionState` schema: pipeline status, config, phase checkpoint, per-agent token usage indexed by phase and role, running `total_cost_usd`, `conductor_decisions`, `conductor_reasoning`, `dependency_divergences`, validator tier, artifact registry
- `PhaseCheckpoint` tracking `completed_agents`, `in_progress_agent`, `in_progress_artifact_partial`, `gate_revision_count`, `unresolved_streak`
- Artifact archival to `.clados/history/` with version suffix before overwrite
- `bumpSpecVersion()` for API spec divergence tracking during revision cycles
- Orphaned `.tmp` file cleanup on startup

#### Crash Recovery
- On startup with `agent_running` status: structural marker test on WIP partial to determine if output can continue mid-stream or must restart clean
- `crashRecoveryPrefix` map injected into the re-dispatched agent call
- Crash before first write (no WIP file): marker test trivially fails, agent restarts clean — treated as normal, not an error

#### Budget Management
- `BudgetManager` (`orchestrator/budget.ts`) with pricing table for Sonnet, Opus, and Haiku
- Pre-dispatch cost projection: `(context_tokens + expected_output_tokens × expected_tool_turns) × price × 1.2` margin
- `BudgetGate` error thrown before dispatch (never mid-stream) when projected cost would exceed remaining cap
- Budget gate UI: shows current spend, breaching agent, inline cap-raise field, option to disable optional agents
- Per-phase cost estimate injected into gate header for next-phase spend preview

#### Rate Limiting and Parallelism
- `Semaphore` (`orchestrator/parallel.ts`) with `setSlots()` for dynamic capacity changes; default 3 concurrent Claude API calls
- `RollingTpmTracker` 60-second rolling TPM window; semaphore reduces to 1 slot when TPM exceeds 80% of the `rate_limit_tpm` limit (default 80,000)

#### Logging
- `Logger` (`orchestrator/logger.ts`) writing structured JSON log entries to `.clados/run.log` with phase/agent context
- Auto-rotation at 10 MB
- Errors and warnings mirrored to `stderr`

#### Server
- Express + WebSocket server (`orchestrator/server.ts`) serving the compiled React SPA from `ui/dist/`
- `findFreePort()` probing ports 3100–3199
- REST endpoints: `POST /gate/respond`, `GET /project/state`, `GET /project/artifact` (path traversal guard: resolved path must be within `.clados/`), `POST /agent/retry`, `POST /agent/skip`, `POST /budget/update`
- WebSocket on `/ws`: broadcasts all `WsServerEvent` types; sends `state:snapshot` on connect for UI resynchronisation

#### React UI
- **`useWebSocket.ts`** — auto-reconnecting hook; 5-second retry interval; gives up after 5 failures (`failed` state); exposes `connectionStatus`, `sessionState`, `lastEvent`
- **`Topbar.tsx`** — project name, 5 phase progress chips (active/done styling), running cost chip with hover breakdown, reconnection banner, "Review ↑" button when gate is pending
- **`KanbanBoard.tsx`** — 5-column Kanban (one column per phase); collapse toggle per column persisted to `localStorage`; derives `AgentCardState` from WS event stream
- **`AgentCard.tsx`** — status-coded styles (pending, running, done, flagged, error, skipped); animated progress bar on running cards; token in/out counts and cost on done cards; Retry/Skip buttons on error cards; `contextCompressed` indicator
- **`Gate.tsx`** — bottom-drawer gate panel; drag-to-resize handle (height persisted to `localStorage`); three-column layout (artifact | revision note | findings) with tab toggle below 1100px; `must_fix` block on Approve until individually overridden; revision count badge with amber/red thresholds; `Goto Gate N` and `Abandon Project` in `...More` dropdown
- **`ArtifactViewer.tsx`** — format detection: `.md` → `react-markdown`; all other types → monospace `<pre><code>` block
- **`ValidatorFindings.tsx`** — sorted findings list (must_fix → should_fix → suggestion); Override checkbox per finding; resolved findings dimmed

#### TypeScript Types
- Shared `orchestrator/types.ts` defining `SessionState`, `SessionConfig`, `PhaseCheckpoint`, `Finding`, `AgentRegistryEntry`, `AgentDispatchConfig`, `AgentResult`, `WsServerEvent` union, `GateResponse`, `ContractValidatorResult`, `TestRunnerResult`, `LogEntry`
- `ui/src/types.ts` mirroring orchestrator types with additional `AgentCardState` for UI-specific per-card tracking

### Out of Scope (explicitly deferred to post-v1)

The following items are documented in `docs/CLaDOS-Goal.md` but do not ship in v1:

- Configurable workflow DAG / condition DSL / `workflow-graph.json`
- Custom agent framework (`clados agent add`)
- Interactive Mode (post-deployment chat with AST-aware context)
- IDE bridge (file watchers, deep-link URIs)
- Artifact version pinning UI
- CLI subcommands (`clados logs`, `clados model-update`)
- Refiner agent
- Multi-language / multi-stack support
- Micro-pivots (`request_architecture_change` tool call during Build)
- Agent questions / `{phase}-questions.json` / autonomy mode
- Budget band UI
- Decisions panel UI
