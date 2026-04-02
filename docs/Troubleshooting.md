# CLaDOS Troubleshooting Guide

## 1. API key invalid or expired

**Symptom:** Pipeline fails immediately with `401 Unauthorized` or `Invalid API key`.

**Fix:**
- Verify your `ANTHROPIC_API_KEY` is set: `echo $ANTHROPIC_API_KEY`
- Check it hasn't expired on the [Anthropic Console](https://console.anthropic.com/)
- Re-export it: `export ANTHROPIC_API_KEY=sk-ant-...`
- Restart CLaDOS

## 2. All retries exhausted on an agent

**Symptom:** Agent card shows "Error" with retry count 3/3. The pipeline stops.

**Fix:**
- Check the [Anthropic Status Page](https://status.anthropic.com/) for outages
- Click "Retry" on the agent card to re-dispatch
- If the model is overloaded, wait a few minutes and retry
- If persistent, check the ActivityLog for the specific error message

## 3. Budget cap hit mid-run

**Symptom:** Budget gate opens: "Agent X is blocked — projected cost exceeds your remaining budget."

**Fix:**
- Raise the cap in the budget gate dialog and click "Continue"
- For future runs, set a higher `spend_cap` when creating the project
- Phase 2 (Build) is the most expensive — budget caps below $5 may interrupt full-stack projects

## 4. Disk full

**Symptom:** Errors mentioning `ENOSPC`, `no space left on device`, or atomic write failures.

**Fix:**
- Clear archived rollback history: delete contents of `<project>/.clados/history/`
- Clear WIP partial files: delete contents of `<project>/.clados/wip/`
- Free disk space and resume — CLaDOS will re-run the interrupted agent

## 5. Port 3100 in use

**Symptom:** `Error: listen EADDRINUSE: address already in use :::3100`

**Fix:**
- Kill the conflicting process: `lsof -i :3100` (macOS/Linux) or `netstat -ano | findstr 3100` (Windows)
- CLaDOS auto-scans ports 3100–3199; if all are taken, free one
- Or kill a stale CLaDOS process: `pkill -f "node.*clados"` (macOS/Linux)

## 6. WebSocket disconnected permanently

**Symptom:** Banner says "Could not reconnect — restart CLaDOS to continue."

**Fix:**
- Restart the CLaDOS server — the UI will auto-reconnect
- The pipeline state is preserved on disk; it will resume from the last checkpoint
- If the server is running but the UI can't connect, check for a proxy or firewall blocking WebSocket upgrades

## 7. Session state corrupt

**Symptom:** `Session state corrupted` error, or `clados doctor` reports checksum mismatch.

**Fix:**
- Run `clados doctor <project-dir>` to diagnose
- If checksum mismatch: the state file was modified outside CLaDOS. Check `.clados/history/` for a recent backup
- If JSON parse error: the process was killed during a write. Delete `00-session-state.json` and restore from the most recent file in `.clados/history/`
- As a last resort, start a new project — all generated source code in `src/` is unaffected

## 8. Docker not running (test runner fails)

**Symptom:** Test runner reports `docker compose up failed` or `Cannot connect to the Docker daemon`.

**Fix:**
- Start Docker Desktop (or the Docker daemon on Linux)
- Verify: `docker info`
- Re-run the current phase — CLaDOS will retry the test runner
- If you don't need database tests, the test runner will skip Docker when no `docker-compose.test.yml` exists

## 9. Agent produces unparseable output

**Symptom:** Validator card shows "Parse error" or the gate opens with empty findings.

**Fix:**
- CLaDOS has a built-in JSON sanitizer that strips markdown fences and trailing prose. If it still fails, the agent's output was severely malformed
- Click "Retry" — LLM output is non-deterministic; a second attempt usually produces valid output
- If persistent across 3+ retries, check if the agent's context is too large (the "compressed" indicator on the card). Large contexts can cause truncated output
- File a bug with the raw output from `.clados/wip/{phase}-{agent}.partial.*`

## 10. Gate stuck (no WS broadcast)

**Symptom:** Agent completes (card shows "Done") but no gate opens. Pipeline appears frozen.

**Fix:**
- Refresh the browser — the WebSocket may have missed the `gate:open` event
- If the Topbar still shows "Agents running..." after all cards are done, the Conductor may have crashed silently. Check the terminal for errors
- Restart the CLaDOS server — state is preserved, and the pipeline will resume
- Run `clados doctor <project-dir>` to verify state integrity before resuming
