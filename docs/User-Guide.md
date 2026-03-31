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
- **Spend cap** — optional dollar limit; the pipeline will pause and ask before going over

Click **Create →** when ready.

If you have existing projects in the current directory, they appear in the **Resume a project** dropdown at the top of the home screen. Select one and click **Open →**.

---

## The Pipeline

### Phase 0 — Concept
The PM agent writes a one-page concept document. The Validator reviews it for feasibility. You then see:
- The concept document (rendered in the left pane)
- Any Validator findings (right pane)

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

1. **Contract Validator** *(automated)* — checks every OpenAPI endpoint has a matching route and vice versa
2. **QA agent** *(no access to your source code)* — writes integration tests based only on the spec and PRD
3. **Test Runner** *(automated)* — spins up Docker, starts the server, runs the tests
4. **Security** *(if enabled)* — threat model and dependency audit
5. **Wrecker** *(if enabled)* — adversarial edge-case tests
6. **Validator** — reviews everything together

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

The gate header shows **Revision N of 3 before Opus escalation** — after 3 revisions without resolving `must_fix` findings, the pipeline automatically upgrades to the more capable Opus model and tries once more.

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

## Common Issues

**"Engineer did not produce test-context.json"**  
The Engineer failed to complete Pass 3 of its output. Use **Retry** on the Engineer card. If it keeps failing, use the revision flow and explicitly mention in your revision note that `02-build/test-context.json` must be produced.

**Test Runner fails with "Tests require a database but no docker-compose.test.yml was generated"**  
The Prototype Engineer (Phase 1) didn't generate the test infrastructure files. Roll back to Gate 2 and revise with: *"The scaffold must include infra/docker-compose.test.yml with a PostgreSQL container and a .env.test file."*

**Approve button stays grey after overriding findings**  
Reload the page — if the WebSocket dropped and reconnected, the override state may be stale. The backend re-sends the full gate state on reconnect.

**"Could not reconnect — restart CLaDOS to continue"**  
The Express server process died. Run `node bin/clados.js` again and use the home screen to reopen the project.
