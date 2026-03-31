# CLaDOS Test Projects

These projects are ordered by complexity. Run them in sequence — each one exercises more of the pipeline than the last.

---

## Tier 1 — Smoke Tests (Happy Path)

Goal: confirm the full 5-phase pipeline completes without crashing. Scope is intentionally trivial so Haiku can succeed.

### 1. URL Shortener API
**Type:** backend-only  
**Idea prompt:** *"A REST API that shortens URLs. POST /shorten accepts a long URL and returns a short code. GET /:code redirects to the original URL. Short codes are 6 random alphanumeric characters. No authentication required."*

What it exercises:
- Minimal schema (one table: `links`)
- Two endpoints — just enough for the contract validator to verify both
- Redirect behavior (301/302) — QA must assert HTTP status codes, not just JSON
- No auth complexity

---

### 2. Expense Tracker API
**Type:** backend-only  
**Idea prompt:** *"A REST API for tracking personal expenses. Endpoints: POST /expenses (create), GET /expenses (list all, with optional ?category= filter), GET /expenses/:id (get one), DELETE /expenses/:id (delete). Each expense has an amount, description, category, and date. No authentication required."*

What it exercises:
- Slightly more complex schema (one table with 4+ columns)
- Query parameter filtering — exercises OpenAPI spec precision
- 4 endpoints — contract validator has more to verify
- Pagination or filtering edge cases may trigger Validator `should_fix` findings

---

## Tier 2 — Revision Loop Tests

Goal: deliberately trigger the Validator to flag something, so the `gate_revision_count` increments and the revision loop runs at least once.

### 3. Rate-Limited Notes API
**Type:** backend-only  
**Idea prompt:** *"A REST API for markdown notes. CRUD endpoints: POST /notes, GET /notes, GET /notes/:id, PUT /notes/:id, DELETE /notes/:id. Notes have a title, body (markdown), and tags array. Requests should be rate-limited to 100 per minute per IP. No authentication required."*

Why it triggers revisions:
- Rate limiting strategy is underspecified — Validator will likely flag the implementation choice
- Tags array has ambiguous storage semantics (JSON column vs. join table) — Architect may choose differently than the Validator expects
- 5 endpoints + rate limiting = more surface area for contract mismatches

---

### 4. Job Queue Status API
**Type:** backend-only  
**Idea prompt:** *"A REST API for managing background job statuses. POST /jobs creates a job with a name and payload. GET /jobs lists all jobs. GET /jobs/:id returns a single job. POST /jobs/:id/cancel cancels a pending job. Jobs have statuses: pending, running, completed, failed. No actual job execution — just status tracking."*

Why it triggers revisions:
- State machine (job statuses) — Validator will check for missing transition guards
- `cancel` on a non-pending job is an edge case QA should catch
- The nested route `/jobs/:id/cancel` is a slightly unusual pattern that may trip up the contract validator's route matching

---

## Tier 3 — Optional Agent Tests (Security + Wrecker)

Run these with **Security ON** and **Wrecker ON** enabled on the home screen.

### 5. API Key Auth Service
**Type:** backend-only  
**Idea prompt:** *"A REST API for managing API keys. POST /keys generates a new API key with a name and optional expiry date. GET /keys lists all keys (never returns the full key value after creation — only a prefix). DELETE /keys/:id revokes a key. POST /auth/verify checks if a submitted key is valid and not expired. Keys are stored hashed in the database."*

Why it's good for Security + Wrecker:
- Security agent has obvious things to find (hashing, timing-safe comparison, key entropy)
- Wrecker can probe the verify endpoint with expired keys, revoked keys, malformed keys
- The "never return full key" requirement gives the Validator something concrete to enforce

---

## Notes on Running Tests

- **Switch agent-registry.json to Haiku** before running Tier 1 and 2. See Testing-Plan.md for instructions.
- **Save `.clados/` snapshots** after each phase completes. If a later phase breaks, you can restore a snapshot and re-open the project from the home screen rather than re-running the expensive early phases.
- **Phase 0 and 1 are cheap.** Don't skip them to save cost — the concept and architecture artifacts are what the Engineer and QA agents build on. Bad inputs here produce cascading failures.
- **Tier 1 tests are not interesting if they succeed on the first try.** The goal is to confirm the pipeline completes, not to get a perfect score. A run where the Validator flags one `should_fix` and it gets resolved on revision is a better test than a clean pass.
