# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution. Migrations are time-ordered — if two branches added migrations, keep both with their original timestamps.
3. After resolving conflicts, run feedback loops if defined:
   - `cd bot && pnpm typecheck && pnpm test` (if bot/ exists)
   - `deno check supabase/functions/*/index.ts` (if Deno is in PATH)
4. If something fails, fix it before proceeding to the next branch.

After all branches are merged, make a single summary commit.

# CLOSE ISSUES

For each merged issue, close it using the matching command from the list below:

Here are all the issues:

{{ISSUES}}

Close commands:

{{CLOSE_COMMANDS}}

Once you've merged everything you can, output `<promise>COMPLETE</promise>`.
