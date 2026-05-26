// Parallel Planner — four-phase orchestration loop (in-repo variant)
//
// Phases per iteration:
//   1. Plan    — Codex agent reads ready-for-agent issues, builds dependency
//                graph, outputs <plan> JSON listing unblocked issues + branch.
//   2. Execute — N Codex agents run in parallel, each working a single issue
//                on its own branch, following TDD discipline.
//   3. Review  — One Codex review agent per completed branch verifies
//                acceptance criteria, TDD compliance, hard-rule adherence,
//                and that tests pass. Outputs <verdict>APPROVE</verdict>
//                or REJECT.
//   4. Merge   — A Codex agent merges only the APPROVED branches, runs
//                feedback loops, and closes the corresponding issues.
//
// The outer loop repeats up to MAX_ITERATIONS times. Rejected branches stay
// open with a comment on the issue; the next iteration may pick them up if
// they're still labelled ready-for-agent.

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ITERATIONS = 10;
const cwd = ".";

const codexHome = path.resolve(
  process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
);

const orchestratorEnvPath = path.resolve(".sandcastle/.env");

const readEnvValue = (key: string): string | undefined => {
  try {
    const content = readFileSync(orchestratorEnvPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const envKey = trimmed.slice(0, eqIndex).trim();
      if (envKey !== key) continue;
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        value.length >= 2 &&
        ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    // No local env file yet.
  }
  return undefined;
};

const ghToken = process.env.GH_TOKEN ?? readEnvValue("GH_TOKEN");

if (!statSync(codexHome, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(
    `Codex auth directory not found at ${codexHome}. Run \`codex --login\` on the host first, or set CODEX_HOME to an existing Codex home.`,
  );
}

if (!ghToken) {
  throw new Error(
    `GH_TOKEN is missing. Set it in ${orchestratorEnvPath} or export it before running npm run sandcastle.`,
  );
}

const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "test -f package.json && npm install || echo 'no package.json yet, skipping install'" },
    ],
  },
};

const copyToWorktree: string[] = [];

const sandbox = docker({
  env: {
    GH_TOKEN: ghToken,
  },
  mounts: [
    {
      hostPath: codexHome,
      sandboxPath: "/home/agent/.codex",
    },
  ],
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // ----- Phase 1: Plan -----
  const plan = await sandcastle.run({
    cwd,
    hooks,
    sandbox,
    name: "planner",
    maxIterations: 1,
    agent: sandcastle.codex("gpt-5.3-codex", { effort: "xhigh" }),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  const { issues } = JSON.parse(planMatch[1]!) as {
    issues: { id: string; title: string; branch: string }[];
  };

  if (issues.length === 0) {
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // ----- Phase 2: Execute -----
  const settled = await Promise.allSettled(
    issues.map((issue) =>
      sandcastle.run({
        cwd,
        hooks,
        copyToWorktree,
        sandbox,
        branchStrategy: { type: "branch", branch: issue.branch },
        name: `implementer-${issue.id}`,
        maxIterations: 100,
        agent: sandcastle.codex("gpt-5.3-codex", { effort: "high" }),
        promptFile: "./.sandcastle/implement-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      }),
    ),
  );

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (
        entry,
      ): entry is {
        outcome: PromiseFulfilledResult<
          Awaited<ReturnType<typeof sandcastle.run>>
        >;
        issue: (typeof issues)[number];
      } =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  console.log(
    `\nExecution complete. ${completedIssues.length} branch(es) with commits.`,
  );

  if (completedIssues.length === 0) {
    console.log("No commits produced. Nothing to review or merge.");
    continue;
  }

  // ----- Phase 3: Review -----
  console.log(`\nRunning review on ${completedIssues.length} branch(es)...\n`);

  const reviewed = await Promise.allSettled(
    completedIssues.map((issue) =>
      sandcastle.run({
        cwd,
        hooks,
        sandbox,
        branchStrategy: { type: "branch", branch: issue.branch },
        name: `reviewer-${issue.id}`,
        maxIterations: 20,
        // Use xhigh for review — strict gatekeeping benefits from strongest reasoning.
        agent: sandcastle.codex("gpt-5.3-codex", { effort: "xhigh" }),
        promptFile: "./.sandcastle/review-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      }),
    ),
  );

  const approvedIssues: typeof completedIssues = [];

  for (let i = 0; i < reviewed.length; i++) {
    const outcome = reviewed[i]!;
    const issue = completedIssues[i]!;
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ review ${issue.id} (${issue.branch}) errored: ${outcome.reason}`,
      );
      continue;
    }
    const stdout = outcome.value.stdout;
    const verdictMatch = stdout.match(/<verdict>(APPROVE|REJECT)<\/verdict>/);
    if (!verdictMatch) {
      console.error(
        `  ⚠ review ${issue.id} (${issue.branch}) produced no <verdict> — treating as REJECT`,
      );
      continue;
    }
    if (verdictMatch[1] === "APPROVE") {
      console.log(`  ✓ APPROVED ${issue.id}: ${issue.title}`);
      approvedIssues.push(issue);
    } else {
      console.log(
        `  ✗ REJECTED ${issue.id}: ${issue.title} (review comments on issue)`,
      );
    }
  }

  if (approvedIssues.length === 0) {
    console.log("No branches approved. Nothing to merge.");
    continue;
  }

  // ----- Phase 4: Merge -----
  const approvedBranches = approvedIssues.map((i) => i.branch);
  console.log(
    `\nMerging ${approvedBranches.length} approved branch(es)...\n`,
  );

  await sandcastle.run({
    cwd,
    hooks,
    sandbox,
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.codex("gpt-5.3-codex", { effort: "medium" }),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: approvedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: approvedIssues
        .map((i) => `- ${i.id}: ${i.title}`)
        .join("\n"),
      CLOSE_COMMANDS: approvedIssues
        .map(
          (i) =>
            `gh issue close ${i.id} --comment "Completed by Sandcastle (review-approved)"`,
        )
        .join("\n"),
    },
  });

  console.log("\nApproved branches merged.");
}

console.log("\nAll done.");
