# ISSUES

Here are the open issues in this repo that are ready for agent work:

<issues-json>

!`gh issue list --state open --label ready-for-agent --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

</issues-json>

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

The "Blocked by" section of each issue body lists explicit dependencies. Treat those as authoritative.

For each unblocked issue, assign a branch name using the format `sandcastle/issue-{id}-{slug}`.

# PROJECT CONTEXT

This is the `indian-market-scanner` repo. The active project is an auto paper-trading bot (see `docs/superpowers/specs/2026-05-21-market-alert-system-design.md`). All bot work goes in `bot/`, `supabase/functions/bot-*`, and `supabase/migrations/*_bot_*`. Old "Market Sniper" code is deprecated — do not touch it.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "1", "title": "Bootstrap: bot/ Next.js scaffold", "branch": "sandcastle/issue-1-bootstrap-bot-scaffold"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (typically the lowest-numbered issue, which is usually the foundation).
