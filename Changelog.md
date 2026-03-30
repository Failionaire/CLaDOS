# Changelog

All notable changes to CLaDOS will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0-alpha.2] — 2026-03-29

Correctness and hardening pass across the entire codebase. No new user-facing features; all changes close concrete bugs or tighten implementation fidelity against the v1 spec.

### Changed

#### Types (`orchestrator/types.ts`)
- Added `AgentRole` and `AgentTool` nominal types; `AgentRegistryEntry`, `AgentDispatchConfig`, and `AgentResult` now use them instead of bare `string`
- `Finding.status` is now required (was optional); `loadValidatorFindings()` normalises missing values to `'new'` so LLM output that omits the field doesn't break filter logic
- `ArtifactRecord` gains `created_at` and `agent` fields
- `SessionState` gains `updated_at`, written on every atomic state write
- `AgentResult` fields renamed to snake_case (`artifactPath` → `artifact_path`, `finalText` → `final_text`, etc.) for consistency with session state
- `GateResponse` narrowed to a discriminated union; `GateAction` derived from it via `GateResponse['action']` so it can never drift
- `ContractFinding` narrowed to a discriminated union; each variant carries exactly the fields its `type` implies
- `TestRunnerResult` refactored: shared fields extracted to `TestSuiteResult` base interface; `wrecker_tests` now extends `TestSuiteResult` (gains `skipped_count` and `duration_ms`)

#### Conductor (`orchestrator/conductor.ts`)
- `sanitizeJson`: slices to outermost `{…}` correctly, trimming trailing prose that LLMs sometimes append after the JSON value
- `wipExtForRole`: security agent no longer treated as JSON (it writes `.md`); only `validator`, `qa`, and `wrecker` get `.partial.json`
- `setBroadcast()` method added for late wiring of the WebSocket broadcast function after the server binds
- Startup now cleans orphaned WIP partial files, keeping only the one matching the current `in_progress_artifact_partial`
- All phase entry points: crash recovery now preserves `completed_agents`, `gate_revision_count`, and `unresolved_streak` from the existing checkpoint — agents that finished before a crash are not re-run, and the escape-hatch streak counter is not reset mid-revision-cycle
- Full-stack parallel engineers: skips any variant (`engineer-backend`, `engineer-frontend`) already in `completed_agents`
- Spec version drift detection (L-3) logged after the engineer run; frontend re-dispatch triggered if version drifted during parallel execution
- Removed unused `AGENTS_DIR` and `HAIKU_MODEL` imports

#### Session (`orchestrator/session.ts`)
- `uuid` imported statically instead of dynamically
- Per-project promise-chain mutex added to `SessionManager`; all state-mutating operations (`update`, `updateCheckpoint`, `recordTokens`, `registerArtifact`, `bumpSpecVersion`, `appendDecision`, `appendReasoning`) go through `mutateState()`, preventing concurrent read-modify-write races when parallel agents are running
- `read()` throws a descriptive error on JSON parse failure instead of propagating a raw `SyntaxError`
- `recordTokens()` now accumulates tokens for re-dispatched roles (revision cycles, retries) instead of replacing the previous record
- Running cost rounded to microdollar precision (6 decimal places) to prevent floating-point accumulation from causing the displayed total to diverge from per-agent sums
- `registerArtifact()` auto-increments `version` when overwriting an existing key
- `init()` writes `updated_at` alongside `created_at`

#### Budget (`orchestrator/budget.ts`)
- `calculateCostUsd()` throws on unknown model IDs instead of silently falling back to arbitrary Opus prices
- `checkPreDispatch()` re-reads state from disk on every call so that parallel dispatches (e.g. backend + frontend engineers) each see the latest spend total
- `checkSummarizerBudget()` applies the same 20% margin as agent dispatch projections for consistent accounting
- `nextPhaseEstimate()` omits agents with unavailable context data instead of using a zero-token placeholder; includes `system_prompt_tokens` in the input cost estimate to match the dispatch-path accounting

#### CLI (`orchestrator/cli.ts`)
- `readline` imported statically
- Project directory is now created **after** setup prompts complete — Ctrl+C during prompts no longer leaves an orphaned directory that blocks a subsequent `clados new`
- Session init failure cleans up the project directory (best-effort `rm -rf`)
- `runPipelineLoop()` extracted as a standalone function, eliminating the duplicated `while` loop between `isNew` and `resume` branches
- `process.once('SIGINT')` used instead of `process.on` to prevent handler stacking if `startServer` were ever re-called
- SIGINT handler adds a 3-second forced exit timeout to drain live WebSocket connections without hanging indefinitely
- Idea prompt re-prompts until non-empty input is given; project type selection emits a message on invalid input instead of silently defaulting
- Fatal error handler now prints the full stack trace

#### Logger (`orchestrator/logger.ts`)
- Logger constructor creates `.clados/` if it doesn't exist, preventing log write failures on projects where the directory hasn't been created yet
- `child(phase, agent)` method added: returns a bound logger with fixed context, safe for concurrent use by parallel agents (avoids the shared `setContext` race)
- Log rotation filename collision handled by adding a counter suffix if the rotated filename already exists

#### Semaphore (`orchestrator/parallel.ts`)
- Queue entries carry a `reject` callback for proper cancellation support
- `setSlots()` validates that `n >= 1`
- `withLock<T>(fn)` helper method added as a safer acquire+release pattern

#### Context management (`orchestrator/context.ts`)
- `TsParser` interface added; `getTypeScriptParser()` return type tightened
- Token estimation and summarizer calls use `SONNET_MODEL` / `HAIKU_MODEL` constants instead of hardcoded string literals
- `resolveContextArtifacts()` loads artifacts in parallel instead of serially
- Missing required artifacts now throw (previously they were silently skipped, masking pipeline logic errors)
- `COMPRESSED_TOKEN_ESTIMATE` constant (100 tokens) replaces the magic literal
- `injectVariables()` strips unreplaced `{{…}}` placeholders to prevent models from misinterpreting the template syntax (H-13)
- `passesStructuralMarkerTest()` JSON branch: parses the full normalised string instead of a regex-captured substring, eliminating false failures on valid JSON without a leading brace

#### Contract Validator (`agents/_subagents/contract-validator.ts`)
- `importMap` typed as `Map<string, string | null>`
- Route matching order corrected: `router.METHOD` is matched before `app.METHOD` to avoid false positives in composition files
- `resolveImportPath()` returns `null` for unresolvable relative paths instead of guessing a `.ts` extension; callers emit an `unresolved_import` finding

#### Test Runner (`agents/_subagents/test-runner.ts`)
- `npm install` uses `hostEnv` (PATH + `.env.test` only) instead of the full parent process environment, preventing CLaDOS secrets from leaking to postinstall scripts
- `parseTapLikeOutput()`: more robustly extracts JSON from stdout by slicing to the outermost `{…}` pair — handles Jest progress text printed before the JSON output
- `parsePlaywrightJsonOutput()` added; full-stack projects now invoke the Playwright CLI with `--reporter=json` and parse its output, instead of incorrectly using the Jest runner
- Docker health check uses structured JSON parsing of `docker compose ps` output to avoid false positives on container names that contain the word "healthy"
- Wrecker test result record gains `skipped_count` and `duration_ms` fields to match the `TestSuiteResult` base interface

#### Agent prompts
- **PM** (`agents/pm.md`): Inputs section reformatted as a phase-keyed table; Phase 3 task now starts from `03-api-spec-draft.yaml` (produced by Docs) rather than re-deriving the entire spec from source code
- **Architect** (`agents/architect.md`): Fix loop task section added — instructs the agent to correct only flagged files, not regenerate untouched ones
- **Engineer** (`agents/engineer.md`): Test user seeding constrained behind a `NODE_ENV !== 'production'` guard or a separate npm script — unconditional seeding in migrations is now explicitly prohibited; fix loop task section added
- **QA** (`agents/qa.md`): `getAuthToken()` is specified as a factory function (fresh token per call) rather than a module-level singleton; data isolation section added requiring tests to clean up created resources via `afterAll` deletion or unique per-run identifiers
- **DevOps** (`agents/devops.md`): Dockerfile multi-stage build corrected — production stage now creates a non-root user, runs `npm ci --omit=dev`, and copies from dist rather than inheriting node_modules; `docker-compose.yml` drops the obsolete `version:` key; CI workflow gains docker compose test service setup, health-wait, and teardown steps, conditional on whether the project has a database

#### UI
- **`App.tsx`**: Budget gate modal implemented — `budget:gate` WS events now display a modal with spend breakdown and Allow/Stop actions; event queue resets on `state:snapshot` so stale pre-disconnect events are not mixed with post-reconnect state
- **`AgentCard.tsx`**: Running animation changed from a bottom progress bar to a slow border colour cycle (matches the spec); model label shown on running and done cards; Retry/Skip button condition corrected — previously showed on `flagged` cards even when no handlers were passed
- **`Gate.tsx`**: `narrowView` now tracked reactively via a resize listener (was a static one-time read at render); drag-to-resize refactored to use stable closures captured at drag-start, preventing ghost event listeners; drag handle highlights on hover via React state; `ValidatorFindings` now receives `overrides` as a controlled prop; removed a CSS `&:hover` pseudo-class that has no effect in inline styles
- **`Topbar.tsx`**: Cost label hidden until Gate 1 completes; `PHASE_LABELS` moved to shared `constants.ts`; corrects the label "Planning" → "Architecture"
- **`ValidatorFindings.tsx`**: Override checkbox reads from the `overrides` prop passed by `Gate` (controlled state) instead of a nonexistent `finding.override` field
- **`constants.ts`** *(new)*: Shared `PHASE_LABELS` constant extracted from `Topbar`
- **`main.tsx`**: `ErrorBoundary` wraps the app root to catch React render errors with a diagnostic screen and a Reload button

### Removed
- `docs/fix-plan.md` — working notes, no longer needed

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
