# Changelog

All notable changes to CLaDOS will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0-alpha.6] — 2026-04-02

Massive multi-version implementation pass — V2 operational polish, V3 extensibility, and V4 lifecycle features implemented in one batch. Also implements the risk mitigations from the gap analysis (doctor command, troubleshooting guide, stack profiles).

### Added

#### V2 — Operational Polish

##### Micro-pivots during Build
- **`orchestrator/micro-pivot.ts`** *(new)* — handles architecture change requests mid-Build; enforces 3-pivot-per-phase cap; creates/updates `MicroPivot` records in session state
- **`ui/src/components/MicroGate.tsx`** *(new)* — compact approval modal for Engineer-requested architecture changes; shows change request (left) and Architect diff (right); Approve/Reject with rejection reason textarea
- Engineer's `request_architecture_change` tool call is now handled by the Conductor: pauses the Engineer, dispatches the Architect, opens the MicroGate, then resumes with context encoding the outcome
- `micro_pivots: MicroPivot[]` added to `SessionState`; `WsMicroGateOpen` and `MicroGateResponse` added to WS event union

##### Decisions Panel
- **`ui/src/components/DecisionsPanel.tsx`** *(new)* — right-side overlay (400px, scrollable) showing chronological log of `conductor_decisions`, `conductor_reasoning`, and `agent_questions` entries; color-coded by type (blue = autonomous, amber = conductor.reason(), green = user answers); triggered by "Decisions" chip in Topbar

##### Budget Band
- **`ui/src/components/BudgetBand.tsx`** *(new)* — expandable budget band replacing the old inline budget gate notification; shows current spend vs cap with percentage bar, which agent would breach and by how much, inline cap-raise field, and toggles to disable optional agents for the remainder of the run; collapses inline rather than blocking the gate

##### Agent Questions and Guided Mode
- **`ui/src/components/QuestionGate.tsx`** *(new)* — unified question display for both discovery gates (Phase 0 two-pass flow) and agent question gates (V2 guided mode); questions shown with default assumptions as placeholder text; "Looks good" fast path accepts all defaults
- **Discovery gate** added to Phase 0 — PM first writes `00-discovery.md` (understanding + clarifying questions + default assumptions); Conductor opens a discovery gate before the main concept pass; skipped automatically when the idea text exceeds 200 words
- **Agent questions** — agents can emit `{phase}-questions.json` before their main artifact; Conductor detects the file and opens a question gate in Guided mode, or uses defaults and logs them in Autonomous mode
- `autonomy_mode: 'guided' | 'autonomous'` added to `SessionConfig`; toggle on HomeScreen
- `agent_questions: AgentQuestion[]` added to `SessionState`
- `discovery_answers?: Record<string, string>` added to `SessionState`
- New WS events: `WsDiscoveryGateOpen`, `WsQuestionGateOpen`; new REST endpoints `POST /gate/discovery/respond`, `POST /gate/question/respond`

##### Refiner Agent
- **`agents/refiner.md`** *(new)* — surgical `should_fix`/`suggestion` auto-fixer; runs after Validator in Phase 2, before Gate 3; reads Validator findings, applies one-finding-one-change fixes, reports changes to `02-build/refiner.json`; never touches `must_fix` findings
- Enabled when `config.refiner` is set; toggle added to HomeScreen; registered in `agent-registry.json`

##### Artifact Version Pinning
- **`ui/src/components/VersionDropdown.tsx`** *(new)* — version history dropdown on artifact links; reads from `.clados/history/`; "Use this version" action copies content to current, increments version, logs rollback, re-opens the gate
- `POST /artifact/revert` REST endpoint added

##### CLI Subcommands
- **`orchestrator/cli/logs.ts`** *(new)* — `clados logs [dir] [--agent X] [--phase N] [--event X] [--since ISO] [--errors] [--raw]`; filtered views of `.clados/run.log`
- **`orchestrator/cli/model-update.ts`** *(new)* — `clados model-update [--apply]`; re-resolves model aliases from `_model_reference` in `agent-registry.json`, shows a diff, and optionally writes updates

---

#### V3 — Extensibility

##### Configurable Workflow DAG
- **`orchestrator/graph-engine.ts`** *(new)* — reads a `WorkflowGraph` JSON and drives phase transitions; evaluates `skip_when` conditions using a safe string DSL (no `eval`); supports `==`, `!=`, `>`, `>=`, `<`, `<=`, `in` operators against session state fields
- **`orchestrator/graph-validator.ts`** *(new)* — startup validation: DFS cycle detection, dangling `next` references, condition string parsing, terminal node uniqueness
- **`orchestrator/workflow-graph.default.json`** *(new)* — default graph encoding the V1/V2 phase sequence; functionally identical to the hardcoded conductor
- **`orchestrator/cli/workflow.ts`** *(new)* — `clados workflow show [graph.json]` prints phases and agents as a table; `clados workflow validate [graph.json]` runs the graph validator and exits with code 1 on failure
- `WorkflowGraph`, `WorkflowNode`, `AgentStep` types added to `orchestrator/types.ts`

##### Custom Agent Framework
- **`orchestrator/cli/agent.ts`** *(new)* — `clados agent add --name <n> --mode reviewer|agent --phase N`; `clados agent list`; `clados agent remove <name>`; `clados agent test <name> [dir]`; scaffolds `agents/custom/` prompts and registers in `agent-registry.json`
- **`orchestrator/findings-adapter.ts`** *(new)* — converts freeform markdown from reviewer-mode custom agents to structured `Finding[]` via a Haiku extraction call; called by Conductor when a custom reviewer's output doesn't parse as JSON
- `custom_phase`, `reviewer_mode`, `custom` fields added to `AgentRegistryEntry`

##### IDE Bridge
- **`orchestrator/file-watcher.ts`** *(new)* — watches `.clados/wip/` and project `src/` for external changes using `fs.watch` with 500ms debounce; emits `FileChangeEvent` via callback; gate UI shows a banner when files change externally while a gate is open
- `editor_uri_scheme` config field (default: `vscode`) added to `SessionConfig`
- Validator findings now include `vscode://file/...` deep-link URIs when the referenced file and line are known

##### Multi-language Support
- **`orchestrator/executors/`** *(new directory)* — language-agnostic `TestExecutor` interface + per-language implementations:
  - `node-executor.ts` — existing `npm test` + Jest/Vitest JSON parsing (extracted from test-runner.ts)
  - `python-executor.ts` — `pytest --json-report` in a virtualenv; Docker health check for FastAPI apps
  - `go-executor.ts` — `go test -v -count=1 ./...`; parses `--- PASS/FAIL/SKIP` output
  - `test-executor.ts` — shared `TestExecutor` interface and `TestResult` type
  - `index.ts` — `getExecutor(language)` factory function
- **`orchestrator/parsers/`** *(new directory)* — per-framework route parsers for contract validation:
  - `route-parser.ts` — `RouteParser` interface + `walkSourceFiles()` helper
  - `express-parser.ts` — existing Express AST walk (extracted from contract-validator.ts)
  - `fastapi-parser.ts` — FastAPI/Starlette decorator regex parser for `.py` files
  - `gin-parser.ts` — Gin `router.GET/POST/...` call parser for `.go` files
  - `index.ts` — `getParser(framework)` factory
- **`stacks/`** *(new directory)* — language-specific idiom reference files injected as `{{language_context}}` into agent prompts:
  - `typescript.md` — Express, Prisma, Supertest patterns
  - `python.md` — FastAPI, SQLAlchemy, pytest patterns
  - `go.md` — Gin, GORM, go test patterns
  - `rust.md` — Axum patterns (reference only; executor/parser not yet implemented)
- `language` field (`'typescript' | 'python' | 'go'`) added to `SessionConfig` and HomeScreen project-creation form
- AST extraction uses `tree-sitter-python` / `tree-sitter-go` when `language !== 'typescript'`; `pyright`/`gopls` as LSP fallbacks

---

#### V4 — Lifecycle Completion

##### Interactive Mode
- **`orchestrator/interactive.ts`** *(new)* — `InteractiveSession` class; chat agent with AST-aware workspace context; `propose_diff` tool forces user approval before any file write; conversation history maintained per session; workspace summary re-built from current file tree on each session start
- **`agents/interactive.md`** *(new)* — interactive agent system prompt; tools: `read_file`, `write_file` (via `propose_diff`), `list_files`, `propose_diff`; rules: surgical changes only, always propose before writing, cite Validator finding IDs
- **`ui/src/components/InteractiveChat.tsx`** *(new)* — chat interface visible when `pipeline_status === 'complete'`; renders assistant markdown with diff highlighting for `propose_diff` tool calls; Accept/Reject buttons on pending diffs
- New REST endpoints: `POST /interactive/message`, `POST /interactive/apply-diff`, `GET /interactive/history`
- `WsInteractiveStream` and `WsInteractiveDiff` events added to WS union

##### Re-invocation Workflow
- **`orchestrator/delta-detector.ts`** *(new)* — classifies a change description against the current project state using a Haiku LLM call; returns `{ entry_phase: 0–4, reasoning }` advisory classification
- **`orchestrator/cli/continue.ts`** *(new)* — `clados continue <project-dir> [change description]`; validates project is `complete`, prompts for description if omitted, runs delta detection, starts the server, opens the UI with a re-invocation gate
- **`ui/src/components/ReinvocationGate.tsx`** *(new)* — pre-invocation confirmation modal; shows detected entry phase + reasoning + affected artifacts; user can override to any phase; confirms before pipeline restart
- Prior phase artifacts carried over as context; amended PRD and architecture diff shown explicitly at gates
- `re_invocation_history` added to `SessionState`

---

#### Risk Mitigations (from gap analysis)

- **`orchestrator/doctor.ts`** *(new)* — `clados doctor [dir]`; validates session state JSON parse, SHA-256 checksum, phase/agent index bounds, artifact file existence, and budget arithmetic; exits 0 on clean, 1 on issues; also callable via `formatDoctorResult()` from the CLI
- SHA-256 state checksum written alongside every atomic state write; verified on startup resume; clear error thrown and resume refused on mismatch rather than silently loading corrupt state
- **`docs/Troubleshooting.md`** *(new)* — operator runbook covering the 10 most common failure modes with step-by-step fixes; ActivityLog error messages now include an inline "How to fix" hint for the most common error types
- **`orchestrator/cli/template.ts`** *(new)* — `clados template list`; `clados template use <name>`; `clados template save <name> [dir]`; built-in templates for `typescript-api`, `typescript-fullstack`, `python-fastapi`, `go-gin-api`; user templates stored in `~/.clados/templates/`
- **`orchestrator/cli/cost.ts`** *(new)* — `clados cost <dir>`; detailed per-phase, per-agent cost breakdown with input/output token separation; revision cycle cost analysis; context compression savings estimate; re-invocation history costs

### Changed

#### Orchestrator
- **`orchestrator/cli.ts`** — subcommand routing extended: `doctor`, `logs`, `model-update`, `workflow`, `agent`, `continue`, `template`, `cost`, `help`; `--help` flag supported
- **`orchestrator/conductor.ts`** — Phase 0 split into discovery pass + concept pass; Engineer tool list gains `request_architecture_change`; Refiner dispatched after Validator in Phase 2 when enabled; micro-pivot handling wired to `micro-pivot.ts`; `graph-engine.ts` used when `workflow-graph.json` is present in project root (falls back to hardcoded sequence if absent)
- **`orchestrator/session.ts`** — `discovery_answers`, `agent_questions`, `micro_pivots`, `re_invocation_history` added to `SessionState`; SHA-256 checksum written on every atomic state save; `autonomy_mode` persisted in `SessionConfig`
- **`orchestrator/types.ts`** — new types: `MicroPivot`, `WsMicroGateOpen`, `MicroGateResponse`, `AgentQuestion`, `WsDiscoveryGateOpen`, `WsQuestionGateOpen`, `DiscoveryQuestion`, `WorkflowGraph`, `WorkflowNode`, `AgentStep`, `TemplateDefinition`, `WsInteractiveStream`, `WsInteractiveDiff`; `SessionConfig` gains `language`, `autonomy_mode`, `editor_uri_scheme`, `refiner`; `AgentRegistryEntry` gains `custom_phase`, `reviewer_mode`, `custom`
- **`agent-registry.json`** — Refiner agent registered with `enabled_when: "config.refiner"`; Engineer `tools` array gains `request_architecture_change`

#### UI
- **`ui/src/types.ts`** — mirrors all new orchestrator types; `AgentCardState` gains `microPivotPending`; `SessionState` updated with new fields
- **`ui/src/components/Topbar.tsx`** — "Decisions" chip added; wires `DecisionsPanel` open/close
- **`ui/src/components/HomeScreen.tsx`** — language selector (TypeScript / Python / Go) added; Guided/Autonomous mode toggle; Refiner toggle
- **`ui/src/components/App.tsx`** — `InteractiveChat` visible when `pipeline_status === 'complete'`; `BudgetBand` replaces inline budget gate modal; `DecisionsPanel` wired; `ReinvocationGate` added; `MicroGate` event handling added; `QuestionGate` handling for discovery and agent question events

---

## [1.0.0-alpha.5] — 2026-04-01

Aperture Science theme migration — full visual overhaul of the React UI from the GitHub-dark blue palette to the Aperture warm-dark theme defined in [clados-aperture-theme.html](docs/clados-aperture-theme.html). Dark and light modes. All 9 phases of the [theme implementation plan](docs/plan.md) completed.

### Added

#### UI — Design Foundation
- **Self-hosted fonts** — Rajdhani (400/500/600/700) and Share Tech Mono (400) served from `ui/public/fonts/` via `@font-face` declarations; Google Fonts CDN `<link>` tags removed from `index.html`
- **Light mode** — full parallel token set (`:root[data-theme="light"]`) with facility-white surfaces, mocha-tinted log panel (`--log-panel: #D8D4CC`), and darkened accent colors for white-bg contrast
- **Theme toggle** (§7.5) — `☀`/`☾` ghost button in topbar; preference persisted in `localStorage` under `clados:theme`; sets `data-theme` attribute on `<html>`

#### UI — Agent Cards (§3, §13, §14)
- **Role color system** — 9 CSS custom properties (`--role-pm` through `--role-wrecker`) applied via `--rc` on each `.agent-card`; left border stripe now reflects agent role instead of status
- **Core eye indicators** (§13) — pulsing dot before the role tag on running cards; pulse pattern varies by role personality (`pulse-slow` for PM/QA/Docs, `pulse-fast` for Engineer/Architect/DevOps, `pulse-flick` for Wrecker)
- **Tooltip taglines** (§13) — GLaDOS-toned `title` attribute on running cards (e.g. "I have a plan. You won't like it.")
- **Elapsed timer** (§14) — `useState`/`setInterval(1000)` counter on running cards, resets on status change
- **Section checklist** (§14) — running cards now accumulate completed sections with `✓` marks and show the active section with `✍`; driven by `sections: string[]` on `AgentCardState`
- **Mini token bar** (§14) — thin progress bar at bottom of running cards showing cumulative output tokens; `tokens_out` field on `WsAgentStream` provides live updates
- **Error type badges** (§14) — color-coded classification for `api_429`, `api_5xx`, `context_length`, `timeout`, `parse_error`; context overflow errors change the Retry button label to "Retry with compression"

#### UI — Gate Panel (§5, §10)
- **Hazard stripe** — amber diagonal repeating-gradient bar at top of gate panel
- **Corner brackets** — `::before`/`::after` pseudo-elements with 2px amber borders on gate modal corners
- **`ConfirmModal.tsx`** *(new)* — replaces all `window.confirm()` calls; red corner brackets + red hazard stripe + GLaDOS-toned confirmation messages; used for rollback, restart phase, and abandon actions

#### UI — Activity Log (§15)
- **Elapsed time tags** — `+Ns` suffix on stream events, `Ns total` on done events; timestamps tracked per agent from `agent:start`
- **Phase separators** — `── Phase N ──` rows injected on phase transitions
- **Conductor commentary** (§15) — client-side idle timer injects GLaDOS quips at 30s/60s/120s thresholds when no `agent:stream` received; quip pool per role in `constants.ts`; zero API cost
- **Cost pace alerts** (§8.3) — after each `agent:done`, projected total vs. spend cap computed; log alert injected when projected total exceeds 80% of cap
- **Context compression events** — `context:compressed` WS events rendered as `.log-compress` in the log

#### UI — Other
- **Reconnection banner** (§12) — orange/red variants with GLaDOS quips ("I can't believe you disconnected…" / "Could not reconnect…")
- **Empty kanban state** (§11) — dashed-border overlay with "The Enrichment Center reminds you that all test subjects must press 'Create' to begin."
- **Focus-visible rings** — `:focus-visible` outline on all interactive elements (orange, 2px, 2px offset)
- **Phase step chip** (§16) — `N of M` indicator in topbar showing sub-phase agent progress
- **Scrollbar styling** — custom 4px scrollbars using theme border tokens

#### Orchestrator
- **`context:compressed` broadcast** (§8.1) — `conductor.ts` emits `{ type: 'context:compressed', phase, agent, artifact, reason, tokens_saved }` after context compression; type added to `orchestrator/types.ts`
- **`tokens_out` on `agent:stream`** (§8.2) — streaming handler emits approximate cumulative output tokens (`Math.ceil(assistantText.length / 4)`) on each section change

### Changed

#### UI
- **`index.css`** — entire `:root` block replaced with dark/light mode token sets; all hardcoded hex values replaced with `var()` references; old token names (`--text-muted`, `--text-dim`, `--blue`, `--blue-bg`, etc.) renamed; `border-radius` removed from all rectangular elements; `body` font set to `var(--font-ui)`
- **`index.html`** — `<html data-theme="dark">` attribute set; inline body style references `--bg` and `--text` tokens
- **`Topbar.tsx`** — Aperture SVG logo (circle + A letterform) replaces text-only logo; `/` separator replaced with vertical 1px line; status chip uses `.chip` pattern; cost badge uses `.budget-chip`; GLaDOS bar `barStyles` migrated from hardcoded hex to CSS variables
- **`AgentCard.tsx`** — card markup uses `.agent-card` + `.card-role-tag` + `.card-name` structure; done cards use `.is-done` class (opacity 0.72) with role stripe instead of green border; gate card uses `.gate-card` with dashed/solid/reviewing state variants
- **`KanbanBoard.tsx`** — column headers use `.col-header` + `.col-phase-name` + `.chip` pattern; active column gets orange left border; `sections` accumulation logic added to `agent:stream` handler; `errorType` stored from `agent:error` events
- **`ActivityLog.tsx`** — hardcoded `eventColor()` function replaced with CSS class mapping (`EVENT_CLASS`); `log-panel` background uses `var(--log-panel, var(--panel))`
- **`HomeScreen.tsx`** — Aperture SVG logo (44×44) + orange Rajdhani logo text + mono tagline; corner bracket decorations; form inputs use `var()` tokens
- **`Gate.tsx`** — grid changed to `1.6fr 1fr 1fr`; header uses mono uppercase gate title; revision count shows color coding; findings column hidden when empty
- **`ValidatorFindings.tsx`** — severity colors reference CSS variables; no hardcoded hex
- **`ArtifactSidebar.tsx`** — selected file highlight changed from blue to orange (`var(--ap-orange-lo)`)
- **`App.tsx`** — minimized gate bar uses flat styling with amber top border + pulsing dot + "↑ expand" chip; budget gate uses `confirm-panel` class with hazard stripe
- **`types.ts`** — `AgentCardState` gains `sections?: string[]` and `errorType?: string`; `WsAgentStream` gains optional `tokens_out`; `WsContextCompressed` event type added

### Removed
- **`SetupScreen.tsx`** — deleted (was unused in App.tsx); Phase 0 form is part of `HomeScreen.tsx`
- **Google Fonts CDN links** — removed from `index.html`; fonts self-hosted

---

## [1.0.0-alpha.4] — 2026-03-31

v1 spec compliance pass — UI-driven project setup, Gate drawer, and polish items from the compliance fix plan.

### Added

#### Orchestrator
- **`POST /project/new`** — new REST endpoint that accepts `{ idea, project_type, security_enabled, wrecker_enabled, spend_cap }` from the `SetupScreen` UI form; validates required fields, writes session config, and signals the pipeline to start via a deferred resolver callback in `ServerContext`
- **`ServerContext.setupResolver`** — optional callback added to `ServerContext` interface; `startServer()` wires it to a deferred `Promise<void>` so `handleNew()` can await the UI form submission before kicking off `runPipelineLoop()`

#### UI
- **`Gate.tsx` overflow mode** — when a `gate:open` event carries `overflow: true`, the Gate renders a simplified single-message view with only a Stop button (no Approve / Revise actions); prevents user confusion on context-length overflow gates
- **Amber retrying timer** (`AgentCard.tsx`) — when a card has been in `retrying` status for 60 seconds, the card border shifts to amber (`#d29922`) and a "Retrying — attempt N of 3" label appears below the status icon; timer resets if the card leaves `retrying` state
- **"Fetched N full artifact(s)" badge** (`AgentCard.tsx`, `KanbanBoard.tsx`) — done cards that ran with compressed context now display a count of how many full artifacts the agent fetched via `read_file` during its turn; driven by `full_artifacts_fetched` from the `agent:done` event

### Changed

#### Orchestrator
- **`cli.ts`** — `promptSetup()` readline flow removed; `clados new <name>` now starts the server and opens the browser immediately; the Phase 0 `SetupScreen` UI is now the sole input mechanism for project configuration; `is_high_complexity` is no longer collected at setup time (it is inferred later from idea complexity)

#### UI
- **`Gate.tsx`** — rebuilt from a full-screen dimming overlay to a **floating modal window**: `position: fixed`, anchored below the topbar (`top: 80px, left/right: 28px`), with a separate dim overlay behind it; clicking the overlay or the `─` button minimizes to the Topbar pill; `✕` closes on resolve
- **`App.tsx`** — removed `gateDrawerHeight` state and `paddingBottom` adjustment (no longer needed; the floating modal overlays rather than displacing content)
- **`KanbanBoard.tsx`** — auto-collapse of completed columns is now conditional on `window.innerWidth < 1400`; wide-screen users retain an uncollapsed view until they manually collapse
- **`ui/src/types.ts`** — `WsGateOpen` gains `overflow?: boolean` and `overflow_message?: string`; `WsAgentDone` gains `full_artifacts_fetched: number`; `AgentCardState` gains `fullArtifactsFetched: number`

---

## [1.0.0-alpha.3] — 2026-03-30

UI additions, bug fixes, and a full gate review overhaul. No spec changes.

### Added

#### UI
- **`SetupScreen.tsx`** *(new)* — Phase 0 setup form rendered inside the browser UI instead of purely in the CLI; collects idea, project type, optional agent toggles, and spend cap; submits to `POST /project/start` and renders inline validation errors
- **`ActivityLog.tsx`** *(new)* — live event stream panel below the Kanban board; displays all WebSocket events in chronological order with phase/agent context
- **`ArtifactSidebar.tsx`** *(new)* — slide-in panel (600 px, fixed right) that lists every generated artifact from `SessionState.artifacts` and renders the selected file via `ArtifactViewer`; toggled by a "Files" button in the Topbar
- **`ui/src/index.css`** *(new)* — global design token variables and shared utility classes (reconnection banner, budget band, cost tooltip, agent card animations)
- **Gate "Your feedback" middle column** — 3-column layout placeholder for the upcoming structured Q&A pane; revision textarea pinned to the bottom of the column

#### Orchestrator
- `POST /budget/abort` endpoint — allows the UI to abandon the pipeline when blocked on a budget gate (previously only cap-raise was available)
- `Conductor.resendPendingEventsTo(ws)` — replays the current `gate:open` or `budget:gate` event to newly connected WebSocket clients so they see a pending gate on reconnect without requiring a full state reload
- `handleBudgetAbort()` — resolves the budget gate promise with `false`, sets `pipeline_status` to `abandoned`, and throws `PIPELINE_ABANDONED` to cleanly stop the pipeline

#### Docs
- `docs/User-Guide.md` — user-facing guide covering installation, project creation, the gate review flow, and crash recovery
- `docs/Test-Projects.md` — reference list of sample projects used for manual testing
- `docs/Testing-Plan.md` — structured test plan covering CLI, pipeline phases, and UI interactions

### Changed

#### UI
- **`Gate.tsx`**: Complete rewrite from a bottom drawer to a centered floating modal overlay
  - `position: fixed` overlay with `rgba(0,0,0,0.35)` dim; clicking the overlay or the `─` button minimizes to the Topbar pill (gate state preserved)
  - 3-column CSS grid body (`1fr 1.1fr 1fr`): Left = generated artifact + filename chip, Middle = feedback/questions pane + revision textarea, Right = findings
  - Removed drag-to-resize handle and all associated state, refs, and resize event listener
  - `onMinimize` prop added (hides modal, keeps `currentGate` alive in App); `onClose` only called on a successful gate response
  - Phase 2 guardrail: Approve button intercepts unresolved `should_fix`/`suggestion` findings (excluding already-resolved ones) and shows a `window.confirm` before dispatching
  - `mustFixCount` filter now also excludes `status === 'resolved'` findings, not just overridden ones
  - `─` / `✕` header icon buttons both minimize; clicking the overlay also closes the More dropdown before minimizing
  - More menu now opens downward (`top: 110%`) instead of upward
  - Revision badge text changed to "Revision N of 3 before Opus escalation"
  - "Restart this phase" action added to the More dropdown
  - `flexWrap` on the body changed from `wrap` to `nowrap`; pane `height: '100%'` added to fix panel scrolling
  - Blocking indicator ("⚠ N issues to resolve") added to the toolbar when `must_fix` findings are unresolved
  - Gate no longer auto-opens on `gate:open` WebSocket event — user must click the Topbar button
- **`Topbar.tsx`**: Gate review button restyled to orange rounded pill (`#FAEEDA` / `#854F0B` / `#EF9F27`) with "⚠ Gate N — review" label; `onToggleSidebar` / `sidebarOpen` props added; "Files" toggle button added; cost breakdown hover tooltip shows per-phase spend
- **`KanbanBoard.tsx`**: Full-stack Phase 2 now renders `engineer-backend` and `engineer-frontend` cards instead of the generic `engineer` card; `blankCard` helper extracted to avoid duplication
- **`App.tsx`**: `ArtifactSidebar` integrated with toggle state; `paddingTop: 48px` added to main container to account for fixed topbar; budget gate "Stop" button wired to `POST /budget/abort`; budget gate cap-raise input pre-populated with a suggested value; `onMinimize` prop plumbed through to `Gate`

#### Orchestrator
- **`conductor.ts`**: All `agent:start`, `agent:done`, `agent:error`, `agent:stream`, and `agent:skipped` broadcasts now use `errorKey ?? role` so full-stack engineer variants (`engineer-backend`, `engineer-frontend`) are identified correctly in the UI; dispatch log line now includes input/context token counts; `budgetGateResolve` signature changed to `(shouldContinue: boolean) => void`; `currentGateEvent` and `currentBudgetGateEvent` fields cache the last broadcast gate event and are cleared on resolution; WIP file handle is closed before `writeFileAtomic` and re-opened afterward to prevent Windows file-locking permission errors
- **`budget.ts`**: `MODEL_PRICES` table is no longer hardcoded — prices are loaded at startup from `agent-registry.json` via `initModelPrices()`; eliminates the risk of model IDs and prices diverging between the registry and the budget module
- **`context.ts`**: Model strings for token counting and summarization are no longer imported from `escalation.ts`; set at startup via `initContextModels()` to match whatever the registry declares
- **`agent-registry.json`**: Model IDs updated to current Anthropic API identifiers; `utility_models` block added (`conductor`, `token_counter`, `summarizer`); `model_prices` block added so pricing is co-located with model declarations
- **`server.ts`**: `GET /project/artifact` strips a leading `.clados/` prefix from the client-supplied path before resolving, fixing artifact load failures when the client includes the subdirectory in the key

#### Agent prompts
- `agents/devops.md`, `agents/docs.md`: Output schema sections added (were missing, causing startup validation errors)

#### Build
- `tsconfig.json`: `@types/node` added to `types` array for correct language-service resolution; `ignoreDeprecations` corrected from `"6.0"` to `"5.0"`
- `orchestrator/cli.ts`: CLI usage message corrected

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

The following items are documented in `docs/CLaDOS-Spec.md` but do not ship in v1:

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
