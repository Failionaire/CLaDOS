# CLaDOS v2 Specification — Beta

Everything in V1-Spec-Alpha ships first. This document describes what gets added in v2. Nothing in this document ships until V1 has been run on at least 3 real projects and the core loop — dispatch, validate, gate, revise — is proven to produce working software.

---

## Prerequisites before v2 work begins

- [ ] V1 pipeline completes end-to-end on 3 distinct project types (backend API, full-stack app, CLI tool)
- [ ] Targeted fix loops demonstrably cheaper than full re-runs (measured, not assumed)
- [ ] Asymmetric QA produces tests that catch real bugs the Engineer introduced (not just confirming happy paths)
- [ ] Crash recovery tested: kill the process mid-agent, restart, verify correct resume-or-restart behavior
- [ ] At least one project reaches Phase 4 (Ship) and produces deployable output

If any of these fail, fix V1 before starting V2. Adding features to a broken loop makes both worse.

---

## What v2 adds

V2 is about **operational polish and user control**. The pipeline works; now the user needs better visibility, more control over agent behavior, and the ability to adapt mid-run.

### 1. Agent questions and autonomy mode

**What:** Agents can surface ambiguity before generating their main artifact.

Before writing, an agent may emit a `{phase}-questions.json` — a structured list of ambiguities:
```json
{
  "questions": [
    {
      "id": "q-001",
      "question": "Should the API support multi-tenancy at the database level or application level?",
      "options": ["database-level", "application-level"],
      "default_if_auto": "application-level",
      "reasoning": "Application-level is simpler for MVP scope and avoids schema-per-tenant complexity."
    }
  ]
}
```

**Two modes** (set at project creation, changeable at any gate):
- **Guided mode** (default): a lightweight gate pauses for user answers before the agent proceeds.
- **Autonomous mode**: the Conductor logs the `default_if_auto` answer for each question and proceeds without pausing. The agent receives the defaults as if the user had chosen them.

Every question and every answer (user or auto) is stored in `00-session-state.json` under `agent_questions` and visible in the Decisions panel (see below).

**Why now:** In V1, agents use silent defaults and ambiguities only surface as Validator findings after the fact. This creates unnecessary revision cycles. Questions let agents resolve ambiguity *before* generating artifacts, reducing wasted work.

### 2. Decisions panel UI

**What:** A read-only chronological log of all `conductor_decisions`, `conductor_reasoning`, and `agent_questions` entries across all phases.

- Accessed via a "Decisions" chip in the topbar
- Opens as a right-side overlay panel (400px, scrollable)
- Each entry shows: phase, agent affected, trigger, decision made, timestamp
- Entries are color-coded: blue for autonomous decisions, amber for `conductor.reason()` calls, green for user answers

**Why now:** V1 logs all decisions to session state but doesn't surface them in the UI. By v2, users have enough pipeline runs to want auditability — "why did the Architect choose PostgreSQL when I said nothing about databases?" traces to a Phase 0 autonomous question answer.

### 3. Budget band UI

**What:** Replaces V1's inline budget notification with the full expandable budget band from the mockup.

The budget band sits between the modal header and modal body. It shows:
- Current total spend vs. cap
- Which agent would breach the cap and by how much
- Inline field to raise the cap
- Toggles to disable optional agents (Security, Wrecker, Refiner) for the remainder of the run
- A note showing projected total if optional agents are disabled

The band expands/collapses on click. The gate modal content remains visible below it — the user can still review the artifact and findings while deciding on the budget.

**Why now:** V1's inline notification is sufficient for "yes/no, raise the cap?" but after real usage, users need the ability to make informed tradeoffs (disable an optional agent vs. raise the cap) without abandoning the pipeline.

### 4. Micro-pivots during Build

**What:** If the Engineer discovers a schema or architecture problem during Phase 2 (Build), it can emit a `request_architecture_change` tool call instead of silently working around the issue.

The tool call includes:
```json
{
  "type": "request_architecture_change",
  "reason": "The tasks table needs a `position` column for drag-and-drop ordering, but the schema only has `created_at` for ordering.",
  "proposed_diff": "ALTER TABLE tasks ADD COLUMN position INTEGER NOT NULL DEFAULT 0;",
  "files_affected": ["src/models/task.ts", "src/routes/tasks.ts"]
}
```

**Flow:**
1. The Conductor pauses the Engineer
2. The Architect agent receives the request and produces a schema diff
3. A **Micro-Gate** opens in the UI — smaller than a full gate, showing only the diff and the Engineer's reasoning
4. The user approves or rejects the change
5. If approved: the Architect's updated schema is written, the Engineer resumes with the new schema in context
6. If rejected: the Engineer resumes with an instruction to work within the existing schema

Micro-gates do not archive artifacts or create new versions — they modify the current working schema. The change is logged to session state under `micro_pivots`.

**Why now:** V1 forces the user to reject the entire build and go back to Gate 2 if the schema is wrong. Micro-pivots let the system adapt without discarding work. Deferred from V1 because the base build loop needed to prove itself first.

### 5. Refiner agent (optional)

**What:** An optional polish pass that runs after the Validator in Phase 2, before Gate 3.

The Refiner reads the code and the Validator's findings, then makes targeted improvements:
- Consistent error handling patterns
- Missing edge cases that aren't `must_fix` but are obvious gaps
- Code style normalization (naming conventions, import ordering)

The Refiner produces a `02-build/refiner.json` documenting every change it made and why. It does **not** produce findings — it directly modifies source files and reports what it changed. The Validator does not re-run after the Refiner; the human reviews the Refiner's changes at Gate 3.

**Why now:** V1 delivers working code. The Refiner is about code quality polish — meaningless if the code doesn't work, valuable once it does.

### 6. Artifact version pinning UI

**What:** Artifact links in the UI show a version dropdown. Each entry shows the version number and which revision cycle produced it. A "Use this version" action on any non-current entry:
1. Copies the selected version's content to the current artifact path
2. Increments the version counter
3. Logs the rollback to session state
4. Re-opens the relevant gate for re-validation

**Why now:** V1 archives old versions to `.clados/history/` but the only way to use an old version is manual file operations. After multiple real projects with revision cycles, users will want to say "actually, v2 of the PRD was better than v3."

### 7. CLI subcommands

**What:** Two CLI utilities for operational use:

**`clados logs`** — filtered views of `run.log`:
- `--agent <name>` — filter by agent
- `--phase <n>` — filter by phase
- `--event <type>` — filter by `api_call`, `file_write`, `error`
- `--since <duration>` — e.g. `30m`, `2h`
- `--errors` — shorthand for failed API calls
- `--raw` — output raw JSONL instead of formatted table

**`clados model-update`** — re-resolve model aliases:
- Reads the current `resolved_models` from session state
- Checks if newer model versions are available (e.g., `claude-sonnet-4-20250514` → `claude-sonnet-4-20250815`)
- Shows a diff of what would change
- `--apply` to write the updated models to session state

**Why now:** V1's `run.log` exists but is raw JSONL — usable for debugging but not for quick operational questions. After running several projects, `clados logs --errors --since 1h` becomes genuinely useful. Model updates aren't urgent for V1 (one model version is fine for proving the loop) but become important once projects span weeks.

---

## Updated file structure (additions only)

```
clados/
  orchestrator/
    micro-pivot.ts               ← NEW: handles request_architecture_change flow
    cli/                         ← NEW
      logs.ts                    ← clados logs subcommand
      model-update.ts            ← clados model-update subcommand
  agents/
    refiner.md                   ← NEW: optional polish pass prompt
  ui/
    components/
      DecisionsPanel.tsx         ← NEW: chronological decision log overlay
      BudgetBand.tsx             ← NEW: expandable budget gate UI
      MicroGate.tsx              ← NEW: small approval for schema changes
      VersionDropdown.tsx        ← NEW: artifact version picker

{project}/
  .clados/
    {phase}-questions.json       ← NEW: agent questions per phase
    02-build/
      refiner.json               ← NEW: if Refiner enabled
```

---

## What's still NOT in v2

- Configurable workflow DAG / condition DSL
- Custom agent framework
- Interactive Mode
- IDE bridge / file watchers / deep-link URIs
- Multi-language / multi-stack support

These ship in V3 or later.
