# TASK

Implement issue #{{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue with comments using `gh issue view {{TASK_ID}} --comments`. The issue body is the **authoritative contract** — every acceptance criterion must be satisfied before you mark the task complete.

If the issue references the spec, fetch it from `docs/superpowers/specs/2026-05-21-market-alert-system-design.md` and read the relevant sections.

Only work on the issue specified. Stay strictly within scope. Do not touch unrelated features.

Work on branch `{{BRANCH}}`. Make atomic commits as you go and run tests after every commit.

Read `AGENTS.md` at the repo root for repo conventions before writing any code. **The "v1 hard rules" and "Forbidden patterns" sections are non-negotiable.**

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# REPO ORIENTATION

The repo has two distinct systems sharing one Supabase project:

- **Old (deprecated):** `dashboard/`, `quant-lab/`, `supabase/functions/scan-alerts`, `supabase/functions/scan-chanakya`, `supabase/migrations/202605*` (anything before the new bot tables)
- **New (active):** `bot/` (Next.js), `supabase/functions/bot-*` (Edge Functions), `supabase/migrations/*_bot_*.sql`

Only modify files in the **new** system unless the issue explicitly says otherwise. You may *read* old files if a helper is reusable (e.g. `supabase/functions/_shared/market-hours.ts` and the Angel One client logic in `supabase/functions/refresh-prices`).

# EXPLORATION

Before writing code, fill your context:

1. Read `AGENTS.md` at repo root
2. Read the spec section relevant to your issue
3. Read prior `bot_*` migrations and `bot-*` edge functions
4. Read the Supabase Vault setup at `supabase/snippets/seed_vault_secrets.sql`
5. Examine reusable helpers in `supabase/functions/_shared/`

# TEST-DRIVEN DEVELOPMENT — MANDATORY FOR BUSINESS LOGIC

This is a financial trading system. **Business logic MUST be developed test-first.** This is not optional. The review agent will reject merges that lack the required tests.

## What counts as business logic (TDD MANDATORY)

| Code | Required tests |
|---|---|
| Position sizing math | Inputs → expected share count, including floor() behaviour |
| Slippage application | Long entry slip up, short entry slip down, stop slip 2×, target slip 1× |
| Stop/target detection on candle | `high >= target`, `low <= stop`, both-hit-in-same-candle priority |
| Long vs short P&L direction | Sign flips correctly for shorts |
| Brokerage + statutory fee calculation | Numeric values match spec to the rupee |
| Net P&L formula | `gross - brokerage - statutory` exactly |
| Risk multiplier cap (1.5×) | Cannot be exceeded under any input |
| Kill switch flow | New entries blocked when `trading_enabled=false`; exits still monitored |
| Daily circuit breaker | Fires at ≤ -₹3,000; daily reset works; manual disable not auto-reset |
| ORB breakout detection | Volume threshold, range computation, direction logic |
| Deduplication of trades / incidents | Same key inside window → no duplicate |
| Market-hours guard | Inside hours → run; outside → no-op |

## What is exempt from TDD

| Code | Why exempt |
|---|---|
| React UI components (visual presentation) | Visual correctness is human-verified |
| SQL migrations | The migration IS the spec — schema is declarative |
| Telegram message string templates | Pure string formatting |
| README / docs files | No behaviour to test |
| Config files (next.config.ts, tsconfig.json) | Declarative |

## Required process for non-exempt code

1. **RED** — write one failing test. Run it. Confirm it fails for the **right reason** (not a syntax error or import miss).
2. **GREEN** — write the minimum code to pass that single test.
3. **REPEAT** — next test, next minimum.
4. **REFACTOR** — clean up once tests are green.

Do not write more than one failing test at a time. Do not write production code without a failing test that justifies it.

## Test files must:

- Live next to the code (`functionName.test.ts` next to `functionName.ts`) or in `__tests__/` per repo convention
- Use Deno's built-in test framework for Edge Functions (`Deno.test`) and Vitest or the Next-default test runner for `bot/` code
- Cover both the happy path AND at least one edge case (e.g. zero shares, exactly-at-stop, simultaneous fills)
- Use named test cases that read like sentences: `Deno.test("position sizing: ₹1000 risk with ₹20 stop distance returns 50 shares", ...)`

# FEEDBACK LOOPS

Before each commit:

- `bot/` code: `cd bot && pnpm typecheck && pnpm test`
- Edge Functions: `deno check supabase/functions/<func>/index.ts && deno test supabase/functions/<func>/`
- Migrations: `supabase migration up` against local DB if available; otherwise apply via SQL and verify schema
- Python `quant-lab/` changes: run the script end-to-end on sample data

If a tool isn't installed, install it once and proceed. Do not skip.

# COMMIT

Make atomic commits. Each commit message must:

1. Start with `RALPH:` prefix
2. State what was implemented + reference issue #{{TASK_ID}}
3. List key decisions
4. List files changed (high-level)
5. Note follow-ups if not fully complete

# WHEN COMPLETE

Leave a comment on the issue summarising:
- Tests added (named list)
- Acceptance criteria satisfied (checklist)
- Anything skipped or deferred (with reason)

Do NOT close the issue — the merge agent handles that.

Output `<promise>COMPLETE</promise>`.

# FINAL RULES

- ONLY WORK ON ISSUE #{{TASK_ID}}
- NEVER touch deprecated old-project files unless explicitly required
- NEVER modify the 1.5× risk multiplier cap
- NEVER bypass the kill switch
- NEVER add per-trade conviction scoring
- ALWAYS apply the slippage and fee model from the spec to paper trades
- ALWAYS write the test before the production code for non-exempt logic
