# CLaDOS

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

This starts a local server on a port between 3100–3199 and opens the UI in your browser. The **home screen** lets you create a new project or pick up an existing one — no subcommands needed. From there everything is driven through the web interface.

### Optional: add `clados` to your PATH

```bash
npm link
# Now you can use: clados
```

### Cost

The default models are Claude Sonnet (agents) and Claude Opus (escalation). A full backend-only pipeline costs roughly **$0.50–$2.00** depending on project complexity and revision count. To test cheaply, swap all models in `agent-registry.json` to `claude-haiku-4-5` — see [docs/Testing-Plan.md](docs/Testing-Plan.md).

---

## What it is

Most "AI coding" tools generate code and hope for the best. CLaDOS works the way a real engineering team does — prioritizing agile prototyping, rapid iteration, and code-as-truth workflows:

- A **Conductor** (Claude Opus) manages the entire process and never writes code itself
- A **Validator** agent acts as an objective linter — using static execution paths, exact test fixtures, and security checklists to find concrete issues, not hallucinated architectural pedantry
- Every phase ends with a **human approval gate** — you review the output and the Validator's findings, deciding whether to proceed, revise, or explicitly override warnings
- Phase handoffs are file-based, with cross-file code context shared via **AST/LSP programmatic extraction** rather than lossy LLM text summaries

---

## How it works

CLaDOS runs as a persistent orchestrator server with a React/Vite Kanban board UI. Each column on the board represents a pipeline phase. Each card is an agent or artifact.

### The pipeline

```
Phase 0 — Concept       PM drafts a one-page concept. Validator reviews.
     ↓ Gate 1: Approve the prototype scope.
Phase 1 — Architecture  PM writes full PRD. Architect defines stack and schema.
                        Prototype Engineer scaffolds real code.
     ↓ Gate 2: Approve the architecture.
Phase 2 — Build         Engineers implement in batches. Contract Validator runs.
                        QA writes black-box tests (no source access).
                        Test Runner executes everything. Validator reviews results.
     ↓ Gate 3: Approve the build.
Phase 3 — Document      Docs and PM write README, runbook, and final API spec
                        based on the actual functioning codebase.
     ↓ Gate 4: Approve the documentation.
Phase 4 — Ship          DevOps generates Dockerfiles, CI/CD, and deployment config.
     ↓ Gate 5: Approve the deployment.
```

### Agents

| Agent | Role | Default Model |
|-------|------|--------------|
| PM | Concept → PRD → final spec | Claude Sonnet |
| Architect | Stack, schema, OpenAPI spec | Claude Sonnet |
| Engineer | Code implementation in batches | Claude Sonnet |
| QA | Black-box tests (asymmetric context — no source access) | Claude Sonnet |
| Validator | Hard results review + structured findings | Claude Sonnet |
| Security *(optional)* | Threat model + dependency audit | Claude Sonnet |
| Wrecker *(optional)* | Adversarial edge-case tests | Claude Sonnet |
| DevOps | Dockerfiles, CI/CD, runbook | Claude Sonnet |
| Docs | README, changelog, runbook | Claude Sonnet |
| Conductor | Orchestration — TypeScript, not a prompt | Claude Opus |

Any agent escalates to Opus automatically when a phase hits 3 unresolved revision cycles or the project is flagged as high-complexity.

---

## Key design decisions

**Validation is split.** Mechanical checks (contract validation, test execution) are deterministic code. The Validator agent handles subjective review and produces structured JSON findings with severity levels (`must_fix`, `should_fix`, `suggestion`). The two layers are not interchangeable.

**Human override is final.** The pipeline cannot force a block the user has explicitly overridden. This prevents death spirals where the Validator flags hallucinated requirements.

**Asymmetric Context QA.** The QA agent is denied access to source code and schema. It reads only the PRD, OpenAPI spec, and a `test-context.json` — forcing it to write pure black-box tests against business requirements, not implementation details.

**Every artifact is a file.** Agents do not share context windows. They read prior artifacts from disk and write to disk. Any phase can be re-run without re-running the whole pipeline.

**Session state is always recoverable.** `00-session-state.json` records every decision and artifact path. A `phase_checkpoint` tracks which agents have completed, which is in-flight, and the path to any partial artifact being written. Close the app and come back later — the Conductor picks up exactly where it left off.

**The Conductor is TypeScript, not Claude.** The Conductor never calls the Claude API for its own reasoning. It is deterministic code. Claude is invoked only for specialist agents and a single reasoning escape hatch (`conductor.reason()`) for genuinely stuck revision loops.

**Budget is always enforced before dispatch, never mid-stream.** Mid-stream termination produces corrupted artifacts that trigger Validator findings and expensive revision cycles. Pre-flight token budgeting prevents this entirely.

---

## UI

React/Vite Kanban board.

- One column per phase, each containing agent cards
- Card states: Pending → Running → Done / Flagged / Error
- Running cards show the current section being written (extracted from structural markers, not raw tokens) with a slow color-cycle border animation
- Gate drawer: resizable, shows artifact and Validator findings side by side
- Revision counter turns amber at revision 2, red at revision 3+
- Per-gate cost estimate for the next phase (single-pass, no revision speculation)
- Running cost total in topbar after Gate 1, with per-phase hover breakdown
- No upfront pipeline estimate — lower-bound anchors erode trust

---

## Roadmap

### v1 — Core loop *(current focus)*
Everything above. The hardcoded 5-phase sequence must work reliably on real projects before anything else ships.

### v2 — Operational polish *(after v1 is proven on 3 real projects)*
- Agent questions before artifact generation
- Decisions panel (audit trail of all Conductor decisions)
- Budget band UI with per-agent toggles
- Artifact version pinning

### v3+ — Extensibility
- Configurable workflow DAG with condition DSL
- Custom agent framework (`clados agent add`)
- IDE bridge (bi-directional file sync, deep-link URIs)
- Multi-language / multi-stack support

### Future — Interactive Mode
Once a project ships, CLaDOS converts to an interactive mode where you can highlight generated code and ask the AI to fix it — with full AST context of the workspace.

---

## Docs

- [User Guide](docs/User-Guide.md) — step-by-step walkthrough of the pipeline and UI
- [Test Projects](docs/Test-Projects.md) — suggested test projects ordered by complexity
- [Testing Plan](docs/Testing-Plan.md) — how to test without burning through API credits
- [Goal document](docs/CLaDOS-Goal.md) — full vision and design rationale
- [V1 Spec](docs/V1-Spec-Alpha.md) — buildable spec for v1; if it's not in here, it doesn't ship
- [V2 Spec](docs/V2-Spec-Beta.md) — what gets added after v1 is proven
- [UI Mockup](docs/clados-mockup.html) — open in a browser

---

## Status

**v1 implementation in progress.** Core orchestrator, all 5 phases, 9 agents, contract validator, test runner, session state and crash recovery, and the React UI are implemented. Active testing underway.

See [CHANGELOG](Changelog.md) for what's been built and what's left.

---

## Inspiration

Inspired by [azure-agentic-infraops](https://github.com/jonathan-vella/azure-agentic-infraops), adapted for the full software development lifecycle.
