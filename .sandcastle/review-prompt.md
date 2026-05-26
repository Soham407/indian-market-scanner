# TASK

Review the implementation on branch `{{BRANCH}}` for issue #{{TASK_ID}}: {{ISSUE_TITLE}}.

Your job is to verify the code is ready to merge. You are the gate between Codex's work and the main branch. **Be strict.** If anything is wrong, output `<verdict>REJECT</verdict>` with specific reasons.

# WHAT TO CHECK

## 1. Acceptance criteria coverage

Run `gh issue view {{TASK_ID}} --comments`. For each `- [ ]` line in the body:

- Verify the change actually satisfies it. Reading the code is not enough — trace the criterion to a specific commit / file / test.
- If a criterion is partially met or missed, that's a reject.

## 2. TDD compliance

Read `.sandcastle/implement-prompt.md` "TEST-DRIVEN DEVELOPMENT" section. For every non-exempt piece of business logic added on this branch:

- Find the test file
- Verify it has at least one test for the happy path
- Verify it has at least one test for an edge case
- Verify the test calls the actual function (not a mock-everything trivial test)
- Verify the test would fail if the implementation were broken

Specifically check:

| Logic added | Required test |
|---|---|
| Position sizing math | YES |
| Slippage application | YES |
| Stop/target detection | YES |
| P&L formulas | YES |
| Kill switch / circuit breaker | YES |
| Deduplication | YES |
| Market-hours guard | YES |
| Risk multiplier cap | YES |

If business logic was added without tests, that's a reject.

## 3. Hard-rule violations (auto-reject)

Read `AGENTS.md`. Reject if any of:

- A 1.5× risk-multiplier cap was added but can be exceeded (any uncapped path)
- Kill switch is bypassed anywhere (any entry placement without a `trading_enabled` check)
- A per-trade conviction score / probability was introduced
- Paper trades skip slippage or fees
- Deprecated old-project files were modified without explicit issue authorisation
- Real-money order paths were added (v1 is paper only)

## 4. Tests pass

Run the relevant feedback loop from the implement-prompt:

- `cd bot && pnpm typecheck && pnpm test` (if bot/ changed)
- `deno check supabase/functions/<func>/index.ts && deno test supabase/functions/<func>/` (if functions changed)
- The Python smoke test (if quant-lab/ changed)

If any test fails, reject.

## 5. Spec alignment

Open `docs/superpowers/specs/2026-05-21-market-alert-system-design.md`. For the sections relevant to this issue:

- Are the parameter values (e.g. 0.05% slip, ₹40 brokerage, 1% risk) used exactly?
- Are table/column names matching the spec schema sketch?
- Is naming aligned with the domain language table (Operator, Strategy, Paper Trade, Tuning Run, Kill Switch)?

Drift from the spec is a reject. If the spec is genuinely wrong, leave a comment on the issue requesting a spec amendment instead of silently diverging.

# OUTPUT

If everything passes:

```
<verdict>APPROVE</verdict>
```

Add a one-paragraph summary of what was verified.

If anything fails:

```
<verdict>REJECT</verdict>
```

List each problem with file path, line, and what needs to change. Do NOT fix the problems yourself — the implementer will iterate. Leave a comment on the issue with the full reject reasons via `gh issue comment {{TASK_ID}} --body "..."`.

# FINAL RULES

- Be strict. False positives waste 10 minutes. False negatives waste a trading day.
- Read the actual code, not just commit messages.
- Run the tests, don't trust them.
