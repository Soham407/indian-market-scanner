// Parallel Planner — three-phase orchestration loop (in-repo variant)
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    A Codex agent reads issues labeled ready-for-agent,
//                      builds a dependency graph, and outputs a <plan> JSON
//                      listing unblocked issues with branch names.
//   Phase 2 (Execute): N Codex agents run in parallel via Promise.allSettled,
//                      each working a single issue on its own branch.
//   Phase 3 (Merge):   A Codex agent merges all branches that produced commits.
//
// The outer loop repeats up to MAX_ITERATIONS times so newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npm run sandcastle
//
// NOTE: This orchestrator lives INSIDE the target repo (cwd = ".").
// Sandcastle creates isolated git worktrees per agent so parallel
// branches don't collide with the orchestrator's own working tree.

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 10;

// In-repo target: agents operate on this repo itself.
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

  // Phase 1: Plan
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

  // Phase 2: Execute
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

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // Phase 3: Merge
  await sandcastle.run({
    cwd,
    hooks,
    sandbox,
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.codex("gpt-5.3-codex", { effort: "medium" }),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues
        .map((i) => `- ${i.id}: ${i.title}`)
        .join("\n"),
      CLOSE_COMMANDS: completedIssues
        .map((i) => `gh issue close ${i.id} --comment "Completed by Sandcastle"`)
        .join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
