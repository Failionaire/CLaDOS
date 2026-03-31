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
- UI: Kanban board + floating gate modal with approve/revise/destructive actions
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

## Startup and invocation

CLaDOS is invoked as a Node.js CLI via `node` with no subcommands:

```
node bin/clados.js
```

`node bin/clados.js` does the following:
1. Validates `ANTHROPIC_API_KEY` is set; exits with an error message if not
2. Starts the Express server on a random available port (probes 3100–3199; first free port wins)
3. Opens the system default browser at `http://localhost:{port}`
4. Presents the **home screen** — the project picker UI

**Home screen — create a new project:**  
The user fills in: project name, free-text idea, project type, optional agent toggles (Security, Wrecker), and an optional spend cap. Submitting calls `POST /projects/create`, which:
1. Creates the directory `{name}/` under the working directory CLaDOS was launched from
2. Initializes `.clados/` with a fresh `00-session-state.json` (`pipeline_status: "idle"`)
3. Starts the pipeline and broadcasts a `state:snapshot` WebSocket event so the UI transitions immediately to the Kanban board

**Home screen — resume an existing project:**  
The home screen calls `GET /projects/list` on load, which scans the working directory for subdirectories containing `.clados/00-session-state.json` and returns each project's name, `pipeline_status`, and timestamps sorted by most-recently-updated. The user selects a project and clicks **Open →**, which calls `POST /projects/open`. This loads the saved state, wires the Conductor, and resumes the pipeline (skipping the loop for projects already `complete` or `abandoned`). A `state:snapshot` event transitions the UI to the Kanban board.

**The UI is served by the orchestrator's Express server** — a single process hosts both the REST/WebSocket API and the static SPA build (from `ui/dist/`). There is no separate Vite dev server in production usage. During development of CLaDOS itself, contributors run the Vite dev server (port 5173) with a proxy to the orchestrator — this is a contributor concern, not user-facing. There is no `clados dev` command.

The entry point is `bin/clados.js` declared in `package.json`. A global install (`npm install -g clados`) allows invoking `clados` directly without specifying the path.

**Server lifecycle:** The Express server stays alive until the user closes the terminal or presses Ctrl+C. On `SIGINT`, the orchestrator writes `pipeline_status` to session state (preserving `gate_pending` or `agent_running` for resume) and exits cleanly. If an agent is mid-stream, the partial artifact in `.clados/wip/` is left intact for crash recovery.

---

## Phases and gates

The Conductor drives agents through a fixed 5-phase sequence. Each phase ends with a human approval gate. Phase transitions are expressed directly in TypeScript — no graph, no DSL.

### Phase 0 — Concept

**Home screen inputs (collected when creating a new project):**
1. Project name (used as the directory name)
2. Describe your idea (free text)
3. Project type (backend-only, full-stack, CLI tool, library)
4. Agent loadout — toggle optional agents:
   - Security (on/off, default off)
   - Wrecker (on/off, default off)
5. Spend cap (optional, dollar amount)

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

   **Route scanning scope:** The Contract Validator resolves Express router composition to a limited depth. It handles:
   - Top-level `app.get/post/put/patch/delete("/path", ...)` calls
   - One level of `app.use("/prefix", router)` composition — it follows the `router` import, reads that file, extracts `router.get/post/...` calls, and prepends the prefix
   - `Router()` instances exported from files imported by the main entry point

   It does **not** handle:
   - Dynamic route loading (e.g., `fs.readdirSync` + `require`)
   - Routes registered via middleware factories or higher-order functions
   - Deeply nested router chains (3+ levels)

   This keeps the Contract Validator at ~80 lines of deterministic AST traversal (using the TypeScript compiler API, not regex). False negatives from dynamic routing are acceptable — those routes still get exercised by the test suite. If the validator cannot resolve a `Router()` import, it emits a `should_fix` finding: *"Could not trace router import at {file}:{line} — verify this route is covered by the OpenAPI spec."* The Engineer's system prompt Constraints section instructs it to prefer flat, explicit route registration over dynamic loading.
2. **QA Agent** (Asymmetric Context) — reads the PRD, OpenAPI spec, and `02-build/test-context.json`. Has no access to source code, schema, or internal implementation. Test framework is determined by project type:
   - **Backend-only / library / CLI tool:** QA writes Supertest tests (`tests/integration/*.test.ts`). These are HTTP-level tests — request/response assertions against the running server. No browser automation.
   - **Full-stack:** QA writes Playwright tests (`tests/e2e/*.spec.ts`). These are browser-level tests that exercise the frontend UI and its integration with the backend API.

   The project type is read from `00-session-state.json` and injected into the QA agent's system prompt as a variable. The QA system prompt has two Task sections (one per framework) and a conditional: *"Use the Supertest section if project_type is backend-only, library, or cli-tool. Use the Playwright section if project_type is full-stack."* Both frameworks are `devDependencies` in the generated project's `package.json` — the QA agent emits the dependency list in its output, and the Test Runner runs `npm install` before execution.
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
  "default_model": "claude-sonnet-4-20250514",
  "escalation_model": "claude-opus-4-20250514",
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

**Model identifiers:** All `default_model` and `escalation_model` values use exact Anthropic API model IDs. The v1 defaults:

| Nickname | API model ID |
|----------|-------------|
| Sonnet | `claude-sonnet-4-20250514` |
| Opus | `claude-opus-4-20250514` |
| Haiku (summarizer only) | `claude-haiku-3-5-20241022` |

These are hardcoded defaults in `agent-registry.json`. When Anthropic releases newer model versions, update the IDs in the registry — no code changes required.

**`enabled_when` — v1 mechanism:**
The full condition DSL is out of scope for v1. In v1, `enabled_when` accepts exactly three string values:
- `"always"` — agent runs in every project (PM, Architect, Engineer, QA, Validator, DevOps, Docs)
- `"config.security"` — agent runs only if the user toggled Security on at the home screen
- `"config.wrecker"` — agent runs only if the user toggled Wrecker on at the home screen

The Conductor evaluates this with a direct lookup — no expression parser:
```typescript
function isAgentEnabled(enabledWhen: string, config: SessionConfig): boolean {
  if (enabledWhen === "always") return true;
  if (enabledWhen === "config.security") return config.security_enabled;
  if (enabledWhen === "config.wrecker") return config.wrecker_enabled;
  throw new Error(`Unknown enabled_when value: ${enabledWhen}`);
}
```
The `SessionConfig` fields `security_enabled` and `wrecker_enabled` are set from the home screen toggles and written to `00-session-state.json`. Adding a new optional agent in a future version requires adding a new `enabled_when` string and a matching config field — the pattern is intentionally rigid to avoid premature abstraction.

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
| Summarizer | Haiku | N/A | — |

Display names (Sonnet, Opus, Haiku) map to exact API model IDs listed in the **Model identifiers** table above. The Summarizer is not a full agent — it is a Haiku-tier side-call used only by the context extraction pipeline (see Context Management).

The Conductor itself always runs as Opus (`claude-opus-4-20250514`). It is TypeScript code, not a prompted agent — it only calls Claude for specialist agent dispatch and the `conductor.reason()` escape hatch.

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
2. The project is flagged as high-complexity at the home screen

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
  "spec_version_at_start": 2,
  "gate_revision_count": 1,
  "unresolved_streak": 0
}
```

**Revision tracking:**
- `gate_revision_count` — incremented each time the human selects "Ask AI to revise" at the current phase's gate. Resets to 0 when the phase advances (gate approved). This is the counter displayed in the gate header as *"Revision 2 of 3 before Opus escalation"* and drives the amber (2) / red (3+) color thresholds.
- `unresolved_streak` — incremented each time a revision cycle completes and the Validator still reports the same `must_fix` findings (compared by finding `id`). Resets to 0 when a previously-unresolved finding is marked `resolved`. This is the counter that triggers `conductor.reason()` at 3.

Both counters are per-phase (scoped to `phase_checkpoint`) and survive crashes — they are written to session state atomically along with all other checkpoint fields. On phase rollback ("Go back to Gate N"), the target phase's counters reset to 0.

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
3. **Semantic Context Mapping** — a cheap side-model (Haiku — `claude-haiku-3-5-20241022`) emits one-line summaries per file (e.g., `src/payment.ts: Exports processPayment. Handles Stripe formatting.`), paired with AST structure to give downstream agents both types and intent. Haiku summarizer calls are tracked in `phase_checkpoint.agent_tokens_used` under a `summarizer` entry and included in the running cost total and per-phase breakdown.

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

## Phase 2 agent execution order and parallelism

**Single-project-type execution (backend-only, CLI tool, library):**

Phase 2 agents execute in three stages with a shared semaphore (`parallel.ts`, default 3 slots):

| Stage | Agents | Concurrency |
|-------|--------|-------------|
| **A — Implementation** | Engineer | Sequential (single agent) |
| **B — Validation** | Contract Validator, QA → Test Runner, Security (if enabled) | Parallel — Contract Validator and Security run concurrently with the QA → Test Runner sequential pair |
| **C — Review** | Wrecker (if enabled), then Validator | Sequential — Wrecker runs first (writes adversarial tests, appends to test suite, Test Runner re-runs for Wrecker's tests only), then Validator reviews all results |

**Stage dependencies:**
- Stage B starts after Stage A completes (all agents need the implementation)
- QA → Test Runner is a sequential pair within Stage B (Test Runner needs QA's tests)
- Contract Validator runs in parallel with QA (no shared dependency)
- Security runs in parallel with QA and Contract Validator (reads source code independently)
- Stage C starts after all Stage B agents complete
- Wrecker depends on Test Runner results to identify failure gaps — it cannot run in parallel with QA/Test Runner
- Validator is always the last agent in Phase 2 — it needs all prior outputs

**If Wrecker is enabled:** Wrecker writes adversarial tests to `tests/adversarial/*.test.ts`. The Test Runner re-executes with only the Wrecker test files (not the full QA suite again). Wrecker test results are merged into the existing `02-build/test-runner.json` under a separate `wrecker_tests` key.

**Full-stack parallel build:**

For full-stack projects, frontend and backend Engineers run in parallel with the OpenAPI spec as a shared contract. The Stage B/C pipeline runs once after both Engineers complete — not separately per Engineer.

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
- **Gate modal:** Floating modal window (position fixed, overlays the board with a dim background; minimize to a topbar pill, close on resolve)

### Phase columns
Each column has a header showing phase name and status (Done / Active / Pending). Completed columns auto-collapse on viewports < 1400px. Collapse state persisted to `localStorage`.

### Agent cards
Card states: Pending, Running, Done, Flagged, Error.

**Running state:** Slow color-cycle border animation. Shows current section being written (extracted from structural markers in streaming output, not raw tokens). After 60s of retrying, border shifts to amber and shows "Retrying — attempt 2 of 3."

**Error state:** Amber border, "Failed after 3 retries" message, Retry and Skip buttons.

**Done state:** Green left border, artifact link.

**Flagged state:** Red left border, finding count.

### Gate modal
Floating modal window anchored to fixed position below the topbar, dimming the board behind it. Three panes in a grid (`1fr 1.1fr 1fr`):
- **Left:** Artifact content (rendered markdown/yaml/json)
- **Middle:** Your feedback — answers to open questions and a revision textarea
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

{project}/                         ← created by `POST /projects/create` via the home screen
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

| Event | Payload | Notes |
|-------|---------|-------|
| `agent:start` | `{ phase: number, agent: string, model: string }` | `agent` is the role name (e.g. `"qa"`), `model` is the API model ID being used for this dispatch |
| `agent:stream` | `{ phase: number, agent: string, section: string }` | `section` is the current structural heading the agent is writing (e.g. `"Non-functional requirements"`), extracted from `## ` markers in the streaming output. Sent each time a new heading is detected — not on every token. |
| `agent:done` | `{ phase: number, agent: string, artifact: string, tokens_used: { input: number, output: number }, cost_usd: number }` | `artifact` is the relative path within `.clados/` (e.g. `"01-prd.md"`). `cost_usd` is the actual cost of this agent dispatch. |
| `agent:error` | `{ phase: number, agent: string, error_type: string, message: string, retry_count: number, is_skippable: boolean }` | `error_type` is one of `"api_429"`, `"api_5xx"`, `"context_length"`, `"timeout"`, `"parse_error"`. `is_skippable` is `true` only for Wrecker, Security, and Docs. |
| `gate:open` | `{ phase: number, gate_number: number, artifacts: string[], findings: Finding[], revision_count: number, next_phase_cost_estimate: string }` | `artifacts` is the list of artifact paths for this gate. `findings` is the full Validator findings array. `revision_count` is the current value of `gate_revision_count`. `next_phase_cost_estimate` is a pre-formatted string (e.g. `"~$0.45"`). |
| `budget:gate` | `{ current_spend_usd: number, remaining_budget_usd: number, blocked_agent: string, projected_cost_usd: number }` | Sent when the next dispatch would breach the spend cap. |
| `state:snapshot` | Full `00-session-state.json` content (the entire JSON object) | Sent on WebSocket reconnection. The UI replaces its entire local state with this snapshot. |

`Finding` shape (used in `gate:open`):
```json
{
  "id": "f-001",
  "severity": "must_fix",
  "category": "security",
  "description": "No authentication mechanism specified.",
  "file": "01-prd.md",
  "line": 45,
  "status": "new"
}
```
`status` is one of `"new"`, `"resolved"`, `"partially_resolved"`, `"unresolved"`, `"new_discovery"` (present only on re-review).

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
- Floating gate modal with 2-pane / 3-pane modes
- WebSocket client with reconnection
- Column collapse, localStorage persistence

**Infrastructure:**
- Express server with WebSocket upgrade
- Project directory scaffolding

**What makes this feasible:**
- Hardcoded phase sequence (no graph engine to build)
- No custom agent framework
- No IDE bridge or file sync
- Findings-based validation (no score math or threshold tuning)
- UI scoped to board + gate modal (no budget band, no decisions panel)
- One stack (TypeScript) — no polyglot tooling

**What will be hardest:**
- Getting agent prompts right so they produce useful artifacts on real projects
- Context extraction (LSP/Tree-sitter integration with broken generated code)
- The targeted fix loop — scoping re-dispatch correctly so it's actually cheaper
- Crash recovery edge cases
- Making the QA agent's black-box tests actually exercise the right things without seeing the code

**Rough component count:** ~15 TypeScript modules in the orchestrator, ~9 agent prompt files, ~5 React components, ~3 utility scripts (contract validator, test runner, summarizer). This is a focused codebase, not a platform.
