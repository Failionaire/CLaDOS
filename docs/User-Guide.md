# CLaDOS User Guide

CLaDOS is a multi-agent AI pipeline that takes a project idea and walks it through five phases — Concept, Architecture, Build, Document, and Ship — with a human approval gate between each one. You review what the AI produced, decide whether to approve it or ask for revisions, and the pipeline continues.

---

## Prerequisites

- Node.js 18+
- Docker Desktop (required for Phase 2 — the test runner spins up a database container)
- An Anthropic API key

---

## First Run

**1. Set your API key**

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

This stays in your shell session only — it is never written to disk.

**2. Launch CLaDOS**

```powershell
node bin/clados.js
```

CLaDOS starts a local web server on a port between 3100–3199 and opens your browser automatically.

**3. Create or open a project on the home screen**

If this is your first time, fill in the **Create** form:

- **Project name** — used as the folder name (`./my-project/`); letters, numbers, hyphens, underscores only
- **Describe your idea** — plain English, as much or as little detail as you want
- **Project type** — backend-only, full-stack, CLI tool, or library
- **Security agent** — toggle on if you want a threat model and dependency audit
- **Wrecker agent** — toggle on if you want adversarial edge-case tests written against your code
- **Guided mode** — toggle on (default) to let agents ask clarifying questions before writing; toggle off for autonomous mode
- **Refiner** — toggle on to automatically fix `should_fix` and `suggestion` findings after Phase 2's Validator runs
- **Spend cap** — optional dollar limit; the pipeline will pause and ask before going over

Click **Create →** when ready.

If you have existing projects in the current directory, they appear in the **Resume a project** dropdown at the top of the home screen. Select one and click **Open →**.

---

## Language Support

CLaDOS supports three generated stacks. There is no language selector on the home screen — the **Architect agent** picks the language during Phase 1 based on your idea and PRD. If no preference is stated, it defaults to TypeScript/Express/Prisma. Mention your preferred language in the project idea (e.g. "use Python with FastAPI") to override the default.

| Language | Framework | Test runner | Contract validator |
|----------|-----------|-------------|-------------------|
| TypeScript *(default)* | Express + Prisma | Jest / Vitest | Express route AST walk |
| Python | FastAPI + SQLAlchemy | pytest | FastAPI decorator regex |
| Go | Gin + GORM | go test | Gin router call parser |

The orchestrator, Conductor, and UI are always TypeScript — `language` selects what gets *generated*, not how CLaDOS itself runs.

> **Note:** Go support in the contract validator and test runner needs real-project validation before it's considered stable. Expect rough edges on Go projects.

---

## Guided vs Autonomous Mode

Set on the home screen when creating a project. Can be changed at any gate.

- **Guided mode** *(default)* — agents can surface clarifying questions before writing their main artifact. A question gate opens and you answer before the agent proceeds. Unasked questions use their default assumptions.
- **Autonomous mode** — agents record their default answers to any questions and proceed immediately. No gates pause for questions. Best for users who write detailed project briefs.

---

## The Pipeline

### Phase 0 — Concept

**If your idea is under 200 words**, the PM first runs a *discovery pass*: it writes a short document explaining what it thinks you want, asks a few clarifying questions, and states what it'll assume if you don't answer. A **Discovery Gate** opens before the main concept is written.

At the discovery gate you can:
- Answer some or all questions in the text fields
- Leave fields blank to accept the stated default assumptions
- Click **Looks good** to accept everything (fast path for well-specified ideas)

The PM then uses your answers to write the concept doc, which goes through the normal Validator review and Gate 1.

**If your idea is 200+ words**, the discovery pass is skipped — a detailed brief doesn't need clarification.

**At Gate 1**, you choose:
- **Approve** — move to Architecture
- **Revise** — type a note describing what needs to change and the PM rewrites the concept
- **Abandon** — stops the pipeline; all artifacts are preserved

---

### Phase 1 — Architecture
Three agents run in sequence:
1. **PM** — expands the concept into a full PRD with user stories and acceptance criteria
2. **Architect** — defines the tech stack, database schema, and OpenAPI spec
3. **Prototype Engineer** — scaffolds real code into `src/` plus a test database container config

**At Gate 2**, you see all architecture artifacts. The Validator will flag anything missing or inconsistent.

> **Tip:** This is the most important gate. The architecture artifacts are the source of truth for everything that follows. If something is wrong here, fix it now rather than in Phase 2.

---

### Phase 2 — Build
The heaviest phase. The Engineer implements the full codebase, then several validation layers run automatically:

Steps 1–5 run automatically:

1. **Contract Validator** *(automated)* — checks every OpenAPI endpoint has a matching route and vice versa
2. **QA agent** *(no access to your source code)* — writes integration tests based only on the spec and PRD
3. **Test Runner** *(automated)* — spins up Docker, starts the server, runs the tests
4. **Security** *(if enabled)* — threat model and dependency audit (runs in parallel with QA)
5. **Wrecker** *(if enabled)* — adversarial edge-case tests
6. **Validator** — reviews everything together
7. **Refiner** *(if enabled)* — automatically fixes `should_fix` and `suggestion` findings after the Validator review; never touches `must_fix` findings

> **Full-stack projects:** The Engineer stage runs two agents in parallel — a backend Engineer and a frontend Engineer. If the backend Engineer updates the API spec while the frontend Engineer is still running, the frontend Engineer is automatically re-run against the updated spec before Stage 2 begins.

**Micro-pivots:** If the Engineer discovers a schema or architecture gap while implementing (e.g., a missing column for a feature the spec requires), it can emit a `request_architecture_change` instead of silently working around it. When this happens:
- The Engineer pauses
- The Architect produces a schema diff
- A **Micro-Gate** opens in the UI — a compact modal showing the change request (left) and the Architect's response plus proposed diff (right)
- You approve or reject; if approved the Architect updates the schema and the Engineer resumes with the new schema in context; if rejected the Engineer is told to work within the existing structure
- Maximum 3 micro-pivots per Build phase

**At Gate 3**, you see test results, contract findings, and the Validator's assessment.

> **What "Flagged" means on an agent card:** The Validator found at least one `must_fix` issue. You cannot approve until you either ask for a revision or explicitly override each finding.

---

### Phase 3 — Document
The Docs agent writes a README, changelog, and runbook. The PM produces the final PRD and a canonical OpenAPI spec reflecting what was actually built. The Validator checks documentation accuracy.

**At Gate 4**, you see the documentation.

---

### Phase 4 — Ship
The DevOps agent produces Dockerfiles, CI/CD configuration, and a deployment runbook. The Validator reviews it for security and completeness.

**At Gate 5**, you approve the deployment configuration. After this, the pipeline is complete.

---

## Gate Actions

### Approve
Advances to the next phase. Blocked if there are unresolved `must_fix` findings — you will see the Approve button greyed out with a count.

To approve anyway, check the override checkbox next to each `must_fix` finding. Your decision is logged but the pipeline proceeds. Use this when you disagree with the Validator's assessment.

### Revise
Opens a 3-pane view: artifact (left), revision note (center), findings (right). Type what needs to change and click **Revise**. The relevant agents re-run with your note and the findings as context.

The gate header shows **Revision N of 3 before escalation** — after 3 revisions without resolving `must_fix` findings, the pipeline automatically upgrades to the escalation model (Sonnet by default, configurable in `agent-registry.json`) and tries once more.

### ⚠ More options
- **Go back to Gate N** — rolls back to a prior gate; work from that gate forward is archived to `.clados/history/`
- **Restart this phase** — clears the current phase and re-runs all its agents from scratch
- **Abandon project** — stops the pipeline permanently; all artifacts are preserved

---

## The Kanban Board

Each phase is a column. Each agent within a phase is a card. Card states:

| Border color | Meaning |
|---|---|
| Blue (animated) | Agent is currently running |
| Green | Agent completed successfully |
| Amber | Validator flagged findings |
| Red | Agent hit an error after retries |
| Grey | Pending or skipped |

**On a red Error card:**
- **Retry** — re-dispatches this agent from scratch
- **Skip** — only available for Security, Wrecker, and Docs; skips the agent and continues

Hovering the cost total in the top bar shows a per-phase breakdown of actual spend.

---

## Resuming After a Crash

If CLaDOS stops unexpectedly (Ctrl+C, power loss, etc.), just launch it again:

```powershell
node bin/clados.js
```

The home screen lists your existing projects sorted by last activity. Select the interrupted project and click **Open →**. CLaDOS reads `.clados/00-session-state.json` and resumes from where it left off:
- If an agent was mid-run, it checks for a partial artifact in `.clados/wip/` and continues from it if the file looks structurally complete
- If at a gate, it re-opens the gate
- If complete or abandoned, it shows the final state

---

## Spend Cap

Set a dollar limit on the home screen when creating your project. Before every agent dispatch, CLaDOS checks whether the projected cost would exceed your remaining budget. If it would:
- The pipeline pauses
- A **Budget Gate** modal appears showing the current spend, projected cost, and a field to raise the cap
- **Allow & continue** — enter a new (higher) cap and resume
- **Stop pipeline** — abandons the project at the current point

The cap is never enforced mid-stream. If an agent goes over its projection, the overage is absorbed and the gate triggers before the *next* dispatch.

---

## File Layout

After a complete run, your project looks like this:

```
my-project/
  .clados/                  ← pipeline metadata (safe to inspect, do not edit manually)
    00-session-state.json   ← full pipeline state
    00-concept.md
    01-prd.md
    01-architecture.md
    01-api-spec.yaml
    02-build/
      test-runner.json      ← test results
      validator.json
    03-api-spec.yaml        ← canonical spec as actually built
    history/                ← archived versions from revision cycles
  src/                      ← generated source code
  tests/                    ← generated integration tests
  infra/                    ← Dockerfiles, CI/CD config
  docs/                     ← README, changelog, runbook
```

---

## Interactive Mode

After Gate 5 is approved and the pipeline reaches `complete`, a chat panel appears below the Kanban board. This is the **Interactive Agent** — it has full AST-aware context of the generated project.

**What you can do:**
- Ask questions about the codebase: "Why does the tasks route use a transaction here?"
- Request targeted fixes: "The `/tasks` route throws a 500 when the array is empty — fix it"
- Ask for explanations of Validator findings: "What exactly is finding 2-v-sec-0?"

**What happens when the agent wants to write a file:**
The Interactive Agent never writes directly. It uses `propose_diff` to show you a unified diff first. Accept or reject each proposed change. Only accepted changes are written to disk.

**What Interactive Mode is NOT:**
- It is not a general coding assistant — it is scoped to the generated project
- It does not re-run the pipeline or update pipeline artifacts
- For adding a whole new feature, use `clados continue` instead

---

## Re-invocation — Adding Changes to a Completed Project

Use `clados continue` when you want to add a feature, fix a bug, or refactor a project that has already completed the full pipeline:

```bash
clados continue my-project "Add a comments feature to tasks"
```

If you omit the description, you'll be prompted for it interactively.

**What happens:**
1. CLaDOS classifies the change against the project's current artifacts to determine the best re-entry phase (0–4)
2. A **Re-invocation Gate** opens in the UI showing the detected phase, reasoning, and affected artifacts
3. You can override the detected phase if you disagree
4. Confirm to start the pipeline from that phase — prior phases' artifacts carry forward as context

**Phase selection guidance:**
| Change type | Typical entry phase |
|-------------|-------------------|
| New idea / major pivot | Phase 0 — Concept |
| New endpoint, schema change, stack change | Phase 1 — Architecture |
| Bug fix, new feature (code-only) | Phase 2 — Build |
| Update docs only | Phase 3 — Document |
| Deployment change only | Phase 4 — Infra |

Prior phase artifacts are preserved in `.clados/history/`. The PRD gains an "Amendment" section rather than being rewritten from scratch.

---

## CLI Subcommands

Beyond the main `clados` server command, the following subcommands are available:

```
clados doctor [project-dir]
```
Validates session state integrity: JSON parse, SHA-256 checksum, phase bounds, artifact file existence, and budget arithmetic. Exits 0 on clean. Run this if a project behaves unexpectedly after a crash.

```
clados logs [project-dir] [flags]
  --agent <name>    Filter by agent role
  --phase <n>       Filter by phase number
  --event <str>     Filter by event name (substring)
  --since <iso>     Only entries after this ISO timestamp
  --errors          Only error-level entries
  --raw             Output raw JSON instead of formatted text
```

```
clados cost <project-dir>
```
Per-phase, per-agent cost breakdown with input/output token separation, revision cycle analysis, and context compression savings estimate.

```
clados model-update [--apply]
```
Shows a diff of any model alias changes in `agent-registry.json`'s `_model_reference` section. Pass `--apply` to write updates.

```
clados workflow show [graph.json]
clados workflow validate [graph.json]
```
Print or validate a workflow graph. Defaults to `workflow-graph.default.json` in the current directory.

```
clados agent add --name <name> --mode reviewer|agent --phase <n>
clados agent list
clados agent remove <name>
clados agent test <name> [project-dir]
```
Custom agent management. Reviewer agents output freeform text that is auto-converted to structured findings. Agent mode agents have full tool dispatch support.

```
clados template list
clados template use <name>
clados template save <name> [project-dir]
```
Project templates pre-fill the creation form. Built-in templates: `typescript-api`, `typescript-fullstack`, `python-fastapi`, `go-gin-api`. User templates are stored in `~/.clados/templates/`.

---

## Common Issues

**"Engineer did not produce test-context.json"**  
The Engineer failed to complete Pass 3 of its output. Use **Retry** on the Engineer card. If it keeps failing, use the revision flow and explicitly mention in your revision note that `02-build/test-context.json` must be produced.

**Test Runner fails with "Tests require a database but no docker-compose.test.yml was generated"**  
The Prototype Engineer (Phase 1) didn't generate the test infrastructure files. Roll back to Gate 2 and revise with: *"The scaffold must include infra/docker-compose.test.yml with a PostgreSQL container and a .env.test file."*

**Approve button stays grey after overriding findings**  
Reload the page — if the WebSocket dropped and reconnected, the override state may be stale. The backend re-sends the full gate state on reconnect.

**"Could not reconnect — restart CLaDOS to continue"**  
The Express server process died. Run `node bin/clados.js` again and use the home screen to reopen the project.
