# CLaDOS v1 Specification

This is the buildable spec for CLaDOS v1. Everything in this document ships. Anything not in this document does not ship — regardless of what the goal document describes.

---

## Scope boundaries

**IN scope:**
- 5-phase hardcoded sequence: Concept → Architecture → Build → Document → Ship
- 9 agents: PM, Architect, Engineer, QA, Validator, DevOps, Docs + optional Security, optional Wrecker
- File-based artifacts with atomic session state and crash recovery
- Findings-based validation (must_fix / should_fix / suggestion) — no numeric scores
- Targeted fix loops on Validator findings (not full phase re-runs)
- Asymmetric Context QA (QA denied access to source code and schema)
- Budget gating before dispatch (never mid-stream)
- Conductor reasoning escape hatch (`conductor.reason()`) for stuck revision loops
- Mechanical validation (contract checks, test execution) separate from LLM review
- AST/LSP context extraction with Tree-sitter fallback
- UI: Kanban board + gate drawer with approve/revise/destructive actions
- One stack: TypeScript end-to-end (orchestrator, generated projects, UI)

**OUT of scope — ships only after v1 is proven:**
- Configurable workflow DAG / condition DSL / `workflow-graph.json`
- Custom agent framework (`clados agent add`)
- Interactive Mode (post-deployment chat)
- IDE bridge, file watchers, deep-link URIs
- Artifact version pinning UI
- CLI subcommands (`clados logs`, `clados model-update`)
- Refiner agent
- Multi-language / multi-stack support
- Micro-pivots (`request_architecture_change` during Build)
- Agent questions / `{phase}-questions.json` / autonomy mode (agents always use defaults for ambiguities in v1; questions surface at gates via Validator findings instead)
- Budget band UI (budget gating uses a simpler inline notification)
- Decisions panel UI (decisions still logged to session state, not surfaced in UI)

---

## Phases and gates

The Conductor drives agents through a fixed 5-phase sequence. Each phase ends with a human approval gate. Phase transitions are expressed directly in TypeScript — no graph, no DSL.

### Phase 0 — Concept

**Setup screen inputs:**
1. Describe your idea (free text)
2. Project type (backend-only, full-stack, CLI tool, library)
3. Agent loadout — toggle optional agents:
   - Security (on/off, default off)
   - Wrecker (on/off, default off)
4. Spend cap (optional, dollar amount)

**Agents:**
1. **PM Agent** — takes the raw idea and writes a one-page concept document (`00-concept.md`). Scope, intent, key constraints, what it must not do.
2. **Validator** — reviews the concept for feasibility and obvious gaps. Produces `00-validator.json` with findings.

**Gate 1:** Human sees the concept + Validator findings. Approve, revise, or abort.

### Phase 1 — Architecture

**Agents:**
1. **PM Agent** — expands the approved concept into a full PRD with user stories, acceptance criteria, and non-functional requirements (`01-prd.md`).
2. **Architect** — defines project skeleton, tech stack, dependency list, database schema, and OpenAPI spec (`01-architecture.md`, `01-api-spec.yaml`, `01-schema.yaml`).
3. **Prototype Engineer** — scaffolds database models and the core server skeleton into `src/`. This is real code, not pseudocode. Also generates `infra/docker-compose.test.yml` (PostgreSQL test container with health check) and `.env.test` (test-safe environment variables) — these are required, not optional.
4. **Validator** — checks the scaffold against the schema programmatically, reviews architecture for completeness. Produces `01-validator.json`.

**Gate 2:** Human sees architecture artifacts + scaffold + Validator findings.

### Phase 2 — Build

**Scaffold ownership:** The Phase 2 Engineer owns all files in `src/`. The Phase 1 scaffold is starter code, not protected. The Engineer's manifest must include any scaffold file it intends to modify, marked with `"source": "scaffold"`. Scaffold files not listed in the manifest are kept as-is. The Validator treats scaffold files and Engineer files identically.

**Pass 1 — Pre-flight Manifest:**
The Engineer receives the scaffold and emits a manifest — a list of every file it intends to create, with declared dependencies between files. For backend-only projects: `02-build/backend-engineer-manifest.json`. For full-stack projects: separate `backend-engineer-manifest.json` and `frontend-engineer-manifest.json`.

**Pass 2 — Implementation & Living Manifest:**
Code is generated in batches. The manifest is not static — the Engineer can append entries when it discovers new files are needed (shared utilities, context providers). Cross-file context is extracted via the Two-Tier AST/LSP strategy (see Context Management).

Each batch receives:
- Full content of files declared as direct dependencies of the current batch
- Summary-only listings of everything else already written
- The OpenAPI spec as a hard constraint

**Pass 3 — Test Context:**
After implementation, the Engineer emits `02-build/test-context.json`:
```json
{
  "base_url": "http://localhost:3000",
  "auth": {
    "mechanism": "bearer",
    "obtain_token": "POST /auth/login with { email, password }",
    "test_credentials": { "email": "test@test.com", "password": "testpass123" }
  },
  "seed_strategy": "API-driven — create resources via POST endpoints before testing",
  "startup_command": "npm start",
  "env_vars": ["DATABASE_URL", "JWT_SECRET"]
}
```
This is not source code — asymmetric context is preserved. The Conductor validates that this file exists before dispatching QA.

**Validation pipeline (runs after implementation):**
1. **Contract Validator** (automated, not LLM) — parses the OpenAPI spec and scans generated source code for route registrations. Checks two things: (a) every endpoint in the OpenAPI spec has a matching route registration with the correct HTTP method, and (b) every route registration in the source code has a corresponding OpenAPI entry. It does **not** verify request/response shapes — that's covered by the test suite and by requiring the Engineer to include `express-openapi-validator` middleware (enforced via the Engineer's system prompt Constraints section). Route-shape mismatches surface as test failures, not contract findings. Produces `02-build/contract-validator.json`.
2. **QA Agent** (Asymmetric Context) — reads the PRD, OpenAPI spec, and `02-build/test-context.json`. Writes black-box integration tests (Playwright/Supertest). Has no access to source code, schema, or internal implementation.
3. **Test Runner** (automated) — executes QA's tests. Produces `02-build/test-runner.json`.

**Test Runner environment setup:**
Before executing tests, the Test Runner runs a deterministic setup sequence:
1. `npm install` in the project root
2. If `infra/docker-compose.test.yml` exists, run `docker compose -f infra/docker-compose.test.yml up -d` and wait for health checks (timeout: 60s)
3. If no docker-compose file exists but `test-context.json` lists `DATABASE_URL` in `env_vars`, fail with: *"Tests require a database but no docker-compose.test.yml was generated"*
4. Load environment variables from `.env.test`
5. Start the server via `test-context.json`'s `startup_command`, wait for the port to accept connections (timeout: 30s)
6. Run the test suite
7. Tear down: stop the server, `docker compose down` if applicable

**Test Runner isolation:** The Test Runner executes QA-generated tests via `child_process.spawn` with a configurable timeout (default: 120s, per `test_timeout_seconds` in `agent-registry.json`). The test process inherits only the environment variables from `.env.test` — no access to the parent process's environment. The server under test and the database run inside Docker containers via `docker-compose.test.yml`; the test runner process itself runs on the host. This provides network and data isolation (the test database is ephemeral — destroyed on `docker compose down`) without requiring the test runner itself to be containerized. If `docker-compose.test.yml` is unavailable, the test runner logs a warning and runs tests against a host-local server — but database-dependent tests will fail deterministically rather than silently connecting to a non-test database.

4. **Security Agent** (optional) — if enabled, runs threat model and dependency audit. Produces `02-build/security-report.md`.
5. **Wrecker** (optional) — if enabled, writes adversarial edge-case tests targeting failure modes. Produces `02-build/wrecker.json`.
6. **Validator** — reviews test results, contract findings, and code quality together. Produces `02-build/validator.json`.

**Targeted fix loops:** When the Validator flags bugs in specific files, the Engineer is re-dispatched with only: the manifest, the findings, and the flagged files' content. Unflagged files are not re-sent or re-generated.

**Gate 3:** Human sees the build artifacts, test results, and Validator findings.

### Phase 3 — Document

**Agents:**
1. **Docs Agent** — writes README, changelog, and runbook based on the actual functioning codebase (`docs/`).
2. **PM Agent** — writes the final PRD (`03-prd.md`) and produces `03-api-spec.yaml` — the canonical record of the API as actually built (may differ from the Phase 1 design version). `01-api-spec.yaml` is preserved as the original design artifact. Any future re-invocation uses the highest-numbered `*-api-spec.yaml` as the binding contract.
3. **Validator** — reviews documentation for accuracy against the code. Produces `03-validator.json`.

**Full-stack projects:** Docs produces a single unified README covering both frontend and backend, with separate "Getting Started" sections for each. The PM's final OpenAPI update covers the backend API only.

**Gate 4:** Human sees the documentation + Validator findings.

### Phase 4 — Ship

**Agents:**
1. **DevOps Agent** — generates Dockerfiles, CI/CD configuration, environment config, and a deployment runbook (`infra/`, `docs/{project}/runbook.md`). For full-stack projects, produces individual Dockerfiles per service plus a `docker-compose.yml` for local development.
2. **Validator** — reviews deployment config for security and completeness. Produces `04-validator.json`.

**Gate 5:** Human approves the deployment configuration.

---

## Agent registry

Each agent is defined in `agent-registry.json` with:
```json
{
  "role": "pm",
  "system_prompt": "agents/pm.md",
  "default_model": "claude-sonnet",
  "escalation_model": "claude-opus",
  "tools": ["read_file", "write_file", "list_files"],
  "enabled_when": "always",
  "context_artifacts": [
    { "artifact": "00-concept.md", "type": "required" }
  ],
  "system_prompt_tokens": null,
  "expected_output_tokens_per_turn": 4000,
  "expected_tool_turns": 1
}
```

`system_prompt_tokens` is calculated once at startup via `anthropic.beta.messages.countTokens()` and cached. If the API call fails, fallback to `Math.ceil(chars / 3.5)`.

Budget projection for an agent: `(context_tokens + (expected_output_tokens_per_turn × expected_tool_turns)) × model_price × 1.2` (20% margin). For agents that don't use tools (Validator, Security), `expected_tool_turns` is 1. For the Engineer, set to the expected number of files per batch (3–5).

**v1 agent roles and models:**

| Role | Default Model | Escalates to | Tools |
|------|--------------|--------------|-------|
| PM | Sonnet | Opus | read_file, write_file |
| Architect | Sonnet | Opus | read_file, write_file |
| Engineer | Sonnet | Opus | read_file, write_file, list_files |
| QA | Sonnet | Opus (Asymmetric Context) | read_file, write_file |
| Validator | Sonnet | Opus | read_file |
| Security | Sonnet | Opus | read_file |
| Wrecker | Sonnet | Opus | read_file, write_file |
| DevOps | Sonnet | Opus | read_file, write_file |
| Docs | Sonnet | Opus | read_file, write_file |

The Conductor itself always runs as Opus. It is TypeScript code, not a prompted agent — it only calls Claude for specialist agent dispatch and the `conductor.reason()` escape hatch.

**Agent system prompt structure (required):**
```
## Identity
## Inputs
## Task
## Output schema
## Constraints
```
Missing sections → Conductor logs a configuration error at startup and refuses to dispatch.

**Escalation triggers:**
1. A phase has been revised 3+ times without resolving must_fix findings
2. The project is flagged as high-complexity at the setup screen

---

## Conductor logic

The Conductor is deterministic TypeScript. It reads `agent-registry.json`, drives agents through the hardcoded phase sequence, manages tool call loops, and handles all error recovery.

**Agent dispatch loop:**
1. Assemble context: system prompt + prior artifacts (per `context_artifacts` declaration)
2. Check budget: if projected cost exceeds remaining budget, trigger budget gate
3. Call Claude API with system prompt, context, and declared tools
4. Handle tool calls in a loop until the agent emits a final text artifact
5. Parse and validate the artifact (JSON sanitizer for structured output)
6. Write artifact to disk (streaming to `.clados/wip/`, rename to final path on completion)
7. Update session state atomically

**Context injection rules:**
- `required` artifacts: injected in full, always
- `reference` artifacts: injected as a compressed summary; full artifact available via `read_file`
- If a `required` artifact would push context over 80K tokens, downgrade strategy:
  1. First: downgrade `reference` artifacts to summaries
  2. If still over: downgrade `required` artifacts to summaries, grant `read_file` access for those artifact paths
  3. Log all downgrades to session state

**The reasoning escape hatch — `conductor.reason()`:**
When 3 consecutive revision cycles leave the same `must_fix` findings unresolved, the Conductor calls Claude Opus with the context and a specific question about how to proceed. The decision is logged to `00-session-state.json` under `conductor_reasoning`. If the reasoning-guided re-run still fails, the loop terminates — the Conductor forces a gate with: *"Three revisions haven't resolved this. You need to decide how to proceed."* The escape hatch does not repeat.

---

## Validation

Validation is split into two layers. They are not interchangeable.

**Mechanical checks (deterministic code, not LLM):**
- **Contract Validator** (`agents/_subagents/contract-validator.ts`) — parses the OpenAPI spec and the generated source code. Checks that every declared endpoint has a matching route registration with the correct HTTP method, and vice versa. Does not verify request/response shapes — that is handled at runtime by `express-openapi-validator` middleware and exercised by the test suite. Failures automatically become `must_fix` findings.
- **Test Runner** (`agents/_subagents/test-runner.ts`) — executes the QA agent's test suite in a sandboxed environment (spawned process with timeout). Failures automatically become `must_fix` findings.

**Validator agent (LLM review):**
The Validator agent produces structured JSON findings:
```json
{
  "findings": [
    {
      "id": "f-001",
      "severity": "must_fix",
      "category": "security",
      "description": "No authentication mechanism specified.",
      "file": "01-prd.md",
      "line": 45
    }
  ]
}
```

Severity levels: `must_fix`, `should_fix`, `suggestion`.

**On re-review**, the Validator must classify each prior finding as `resolved`, `partially_resolved`, or `unresolved`. New issues must be tagged `new_discovery`. The Conductor routes based on whether open `must_fix` findings exist.

**Human override:** Users can override any `must_fix` finding at the gate. The override is logged but the pipeline proceeds. The human's decision is final.

---

## Session state and crash recovery

**State machine — `pipeline_status` in `00-session-state.json`:**

| Status | Meaning | Transitions to |
|--------|---------|---------------|
| `idle` | Not yet started | `agent_running` |
| `agent_running` | Agent dispatched and active | `gate_pending`, `budget_gate_pending`, `idle` |
| `gate_pending` | Waiting for human decision | `agent_running`, `abandoned` |
| `budget_gate_pending` | Spend cap hit, waiting for human | `agent_running`, `abandoned` |
| `abandoned` | Human stopped the pipeline | — (terminal) |
| `complete` | All phases approved | — (terminal) |

**Atomic writes:** All session state writes go to `00-session-state.tmp.json` first, then `fs.rename()` replaces the real file. On Windows, use `write-file-atomic` (npm). On startup, if the tmp file exists alongside the real file, discard the tmp (write died mid-rename).

**Phase checkpoint (tracks mid-phase progress):**
```json
"phase_checkpoint": {
  "phase": 2,
  "completed_agents": ["backend-engineer", "qa"],
  "in_progress_agent": "security",
  "in_progress_artifact_partial": ".clados/wip/02-security-report.partial.md",
  "spec_version_at_start": 2
}
```

**Crash recovery (on startup with `pipeline_status: "agent_running"`):**
1. Read `phase_checkpoint.in_progress_artifact_partial`
2. If the file doesn't exist → agent restarts clean (crashed before first write)
3. If the file exists → run structural marker test:
   - Markdown: at least one `##` heading
   - JSON: at least one top-level key
   - YAML: at least one unindented key matching `^[a-zA-Z][\w-]*:`
4. If markers pass → include partial content in restarted agent's context, instruct it to continue
5. If markers fail → agent restarts clean

**On startup with `gate_pending`:** re-open the gate UI.
**On startup with `abandoned` or `complete`:** present the final state.

---

## Error handling

**Transient API errors (429, 5xx):**
Exponential backoff with jitter: ~2s, ~8s, ~30s. After 3 failed retries, the agent card transitions to `Error` state. The card shows:
- "Failed after 3 retries — [error type]"
- **Retry agent** button (re-dispatch this agent only)
- **Skip agent** button (only where safe: Wrecker, Security, Docs with warning; never Validator or Contract Validator)

A `{agent}-error.json` is written to `.clados/wip/` with: error type, message, retry count, elapsed time, artifact path. Preserved even after a successful retry, for diagnostics.

**Context length errors:**
1. Downgrade all `required` artifacts to summaries, retry once
2. If retry also exceeds context → force gate: *"This agent's inputs are too large to process even with compression. You can simplify the inputs or stop here."*

**JSON sanitizer middleware:**
LLMs wrap JSON in markdown fences or include conversational prefixes. The Conductor applies deterministic repair: strip markdown fences → slice to outermost `{` or `[` → `JSON.parse`. If repair fails, retry the agent with explicit instruction to produce valid JSON. No secondary model repair.

**Budget gating:**
Before dispatching any API call, the Conductor checks: `remaining_budget - projected_cost >= 0`. Projected cost uses the formula from the agent registry: `(context_tokens + (expected_output_tokens_per_turn × expected_tool_turns)) × model_price × 1.2`. If it would breach:
1. Write `pipeline_status: "budget_gate_pending"` to session state
2. Notify the UI via WebSocket
3. UI shows inline notification at the gate: current spend, which agent would breach, option to raise cap or stop

Budget is *never* enforced mid-stream. If a call exceeds projection, the overage is absorbed and the budget gate triggers before the *next* dispatch.

**Rate limit management:**
The shared semaphore in `parallel.ts` (default: 3 concurrent slots) is the primary rate limit defense. In addition, the Conductor tracks rolling 60-second token usage (input + output) across all agents. If cumulative token throughput in the current 60-second window exceeds 80% of the configured TPM (tokens-per-minute) limit, the semaphore temporarily reduces available slots to 1 until the window rolls below 60%. The TPM limit is configured in `agent-registry.json` as a top-level `rate_limit_tpm` field (default: 80,000 — conservative for Tier 1 API access; users with higher tiers should increase this). This prevents 429 storms during phases with many concurrent or sequential agent calls (e.g., Phase 2 with parallel Engineers + Validator + optional Security + optional Wrecker). Token throughput is tracked from API response `usage` fields — the same data already used for cost tracking — so no additional API calls are needed.

**Token counting:**
Use `anthropic.beta.messages.countTokens()` for exact counts (called once per artifact at write time, stored in session state). If the endpoint is unavailable, fall back to `Math.ceil(chars / 3.5)` and log a warning. The pipeline continues with approximate counting.

---

## Context management

**Two-Tier AST/LSP extraction:**
1. **LSP parsing** — extract precise signatures, exports, and public methods from generated code
2. **Tree-sitter fallback** — if LSP fails (common with temporarily broken syntax), Tree-sitter provides partial-error-tolerant parsing
3. **Semantic Context Mapping** — a cheap side-model (Haiku) emits one-line summaries per file (e.g., `src/payment.ts: Exports processPayment. Handles Stripe formatting.`), paired with AST structure to give downstream agents both types and intent. Haiku summarizer calls are tracked in `phase_checkpoint.agent_tokens_used` under a `summarizer` entry and included in the running cost total and per-phase breakdown.

**Summarizer budget cap:** Summarizer calls are capped at 5% of the remaining budget. If the next summarizer call would push cumulative summarizer spend past this threshold, the Conductor skips the semantic summary and falls back to AST-only context (structural exports without intent descriptions) for the remainder of the phase. The cap prevents silent cost accumulation on large projects with many revision cycles. The threshold is checked per-call, not batched — a single summarizer call never exceeds a few cents, so the 5% cap triggers gradually.

**Context budget enforcement:**
Token counts stored at artifact write time. At inject time, pure arithmetic projection. If projected context > 80K tokens:
1. Downgrade `reference` artifacts to summaries
2. If still over: downgrade `required` artifacts, grant `read_file` access
3. Log all decisions to session state

**Context compression indicator:** Agent cards that ran with compressed context display "Context compressed." If the agent subsequently fetched a full artifact via `read_file`, show "Agent fetched N full artifact(s)" so the human knows at the gate.

**Engineer batch dependencies:**
Each batch in Pass 2 receives full file content for files declared as direct dependencies of the current batch (via the `dependencies` field in the manifest), and summary-only listings of everything else. The manifest declares these relationships explicitly.

---

## Parallel build and contract drift

For full-stack projects, frontend and backend Engineers run in parallel with the OpenAPI spec as a shared contract.

A `spec_version` integer in session state increments whenever `01-api-spec.yaml` is modified. When either Engineer's output is revised, the Conductor compares the spec version the other Engineer ran against to the current version. If they differ, the Contract Validator re-runs and the Validator does a targeted integration review — not a full re-run.

**Dependency divergence detection:**
The Architect's `01-architecture.md` includes a declared dependency list. After the Engineer produces its manifest, the Conductor compares manifest dependencies against the architecture's declared list. Any new package the Engineer introduces is added to `dependency_divergences` in session state and shown at the gate as informational — not blocking.

---

## UI specification

### Architecture
React/Vite SPA connecting to the orchestrator over WebSocket. No polling.

### Layout
- **Topbar:** CLaDOS logo, project name, phase chip, status indicator ("Waiting for your decision at Gate 2"), running cost total ("$0.38 used"), Focus button
- **Board:** Horizontal scroll of phase columns, one per phase
- **Gate drawer:** Resizable bottom drawer (drag handle, min 200px, height persisted to `localStorage`)

### Phase columns
Each column has a header showing phase name and status (Done / Active / Pending). Completed columns auto-collapse on viewports < 1400px. Collapse state persisted to `localStorage`.

### Agent cards
Card states: Pending, Running, Done, Flagged, Error.

**Running state:** Slow color-cycle border animation. Shows current section being written (extracted from structural markers in streaming output, not raw tokens). After 60s of retrying, border shifts to amber and shows "Retrying — attempt 2 of 3."

**Error state:** Amber border, "Failed after 3 retries" message, Retry and Skip buttons.

**Done state:** Green left border, artifact link.

**Flagged state:** Red left border, finding count.

### Gate drawer
Two panes side by side:
- **Left:** Artifact content (rendered markdown/yaml/json)
- **Right:** Validator findings sorted by severity

Gate header shows:
- Gate name and phase
- Revision counter: "Revision 1 of 3 before Opus escalation" (amber at 2, red at 3+)
- Next-phase cost estimate: "Next phase: ~$0.45" (single-pass, no revision speculation)

Gate actions:
- **Approve →** — proceed to next phase
- **↺ Ask AI to revise** — opens 3-pane view: artifact (40%), revision textarea (30%), findings (30%). On viewports < 1100px, left pane toggles between Artifact and Revision tabs. Findings always visible.
- **⚠ More options:** destructive actions menu:
  - Go back to Gate N (dropdown of prior gates, confirmation lists discarded artifacts). When rolling back past Phase 2, `src/`, `tests/`, `infra/`, and `docs/` are archived to `.clados/history/rollback-{timestamp}/` before the re-run. The confirmation dialog lists these directories alongside `.clados/` artifacts. After rollback, a clean scaffold is regenerated from Phase 1.
  - Restart this phase (clears `.clados/wip/` for current phase)
  - Abandon project (writes `abandoned` status, all artifacts preserved)

### Cost display
- **Running total** in topbar after Gate 1 is approved: "$0.38 used" — updated after each API call. Hover shows per-phase breakdown of actual spend.
- **Per-gate estimate** for the next phase only: single-pass cost, clearly labeled as assuming zero revisions. Accounts for system prompt tokens + projected input tokens + (expected_output_tokens_per_turn × expected_tool_turns) per agent.
- **No upfront pipeline estimate.** Lower-bound estimates anchor expectations and erode trust.

### WebSocket reconnection
If the WebSocket drops, retry every 5s. Topbar banner: "Connection lost — reconnecting…" After 5 failures: "Could not reconnect — restart CLaDOS to continue" (amber, persistent). Cards freeze in last-known state — no Error transitions from connection drops alone. On reconnection, orchestrator sends full state snapshot.

### What's NOT in v1 UI
- Budget band (expandable breakdown with agent toggles) — budget gating uses inline notification
- Decisions panel (conductor decisions logged to session state, not surfaced in UI)
- Score chips (no numeric scores at all)
- Artifact version dropdown / version pinning

---

## File and artifact structure

```
clados/                            ← CLaDOS installation
  orchestrator/
    conductor.ts                   ← hardcoded phase sequence, agent dispatch
    escalation.ts                  ← Sonnet → Opus escalation rules
    session.ts                     ← atomic session state writes
    parallel.ts                    ← semaphore for concurrent API calls
    agent-registry.json            ← role → config (see Agent Registry)
  agents/
    conductor.md
    pm.md
    architect.md
    engineer.md
    qa.md
    validator.md
    security.md
    wrecker.md
    devops.md
    docs.md
    _subagents/
      contract-validator.ts        ← static analysis, not LLM
      test-runner.ts               ← sandboxed test execution
      summarizer.md                ← Haiku-tier, writes summaries
  ui/
    components/
      Gate.tsx
      KanbanBoard.tsx
      ArtifactViewer.tsx
      ValidatorFindings.tsx
    App.tsx

{project}/                         ← created by `clados new {name}`
  .clados/
    00-session-state.json
    run.log                        ← JSONL operational log (rotates at 10MB)
    00-concept.md
    00-validator.json
    01-prd.md
    01-architecture.md
    01-api-spec.yaml
    01-schema.yaml
    01-validator.json
    02-build/
      backend-engineer-manifest.json
      frontend-engineer-manifest.json  ← full-stack only
      test-context.json              ← test environment config for QA
      contract-validator.json
      test-runner.json
      validator.json
      wrecker.json                 ← if Wrecker enabled
      security-report.md           ← if Security enabled
    03-validator.json
    03-prd.md                      ← final PRD based on actual build
    03-api-spec.yaml               ← canonical API spec as actually built
    04-validator.json
    history/                       ← superseded artifact versions
    wip/                           ← partial artifacts during active runs
  src/                             ← generated source code
  tests/                           ← generated tests
  infra/                           ← CI/CD, Dockerfiles
  docs/                            ← README, changelog, runbook
```

**Naming convention:** `{phase-number}-{name}.{ext}`. Phase 0 → `00-`, Phase 1 → `01-`, Phase 2 → `02-build/`, etc. Phase 2 uses a subdirectory because it generates many files from several agents.

**Versioning:** When a phase is revised, the previous artifact is renamed to `{name}_vN.md` and moved to `.clados/history/`. Session state tracks version numbers.

---

## Transport layer

The orchestrator runs as a persistent Express server.

**REST endpoints:**
- `POST /project/new` — create a new project, returns project ID
- `POST /gate/respond` — human decision at a gate: `{ action: "approve" | "revise" | "abort" | "goto", revision_text?: string, override_findings?: string[], goto_gate?: number }`
- `GET /project/:id/state` — current session state (for reconnection)
- `POST /budget/update` — raise spend cap: `{ new_cap: number }`

**WebSocket events (server → client):**
- `agent:start` — agent card transitions to Running
- `agent:stream` — current section marker (not raw tokens)
- `agent:done` — agent finished, artifact path
- `agent:error` — agent failed after retries
- `gate:open` — gate is ready for human decision
- `budget:gate` — spend cap would be breached
- `state:snapshot` — full state (sent on reconnection)

---

## Feasibility assessment

This v1 is a substantial project, but it's buildable. Here's how the work breaks down:

**Core orchestrator (the hardest part):**
- Conductor with hardcoded phase sequence, agent dispatch loop, tool call handling
- Session state management with atomic writes and crash recovery
- Context assembly with token budgeting and downgrade logic
- Budget gating (pre-dispatch checks)
- JSON sanitizer middleware
- `conductor.reason()` escape hatch

**Agents (prompt engineering + integration):**
- 9 agent system prompts with required structure
- Agent-specific tool implementations (`read_file`, `write_file`, `list_files` as Node.js `fs` ops)
- Escalation logic (Sonnet → Opus based on revision count or complexity flag)

**Mechanical validators (TypeScript utilities):**
- Contract Validator: parse OpenAPI spec + scan source for route definitions
- Test Runner: spawn sandboxed process, capture results, enforce timeout

**Context extraction:**
- LSP integration for TypeScript (use `typescript` package directly for AST)
- Tree-sitter fallback (npm package, well-maintained)
- Haiku summarizer calls

**UI:**
- Kanban board with 5 columns, card state transitions
- Gate drawer with 2-pane / 3-pane modes
- WebSocket client with reconnection
- Drawer resize, column collapse, localStorage persistence

**Infrastructure:**
- Express server with WebSocket upgrade
- Project directory scaffolding

**What makes this feasible:**
- Hardcoded phase sequence (no graph engine to build)
- No custom agent framework
- No IDE bridge or file sync
- Findings-based validation (no score math or threshold tuning)
- UI scoped to board + drawer (no budget band, no decisions panel)
- One stack (TypeScript) — no polyglot tooling

**What will be hardest:**
- Getting agent prompts right so they produce useful artifacts on real projects
- Context extraction (LSP/Tree-sitter integration with broken generated code)
- The targeted fix loop — scoping re-dispatch correctly so it's actually cheaper
- Crash recovery edge cases
- Making the QA agent's black-box tests actually exercise the right things without seeing the code

**Rough component count:** ~15 TypeScript modules in the orchestrator, ~9 agent prompt files, ~5 React components, ~3 utility scripts (contract validator, test runner, summarizer). This is a focused codebase, not a platform.
