# TASK

Implement issue #{{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue with comments using `gh issue view {{TASK_ID}} --comments`. The issue body is the **authoritative contract** for this work — every acceptance criterion must be satisfied before you mark the task complete.

If the issue references the spec, fetch it from `docs/superpowers/specs/2026-05-21-market-alert-system-design.md` and read the relevant sections.

Only work on the issue specified. Stay strictly within scope. Do not touch unrelated features.

Work on branch `{{BRANCH}}`. Make commits as you go and run tests.

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

Only modify files in the **new** system unless the issue explicitly says otherwise. You may *read* from old files if a helper is reusable (e.g. `supabase/functions/_shared/market-hours.ts` and Angel One client logic from `supabase/functions/refresh-prices`).

# EXPLORATION

Before writing code, explore the repo to fill your context:

1. Read `AGENTS.md` at repo root
2. Read the spec section relevant to your issue
3. Read any prior `bot_*` migrations and `bot-*` edge functions
4. Read the Supabase Vault setup at `supabase/snippets/seed_vault_secrets.sql`
5. Examine reusable helpers in `supabase/functions/_shared/`

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use Red-Green-Refactor (TDD) to complete the task:

1. RED: write one failing test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing:

- If `bot/package.json` exists: run `cd bot && pnpm typecheck && pnpm test` (skip steps not defined)
- For Edge Functions: run `deno check supabase/functions/<func>/index.ts`
- For migrations: run `supabase db reset` locally if possible (otherwise `supabase migration up`)
- If `quant-lab/` is modified: run the relevant Python script end-to-end

If a script doesn't exist yet (bootstrap issue scenario), do not invent it — skip.

# COMMIT

Make atomic git commits. Each commit message must:

1. Start with `RALPH:` prefix
2. State what was implemented + reference issue #{{TASK_ID}}
3. Note key decisions made
4. List files changed (high-level)
5. Note blockers or follow-ups if not fully complete

Keep it concise.

# THE ISSUE

If the task is not complete when you stop, leave a comment on the issue summarizing what's done and what remains.

Do not close the issue — the merge agent handles that.

Once you've fully satisfied all acceptance criteria, output `<promise>COMPLETE</promise>`.

# FINAL RULES

- ONLY WORK ON ISSUE #{{TASK_ID}}
- NEVER touch deprecated old-project files unless explicitly required
- NEVER modify the 1.5× risk multiplier cap
- NEVER bypass the kill switch
- NEVER add per-trade conviction scoring
- ALWAYS apply the slippage and fee model from the spec to paper trades
