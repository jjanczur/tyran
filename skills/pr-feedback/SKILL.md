---
description: Work a reviewer's comments on a pull request to the end. Enumerate all three comment surfaces before triaging any, give every comment a disposition - fixed, declined with a reason, or ticketed - push before you reply, and resolve only what you addressed. Use when a PR comes back with review feedback or a red check.
---

# PR feedback — closing the loop with a human reviewer

> The safest autonomy class, and the default, ends with a change on a branch
> and a person merging it. So the ordinary last step of this plugin's work is a
> pull request somebody reviews — and it was the one step with no protocol.
> `tyran:reviewer` governs our own internal review; this governs theirs.

## The three surfaces, and why one of them is a trap

GitHub keeps pull-request feedback in three separate resources:

| Surface | Endpoint | What lives there |
|---|---|---|
| Conversation | `/issues/{n}/comments` | Plain comments on the PR |
| Inline review comments | `/pulls/{n}/comments` | Anchored to a line of the diff |
| Reviews | `/pulls/{n}/reviews` | The submitted verdict **and its body text** |

**A review's body is not in the inline-comments collection.** Reviewers write
their summary there, and bots put whole findings there — anything that could not
be anchored to a changed line, which is exactly the "outside diff range" class.

Measured, against a public repository: `cli/cli` PR **#13944** has one review
carrying a written body and **zero** inline comments. An agent that reads only
`/pulls/{n}/comments` sees nothing on that PR and reports that there was nothing
to address. The report is true about what it looked at and false about what it
claims, which is the failure shape this whole plugin exists to refuse.

So: **fetch all three, paginated, before triaging any of them.** Print the
counts. `3 inline · 2 review bodies · 1 conversation` is the first line of the
work, and it is what makes a missed surface visible.

## Every comment gets a disposition

No comment is silently dropped. Each one ends as exactly one of:

- **Fixed** — with the commit that did it.
- **Declined** — with the reason, in one sentence. Disagreeing is allowed;
  disagreeing silently is not. If it is a product or scope decision rather than
  a technical one, it goes to the conductor instead of being decided here.
- **Ticketed** — real, out of this PR's scope, captured where it will be found
  again. A promise in a thread is not a ticket.

Nitpicks are answered too, briefly. An unanswered comment reads as unread, and
the reviewer's next move is to check whether you read the others.

**A comment that names a defect gets pinned as a test**, not just patched. The
same rule the reviewer applies internally: a finding that cannot be verified as
fixed will be found again by someone else, later, at more cost.

## Order of operations

1. **Fix, then push, then reply.** "Fixed in `abc1234`" posted before the push
   is a claim about a commit the reviewer cannot fetch. Push first; quote the
   real sha.
2. **Resolve only threads you actually addressed.** Resolving a thread you
   declined hides the disagreement — say why, and leave it for them to close.
   Never resolve someone else's open question to tidy the view.
3. **A red check is feedback.** Read the failing job's own output, not the
   summary. And gate on the runner's exit code: a pipeline that pipes a test
   run into `grep` and pushes on success pushes on a red suite too, because
   `grep` was satisfied.
4. **Re-check the three surfaces after you push.** Reviews arrive while you
   work, and CI posts after it finishes. A loop that reads once at the start
   ends by declaring victory over a snapshot.

## When to stop and ask

- The comment asks for a change that crosses a boundary the story did not own —
  an API shape, a schema, someone else's module.
- Two reviewers ask for opposite things. Do not pick; put both in front of the
  conductor with a recommendation.
- The review asks for a rewrite large enough to be its own story. Say so with a
  size, rather than quietly starting it inside a feedback round.

## The report

Counts per surface, the disposition of every comment with its thread, the shas
that carry the fixes, the checks that are now green with their raw output, and
anything still open with the reason. If you declined something, that line is the
most important one in the report — it is the only part the reviewer cannot see
by looking at the diff.
