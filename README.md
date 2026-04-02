# CLaDOS

## Highly Experimental (Use at your own risk)

**Claude Logic and Development Operating System**

A multi-agent software development system built on the Claude API. You describe an idea. A team of AI agents designs, critiques, architects, and builds it — with you approving every major decision before work continues.

> *The Conductor retains GLaDOS as its identity.*

---

## Getting Started

### Prerequisites

- **Node.js 18+**
- **Docker Desktop** — required for Phase 2 (the test runner spins up a database container)
- **Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com)

### Install from source

```bash
git clone https://github.com/Failionaire/CLaDOS.git
cd CLaDOS
npm install
npm run build:all
```

`build:all` compiles the TypeScript orchestrator and builds the React UI into `ui/dist/`. Both are required — the server serves the UI as static files.

### Run

```bash
# macOS / Linux
export ANTHROPIC_API_KEY=sk-ant-...
node bin/clados.js

# Windows PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node bin/clados.js
```

This starts a local server on a port between 3100–3199 and opens the UI in your browser. The **home screen** lets you create a new project or pick up an existing one. From there everything is driven through the web interface.

### Optional: add `clados` to your PATH

```bash
npm link
# Now you can use: clados
```

### CLI subcommands

```
clados                             Start the server and open the UI
clados continue <project-dir>      Re-enter a completed project with new changes
clados doctor [project-dir]        Validate session state integrity
clados logs [project-dir]          View filtered run.log (--agent, --phase, --errors, --raw)
clados cost <project-dir>          Detailed per-phase, per-agent cost breakdown
clados model-update [--apply]      Check/apply model alias updates in agent-registry.json
clados workflow show               Print the current workflow graph as a table
clados workflow validate           Run cycle detection and condition parsing on the graph
clados agent add --name X ...      Scaffold a custom reviewer or agent
clados agent list                  Show all registered agents (built-in and custom)
clados agent remove <name>         Remove a custom agent
clados agent test <name>           Dry-run dispatch against a sample project
clados template list               Show all built-in and user templates
clados template use <name>         Pre-fill a new project from a template
clados template save <name>        Save the current project's config as a template
clados help                        Show this list
```

### Cost

Currently running Haiku for agents and Sonnet for escalation and the Conductor. To swap models, edit `agent-registry.json`.

---

## What it is

Most "AI coding" tools generate code and hope for the best. CLaDOS works the way a real engineering team does — prioritizing agile prototyping, rapid iteration, and code-as-truth workflows:

- A **Conductor** (Claude Sonnet) manages the entire process and never writes code itself
- A **Validator** agent acts as an objective linter — using static execution paths, exact test fixtures, and security checklists to find concrete issues, not hallucinated architectural pedantry
- Every phase ends with a **human approval gate** — you review the output and the Validator's findings, deciding whether to proceed, revise, or explicitly override warnings
- Phase handoffs are file-based, with cross-file code context shared via **AST/LSP programmatic extraction** rather than lossy LLM text summaries

---

## How it works

CLaDOS runs as a persistent orchestrator server with a React/Vite Kanban board UI. Each column on the board represents a pipeline phase. Each card is an agent or artifact.

### The pipeline

```
Phase 0 — Concept       PM runs a discovery pass (questions + assumptions).
                        You answer or accept defaults at the Discovery Gate.
                        PM writes the concept doc. Validator reviews.
     ↓ Gate 1: Approve the prototype scope.
Phase 1 — Architecture  PM writes full PRD. Architect defines stack and schema.
                        Prototype Engineer scaffolds real code.
     ↓ Gate 2: Approve the architecture.
Phase 2 — Build         Engineers implement in batches. Contract Validator runs.
                        QA writes black-box tests (no source access).
                        Test Runner executes everything.
                        Validator reviews the full build.
                        Refiner auto-fixes should_fix/suggestion findings (if enabled).
                        (Engineers can request architecture changes mid-build
                        via Micro-Gate — user approves the diff before work continues.)
     ↓ Gate 3: Approve the build.
Phase 3 — Document      Docs and PM write README, runbook, and final API spec
                        based on the actual functioning codebase.
     ↓ Gate 4: Approve the documentation.
Phase 4 — Infra         DevOps generates Dockerfiles, CI/CD, and deployment config.
     ↓ Gate 5: Approve the deployment.

After Gate 5:           Interactive Mode — chat directly with the codebase using
                        full AST context. The AI proposes diffs; you approve writes.
                        Run `clados continue <project>` to re-invoke the pipeline
                        for a new feature, bug fix, or refactor.
```

### Agents

| Agent | Role | Default Model |
|-------|------|--------------|
| PM | Discovery → Concept → PRD → final spec | Claude Haiku |
| Architect | Stack, schema, OpenAPI spec | Claude Haiku |
| Engineer | Code implementation in batches | Claude Haiku |
| QA | Black-box tests (asymmetric context — no source access) | Claude Haiku |
| Validator | Hard results review + structured findings | Claude Haiku |
| Refiner *(optional)* | Auto-fixes should_fix/suggestion findings from Validator | Claude Sonnet |
| Security *(optional)* | Threat model + dependency audit | Claude Haiku |
| Wrecker *(optional)* | Adversarial edge-case tests | Claude Haiku |
| DevOps | Dockerfiles, CI/CD, runbook | Claude Haiku |
| Docs | README, changelog, runbook | Claude Haiku |
| Interactive *(post-pipeline)* | Chat-based iteration on the completed project | Claude Haiku |
| Conductor | Orchestration — TypeScript, not a prompt | Claude Sonnet |

Any agent escalates to Sonnet automatically when a phase hits 3 unresolved revision cycles or the project is flagged as high-complexity.

---

## Key design decisions

**Validation is split.** Mechanical checks (contract validation, test execution) are deterministic code. The Validator agent handles subjective review and produces structured JSON findings with severity levels (`must_fix`, `should_fix`, `suggestion`). The two layers are not interchangeable.

**Human override is final.** The pipeline cannot force a block the user has explicitly overridden. This prevents death spirals where the Validator flags hallucinated requirements.

**Asymmetric Context QA.** The QA agent is denied access to source code and schema. It reads only the PRD, OpenAPI spec, and a `test-context.json` — forcing it to write pure black-box tests against business requirements, not implementation details.

**Every artifact is a file.** Agents do not share context windows. They read prior artifacts from disk and write to disk. Any phase can be re-run without re-running the whole pipeline.

**Session state is always recoverable.** `00-session-state.json` records every decision and artifact path. A `phase_checkpoint` tracks which agents have completed, which is in-flight, and the path to any partial artifact being written. Close the app and come back later — the Conductor picks up exactly where it left off.

**The Conductor is TypeScript, not Claude.** The Conductor never calls the Claude API for its own reasoning. It is deterministic code. Claude is invoked only for specialist agents and a single reasoning escape hatch (`conductor.reason()`) for genuinely stuck revision loops.

**Budget is always enforced before dispatch, never mid-stream.** Mid-stream termination produces corrupted artifacts that trigger Validator findings and expensive revision cycles. Pre-flight token budgeting prevents this entirely.

**Workflow is a graph, not hardcoded.** The phase sequence is encoded in `workflow-graph.default.json` and evaluated by a condition DSL engine. Custom workflows can override it without changing the Conductor. No `eval()` — conditions are field/operator/value string expressions only.

**Multi-language, same pipeline.** TypeScript, Python, and Go projects use the same orchestrator, phases, and gate flow. Language-specific behavior is isolated to stack profiles, route parsers, and test executors — the Conductor doesn't care what language it's building.

**Re-invocation is a first-class workflow.** Once a project completes, `clados continue` re-enters the pipeline at the right phase for the change being made (concept, architecture, build, docs, or infra). Prior artifacts carry forward. The delta is shown explicitly at each gate.

---

## UI

React/Vite Kanban board with Aperture Science theme (dark and light modes, self-hosted fonts).

- One column per phase, each containing agent cards
- Card states: Pending → Running → Done / Flagged / Error
- Running cards show the current section being written with a slow color-cycle border animation, elapsed timer, section checklist, and live token bar
- Gate modal: floating, three-pane layout (artifact | revision note | findings); hides the findings pane when no findings exist
- Decisions panel: audit trail of every conductor decision, question answered, and `conductor.reason()` call
- Budget band: expandable bar showing spend vs cap, which agent would breach, inline cap-raise, optional agent toggles
- Micro-Gate: compact diff-approval modal when the Engineer requests an architecture change mid-build
- Question Gate: unified discovery/agent-question form with default assumptions as placeholders
- Artifact version dropdown on done cards with rollback to any history version
- Interactive chat panel (visible after pipeline completes): message the codebase and approve proposed diffs
- Re-invocation Gate: phase classification + override before re-entering the pipeline on a completed project
- Revision counter turns amber at revision 2, red at revision 3+
- Per-gate cost estimate for the next phase; running total in topbar after Gate 1
- No upfront pipeline estimate — lower-bound anchors erode trust

---

## Roadmap

### v1–v4 — Core pipeline through lifecycle *(implemented)*
The full V1–V4 feature set is implemented:
- 5-phase hardcoded sequence (Concept → Architecture → Build → Document → Infra)
- 11 agents including Refiner and Interactive
- Discovery gate (Phase 0 two-pass PM flow) and agent question gates
- Micro-pivots during Build (Engineer requests architecture change; user approves diff)
- Configurable workflow DAG with condition DSL (`workflow-graph.default.json`)
- Custom agent framework (`clados agent add/list/remove/test`)
- IDE bridge (file watcher on `src/` and `wip/`, deep-link URIs in Validator findings)
- Multi-language support: TypeScript (Express), Python (FastAPI), Go (Gin)
- Interactive Mode (post-pipeline AST-aware chat, diff approval)
- Re-invocation workflow (`clados continue`, delta detection, re-invocation gate)
- Decisions panel, budget band, artifact version pinning
- Full CLI: `doctor`, `logs`, `cost`, `model-update`, `workflow`, `agent`, `template`, `continue`
- Session state SHA-256 checksums, `clados doctor` integrity validation
- Troubleshooting guide and operator runbook

### Next — Prove it on real projects
Before adding anything new, the pipeline needs to complete end-to-end on real projects across all three languages and multiple project types. Priorities:
1. Run 3 TypeScript projects (backend API, full-stack app, CLI tool) to completion
2. Run 1 Python FastAPI project to verify the language layer works
3. Test crash recovery with intentional process kills
4. Calibrate budget caps for Sonnet/Opus production models
5. First real use of `clados continue` to add a feature to a completed project

### Future
- Go support in contract validator and test runner (executors implemented, parser needs validation)
- Rust support (stack profile exists; executor and parser not yet implemented)
- Additional languages (Java, Ruby) — only after Go/Rust are proven
- `clados agent test` dry-run for custom agents with real project fixture
- Enhanced cost analytics dashboard in the UI (currently CLI-only via `clados cost`)

---

## Docs

- [User Guide](docs/User-Guide.md) — step-by-step walkthrough of the pipeline, CLI, and UI
- [Troubleshooting](docs/Troubleshooting.md) — operator runbook for the most common failures
- [System specification](docs/CLaDOS-Spec.md) — full design rationale, architecture decisions, and pipeline spec

---

## Status

**V1–V4 feature implementation complete.** Full pipeline, all 11 agents, configurable DAG, multi-language support (TypeScript, Python, Go), interactive mode, re-invocation, and full CLI implemented. Active field testing underway on real projects to validate end-to-end behavior before declaring a stable release.

See [CHANGELOG](Changelog.md) for the full history.

---

## Inspiration

Inspired by [azure-agentic-infraops](https://github.com/jonathan-vella/azure-agentic-infraops), adapted for the full software development lifecycle.
