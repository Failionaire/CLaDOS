# CLaDOS v1 Fix Plan

Issues identified during code review, ordered by severity and dependency. Each fix is scoped to the minimum change needed — no refactoring beyond what's required.

---

## Critical fixes (do these first)

---

### Fix 1 — WIP artifact extension must reflect output type, not always `.md`

**File:** `orchestrator/conductor.ts`  
**Problem:** `wipPath` always uses `.partial.md`. `passesStructuralMarkerTest` branches on extension — Validator (JSON), QA manifest (JSON), etc. will always fail the marker test and restart clean after a crash, losing partial progress.

**Fix:** Derive the extension from the agent's expected output type. Add a small lookup:

```typescript
function wipExtForRole(role: string): string {
  const jsonRoles = new Set(['validator', 'qa', 'security', 'wrecker']);
  return jsonRoles.has(role) ? '.partial.json' : '.partial.md';
}
```

Then in `dispatchWithRetry`:
```typescript
const wipPath = path.join(claDosDir, 'wip', `${phase}-${role}${wipExtForRole(role)}`);
```

**Verification:** After fix, crash-recovery for Validator and QA agents should resume from partial output rather than restarting.

---

### Fix 2 — Phase 4 revision Validator is missing its prior findings artifact

**File:** `orchestrator/conductor.ts`  
**Problem:** In `runPhaseRevision`, case 4, the Validator's `contextArtifacts` contains only `01-architecture.md`. Without `04-validator.json`, it cannot classify prior findings as `resolved`/`unresolved`/`new_discovery` — every re-review produces a new set of `new` findings, which breaks the `unresolved_streak` counter and the `conductor.reason()` trigger.

**Fix:** Add `04-validator.json` as a `required` artifact in the case 4 Validator dispatch, matching the pattern used in cases 0–3:

```typescript
case 4:
  await this.dispatchAgent({
    role: 'devops', phase: 4, projectDir,
    contextArtifacts: [{ artifact: '04-validator.json', type: 'required' }],
    contextPrefix: revisedContextPrefix,
  });
  await this.dispatchAgent({
    role: 'validator', phase: 4, projectDir,
    contextArtifacts: [
      { artifact: '01-architecture.md', type: 'reference' },
      { artifact: '04-validator.json', type: 'required' },  // ← add this
    ],
    contextPrefix: 'Classify each prior finding. Read infra/ and docs/runbook.md via read_file. Update 04-validator.json.',
  });
  break;
```

---

### Fix 3 — Retry/Skip resolves all waiting parallel agents instead of the targeted one

**Files:** `orchestrator/conductor.ts`, `orchestrator/server.ts`  
**Problem:** `handleAgentRetry()` and `handleAgentSkip()` loop over the entire `agentErrorResolves` Map and resolve every entry. In Phase 2 Stage B, QA and Security run in parallel — a Retry on one resolves both.

**Fix part A — server.ts:** Accept a `role` in the request body for both routes:

```typescript
app.post('/agent/retry', (req, res) => {
  const { role } = req.body as { role?: string };
  if (!role) { res.status(400).json({ error: 'role required' }); return; }
  ctx.conductor.handleAgentRetry(role);
  res.json({ ok: true });
});

app.post('/agent/skip', (req, res) => {
  const { role } = req.body as { role?: string };
  if (!role) { res.status(400).json({ error: 'role required' }); return; }
  ctx.conductor.handleAgentSkip(role);
  res.json({ ok: true });
});
```

**Fix part B — conductor.ts:** Change the handlers to target a specific role:

```typescript
handleAgentRetry(role: string): void {
  const resolve = this.agentErrorResolves.get(role);
  if (resolve) { resolve('retry'); this.agentErrorResolves.delete(role); }
}

handleAgentSkip(role: string): void {
  const resolve = this.agentErrorResolves.get(role);
  if (resolve) { resolve('skip'); this.agentErrorResolves.delete(role); }
}
```

**Fix part C — AgentCard.tsx / KanbanBoard.tsx / App.tsx:** Pass the agent role in the fetch body:

```typescript
// App.tsx
const handleRetry = async (phase: number, agent: string) => {
  await fetch('/agent/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: agent }),
  });
};

const handleSkip = async (phase: number, agent: string) => {
  await fetch('/agent/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: agent }),
  });
};
```

---

### Fix 4 — Skip button is never rendered (not wired through the component tree)

**Files:** `ui/src/App.tsx`, `ui/src/components/KanbanBoard.tsx`  
**Problem:** `App.tsx` declares no `handleSkip`. `KanbanBoard`'s props interface has no `onSkip`. The Skip button in `AgentCard` can never appear because `onSkip` is always `undefined`.

**Fix part A — App.tsx:** Add `handleSkip` (using role-targeted body from Fix 3) and pass it to `KanbanBoard`.

**Fix part B — KanbanBoard.tsx:** Add `onSkip` to `KanbanBoardProps`:

```typescript
interface KanbanBoardProps {
  sessionState: SessionState | null;
  events: WsEvent[];
  onRetry: (phase: number, agent: string) => void;
  onSkip: (phase: number, agent: string) => void;  // ← add
}
```

Then in the card rendering, pass `onSkip` only when `card.isSkippable` is true:

```typescript
<AgentCard
  key={`${card.phase}:${card.role}`}
  card={card}
  onRetry={card.status === 'error' ? () => onRetry(card.phase, card.role) : undefined}
  onSkip={card.status === 'error' && card.isSkippable ? () => onSkip(card.phase, card.role) : undefined}
/>
```

---

### Fix 5 — Skip button condition is inverted and `isSkippable` is not stored on cards

**Files:** `ui/src/types.ts`, `ui/src/components/KanbanBoard.tsx`, `ui/src/components/AgentCard.tsx`  
**Problem:** `AgentCard` shows Skip only on status `'flagged'` (wrong — should be `'error'`). Also `AgentCardState` has no `isSkippable` field, so the button cannot be gated on role-specific skipability. This is a prerequisite for Fix 4 to be meaningful.

**Fix part A — types.ts:** Add `isSkippable` to `AgentCardState`:
```typescript
interface AgentCardState {
  // ... existing fields ...
  isSkippable: boolean;
}
```

**Fix part B — KanbanBoard.tsx:** Store `is_skippable` when processing `agent:error`:
```typescript
case 'agent:error': {
  const key = `${latestEvent.phase}:${latestEvent.agent}`;
  if (next[key]) {
    next[key] = {
      ...next[key],
      status: 'error',
      errorMessage: latestEvent.message,
      isSkippable: latestEvent.is_skippable,  // ← add
    };
  }
  break;
}
```

And initialize it to `false` in `buildInitialCards`.

**Fix part C — AgentCard.tsx:** Change the Skip condition from `'flagged'` to `'error'`:
```typescript
{onSkip && card.status === 'error' && (  // was: card.status === 'flagged'
  <button style={styles.skipBtn} onClick={onSkip}>Skip</button>
)}
```

---

### Fix 13 — Full-stack parallel Engineers share the same WIP path (data corruption)

**File:** `orchestrator/conductor.ts`  
**Problem:** Both the backend and frontend Engineers in `runPhase2` full-stack mode use `role: 'engineer'`, so `dispatchWithRetry` generates the identical WIP path for both: `.clados/wip/2-engineer.partial.md`. Both streams write to this same file concurrently — the last writer wins and the other's partial output is silently lost, breaking crash recovery for whichever engineer loses the race.

**Fix:** Derive a disambiguating suffix from `variables.engineer_role` when building the WIP path:

```typescript
// In dispatchWithRetry, when computing wipPath:
const engineerSuffix = variables?.engineer_role ? `-${variables.engineer_role}` : '';
const ext = wipExtForRole(role); // from Fix 1
const wipPath = path.join(claDosDir, 'wip', `${phase}-${role}${engineerSuffix}${ext}`);
```

**Verification:** Run a full-stack project through Phase 2; both `2-engineer-backend.partial.md` and `2-engineer-frontend.partial.md` should exist and be non-empty while engineers are running.

---

### Fix 14 — Full-stack parallel Engineers share `agentErrorResolves` key (orphaned promise)

**File:** `orchestrator/conductor.ts`  
**Problem:** Same root cause as Fix 3 but distinct. When both Engineers error simultaneously, `agentErrorResolves.set('engineer', resolve_frontend)` overwrites `resolve_backend`. The backend engineer's `await new Promise(...)` can never resolve — it hangs forever. Fix 3 already handles different roles (QA + Security); this case requires a distinct key per engineer role.

**Fix:** Use the `engineer_role` variable to form the map key, and apply the same key in `handleAgentRetry`/`handleAgentSkip`. The cleanest approach is to pass an optional `errorKey` override through `AgentDispatchConfig`:

```typescript
// In AgentDispatchConfig (types.ts), add:
errorKey?: string;

// In dispatchAgent, when storing the resolver:
const mapKey = config.errorKey ?? role;
const decision = await new Promise<'retry' | 'skip'>((resolve) => {
  this.agentErrorResolves.set(mapKey, resolve);
});
this.agentErrorResolves.delete(mapKey);
```

Then in `runPhase2`, pass `errorKey: 'engineer-backend'` and `errorKey: 'engineer-frontend'` to the respective engineer dispatches. The Retry/Skip body from the UI must send the matching key — so the `WsAgentError` event should carry whatever key was used, not just `role`.

---

### Fix 15 — No `agent:skipped` WebSocket event emitted on skip

**Files:** `orchestrator/conductor.ts`, `orchestrator/types.ts`, `ui/src/types.ts`, `ui/src/components/KanbanBoard.tsx`  
**Problem:** When an agent is skipped (`decision === 'skip'`), the Conductor returns silently with no `this.broadcast(...)` call. The card stays permanently in `'error'` status. The `'skipped'` color, border, and label in `AgentCard`'s style maps are unreachable dead code.

**Fix part A — types.ts (orchestrator):** Add the event type:

```typescript
export interface WsAgentSkipped {
  type: 'agent:skipped';
  phase: number;
  agent: string;
}
// Add to WsServerEvent union
```

**Fix part B — conductor.ts:** Broadcast before the early return:

```typescript
if (decision === 'skip') {
  this.logger.warn('agent.skipped', `${role} skipped by user`);
  this.broadcast({ type: 'agent:skipped', phase, agent: role }); // ← add
  return { role, phase, artifactPath: '', finalText: '', tokensInput: 0, tokensOutput: 0, costUsd: 0 };
}
```

**Fix part C — ui/src/types.ts:** Mirror the event type and add to the `WsEvent` union.

**Fix part D — KanbanBoard.tsx:** Handle the new event case:

```typescript
case 'agent:skipped': {
  const key = `${latestEvent.phase}:${latestEvent.agent}`;
  if (next[key]) {
    next[key] = { ...next[key], status: 'skipped' };
  }
  break;
}
```

---

### Fix 6 — Stale closure saves wrong height in `Gate.tsx` drag-to-resize

**File:** `ui/src/components/Gate.tsx`  
**Problem:** `onDragEnd` captures `height` from the render at drag-start time (stale closure). The persisted localStorage value is always the pre-drag height.

**Fix:** Track live height in a ref inside `onDragMove`, then read the ref in `onDragEnd`:

```typescript
const liveHeightRef = useRef(height);

const onDragMove = (e: MouseEvent) => {
  if (dragStartY.current === null) return;
  const delta = dragStartY.current - e.clientY;
  const newH = Math.max(MIN_HEIGHT, dragStartH.current + delta);
  liveHeightRef.current = newH;  // ← keep ref in sync
  setHeight(newH);
};

const onDragEnd = () => {
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
  try { localStorage.setItem(STORAGE_KEY, String(liveHeightRef.current)); } catch {}  // ← read ref
};
```

---

## Medium fixes

---

### Fix 7 — QA asymmetric context is prompt-only; `read_file` should enforce it in code

**File:** `orchestrator/conductor.ts`  
**Problem:** `processToolCalls` uses a single `resolveSafePath` scoped to the project root, with no agent-level path restrictions. The QA agent can call `read_file("src/index.ts")` and succeed. The spec requires asymmetric context to be structurally enforced.

**Fix:** Add an optional `deniedPrefixes` parameter to `dispatchAgent` / `dispatchWithRetry`, and thread it through to `processToolCalls`:

```typescript
// In processToolCalls, read_file case:
case 'read_file': {
  const filePath = this.resolveSafePath(projectDir, input['path']!);
  // Enforce denied prefixes (e.g., QA cannot read src/ or 01-schema.yaml)
  if (deniedPrefixes?.some((p) => filePath.startsWith(path.resolve(projectDir, p)))) {
    toolResult = `Access denied: ${input['path']} is not available to this agent.`;
    break;
  }
  toolResult = await fs.promises.readFile(filePath, 'utf-8');
  break;
}
```

In `runPhase2`, pass `deniedPrefixes: ['src', '.clados/01-schema.yaml']` to the QA dispatch.

---

### Fix 8 — `GOTO_PHASE_` rollback grows the call stack on multiple gotos

**File:** `orchestrator/cli.ts`  
**Problem:** Each goto exception is caught and calls `conductor.runPipeline(projectDir)` recursively. Multiple gotos nest call frames, and a long session with many rollbacks could eventually stack-overflow (or just be hard to reason about in a debugger).

**Fix:** Replace the recursive call with a loop:

```typescript
// In startServer:
let keepRunning = true;
while (keepRunning) {
  try {
    await conductor.runPipeline(projectDir);
    keepRunning = false;
  } catch (err) {
    const msg = String(err);
    if (msg === 'PIPELINE_ABANDONED') {
      console.log('\nProject abandoned.');
      keepRunning = false;
    } else if (msg.startsWith('GOTO_PHASE_')) {
      // runPipeline will re-resume from current_phase — just loop
      continue;
    } else {
      logger.error('cli.pipeline_error', msg);
      console.error('\nPipeline error:', msg);
      keepRunning = false;
    }
  }
}
```

---

### Fix 9 — Compressed artifact read_file hint gives paths without `.clados/` prefix

**File:** `orchestrator/context.ts`  
**Problem:** When artifacts are downgraded to summaries and granted `read_file` access, the note injected into context lists paths like `01-prd.md`. But `resolveSafePath(projectDir, "01-prd.md")` looks in the project root, not `.clados/`. The actual file is at `.clados/01-prd.md`.

**Fix:** Prefix with `.clados/` when building the hint in `conductor.ts`:

```typescript
// In dispatchWithRetry, after resolveContextArtifacts:
if (fullFetchPaths.length > 0) {
  const prefixed = fullFetchPaths.map((p) => `.clados/${p}`);
  userContent += `\n\n[NOTE: The following artifacts were compressed. Use read_file to access them in full: ${prefixed.join(', ')}]`;
}
```

---

### Fix 16 — `context_compressed` missing from UI `WsAgentDone` type; KanbanBoard never maps it

**Files:** `ui/src/types.ts`, `ui/src/components/KanbanBoard.tsx`  
**Problem:** The orchestrator's `WsAgentDone` event includes `context_compressed: boolean`. The UI mirror type in `ui/src/types.ts` omits this field. The `agent:done` handler in `KanbanBoard.tsx` never writes to `contextCompressed`. The "⬇ compressed" indicator in `AgentCard` initializes to `false` in `buildInitialCards` and can never change — it is permanently broken.

**Fix part A — ui/src/types.ts:** Add the field:

```typescript
export interface WsAgentDone {
  // ... existing fields ...
  cost_usd: number;
  context_compressed: boolean; // ← add
}
```

**Fix part B — KanbanBoard.tsx, `agent:done` case:** Wire the field through:

```typescript
next[key] = {
  ...next[key],
  status: 'done',
  inputTokens: latestEvent.tokens_used.input,
  outputTokens: latestEvent.tokens_used.output,
  costUsd: latestEvent.cost_usd,
  artifactKey: latestEvent.artifact,
  contextCompressed: latestEvent.context_compressed, // ← add
};
```

---

### Fix 17 — Phase 3 revision never re-dispatches PM

**File:** `orchestrator/conductor.ts`  
**Problem:** Phase 3 produces two PM-owned artifacts (`03-prd.md`, `03-api-spec.yaml`) and one Docs-owned artifact (`docs/`). The `runPhaseRevision` case 3 block only re-dispatches `docs`. If the Validator flags must-fix issues in either PM artifact, the revision loop cannot address them. The `unresolved_streak` counter increments until the terminal gate fires with no real path to resolution.

**Fix:** Mirror the case 1 pattern — check which artifacts are flagged and conditionally re-dispatch `pm`:

```typescript
case 3: {
  const pmFiles = ['03-prd.md', '03-api-spec.yaml'];
  const needsPm = mustFixFindings.some(
    (f) => !f.file || pmFiles.some((pf) => f.file?.includes(pf)),
  );
  if (needsPm) {
    await this.dispatchAgent({
      role: 'pm', phase: 3, projectDir,
      contextArtifacts: [
        { artifact: '01-api-spec.yaml', type: 'reference' },
        { artifact: '03-validator.json', type: 'required' },
      ],
      contextPrefix: revisedContextPrefix,
    });
  }
  await this.dispatchAgent({
    role: 'docs', phase: 3, projectDir,
    contextArtifacts: [{ artifact: '03-validator.json', type: 'required' }],
    contextPrefix: revisedContextPrefix,
  });
  await this.dispatchAgent({
    role: 'validator', phase: 3, projectDir,
    contextArtifacts: [
      { artifact: '03-prd.md', type: 'required' },
      { artifact: '03-api-spec.yaml', type: 'required' },
      { artifact: '03-validator.json', type: 'required' },
    ],
    contextPrefix: 'Classify each prior finding. Update 03-validator.json.',
  });
  break;
}
```

---

## Low priority fixes

---

### Fix 10 — `gate:open` flags the wrong card (by order, not by role)

**File:** `ui/src/components/KanbanBoard.tsx`  
**Problem:** `Object.values(next)` order is non-deterministic in edge cases. The intent is to flag the Validator card specifically after a gate opens.

**Fix:** Replace the last-done heuristic with an explicit role lookup:

```typescript
case 'gate:open': {
  // Flag the Validator card for this phase — it's always the gate-owner
  const key = `${latestEvent.phase}:validator`;
  if (next[key]?.status === 'done') {
    next[key] = { ...next[key], status: 'flagged' };
  }
  break;
}
```

---

### Fix 11 — Summarizer cost is tracked in-memory but never written to session state

**File:** `orchestrator/conductor.ts` and `orchestrator/session.ts`  
**Problem:** `onSummarizerCost` accumulates cost locally within `dispatchWithRetry` but never calls `session.recordTokens`. The hover-over per-phase cost breakdown will undercount on projects that trigger context compression.

**Fix:** After `resolveContextArtifacts` returns, write accumulated summarizer cost to session state under a `summarizer` role key:

```typescript
if (cumulativeSummarizerCost > 0) {
  await this.session.recordTokens(projectDir, phase, 'summarizer', {
    input: 0,
    output: 0,
    cost_usd: cumulativeSummarizerCost,
  });
}
```

---

### Fix 12 — `resolveSafePath` path-traversal check is fragile on Windows (case sensitivity)

**File:** `orchestrator/conductor.ts`  
**Problem:** `resolved.startsWith(path.resolve(projectDir) + path.sep)` is a string prefix check. On case-insensitive filesystems (Windows), `C:\Project` and `c:\project` differ as strings but are the same path, making the check bypassable via case manipulation.

**Fix:** Use a relative-path check, which is case-normalized by the OS:

```typescript
private resolveSafePath(projectDir: string, requestedPath: string): string {
  const resolved = path.resolve(projectDir, requestedPath);
  const relative = path.relative(path.resolve(projectDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path traversal denied: ${requestedPath}`);
  }
  return resolved;
}
```

---

### Fix 18 — `is_high_complexity` missing from UI `SessionConfig` type

**File:** `ui/src/types.ts`  
**Problem:** The orchestrator's `SessionConfig` has `is_high_complexity: boolean`. The UI mirror type omits it. Any component that reads `sessionState.config.is_high_complexity` (e.g., a complexity indicator in the Topbar) would get a TypeScript error, and the field is invisible to the type system for any future UI use.

**Fix:** Add the field to `ui/src/types.ts` `SessionConfig`:

```typescript
export interface SessionConfig {
  // ... existing fields ...
  is_high_complexity: boolean; // ← add
}
```

---

## Implementation order

The dependencies between fixes mean the recommended order is:

1. **Fix 5** (store `isSkippable` on cards) — prerequisite for Fix 4
2. **Fix 4** (wire Skip through the component tree) — prerequisite for Fix 3c to be testable
3. **Fix 13** (full-stack engineer WIP path) — independent, prevents crash-recovery data loss on full-stack projects
4. **Fix 14** (full-stack engineer error key) — shares root cause with Fix 3; do together
5. **Fix 3** (target Retry/Skip to specific agent) — includes UI + server + conductor
6. **Fix 15** (agent:skipped broadcast) — do alongside Fix 5 Skip wiring; completes the Skip flow end-to-end
7. **Fix 1** (WIP extension) — independent, high value, easy; combine with Fix 13 since both touch `wipPath`
8. **Fix 2** (Phase 4 Validator context) — independent, one-line
9. **Fix 17** (Phase 3 PM revision) — independent, targeted fix in `runPhaseRevision`
10. **Fix 6** (Gate drag stale closure) — independent UI fix
11. **Fix 16** (context_compressed in UI) — independent KanbanBoard fix
12. **Fix 9** (`.clados/` prefix in read_file hint) — independent, one-line
13. **Fix 7** (QA path enforcement) — requires adding `deniedPrefixes` to dispatch config
14. **Fix 8** (goto loop) — independent, CLI-only
15. **Fix 10, 11, 12, 18** — low priority, can batch last
