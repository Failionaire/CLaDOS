# CLaDOS — Claude Logic and Development Operating System

A multi-agent software development system built on the Claude API. You describe an idea. A team of AI agents designs, critiques, architects, and builds it — with you approving every major decision before work continues.

Inspired by [azure-agentic-infraops](https://github.com/jonathan-vella/azure-agentic-infraops), adapted for the full software development lifecycle.

---

## The core idea

Most "AI coding" tools generate code and hope for the best. CLaDOS works the way a real modern engineering team does, avoiding the heavy Waterfall trap by prioritizing agile prototyping, rapid iteration, and pragmatic code-as-truth workflows:

- A **Conductor** (Claude Opus) manages the whole process and never writes code itself
- A **Validator** agent acts as an objective linter — using static execution paths, exact test fixtures, and security checklists to find concrete issues rather than hallucinating subjective architectural pedantry
- Every phase ends with a **human approval gate** — you review the output and the Validator's findings, deciding whether to proceed, revise, or explicitly override warnings (preventing LLM death-spirals)
- Phase handoffs are file-based, and cross-file code context is shared via rigorous **AST/LSP programmatic extraction** (interfaces, exports) rather than lossy LLM text summaries
- **[Future]** An Interactive Mode lets users iterate and fix code interactively with the AI in the context of the generated workspace — a separate product surface that ships after the core pipeline is proven

The ultimate proof of success would be if this could be used to make itself.

---

## Scope: v1 core vs. future

This document describes the full vision for CLaDOS. Not all of it ships in v1. The following framework separates what must work first from what gets added later.

**V1 Core — must prove itself on real projects before anything else ships:**
- Conductor driving agents in a hardcoded phase sequence (no configurable DAG)
- PM → Architect → Engineer → Validator → human gate, with revision loops
- File-based artifacts with atomic session state and crash recovery
- Targeted fix loops on Validator findings (not full re-runs)
- Mechanical validation (contract checks, test execution) separated from LLM review
- Budget gating before dispatch (not mid-stream)
- Findings-based validation (must_fix / should_fix / suggestion) — no numeric scores
- One stack: TypeScript end-to-end

**Future expansion — ships only after the core loop is proven:**
- Configurable workflow DAG with condition DSL
- Custom agent framework (`clados agent add`)
- Interactive Mode (post-deployment chat with AST-aware context)
- IDE bridge (bi-directional file sync, deep-link URIs)
- Artifact version pinning UI (version dropdown + "Use this version")
- CLI subcommands (`clados logs`, `clados model-update`)
- Refiner agent (optional polish pass)
- Multi-language / multi-stack support

Features marked **[Future]** throughout this document are part of the long-term vision but explicitly out of scope for v1.

---

## Technology choices

**Runtime:** Claude API directly (TypeScript orchestrator)
- The Conductor is real code, not a chat prompt — it can branch, loop, escalate, and run things in parallel
- Human approval gates are proper UI components, not text prompts
- No dependency on VS Code, GitHub Copilot, or any third-party platform

**UI:** React/Vite web app — a Kanban board with one column per phase

Each phase column contains cards for every agent and artifact within that phase. Card states:
- **Pending** — not yet started
- **Running** — agent is active; the card shows a slow color-cycle border animation and displays the current section the agent is writing (e.g. *"Writing: Non-functional requirements"*), extracted from structural markers in the streaming output rather than raw token output
- **Done** — artifact written to disk, viewable inline
- **Flagged** — Validator returned must-fix findings
- **Error** — agent failed after all retries; shows retry count and a "Retry agent" action

Each agent role has a fixed icon (small inline SVG): PM = document, Architect = blueprint grid, Engineer = `</>`, Security = shield, QA = checkbox, DevOps = gear, Validator = crosshairs, Docs = book. Icons anchor identity to the card; they do not animate between phases.

Gate cards show the artifact and Validator findings side by side in a **floating modal window** (fixed position, dims the board behind it; minimize to a topbar pill). The gate header shows a **revision counter** — *"Revision 2 of 3 before Opus escalation"* — that turns amber at revision 2 and red at revision 3+. The header also shows a **pre-phase cost estimate** for the next phase: *"Next phase: ~$0.45–$1.30 depending on escalation"*, computed from stored artifact token counts and known model pricing before the gate opens.

Gate actions:
- **Approve →** — primary action, proceeds to next phase
- **↺ Ask AI to revise** — opens a three-pane revision view: the artifact pane narrows (40%) but stays visible on the left, the revision textarea appears in the center (30%), and the Validator findings pane stays on the right (30%). On viewports narrower than 1100px, the left pane shows a tab toggle between "Artifact" and "Revision." The findings pane is always visible.
- **⚠ More options** — expands a destructive actions menu with three entries:
  - **Go back to Gate N** — dropdown of previously-passed gates; confirmation dynamically lists every artifact file that will be discarded (e.g. *"Will permanently discard: `01-prd.md`, `01-architecture.md`. Archived to `.clados/history/` — not coming back into the pipeline."*)
  - **Restart this phase** — clears current phase's in-progress artifacts from `.clados/wip/` and re-runs from the first agent; does not archive to history since artifacts are incomplete; confirmation lists what will be cleared
  - **Abandon project** — stops the pipeline, writes `status: "abandoned"` to session state, leaves all artifacts in place; the project can be resumed later or deleted manually; this is not destructive, it is a declared pause

Agent cards that ran with compressed context display a **"Context compressed"** indicator. If the agent subsequently fetched a full artifact via `read_file`, a secondary indicator shows *"Agent fetched N full artifact(s)"* so the human knows at the gate whether the agent self-corrected for the compression.

The topbar includes a **"Decisions"** chip that opens a read-only chronological log of all `conductor_decisions` and `conductor_reasoning` entries across all phases. Each entry shows: phase, agent affected, trigger, decision made, and timestamp. Users can audit the full autonomous decision chain without clicking through individual gates — useful when a Phase 3 problem traces back to a Phase 1 autonomous decision.

After Gate 1 is approved (concept accepted), the topbar displays a **running cost total**: *"$0.38 used"*. This is the actual spend so far, updated after each API call completes. Hovering the chip shows a per-phase breakdown of actual spend. No upfront total estimate is displayed — lower-bound estimates (e.g. "$23+") anchor user expectations and erode trust when actual costs are materially higher due to revisions and escalations. The running total gives users honest, real-time cost visibility without false precision about future spend.

On viewport widths below 1400px, completed phase columns auto-collapse on initial load. Collapse state is persisted to `localStorage` per project. A **"Focus"** button in the topbar collapses all columns except the active one and the gate modal.

The UI connects to the orchestrator over WebSocket for live streaming updates — no polling. If the WebSocket connection drops, the UI enters a reconnection loop: it retries every 5 seconds and displays a topbar banner — *"Connection lost — reconnecting…"* The banner resolves to *"Reconnected"* (green, auto-dismisses after 3 seconds) or *"Could not reconnect — restart CLaDOS to continue"* (amber, persists) after 5 failed attempts. While disconnected, all cards freeze in their last-known state; no card transitions to Error solely due to a connection drop. Plain language everywhere, no AI jargon in status messages.

**Models:**
| Role | Nickname | Default | Escalates to |
|------|----------|---------|--------------|
| Conductor | **GLaDOS** | Claude Opus | N/A — always Opus |
| PM | **Project Manager Core** | Claude Sonnet | Claude Opus |
| Architect | **Architect Core** | Claude Sonnet | Claude Opus |
| Engineer | — | Claude Sonnet | Claude Opus |
| QA | **QA Core** | Claude Sonnet | Claude Opus (Restricted: Asymmetric Context Only) |
| Validator | **Validator Core** | Claude Sonnet | Claude Opus |
| Wrecker *(optional)* | **Wrecker Core** | Claude Sonnet | Claude Opus |
| Refiner *(optional)* **[Future]** | **Refiner Core** | Claude Sonnet | Claude Opus |
| Security *(optional)* | **Security Core** | Claude Sonnet | Claude Opus |
| DevOps | **DevOps Core** | Claude Sonnet | Claude Opus |
| Docs | **Docs Core** | Claude Sonnet | Claude Opus |

Nicknames are display-only — the role name is the canonical identifier in all logs, file names, and API calls. The persona voice of each Core is confined to the Identity section of its system prompt and to the phrasing of questions it emits — it must not appear in the artifact content itself, which must be written in plain professional language appropriate to its type. The PRD reads like a PRD; the Validator's findings read like findings. The Conductor retains GLaDOS as its identity.

Escalation to Opus happens automatically when:
1. A phase has been revised 3+ times without resolving
2. The project is flagged as high-complexity at the start

The Validator uses strict test-results, contract validation, and AST checks to guide its validation instead of relying on subjective LLM critique, significantly reducing token cost spirals. Session state tracks this via a `validator_tier`.

---

## The workflow

### Phase 0 — Concept
Before any agent runs, CLaDOS shows a setup screen with these inputs:

1. **Describe your idea** — free text, any length
2. **Project type**
3. **Agent loadout** — toggleable optional review agents for Phase 2:
   - Security (Security Core)
   - Wrecker (Adversarial edge-case tester)
   - **[Future]** Refiner (Polish pass)
4. **Spend cap** — optional maximum API budget.

The PM agent sharpens the idea into a rapid one-page concept. The Validator reviews it purely for feasibility and obvious blank spots. 
**Gate 1: You approve the prototype scope.**

---

### Phase 1 — Architecture
The Architect defines the project skeleton, tech stack, and a lightweight schema. A Prototype Engineer scaffolds the basic database models and core server skeleton, plus generates `infra/docker-compose.test.yml` and `.env.test` for the test environment. The Validator checks the scaffolding against the schema layout programmatically.
**Gate 2: You approve the architecture prototype.**

---

### Phase 2 — Build
Engineers operate iteratively. Code implementation acts as the source of truth for all downstream layers — not a static spec written in a vacuum.

**Pass 1 — Pre-flight Manifest:** The Engineer receives the scaffold and emits an initial `build-manifest.json` — a list of files it intends to create.
**Pass 2 — Implementation & Living Manifest:** Code is generated in batches. The manifest is not static; if the LLM realizes mid-implementation it needs a shared utility or context provider, it dynamically appends to the manifest. *Crucially, cross-file context is extracted using a Two-Tier AST (Abstract Syntax Tree) / LSP strategy (with Tree-sitter fallback and Haiku semantic descriptions) to provide accurate exports to the Engineers—preventing hallucinated implementations while tolerating temporarily broken syntax.*
**Micro-Pivots (Escaping Waterfall):** If the Engineer discovers a database schema is unworkable, it can emit a `request_architecture_change` tool call. This spawns a **Micro-Gate** in the UI where the human approves a minor schema diff from the Architect to adapt on the fly, without discarding the entire phase. 

**Validation Pipeline:**
Code is executed. A Contract Validator mechanically ensures every declared API endpoint has a matching route registration and vice versa (route-level checks only — request/response shape validation is handled at runtime via `express-openapi-validator` middleware and exercised by the test suite).
**Asymmetric Context QA:** To prevent AI from confirming its own hallucinations, the QA Agent is explicitly denied access to the internal schema or generated source code. It reads the PM's PRD, OpenAPI spec, and a `test-context.json` (base URL, auth mechanism, seed strategy — not source code), forcing it to write pure Black-Box tests (e.g., Cucumber/Playwright) validating the source-of-truth *business requirements*, not the exact implementation details.
The Test-Runner sets up the test environment (installs dependencies, starts database containers via docker-compose, launches the server), executes these tests, and tears down. The Validator Agent reviews these hard execution results and acts as an actionable Linter, not an adversarial philosopher. Warnings are raised, but humans can override `must_fix` blockers to prevent death spirals.

**Gate 3: You approve the code execution (The Build).**

---

### Phase 3 — Document
Once the build executes properly, the Docs and PM agents write the official README, final PRD (`03-prd.md`), and canonical API spec (`03-api-spec.yaml`) *based on the actual functioning codebase*. The Phase 1 `01-api-spec.yaml` is preserved as the original design artifact; `03-api-spec.yaml` is the record of what was actually built and the binding contract for any future re-invocation.
**Gate 4: You approve the documentation.**

---

### Phase 4 — Ship
The DevOps agent handles Dockerfiles, CI/CD, and deployment configs. 
**Gate 5: You approve the deployment.**

---

### [Future] Interactive Mode
Once a project is shipped, CLaDOS converts the UI to an interactive mode where you can highlight generated code and chat with the AI (e.g., "This route throws a 500 when I pass X, fix the DB query") with full AST context of the workspace. This is a separate product surface and ships after the core pipeline is proven.

## Error handling and resilience

The Claude API will return transient errors (429, 500, 502, 503) and occasional context length errors. The Conductor handles these explicitly rather than surfacing them as agent failures.

**Transient errors (429, 5xx):** Exponential backoff with jitter — retries at approximately 2s, 8s, and 30s. After 3 failed retries, the agent's card transitions to the `Error` state (distinct from `Flagged`): amber border, `Error` badge, stream preview replaced with *"Failed after 3 retries — [error type]"*. The card shows two actions: **Retry agent** (re-dispatches from the current agent without re-running earlier agents in the phase) and **Skip agent** (available only where skipping is safe — Wrecker, Security, Docs with warning; never available for Validator or contract-validator).

**Robust Parsing & JSON Sanitizer Middleware:** LLMs frequently wrap JSON in markdown or include conversational prefixes. The Conductor includes deterministic JSON middleware: strip markdown fences, slice to the outermost `{` or `[`, and attempt `JSON.parse`. If deterministic repair fails, the agent is retried with an explicit instruction to produce valid JSON — not silently repaired by a secondary model, which risks semantic drift in critical artifacts.

**During retry:** A card that has been retrying for more than 60 seconds changes its stream preview to *"Retrying — attempt 2 of 3"* and shifts its border animation from blue to amber, distinct from both the normal running state and the error state.

**Context length errors:** The Conductor treats these as a structured event, not a crash. It downgrades all `required` artifacts to summaries and retries once. If the retry also exceeds the context limit, the Conductor forces a gate with the message: *"This agent's inputs are too large to process even with compression. You can simplify the inputs or stop here."*

**Persistent failure:** When an agent reaches the Error state, a `{agent}-error.json` is written to `.clados/wip/` containing: error type, message, retry count, elapsed time, and the artifact path that was being written (if any). This file is preserved even after a successful Retry, for post-run diagnostics.

**Spend cap breach & Pre-Flight Token Budgeting:** If the Conductor's pre-dispatch cost projection (`Tokens available < Context + Expected Output + 20% margin`) would exceed `max_budget`, it does not start the api call. It writes `pipeline_status: "budget_gate_pending"` to session state and opens a `BudgetGateNode` (see DAG schema). The budget gate UI shows: current total spend, the agent that would breach the cap, an inline field to raise the cap, and a button to disable optional agents for the remainder of the run. On `on_continue`, it re-runs the pre-dispatch check with the updated cap.

Budget is always checked *before* dispatch, never terminated mid-stream. Mid-stream termination produces corrupted artifacts (partial JSON, broken code) that trigger Validator findings and revision cycles, creating expensive loops. If the pre-dispatch check passes but the actual call exceeds the projection, the overage is absorbed and the budget gate triggers before the *next* dispatch.

**WebSocket disconnection:** If the WebSocket connection between the UI and the orchestrator drops, the UI retries every 5 seconds. The topbar shows *"Connection lost — reconnecting…"* After 5 failed attempts it shows *"Could not reconnect — restart CLaDOS to continue"* (amber, persistent). Cards freeze in their last-known state; no card transitions to Error solely because the connection dropped — the agent may still be running in the orchestrator process. On reconnection, the orchestrator sends a full state snapshot so the UI resynchronises to the current `pipeline_status` without requiring a page reload.

**Unexpected process exit:** On startup, the Conductor reads `pipeline_status` from session state. If it finds `agent_running` (not `gate_pending`, `budget_gate_pending`, or `abandoned`), it knows it crashed mid-agent and goes directly to crash recovery: inspect `phase_checkpoint.in_progress_artifact_partial`, run the structural marker test, and resume or restart clean. If `in_progress_artifact_partial` points to a file that does not exist (crashed before the first write), the marker test trivially fails and the agent restarts clean — this is the expected and correct outcome, not an error condition.

**API availability:** If `anthropic.beta.messages.countTokens()` is unavailable (endpoint removed or network error), the Conductor falls back to `Math.ceil(chars / 3.5)` for all token estimates and logs a warning to `00-session-state.json` under `conductor_decisions`. The pipeline continues with approximate counting; a persistent topbar warning chip notifies the user that cost estimates are approximate.

---

## After the AI is done — what you do

When CLaDOS finishes a phase, the output lands in folders on your machine. Here is what you may need to do yourself, in plain language:

**After Phase 2 (Build):**
- The test-runner already executed the test suite during the build phase — results are in `02-build/test-runner.json` and were reviewed by the Validator before the gate opened. If tests passed during the build, you can still run them yourself: open a terminal, go to the project folder, run `npm test` (or whatever the QA agent documented)
- Review the generated code — it will be in your project output directory (see Repo structure)

**After Phase 4 (Ship):**
- If you want to deploy to the cloud, you will need accounts set up (AWS, GCP, Azure, Vercel, etc.) — CLaDOS generates the config but cannot create accounts for you
- Run the deploy command the DevOps agent documented in `docs/{project}/runbook.md` — it will be a single command like `npm run deploy` or `docker compose up`
- Set your environment variables (API keys, database passwords, etc.) — CLaDOS will list exactly what is needed and where to put them, but you supply the actual values

**Ongoing:**
- The Validator can be run standalone at any time on any artifact if you want a fresh adversarial review
- Re-invoking CLaDOS on an existing project to add features, fix bugs, or refactor is an intentional future capability. The artifact structure is designed to support it — session state is recoverable, artifacts are versioned, and the DAG is re-enterable at any gate — but the re-invocation workflow itself is out of scope for v1. If you need to modify a generated project, do so directly in `src/` and treat the CLaDOS artifacts as the original specification.

---

## Repo structure

```
clados/                            ← CLaDOS installation (never modified by runs)
  orchestrator/                    ← TypeScript — the brain
    conductor.ts                   ← drives phases (hardcoded sequence in v1; [Future] reads workflow-graph.json)
    escalation.ts                  ← Sonnet → Opus escalation rules
    session.ts                     ← atomic session state writes via write-file-atomic
    parallel.ts                    ← shared semaphore for concurrent API calls; runs engineers
    workflow-graph.json            ← [Future] DAG: phases, edges, conditions (schema defined below)
    agent-registry.json            ← role → {system prompt file, model, tools, enabled_when,
                                      context_artifacts, system_prompt_tokens,
                                      expected_output_tokens, test_timeout_seconds,
                                      max_concurrent_api_calls}

  agents/                          ← Markdown system prompts (required structure defined below)
    conductor.md
    validator.md
    pm.md
    architect.md
    engineer.md                    ← parameterized for frontend or backend
    qa.md
    security.md                    ← optional
    wrecker.md                     ← optional
    refiner.md                     ← [Future] optional
    devops.md
    docs.md
    custom/                        ← [Future] user-defined agent prompts
    _subagents/
      validator-review.md         ← single-lens adversarial review
      schema-designer.md
      contract-validator.ts        ← static analysis; reads OpenAPI spec + source, not an LLM prompt
      test-runner.ts               ← sandboxed test execution; reads prerequisites from QA output
      summarizer.md                ← Haiku-tier; writes {phase}-summary.md concurrently

  ui/                              ← React/Vite web app
    components/
      Gate.tsx                     ← approval gate with three-pane revision view
      KanbanBoard.tsx              ← one column per phase, live card states
      ArtifactViewer.tsx           ← renders .md / .yaml / .json artifacts; [Future] version dropdown + pin
      ValidatorFindings.tsx       ← findings table sorted by severity
      DecisionsPanel.tsx           ← [Future] read-only chronological log of conductor_decisions
    App.tsx

{your-project}/                    ← created in cwd when you run `clados new {name}`
  .clados/
    00-session-state.json          ← machine state: current phase, project_type, autonomy_mode,
                                      test_mode, pipeline_status, resolved_models,
                                      conductor_decisions, conductor_reasoning, validator_tier,
                                      phase_checkpoint, token_budget, max_budget, spec_version,
                                      agent_tool_calls, pipeline_cost_estimate,
                                      dependency_divergences
    run.log                        ← structured JSONL operational log (rotates at 10MB)
    00-concept.md                  ← Phase 0 output; symlink to current version
    00-concept_v1.md               ← versioned artifact; revisions produce _v2.md, _v3.md, etc.
    00-validator.json
    01-prd.md                      ← Phase 1 output
    01-prd_v1.md
    01-architecture.md
    01-api-spec.yaml
    01-schema.yaml
    01-validator.json
    02-build/                      ← Phase 2 build artifacts, named by agent slug
      backend-engineer-manifest.json
      frontend-engineer-manifest.json   ← full-stack projects only
      test-context.json                 ← test environment config for QA
      contract-validator.json
      test-runner.json
      validator.json
      wrecker.json                      ← if enabled
      security-report.md                ← if enabled
    03-prd.md                      ← final PRD based on actual build
    03-api-spec.yaml               ← canonical API spec as actually built
    history/                       ← all superseded artifact versions archived here
    wip/                           ← partial artifacts and error files written here during active
                                      agent runs; renamed/moved to final path on completion
  src/                             ← generated source code
  tests/                           ← generated tests
  infra/                           ← CI/CD, Dockerfiles, env config
  docs/                            ← README, changelog, runbook
```

**Artifact naming convention:** Artifacts use `{phase-number}-{name}.{ext}` (e.g. `00-concept.md`, `01-validator.json`, `02-build/security-report.md`). The numeric prefix equals the phase number: Phase 0 → `00-`, Phase 1 → `01-`, Phase 2 → `02-`, etc. Phase 2 (Build) artifacts live in a `02-build/` subdirectory because the phase generates many files from several agents; all other phases write directly into `.clados/`.

---

## Key design decisions

**Validation is split between mechanical checks and LLM review.** Mechanical checks (contract validation against OpenAPI spec, test execution, schema conformance) are code — deterministic, reproducible, and not subject to LLM opinion. The Validator agent handles subjective review (feasibility, completeness) and produces structured JSON findings with severity levels (must_fix, should_fix, suggestion). Its system prompt instructs it to find problems, not be helpful. Mechanical check failures automatically produce `must_fix` findings. The Validator's LLM-based findings are clearly labeled as advisory — the human at the gate decides which to act on.

**Human Override is King.** To prevent death spirals where the Validator hallucinates overly pedantic requirements, users can override any `must_fix` finding at the gate. The human's decision is final — the pipeline cannot force a block that the user has explicitly overridden.

**[v1] The workflow is a hardcoded phase sequence.** In v1, the Conductor drives a fixed sequence: Concept → Architecture → Build → Document → Ship. Phase transitions, agent ordering within phases, and gate placement are expressed directly in TypeScript — simple and debuggable. **[Future]** This evolves into a configurable DAG where `workflow-graph.json` defines phases as nodes and transitions as edges with conditions. The schema is:

```typescript
// Conditions use a minimal string DSL: "field operator value"
// Operators: ==, !=, >, <, in
// Unknown field references evaluate to false, never throw
// Cycles are validated at startup via DFS; CLaDOS refuses to start if any cycle is found

interface AgentNode {
  id: string;
  role: string;
  enabled_when?: string;   // e.g. "project_type == full-stack"
  on_complete: string;     // id of next node
  on_skip: string;         // id of next node when enabled_when is false
  on_fail: string;         // id of gate node or error handler node
}

interface GateNode {
  id: string;
  type: "gate";
  on_approve: string;      // id of first node in next phase
  on_revise: string;       // id of first agent node in current phase
  on_abort: string;        // id of cleanup node that clears .clados/wip/ for current phase
  on_goto: Record<string, string>;  // gate_id → first agent node for that phase
}

interface BudgetGateNode {
  id: string;
  type: "budget_gate";
  triggered_by: string;   // id of the agent node whose dispatch would breach the cap
  on_continue: string;    // re-runs pre-dispatch check with updated cap, then proceeds to triggered_by
  on_abort: string;       // id of cleanup node
}

interface CleanupNode {
  id: string;
  type: "cleanup";
  clears: "wip";           // only wip/ is cleared; history/ is never touched by cleanup
  on_complete: string;     // routes back to first agent node for the phase
}
```

Condition evaluation uses a trivial string parser — no arbitrary JavaScript, no `eval`. Adding or reordering phases means editing the graph, not the Conductor's code.

**Parallel build requires a shared contract, and contract drift is detected mechanically.** Both Engineers are given the OpenAPI spec as a hard constraint. A `spec_version` integer in `00-session-state.json` increments whenever `01-api-spec.yaml` is modified. When the frontend Engineer's output is revised, the Conductor compares the spec version the backend Engineer ran against the current version. If they differ, a targeted contract-validator re-run and Validator integration review are queued for the backend — not a full re-run.

**Every artifact is a file.** Agents do not share context windows. They read the previous artifact from disk and write their output to disk. This means any phase can be re-run without re-running the whole pipeline, and humans can read or edit any artifact at any time.

**Session state is always recoverable.** `00-session-state.json` records every decision made, every artifact path, and the current phase. A `phase_checkpoint` object tracks progress *within* a phase — which agents have completed, which is in flight, and the path to any partial artifact currently being written. If you close the app and come back later, the Conductor reads this file and picks up exactly where it left off.

**Gates block on a real async suspension point.** The orchestrator runs as a persistent Express server. When the Conductor reaches a gate node in the DAG, it pauses by awaiting a Promise. The UI resolves this Promise by POSTing to `/gate/respond` with the human's decision (`approve`, `revise`, `abort`, or `goto`). No polling, no file-based signaling.

**[Future] IDE Bridge (Bi-directional File Sync):** File watchers on `.clados/wip/` and `/src/` that auto-refresh the Gate UI when users edit files externally, plus deep-link URIs (e.g. `vscode://file/{project}/src/utils.ts:44`) that open Validator findings directly in the user's IDE. Ships after the core pipeline is stable — adds file-watcher complexity, race conditions between AI writes and user edits, and platform-specific URI handling.

**The Conductor is TypeScript, not Claude.** The Conductor never calls the Claude API for its own reasoning — it is deterministic code that reads the DAG and drives execution. Claude is only invoked for specialist agents. Each invocation follows the standard agentic loop: the Conductor sends the agent's system prompt, prior artifacts as context, and a declared tool set to the API, then handles tool calls in a loop until the agent emits a final text artifact. Tools (`read_file`, `write_file`, `list_files`) are implemented as Node.js `fs` operations inside the orchestrator. Which tools each agent receives is declared in `agent-registry.json`.

**The Conductor has a single reasoning escape hatch.** For genuinely ambiguous situations that deterministic code cannot resolve, the Conductor calls `conductor.reason(context, question)` to invoke Claude Opus for a single decision. The specific trigger is: 3 consecutive revision cycles where the same `must_fix` findings remain unresolved. After a reasoning-guided re-run that still fails, the loop does not repeat — the Conductor forces a gate with the message: *"Three revisions haven't resolved this. You need to decide how to proceed."* Every `conductor.reason()` call is logged to `00-session-state.json` under `conductor_reasoning` (context, question, and decision returned). This escape hatch should be rare; if it fires frequently, the underlying prompts or validation criteria need adjustment, not the orchestrator.

**Project type drives the DAG at runtime.** Phase 0 writes `project_type` into session state. Every agent entry in `agent-registry.json` can declare an `enabled_when` condition. Changing project type is handled by going back to Gate 0 — the confirmation message specifies which agents and artifacts are affected by the change. Mid-pipeline mutation of project type without going back to Gate 0 is not supported.

**Context injection is declared, not implicit.** Each entry in `agent-registry.json` includes a `context_artifacts` list where each artifact declares a type: `required` (injected in full, always) or `reference` (injected as a compressed summary by default, full artifact available via `read_file`). When the Conductor force-downgrades a `required` artifact to a summary due to token budget pressure, it adds `read_file` to that agent's tool permissions for that specific artifact path, so the agent can self-correct if the summary is insufficient. Any `read_file` call on a force-downgraded artifact is logged in `00-session-state.json` under `agent_tool_calls` per phase checkpoint entry, and shown in the UI alongside the "Context compressed" indicator.

**Context extraction uses a robust Two-Tier pattern.** CLaDOS relies on standard LSP integrations to extract signatures, exports, and public methods representing the code context for downstream agents. Because generated code may contain temporary syntax errors (missing brackets), leaving strict LSP servers returning empty trees, the Conductor implements a unified fallback:
1. **LSP parsing** to get precise exact AST exports.
2. **Tree-sitter fallback** to gracefully parse broken syntax if LSP crashes.
3. **Semantic Context Mapping**, generated by a cheap side-model (Haiku). It emits a one-line summary (e.g. `src/payment.ts: Exports processPayment. Handles Stripe formatting.`) which is paired with the AST structure to give the downstream LLM *intent* along with rigid types.

**Context budget is enforced automatically.** Token counts are stored in `00-session-state.json` at artifact write time, calculated once using `anthropic.beta.messages.countTokens()` from the official SDK — a lightweight counting call with no generation, producing exact counts against Anthropic's actual context limits. This call is wrapped with a graceful fallback: if it fails, the Conductor falls back to `Math.ceil(chars / 3.5)` and logs a warning; the pipeline degrades to approximate counting rather than breaking. At inject time, projection is pure arithmetic. If projected context would exceed 80K tokens, the Conductor applies a two-stage downgrade: `reference` artifacts are reduced to summaries first; if still over budget, `required` artifacts are downgraded with `read_file` access granted. Both decisions are logged.

**Artifacts are versioned, never overwritten.** When a phase is revised, the previous artifact is renamed to `{name}_vN.md` and preserved in `.clados/history/`. Session state tracks the current version number per artifact. **[Future]** The UI's artifact links show a version dropdown with a "Use this version" action on any non-current entry — this version pinning UI ships after the core loop is stable.

**Agents can surface ambiguity before they write.** Before generating its main artifact, an agent may emit a `{phase}-questions.json` — a structured list of ambiguities with a `default_if_auto` field for each. In Guided mode, a lightweight gate pauses for user answers. In Autonomous mode, the Conductor logs its own answers. Either way, every question and decision is preserved in `00-session-state.json` and visible in the Decisions panel.

**Validation is findings-based, not score-based.** Review agents produce structured findings categorized as `must_fix`, `should_fix`, or `suggestion` — not numeric scores. On a re-review, the agent must explicitly classify each prior finding as `resolved`, `partially_resolved`, or `unresolved`. New findings must be tagged `new_discovery`. The Conductor routes based on whether open `must_fix` findings exist, not on arbitrary numeric thresholds. This avoids false precision from LLM-generated scores that fluctuate nondeterministically across identical inputs.

**Agent system prompts have a required structure.** Every agent prompt — built-in and custom — must contain these sections in order:

```
## Identity
[Role name and persona voice. Voice applies to questions emitted and status messages only —
not to artifact content, which must use plain professional language appropriate to its type.]

## Inputs
[Which artifacts this agent receives and in what format.]

## Task
[What this agent must produce.]

## Output schema
[Exact structure of the output artifact — JSON schema for structured outputs,
required section list for prose artifacts.]

## Constraints
[What this agent must not do — e.g. "do not modify the API spec", "do not produce must_fix findings".]
```

If any mandatory section is missing, the Conductor logs a configuration error at startup and refuses to dispatch the agent.

**[Future] Custom agents have two tiers.** `clados agent add` prompts for a mode:

- `--mode reviewer` (default): scaffolds a minimal prompt that produces freeform text findings. An adapter in the Conductor converts these to the structured findings schema. Suitable for quick custom checks without learning the schema.
- `--mode agent` (advanced): full scaffold with required sections, structured output, and fix loop support. Uses the same dispatch loop and toolset as built-in agents.

Custom agents ship after the core agent set is proven. Zero users need extensibility before the built-in loop works reliably.

**The pipeline has an explicit state machine.** `pipeline_status` in `00-session-state.json` is the canonical record of what the Conductor is doing. Valid values and their transitions:

| Status | Meaning | Transitions to |
|--------|---------|----------------|
| `idle` | Not yet started | `agent_running` |
| `agent_running` | An agent is dispatched and active | `gate_pending`, `budget_gate_pending`, `idle` (next agent) |
| `gate_pending` | Waiting at a human approval gate | `agent_running` (on approve/revise), `abandoned` |
| `budget_gate_pending` | Paused at spend cap; waiting for human | `agent_running` (on continue), `abandoned` |
| `abandoned` | Human stopped the pipeline | — (terminal) |
| `complete` | All phases approved | — (terminal) |

The Conductor writes session state atomically on every transition. All writes go to `.clados/00-session-state.tmp.json` first; `fs.rename()` then atomically replaces `00-session-state.json`. On POSIX filesystems, rename is atomic when source and destination are on the same filesystem (they always are here). On Windows, use `write-file-atomic` (npm) which handles the non-atomic rename edge case. On startup, if `.clados/00-session-state.tmp.json` exists alongside `00-session-state.json`, the process died during the rename — discard the tmp file and treat the last successfully renamed state as canonical. On startup, if `pipeline_status` is `agent_running`, proceed directly to crash recovery. If `gate_pending` or `budget_gate_pending`, re-open the relevant gate UI. If `abandoned` or `complete`, present the appropriate final state.

**Cost visibility is based on actual spend, not projections.** The topbar shows a running total of actual API spend, updated after each call completes. Hovering shows a per-phase breakdown. No upfront pipeline estimate is displayed — lower-bound projections anchor user expectations and erode trust when actual costs are materially higher due to revisions and escalations. Per-gate, a single-pass cost estimate for the *next phase only* is shown (*"Next phase: ~$0.45"*), clearly labeled as assuming zero revisions.

**Pre-gate next-phase cost estimates include system prompt tokens.** The per-gate estimate (*"Next phase: ~$0.45"*) accounts for: system prompt tokens per agent (from `agent-registry.json`), projected input artifact tokens (from stored counts), and a fixed output estimate per agent role (declared in the registry as `expected_output_tokens`). It does not speculate on revision cycles — it represents a single-pass cost. System prompt tokens are calculated once at CLaDOS startup using `countTokens()` and stored in the registry entry; they are not recalculated per run.

**Budget is tracked per API call.** The Conductor accumulates token usage from each API response's `usage` field into `phase_checkpoint.agent_tokens_used`. Before dispatching the next API call (whether a new turn in an agentic loop or a new agent), it checks: would the projected cost exceed the remaining budget? If yes, it triggers the budget gate *before* the call — budget is never enforced mid-stream, which would produce corrupted artifacts.

**Session state tracks mid-phase progress for crash recovery.** When an agent writes its artifact, it appends to a file in `.clados/wip/` as tokens stream in, then renames to the final path on completion. The `phase_checkpoint` object records which agents have completed, which is in flight, and the path to any partial file:

```json
"phase_checkpoint": {
  "phase": 2,
  "completed_agents": ["backend-engineer", "qa"],
  "in_progress_agent": "security",
  "in_progress_artifact_partial": ".clados/wip/02-security-report.partial.md",
  "spec_version_at_start": 2
}
```

On restart, the Conductor inspects the partial file for structural markers before deciding how to resume:

- **Markdown** (`.md`): at least one `##` section heading present
- **JSON** (`.json`): at least one top-level key present
- **YAML** (`.yaml`): at least one unindented key matching `^[a-zA-Z][\w-]*:` present (covers `01-api-spec.yaml`, `01-schema.yaml`, and similar)

If the structural marker test passes, the Conductor includes the partial content in the restarted agent's context and instructs it to continue rather than restart clean. If the test fails, the agent restarts clean.

**Engineer fix loops are targeted, not full re-runs.** When the Validator or Wrecker flags bugs in specific files, the Conductor re-dispatches the Engineer with a scoped instruction identifying the files to revise and the findings to address. The manifest's `revised` flag is set to `true` for those entries. Unaffected files are not sent and not re-generated. The re-dispatch receives: the full manifest, the findings, and the current content of only the flagged files. This makes fix loop cost proportional to the number of flagged files, not the size of the project — a one-bug fix on a 20-file project dispatches one file's worth of context, not twenty.

**Engineer batch calls include full content for direct dependencies.** Each batch in pass 2 receives the full file content of any files declared as direct dependencies of the current batch's entries (via the `dependencies` field in the manifest), and summary-only listings of everything else already written. A file written in batch 1 that exports type signatures used by a batch 4 file is included in full for batch 4 — a summary of "file A exports some types" is insufficient for type-safe code generation. The manifest declares these relationships explicitly, so the Conductor can compute exactly which prior files each batch needs in full.

**Engineer manifests validate against the Architect's declared dependencies.** The Architect's `01-architecture.md` includes a declared dependency list (npm packages, external services, infrastructure). The Conductor reads this list after the Engineer produces its manifest and compares it to the packages declared in the manifest's `package.json` entry. Any package the Engineer introduces that wasn't declared in the architecture is added to `dependency_divergences` in session state and shown at Gate 3 as an informational item — not a blocking finding. The human can decide at the gate whether the divergence is acceptable.

**[Future] `clados logs` provides filtered views of the operational log.** The command supports these flags: `--agent <name>` (filter by agent slug), `--phase <n>` (filter by phase number), `--event <type>` (filter by event type: `api_call`, `file_write`, `phase_transition`, `error`), `--since <duration>` (e.g. `30m`, `2h`, `1d`), and `--errors` (shorthand for `--event api_call` filtered to non-2xx status codes). Examples: `clados logs --phase 2 --agent backend-engineer` shows all API calls and file writes for the backend engineer in Phase 2; `clados logs --errors --since 1h` shows all failed API calls in the last hour. Output is formatted as human-readable table rows, not raw JSONL, unless `--raw` is passed. At `clados new` time, the Conductor resolves model aliases to current API strings and writes them to `00-session-state.json` under `resolved_models`:

```json
"resolved_models": {
  "sonnet": "claude-sonnet-4-5-20251001",
  "opus":   "claude-opus-4-5-20251001"
}
```

All subsequent API calls use these pinned strings — never the aliases. A model release mid-project does not affect the current run. **[Future]** `clados model-update` re-resolves and overwrites `resolved_models`, but only takes effect at the next phase boundary, never mid-phase.

**The Engineer builds in two passes with a manifest as the continuity mechanism.** Code generation for real projects spans 20+ files that cannot fit in one context window. The Engineer's first pass produces a `{phase}-build/{engineer}-manifest.json` — a flat list of every file to create, with path, purpose, and intra-manifest dependencies. No code is written in pass 1. The Conductor validates manifest structure before dispatching pass 2. In pass 2, the Engineer works through the manifest in dependency order, writing files in batches of 3–5 per API call. Each batch receives the full manifest plus a summary list of already-written files as persistent context. The contract-validator and test-runner both receive the manifest so they can flag declared-but-missing files explicitly. If the process crashes mid-pass 2, `phase_checkpoint` records which manifest entries are complete; restart resumes from the next unwritten entry.

**Parallel API calls are rate-limited by a shared semaphore.** `parallel.ts` maintains a process-wide semaphore (default: 3 max concurrent calls, configurable as `max_concurrent_api_calls` in `agent-registry.json`). Every agent acquires a slot before any API call — including retry attempts — and releases it on response. Two parallel engineers cannot simultaneously hit rate limits and simultaneously retry; they queue behind the semaphore. The limit applies across all agents in the process, so enabling more optional agents in Phase 3 automatically increases contention and slows throughput rather than burning through rate limits.

**The orchestrator writes a structured operational log.** `.clados/run.log` is a JSONL file — one record per event — written by the Conductor throughout the run:

```json
{"ts":"2025-01-15T14:23:01Z","event":"api_call","agent":"pm","model":"claude-sonnet-4-5-20251001","input_tokens":4821,"output_tokens":1203,"latency_ms":8341,"status":200}
{"ts":"2025-01-15T14:23:10Z","event":"file_write","path":".clados/01-prd.md","bytes":4892,"op":"create"}
{"ts":"2025-01-15T14:23:10Z","event":"phase_transition","from":"pm-agent","to":"validator-agent","phase":1}
{"ts":"2025-01-15T14:31:44Z","event":"api_call","agent":"engineer","model":"claude-sonnet-4-5-20251001","input_tokens":18200,"output_tokens":3100,"latency_ms":22100,"status":429,"retry":1}
```

Session state is application state; `run.log` is operational history. They are separate concerns. The log rotates at 10MB (rename to `run.log.1`, start fresh). **[Future]** `clados logs` will tail and filter the log without requiring the user to parse JSONL manually; until then, standard JSONL tools work. When a user reports "Phase 3 took 45 minutes and cost $15", `run.log` is what you read to reconstruct which API calls caused it.

**The abort path has three distinct actions.** Going back (archives and re-runs from an earlier gate), restarting a phase (clears `.clados/wip/` for the current phase and re-runs from the first agent, without archiving incomplete artifacts), and abandoning (declares `status: "abandoned"` in session state and stops the pipeline, leaving all artifacts in place for later resumption or manual deletion) are distinct operations with separate confirmation flows. The `on_abort` DAG edge handles the restart case and routes through a cleanup node before returning to the first agent node of the current phase.

**Output is owned by the project, not CLaDOS.** All generated artifacts land in the directory where `clados new` was run. The `.clados/` subfolder holds agent artifacts and session state; `src/`, `tests/`, `infra/`, and `docs/` are standard project folders the user can treat as their own repo. The CLaDOS installation never accumulates project-specific files and can be updated independently of any project.
