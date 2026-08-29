<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# A fix for a bug on an open PR targets `main`, not that PR's branch

Stacking a fix onto the branch it corrects is the obvious move and it has already
lost one set of security fixes.

PR #548 fixed an unauthenticated webhook-forgery hole in #538 and was based on
#538's branch, which is the natural thing to do while that PR is open. #538 then
merged to `main` at 18:15. #548 merged at 21:24 — into a branch that had already
landed and was no longer going anywhere. `main` shipped the vulnerable code, both
PRs showed `merged: true`, and nothing anywhere reported a problem. It was found
three hours later only because somebody asked whether the merge had worked.

The trap is that a stacked PR is safe *only while its base is unmerged*, and
nothing watches for that changing. GitHub will happily merge a PR into a branch
that is already dead.

So:

- **A fix for a defect found in review targets `main`.** It is a fix on its own
  terms; it does not need the feature branch's history to make sense, and basing
  it there couples its delivery to somebody else's merge timing.
- **If it genuinely must be stacked** — it depends on code that only exists on
  that branch — then whoever merges the base is responsible for the stack, and
  the stacked PR must be re-targeted to `main` the moment its base merges.
- **After a merge, verify the change is actually in `main`.** `merged: true` on
  the PR is not that proof; it only says the branch it named accepted it.
  `git merge-base --is-ancestor <fix-sha> origin/main` is.

The last point generalises past this case. A PR reports what happened to *a
branch*. If what you care about is that a change reached production, check the
branch that deploys.
