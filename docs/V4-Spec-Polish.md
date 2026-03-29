# CLaDOS v4 Specification — Polish

Everything in V1, V2, and V3 ships first. This document describes the final layer that closes the gap between "a working multi-agent pipeline" and the full CLaDOS vision described in the goal document. Nothing here ships until V3's configurable DAG and custom agents are stable in real use.

---

## Prerequisites before v4 work begins

- [ ] V3 workflow graph used by at least 3 projects with custom agent ordering or conditional branches
- [ ] At least 2 custom agents created by users (not by the author)
- [ ] Python support proven on at least 2 real projects
- [ ] IDE bridge stable — file watchers don't cause race conditions or false notifications
- [ ] User feedback explicitly requesting Interactive Mode or re-invocation (not just author assumption)

V4 is the hardest version to justify. Every feature here sounds compelling in isolation. The prerequisites exist specifically to prevent building a second product (Interactive Mode) or speculative infrastructure (multi-language beyond Python) before there's evidence anyone needs it.

---

## What v4 adds

V4 is about **lifecycle completion**. CLaDOS goes from "generates a project" to "lives alongside a project" — supporting iteration, maintenance, and evolution after the initial pipeline run.

### 1. Interactive Mode

**What:** Once a project reaches `complete` status (all gates approved), the UI transitions to an interactive mode where the user can chat with the AI in the context of the generated workspace.

**How it works:**
- The Kanban board compresses into a read-only sidebar showing the pipeline history
- The center of the screen becomes a chat interface
- The chat agent has full AST-aware context of the workspace — it knows every file, every export, every type signature
- The user can reference specific files or functions: "The `/tasks` route throws a 500 when I pass an empty array"
- The agent can read files, propose edits (shown as diffs), and write files — but every write requires user approval (the "human override is king" principle carries over)
- The agent has access to the PRD, architecture, and Validator findings from the pipeline run, so it understands the project's intent as well as its implementation

**Context management:**
- Uses the same Two-Tier AST/LSP strategy from the pipeline for workspace awareness
- The chat agent receives a workspace summary (file tree + semantic descriptions) at the start of each conversation
- Individual files are loaded on demand when the conversation references them
- Token budget management follows the same rules as pipeline agents

**What Interactive Mode is NOT:**
- It is not a general-purpose AI coding assistant — it is scoped to the generated project
- It does not re-run the pipeline — it makes targeted edits
- It does not produce pipeline artifacts (no PRD updates, no Validator findings) — it produces code changes
- It is not a replacement for the pipeline on new projects — it is a complement for maintaining existing ones

**Why now:** After V1–V3, CLaDOS generates projects and walks away. Users then need to modify the output using their own tools, losing all the context the pipeline accumulated. Interactive Mode bridges the gap between "generated" and "maintained."

### 2. Re-invocation workflow

**What:** Re-run CLaDOS on an existing project to add features, fix bugs, or refactor — without starting from scratch.

**How it works:**
1. `clados continue <project>` reads the existing session state
2. The user describes what they want to change: "Add a comments feature to tasks" or "Switch from JWT to session-based auth"
3. The Conductor determines which phases are affected:
   - Feature addition → starts at Phase 0 (Concept) with the change scoped as a delta, then flows through Architecture → Build as usual
   - Bug fix → starts at Phase 2 (Build) with the bug description injected directly to the Engineer
   - Refactor → starts at Phase 1 (Architecture) if the stack changes, or Phase 2 if it's code-only
4. The pipeline runs from the entry point forward — prior phases' artifacts are carried over as context
5. Each gate shows both the original artifact and the delta clearly marked

**Phase classification (`delta-detector.ts`):**
The Conductor calls Claude Opus with the full session state summary (project type, current artifacts list, schema, and the user's change description) and asks it to produce a structured classification:
```json
{
  "entry_phase": 0 | 1 | 2,
  "reasoning": "This is a feature addition that requires new API endpoints and a schema change.",
  "affected_artifacts": ["01-prd.md", "01-architecture.md", "01-schema.yaml"]
}
```
The classification is presented to the user at a **Re-invocation Gate** before any agents run — the user confirms or overrides the entry phase. The LLM's classification is advisory; the human decides. If the user disagrees (e.g., the LLM suggests Phase 0 but the user knows it's a targeted bug fix), they select the correct entry phase and proceed. This gate is lightweight — a single confirmation, not a full artifact review.

**What changes in existing artifacts:**
- New versions are created (v4, v5, etc.) — originals are preserved in `history/`
- The PRD gains an "Amendment" section rather than being rewritten
- The architecture diff is explicit: "Added `comments` table, added `GET /tasks/:id/comments` endpoint"
- The Engineer receives both the existing codebase and the delta instructions

**Scope limits:**
- Re-invocation handles additive changes and targeted fixes. It does not handle "rewrite the project in a different framework" — that's a new project.
- Only one re-invocation can run at a time. Concurrent changes are not supported.
- Re-invocation uses the same workflow graph as the original run. If the graph has been customized, the same customizations apply.

**Why now:** This is the single most valuable post-pipeline feature. Every generated project will eventually need changes. Without re-invocation, users either edit the code manually (losing CLaDOS context) or start a new project from scratch (losing existing work). The artifact structure was designed for this from V1 — now it's time to use it.

### 3. Additional language support

**What:** Add Go as a third supported language. The framework for adding languages was established in V3 (Python); this proves the framework scales.

**Per-language requirements (same as Python):**
- Contract Validator mode (parse Go HTTP handler registrations)
- Test Runner mode (run `go test` in a sandboxed environment)
- AST extraction (Tree-sitter Go grammar, `gopls` for LSP)
- Engineer prompt tuning (Go idioms, module structure, error handling patterns)

**Language selection:** The setup screen's `language` field gains `go` as an option. The Agent Registry's `{{language_context}}` template handles Go automatically.

**Which language next after Go:** Determined by user demand. The framework supports any language with a Tree-sitter grammar and a testable build system. Likely candidates: Rust (strong type system maps well to contract validation), Java/Kotlin (enterprise demand), or Ruby (Rails).

**Why now:** Two proven languages (TypeScript + Python) establish the pattern. A third proves it's actually a framework, not just two special cases.

### 4. Project templates

**What:** Pre-configured starting points that combine project type, language, workflow graph, and agent loadout into a single selection.

**Built-in templates:**
- `typescript-api` — backend REST API (Express, PostgreSQL, the current default)
- `typescript-fullstack` — React + Express + PostgreSQL
- `python-api` — FastAPI + PostgreSQL
- `python-cli` — Click-based CLI tool
- `go-api` — Go HTTP service with standard library or Chi router

**Custom templates:**
- `clados template save <name>` — saves the current project's setup (type, language, graph, loadout, spend cap) as a reusable template
- `clados template list` — shows available templates
- `clados template use <name>` — applies a template at project creation

Templates are stored in `~/.clados/templates/` as JSON files.

**Why now:** After V3, the combination of language, project type, graph, and agent loadout creates a large configuration space. Templates reduce "new project" friction from "answer 6 questions" to "pick a template and describe your idea."

### 5. Enhanced cost analytics

**What:** Post-run cost analysis beyond the running total.

**`clados cost <project>`** shows:
- Total spend, broken down by phase and by agent
- Tokens used per agent (input and output separately)
- Cost of revision cycles (how much extra was spent on re-runs vs. first-pass)
- Escalation cost (how much extra was spent on Opus vs. what Sonnet-only would have cost)
- Comparison to the per-gate estimates: were they accurate?

**Cost history:** If a project has been re-invoked, shows spend per invocation with a running total.

**Why now:** After enough runs, users want to understand their spending patterns — which agents are expensive, whether revision cycles are worth the cost, and whether the budget gate settings are calibrated correctly. This data also informs prompt engineering: if the Validator consistently adds $5 in revision cycles, the prompt may be too aggressive.

---

## Updated file structure (additions only)

```
clados/
  orchestrator/
    interactive/
      chat-agent.ts              ← NEW: Interactive Mode agent dispatch
      workspace-context.ts       ← NEW: AST-aware workspace summary builder
    reinvoke/
      continue.ts                ← NEW: re-invocation entry point
      delta-detector.ts          ← NEW: determines which phases are affected
      amendment-merger.ts        ← NEW: merges deltas into existing artifacts
    cli/
      template.ts                ← NEW: clados template save/list/use
      cost.ts                    ← NEW: clados cost analytics
    language/
      go.ts                      ← NEW: Go-specific support
  ui/
    components/
      InteractiveChat.tsx        ← NEW: chat interface for Interactive Mode
      PipelineHistory.tsx        ← NEW: compressed read-only pipeline sidebar
      DeltaViewer.tsx            ← NEW: shows original + delta at re-invocation gates

~/.clados/
  templates/                     ← NEW: saved project templates
```

---

## What this completes

With V4, CLaDOS closes the loop described in the goal document:

| Goal doc feature | Ships in |
|-----------------|----------|
| Hardcoded phase sequence | V1 |
| File-based artifacts + crash recovery | V1 |
| Human gates + revision loops | V1 |
| Findings-based validation | V1 |
| Targeted fix loops | V1 |
| Asymmetric QA | V1 |
| Budget gating | V1 |
| `conductor.reason()` | V1 |
| Mechanical validation | V1 |
| AST/LSP + Tree-sitter | V1 |
| Kanban UI + gate drawer | V1 |
| Agent questions / autonomy mode | V2 |
| Decisions panel | V2 |
| Budget band UI | V2 |
| Micro-pivots | V2 |
| Refiner agent | V2 |
| Artifact version pinning | V2 |
| CLI subcommands | V2 |
| Configurable workflow DAG | V3 |
| Custom agent framework | V3 |
| IDE bridge | V3 |
| Python support | V3 |
| Interactive Mode | V4 |
| Re-invocation workflow | V4 |
| Additional languages (Go) | V4 |
| Project templates | V4 |
| Cost analytics | V4 |

**Not shipped in any version (intentionally):**
- Agent marketplace / community sharing — requires hosting infrastructure and trust model that's premature
- Full multi-stack in a single project (e.g., Go backend + TypeScript frontend) — each half is a separate CLaDOS project for now
- Real-time collaboration (multiple users on one pipeline) — not the product's purpose
