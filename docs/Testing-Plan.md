Searched codebase for "Okay, I suppose that is my next question. How the hell do I test this without spending insane amounts of money on API costs?", 25 results

Testing a multi-agent orchestrator can burn through API credits extremely quickly if you do full end-to-end runs with Opus and Sonnet every time. 

Here are the four most practical ways to test CLaDOS without draining your wallet, ranging from "cheap real runs" to "completely free offline testing."

### 1. The "Oops, All Haiku!" Strategy (Cheap Real Runs)
Currently, your agent-registry.json assigns `claude-sonnet-...` as the default and `claude-opus-...` as the escalation model. Haiku is about **95% cheaper** than Opus and ~75% cheaper than Sonnet. 

For pipeline testing, you can temporarily set all models in agent-registry.json to `claude-haiku-4-5`. 
* **The Benefit:** It still tests real LLM generation, tool usage, and context assembly.
* **The Bonus:** Haiku is less capable at complex coding, which means it will naturally fail more often. This is actually *perfect* because it natively exercises your `must_fix` finding revision loops, the `conductor.reason()` escape hatch, and the `Error` transition states without you having to artificially break things.

### 2. Stand Up a Mock Anthropic Server (Completely Free)
If you want to relentlessly test the UI WebSocket transitions, crash recovery, and state machine without hitting real APIs at all, you can spoof the API base URL. 

The Anthropic SDK automatically respects the `ANTHROPIC_BASE_URL` environment variable. You can create a tiny Express script that intercepts requests and returns canned artifacts based on the agent's system prompt or requested tools:

```javascript
// mock-anthropic.js
const express = require('express');
const app = express();
app.use(express.json());

app.post('/v1/messages', (req, res) => {
  // Inspect req.body.system to figure out which agent this is, then return fake data
  res.json({
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: req.body.model,
    content: [{ type: "text", text: "## Mock Output\n\nThis is a free test." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 150, output_tokens: 50 }
  });
});

app.listen(4000, () => console.log('Mock Anthropic running on port 4000'));
```
Run `node mock-anthropic.js` in one terminal, then start CLaDOS with `ANTHROPIC_BASE_URL=http://localhost:4000 node bin/clados.js`. The home screen will appear — create a project called `test-project` from there. This lets you stress-test the Kanban board and Conductor logic entirely for free.

### 3. "Hot-Swap" Session Checkpoints
Don't rebuild the whole project from Concept (Phase 0) every time you want to test the Docs agent (Phase 3). 
Manually assemble a `.clados/` folder with fake artifacts (`00-concept.md`, `01-prd.md`, etc.) and a seeded `00-session-state.json` file. 

Set your state to start *right at the gate* of whatever you're testing:
```json
{
  "pipeline_status": "idle",
  "current_phase": 2,
  "phases_completed": [0, 1],
  "phase_checkpoint": {
    "phase": 2,
    "completed_agents": [],
    "in_progress_agent": null,
    "gate_revision_count": 0,
    "unresolved_streak": 0
  }
}
```
Run `node bin/clados.js` and select `test-project` from the home screen. CLaDOS will pick up immediately at Phase 2, allowing you to iterate on Engineer prompts without paying the PM/Architect tax of Phase 0 and 1. 

### 4. Test Mechanical Subagents Locally 
The parts of the codebase most prone to execution failure are the determinist bots: contract-validator.ts and test-runner.ts. Because these are purely TypeScript AST/Docker process wrappers, you can write simple unit tests or npm scripts calling these modules directly against dummy `src/` files. No Claude API required at all.

***

**My Recommendation:** Start by switching agent-registry.json entirely to Haiku to test if the "happy path" holds together structurally. After that, rely heavily on Method #3 (saving zipped `.clados/` checkpoint states) so you can resume straight into specific tricky phases over and over.