# CLaDOS v3 Specification — Release

Everything in V1 and V2 ships first. This document describes what gets added in v3. Nothing here ships until the V2 pipeline has been used on enough real projects that the operational patterns are clear — which agents get toggled, which questions recur, which workflows users actually want to customize.

---

## Prerequisites before v3 work begins

- [ ] V2 pipeline stable — micro-pivots, Refiner, agent questions, and budget band all exercised on real projects
- [ ] At least 2 different users (not just the author) have run V2 and given feedback
- [ ] Clear evidence that the hardcoded phase sequence is a limitation — specific projects where users needed a different agent order, a skipped phase, or a conditional branch
- [ ] At least one case where a user wanted a custom agent that doesn't exist in the built-in set

If there's no evidence of demand for configurable workflows or custom agents, defer v3 and improve v2. Don't build a platform before someone needs it.

---

## What v3 adds

V3 is about **extensibility and platform**. The core loop is proven and polished; now CLaDOS becomes configurable for different workflows and different teams.

### 1. Configurable workflow DAG

**What:** The hardcoded phase sequence is replaced by a `workflow-graph.json` that defines phases as nodes and transitions as edges with conditions.

**Schema:**
```typescript
interface AgentNode {
  id: string;                    // e.g. "pm-concept"
  role: string;                  // agent role from registry
  enabled_when?: string;         // condition DSL: "project_type == full-stack"
  on_complete: string;           // next node id
  on_skip: string;               // next node when enabled_when is false
  on_fail: string;               // gate or error handler node
}

interface GateNode {
  id: string;
  type: "gate";
  on_approve: string;            // first node of next phase
  on_revise: string;             // first agent node of current phase
  on_abort: string;              // cleanup node
  on_goto: Record<string, string>; // gate_id → first agent node for rollback
}

interface BudgetGateNode {
  id: string;
  type: "budget_gate";
  triggered_by: string;          // agent node that would breach cap
  on_continue: string;           // re-check with updated cap
  on_abort: string;              // cleanup node
}

interface CleanupNode {
  id: string;
  type: "cleanup";
  clears: "wip";                 // only wip/ is cleared
  on_complete: string;           // routes back to first agent of the phase
}
```

**Condition DSL:** Minimal string parser — `field operator value`. Operators: `==`, `!=`, `>`, `<`, `in`. Unknown field references evaluate to `false`, never throw. No `eval`, no arbitrary JavaScript.

**Validation:** At startup, CLaDOS validates the graph via DFS for cycles. If any cycle is found, it refuses to start with a clear error listing the cycle path.

**Default graph:** CLaDOS ships with a `workflow-graph.default.json` that encodes the exact V1/V2 phase sequence. The default graph is functionally identical to the hardcoded conductor — proving the graph engine doesn't change behavior, only representation.

**`clados workflow`** CLI subcommand:
- `clados workflow show` — prints the current graph as a readable table
- `clados workflow validate` — runs cycle detection and condition parsing without starting the pipeline

**Why now:** After V1 and V2, you know which phase orderings and conditional branches real projects need. The DAG isn't speculative — it's encoding patterns you've already seen.

### 2. Custom agent framework

**What:** `clados agent add` scaffolds a new agent prompt and registers it in `agent-registry.json`.

**Two tiers:**

**`--mode reviewer` (default):**
- Scaffolds a minimal prompt with the required sections (Identity, Inputs, Task, Output schema, Constraints)
- The output schema is freeform text
- An adapter in the Conductor converts freeform text output to the structured findings schema (`must_fix` / `should_fix` / `suggestion`)
- The agent is automatically inserted into the workflow graph after the Validator in the phase specified by `--phase`
- Suitable for quick domain-specific checks (accessibility, compliance, performance budget)

**`--mode agent` (advanced):**
- Full scaffold with structured output, tool declarations, and fix loop support
- Uses the same dispatch loop and toolset as built-in agents
- Requires manual placement in `workflow-graph.json`
- For agents that produce artifacts, not just findings

**Agent lifecycle commands:**
- `clados agent add --mode reviewer --phase 2 --name "a11y-checker"` → scaffolds `agents/custom/a11y-checker.md`, adds to registry and graph
- `clados agent list` → shows all agents (built-in and custom) with their status, phase, and mode
- `clados agent remove <name>` → removes from registry and graph, archives prompt to `agents/custom/_archived/`
- `clados agent test <name>` → dry-run dispatch with a minimal test artifact, check that the output parses correctly

**Why now:** After V2, you've seen what domain-specific checks users want. The framework gives them the ability to add checks without modifying the Conductor's code.

### 3. IDE bridge

**What:** Bi-directional awareness between CLaDOS and the user's code editor.

**File watchers:**
- CLaDOS watches `.clados/wip/` and `src/` for external changes
- If the user edits a generated file in their editor while a gate is open, the Gate UI shows a banner: *"1 file changed externally since this gate opened"* with a list of changed files
- The Conductor does not auto-re-validate on external changes — the user must explicitly request re-validation or approve as-is
- File watching uses `fs.watch` with debounce (500ms) — no polling, no heavy dependency

**Deep-link URIs:**
- Validator findings that reference specific files include clickable links: `vscode://file/{project_root}/src/routes/tasks.ts:44`
- Links work for VS Code. Other editors are supported via a config field `editor_uri_scheme` in `.clados/00-session-state.json` (default: `vscode`)
- If the user's editor doesn't support URI schemes, the link falls back to displaying the file path and line number as plain text

**Limitations (explicit):**
- CLaDOS does not auto-resolve conflicts between AI writes and user edits — this is the user's responsibility
- File watchers are best-effort; they notify but don't block

**Why now:** After V2, users are actively editing generated code alongside the pipeline. The IDE bridge acknowledges this workflow instead of pretending the generated files are read-only.

### 4. Multi-language support (Python)

**What:** Add Python as a second supported stack alongside TypeScript.

**What changes:**
- `project_type` gains a `language` field: `typescript` (default) or `python`
- Agent prompts receive language-specific sections via a template variable: `{{language_context}}`
- The Contract Validator gains a Python mode: parses FastAPI/Flask route decorators instead of Express route definitions
- The Test Runner gains a Python mode: runs `pytest` in a virtualenv instead of `npm test`
- AST/LSP extraction uses `tree-sitter-python` and `pyright` instead of `tree-sitter-typescript` and `tsserver`
- Engineer system prompts include language-specific constraints (e.g., Python typing conventions, dependency management via `pyproject.toml`)

**What doesn't change:**
- The orchestrator, Conductor, and UI remain TypeScript
- The workflow graph, session state, and artifact format are identical
- Agent dispatch, tool handling, and validation pipeline are language-agnostic

**Scope limit:** Only Python. No Go, Rust, Java, or others until Python support is proven. Each new language requires: Contract Validator support, Test Runner support, AST extraction support, and Engineer prompt tuning. That's a nontrivial per-language cost.

**Why now:** TypeScript-only is sufficient to prove the pipeline, but limits the addressable project space. Python is the most obvious second language — large ecosystem, clear web framework choices (FastAPI), and well-supported Tree-sitter grammar.

---

## Updated file structure (additions only)

```
clados/
  orchestrator/
    workflow-graph.default.json  ← NEW: default graph encoding V1/V2 sequence
    graph-engine.ts              ← NEW: reads graph, evaluates conditions, drives transitions
    graph-validator.ts           ← NEW: DFS cycle detection, condition parsing validation
    cli/
      workflow.ts                ← NEW: clados workflow show/validate
      agent.ts                   ← NEW: clados agent add/list/remove/test
    language/
      typescript.ts              ← NEW: TS-specific contract validator, test runner, AST config
      python.ts                  ← NEW: Python-specific equivalents
  agents/
    custom/                      ← NEW: user-defined agent prompts
      _archived/                 ← NEW: removed custom agents preserved here

{project}/
  .clados/
    workflow-graph.json          ← NEW: project-level graph (copied from default, editable)
```

---

## What's still NOT in v3

- Interactive Mode (post-deployment chat with AST context)
- Re-invocation workflow (adding features / fixing bugs on existing CLaDOS projects)
- Languages beyond Python
- Agent marketplace or community sharing

These ship in V4 or later.
