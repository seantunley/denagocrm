// Does "merged" actually mean "on main"?
//
// On 2026-08-07, thirty-four pull requests were merged and fifteen of them never
// reached production. Nothing was broken and nothing warned: they were stacked
// PRs whose BASE was the branch below them, so `gh pr merge` merged each into
// its parent branch, exactly as asked. GitHub showed MERGED. The features were
// simply not on main, and nobody found out until someone went looking for a
// button that was not there.
//
// GitHub cannot warn about this, because nothing went wrong by its lights. The
// only way to know is to ask git whether each pull request's HEAD commit is an
// ancestor of main — which is what this does.
//
// It also reports the situation BEFORE it bites: an open PR whose base is not
// main will not ship when merged, which is fine for a stack in progress and a
// trap if you think you are releasing.
//
// Usage:
//   node scripts/check-prs-landed.mjs              last 60 merged PRs
//   node scripts/check-prs-landed.mjs --limit 200  more history
//   node scripts/check-prs-landed.mjs --open       also list open PRs off main
//
// Exits non-zero when a merged PR has not landed. That is a release blocker:
// somebody believes work shipped that did not.

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const LIMIT = Number(args[args.indexOf("--limit") + 1]) || 60;
const SHOW_OPEN = args.includes("--open");
const CHECK_DEPLOY = args.includes("--deploy");
const TRUNK = process.env.TRUNK_BRANCH || "main";

/**
 * Classify one merged pull request.
 *
 * Pure, so the rule is testable without a repository or a network. `landed` is
 * supplied by the caller (a git ancestry check) rather than computed here.
 */
export function classifyMerged(pr, landed) {
  if (!pr.headRefOid) {
    // Nothing to trace. Reported rather than assumed fine, because "cannot tell"
    // is not "is fine".
    return { number: pr.number, status: "unverifiable", base: pr.baseRefName };
  }
  if (landed) return { number: pr.number, status: "landed", base: pr.baseRefName };
  return {
    number: pr.number,
    status: "stranded",
    base: pr.baseRefName,
    title: pr.title,
    // The diagnosis, not just the symptom: a base other than the trunk is
    // ALWAYS why this happens, and saying so turns a confusing report into an
    // obvious one.
    reason:
      pr.baseRefName && pr.baseRefName !== TRUNK
        ? `merged into "${pr.baseRefName}", not ${TRUNK} — a stacked PR ships only when its base does`
        : `merge commit is not an ancestor of ${TRUNK} — history may have been rewritten`,
  };
}

/**
 * The twin question: did the last production deployment actually succeed?
 *
 * The same afternoon, every production deploy failed for three hours while CI
 * stayed green — migrations run inside the Vercel BUILD command, so a
 * data-dependent migration failure fails the whole deployment. A green CI run
 * says the tests passed against an empty database. It does not say the
 * application shipped.
 *
 * Pure, so the rule is testable. A deployment still running is NOT a failure —
 * reporting one would make this racy and therefore ignored.
 */
export function classifyDeployment(state) {
  if (state === "failure" || state === "error") {
    return { ok: false, reason: `the most recent production deployment ended in "${state}"` };
  }
  if (state === "success") return { ok: true, reason: "the most recent production deployment succeeded" };
  return { ok: true, reason: `the most recent production deployment is "${state ?? "unknown"}" — not judged` };
}

/** Open PRs that will not ship when merged. Advisory, never fatal. */
export function classifyOpen(pr) {
  return pr.baseRefName === TRUNK
    ? null
    : { number: pr.number, base: pr.baseRefName, title: pr.title };
}

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

function isAncestor(commit, ref) {
  if (!commit) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  // Make sure the trunk we compare against is current; a stale local ref would
  // report everything merged in the last hour as stranded.
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", TRUNK], { stdio: "ignore" });
  } catch {
    /* offline / no remote: fall through and use what is here */
  }
  const ref = `origin/${TRUNK}`;

  // The PR's HEAD, not its merge commit.
  //
  // "Is the merge commit an ancestor of main?" is the wrong question, and I
  // shipped it wrong first: after the stranded stacks were recovered by merging
  // their topmost branch, every individual PR's work WAS on main while its own
  // `gh pr merge` commit still was not. The guard reported eleven false alarms,
  // and a check that cries wolf is one people switch off — which would have left
  // exactly the gap it exists to close.
  //
  // The head commit answers what is actually being asked: is this pull request's
  // work in main, by whatever route it got there?
  const merged = gh([
    "pr", "list", "--state", "merged", "--limit", String(LIMIT),
    "--json", "number,title,baseRefName,headRefOid,mergeCommit",
  ]);

  // EITHER commit being an ancestor means the work is on main, and both are
  // needed because the two merge strategies leave different traces:
  //
  //   merge commit  — the head becomes an ancestor. Recovering a stranded stack
  //                   by merging its topmost branch lands every PR's head this
  //                   way, which is why checking only the merge commit reported
  //                   eleven false alarms after the recovery.
  //   squash/rebase — the head NEVER becomes an ancestor; only the squashed
  //                   commit does. #299 and #300 are exactly this, and checking
  //                   only the head reported them as lost years after shipping.
  //
  // I got this wrong in both directions before settling here. A guard that
  // reports work as lost when it is not gets switched off, and then the real
  // one goes unnoticed.
  const results = merged.map((pr) =>
    classifyMerged(pr, isAncestor(pr.headRefOid, ref) || isAncestor(pr.mergeCommit?.oid, ref)),
  );
  const stranded = results.filter((r) => r.status === "stranded");
  const unverifiable = results.filter((r) => r.status === "unverifiable");

  console.log(`Checked ${results.length} merged pull request(s) against ${ref}.`);
  console.log(`  landed:       ${results.filter((r) => r.status === "landed").length}`);
  console.log(`  stranded:     ${stranded.length}`);
  if (unverifiable.length) console.log(`  unverifiable: ${unverifiable.length} (no merge commit recorded)`);

  if (SHOW_OPEN) {
    const open = gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,baseRefName"])
      .map(classifyOpen)
      .filter(Boolean);
    if (open.length) {
      console.log(`\n${open.length} OPEN pull request(s) do not target ${TRUNK}. Merging these ships nothing:`);
      for (const pr of open) console.log(`  #${pr.number} → ${pr.base}   ${pr.title}`);
    }
  }

  let deployFailed = false;
  if (CHECK_DEPLOY) {
    try {
      const deployments = gh([
        "api", "repos/:owner/:repo/deployments?environment=Production&per_page=1",
      ]);
      const deployment = deployments[0];
      if (deployment) {
        const statuses = gh(["api", `repos/:owner/:repo/deployments/${deployment.id}/statuses`]);
        const verdict = classifyDeployment(statuses[0]?.state);
        console.log(`\nProduction deployment ${String(deployment.sha).slice(0, 8)}: ${verdict.reason}`);
        if (!verdict.ok) deployFailed = true;
      }
    } catch {
      console.log("\nProduction deployment state could not be read — not judged.");
    }
  }

  if (stranded.length === 0 && !deployFailed) {
    console.log(`\nEvery merged pull request is on ${TRUNK}.`);
    return;
  }
  if (stranded.length === 0) {
    // Merges are fine and the site still does not have them. Same lesson from
    // the other direction: on main is not the same as deployed.
    console.error(`\n✖ Production did not deploy. The code is on ${TRUNK} and not on the site.`);
    process.exitCode = 1;
    return;
  }

  console.error(`\n✖ ${stranded.length} pull request(s) are MERGED but not on ${TRUNK}:\n`);
  for (const pr of stranded) {
    console.error(`  #${pr.number}  ${pr.title ?? ""}`);
    console.error(`      ${pr.reason}`);
  }
  console.error(
    `\nThese are believed to be shipped and are not. Merge the branch that received\n` +
      `them into ${TRUNK} — for a stack, that is the topmost branch, which carries\n` +
      `the whole chain.\n`,
  );
  process.exitCode = 1;
}

// Only run when invoked directly, so the pure rules above can be imported.
if (process.argv[1] && process.argv[1].endsWith("check-prs-landed.mjs")) main();
