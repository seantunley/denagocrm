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
 * PULL REQUESTS WHOSE WORK REACHED THE TRUNK THROUGH A DIFFERENT PULL REQUEST.
 *
 * The only way a stranded PR may stop being reported, and it is deliberately
 * narrow — the same shape as ACKNOWLEDGED in tests/tenantAccessRatchet.test.ts,
 * for the same reason: an exception belongs in source as prose that names its
 * replacement, where review can see it, not as a silenced alarm.
 *
 * WHY THIS IS NEEDED AT ALL. Recovering a stranded stack means merging its work
 * again from a fresh branch. Under a SQUASH workflow that produces a new commit,
 * so the original PR's head never becomes an ancestor of the trunk and its own
 * merge commit never will either — the two things this file checks. The work is
 * on main; the bookkeeping cannot show it. Without a record here the guard would
 * report those PRs as lost forever, and a check that cries wolf is one people
 * switch off, which is exactly the gap it exists to close.
 *
 * AN ENTRY IS NOT A WAIVER. It only redirects the question: the replacement PR
 * must ITSELF have landed, checked the same way as any other. If a recovery is
 * reverted, or was never merged, the original goes straight back to `stranded`.
 * So this cannot excuse work that is genuinely missing — it can only point at
 * where the work actually went.
 *
 * 2026-08-12: #478, #491 and #492 were merged with their base set to the branch
 * below them rather than main — the exact failure this file was written for,
 * caught by this file. Their work was re-landed on main by #498, #499 and #500
 * respectively, verified by content at the time (each PR's signature test file
 * present on main, and #492's scoped `updateMany` in place with no unscoped
 * write left).
 *
 * 2026-08-26: #548 the same way, and it mattered more than most — it closed a
 * CRC signing oracle in the X webhook, so the guard was reporting a SECURITY fix
 * as unshipped. It was merged into `agent/x-social-inbox-integration` while the
 * X integration itself reached main separately under #538, which left the
 * vulnerable code live and its fix on a side branch. #549 re-landed it on main
 * under the title "SECURITY: X webhook fixes from #548 never reached main".
 *
 * Verified by CONTENT, not by the merge graph: all three files #548 touched —
 * `src/lib/xWebhook.ts`, `src/app/api/webhooks/x/route.ts` and
 * `tests/xIntegration.test.ts` — are byte-identical between main and
 * `agent/x-social-inbox-integration`, and #548's own commit is on main as
 * 6cd2a25f under a rebased sha. That is why its head never became an ancestor:
 * the recovery rebased rather than merged.
 */
export const RECOVERED_BY = {
  478: 498,
  491: 499,
  492: 500,
  548: 549,
};

/**
 * Classify one merged pull request.
 *
 * Pure, so the rule is testable without a repository or a network. `landed` is
 * supplied by the caller (a git ancestry check) rather than computed here, and
 * so is `recoveryLanded` — whether the replacement named in {@link RECOVERED_BY}
 * has itself reached the trunk. `undefined` means "no replacement recorded".
 */
export function classifyMerged(pr, landed, recoveryLanded) {
  if (!pr.headRefOid) {
    // Nothing to trace. Reported rather than assumed fine, because "cannot tell"
    // is not "is fine".
    return { number: pr.number, status: "unverifiable", base: pr.baseRefName };
  }
  if (landed) return { number: pr.number, status: "landed", base: pr.baseRefName };
  const recoveredBy = RECOVERED_BY[pr.number];
  if (recoveredBy !== undefined && recoveryLanded) {
    // Reported as its own status rather than folded into `landed`, so the run
    // still says out loud that this PR did not ship under its own number.
    return { number: pr.number, status: "recovered", base: pr.baseRefName, recoveredBy };
  }
  if (recoveredBy !== undefined) {
    return {
      number: pr.number,
      status: "stranded",
      base: pr.baseRefName,
      title: pr.title,
      reason:
        `recorded as recovered by #${recoveredBy}, but #${recoveredBy} has not reached ${TRUNK} either — ` +
        "the replacement must land before the original counts as shipped",
    };
  }
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
  // Landedness is worked out ONCE per pull request and then reused, because a
  // recovery record has to ask the same question of the replacement PR. Asking
  // it a second way would let the two answers disagree.
  const landedByNumber = new Map(
    merged.map((pr) => [
      pr.number,
      Boolean(pr.headRefOid) && (isAncestor(pr.headRefOid, ref) || isAncestor(pr.mergeCommit?.oid, ref)),
    ]),
  );
  const results = merged.map((pr) => {
    const recoveredBy = RECOVERED_BY[pr.number];
    // A replacement outside the window is not assumed to have landed — it is
    // simply unknown, which leaves the original reported. `--limit` shrinking
    // must never turn a stranded PR green.
    const recoveryLanded = recoveredBy === undefined ? undefined : landedByNumber.get(recoveredBy) === true;
    return classifyMerged(pr, landedByNumber.get(pr.number), recoveryLanded);
  });
  const stranded = results.filter((r) => r.status === "stranded");
  const recovered = results.filter((r) => r.status === "recovered");
  const unverifiable = results.filter((r) => r.status === "unverifiable");

  console.log(`Checked ${results.length} merged pull request(s) against ${ref}.`);
  console.log(`  landed:       ${results.filter((r) => r.status === "landed").length}`);
  console.log(`  stranded:     ${stranded.length}`);
  if (recovered.length) {
    // Printed, not swallowed: these did not ship under their own number, and the
    // next person reading a release list should be told where they went.
    console.log(`  recovered:    ${recovered.length} (re-landed by another pull request)`);
    for (const pr of recovered) console.log(`      #${pr.number} → shipped by #${pr.recoveredBy}`);
  }
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
