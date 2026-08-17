---
description: Drive a real browser and come back with a MEASUREMENT rather than an impression - console errors and >=400 responses as counts, computed styles as JSON when appearance is disputed. Use when work touches UI, when a review must verify one, or when fidelity-gate asks for its measurement.
---

# Browser check — proving a UI works, in numbers

> Three places in this plugin order a browser pass — the conductor's quality
> gates, the reviewer, the implementer — and `fidelity-gate` asks for computed
> styles on top. None of them said how. This is the how, and it exists so that
> "I checked it in the browser" stops being a sentence and starts being a
> counter someone else can re-run.

**A browser pass is a measurement.** It returns numbers: pages visited, links
resolved, console errors, failed responses. `Looks fine`, `renders correctly`
and `no obvious issues` are REJECTED by the evidence contract exactly like a
test report with no output, and for the same reason — nothing in them can be
wrong.

## Before you promise a run

1. **The browser exists.** `npx playwright --version`, and install only
   chromium (`npx playwright install chromium`) — a full browser install is
   several GB for two extra engines nobody asked for.
2. **The server is up and SERVING WHAT YOU THINK.** Fetch one known URL and
   check the status before automating anything. A dev server that is still
   compiling, or is serving a stale build on a port you forgot to kill,
   produces a page of failures that have nothing to do with your change.
3. **Build first when the target is a static site.** Testing the dev server
   and shipping the build tests two different programs.

## Waits are deterministic — never a sleep

Wait for a *condition*: a response, a selector, a network-idle state, a font
ready promise. `waitForTimeout` is a guess that is simultaneously too long on
your machine and too short in CI, and the failures it produces are
indistinguishable from real ones. The only defensible fixed wait is settling an
animation you cannot observe, and it says so in a comment.

**Warm the routes before a batch run.** The first request to a route compiles
it; a cold compile times out and reads as a defect in the page. Hitting every
route once before measuring costs one pass and removes a whole class of false
finding.

## What you collect, and what you return

Subscribe before you navigate — listeners attached after the first `goto` miss
everything that page already did:

- `console` events of type `error`
- `pageerror` — uncaught exceptions, which are NOT console errors and are
  routinely missed by checking only the first
- `response` with status `>= 400`, including the ones fired by the page's own
  fetches, which no amount of clicking will reveal
- every in-page link, resolved once and cached by URL

Return them as **counts plus the first few offenders**, then a single verdict
line. A pass with `0` console errors is a fact; "the console was clean" is a
recollection.

**When the UI claims to change something the SERVER acts on** — a mapping, a
setting, a value the next request depends on — a clean console and a `2xx` are
not proof it arrived. The evidence has to follow the value to what got STORED,
not stop at what got RENDERED: capture the request body you actually sent, or
read the value back with a second request or a reload, and assert on THAT. This
is not hypothetical. A column-mapping override shipped with a perfect browser
pass — 15/15 columns visible, 0 console errors, the mapping visibly changed by
hand — while the server re-derived the source type from the uploaded bytes and
discarded the mapping, answering `201` either way. Only a reviewer reading the
server route caught it; nothing in the browser measurement could have, because
it never inspected what the server persisted.

## Selectors that do not go blind

Anchor on what the user sees — a role, a label, the text — not on a container
class or an nth-child. This is not a style preference. A selector scoped to the
markup it was written against keeps passing while silently checking LESS of the
page as the page grows, and it reports the narrowed number as success. That has
already happened in this repo: a link check named two regions of one framework's
chrome, and went from checking every link to checking half of them on the day a
page was added outside that chrome — with no failure anywhere.

So: assert the COUNT you expected as well as the condition. `24 links checked,
0 broken` catches the regression that `0 broken` cannot.

## When the disagreement is about appearance

Settle it with `getComputedStyle`, dumped to JSON, compared against the
inventory. Never by looking, and never by asking a model to look:

```js
await page.$$eval(SELECTORS, (els) => els.map((el) => {
  const s = getComputedStyle(el);
  return { text: el.textContent.trim(), fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color };
}));
```

Two rules that keep this a measurement:

- **Assert the element's text alongside its geometry.** A structural selector
  with no text assertion measures the wrong element when the markup is
  renumbered, and reports a confident wrong number instead of a loud miss.
- **A zero-size box is a failure, not a pass.** An element that renders with no
  width, or a glyph that inherits `fill: none`, is present in the DOM and
  invisible on the screen. Check the bounding box whenever you check anything
  visual, or the check passes on a page nobody can read.

For a frozen reference, this step belongs to `fidelity-gate`, which owns the
inventory, the relics list and the verdict format. Do not invent a second one.

## Artefacts and cleanup

Screenshots, JSON dumps and logs go under `.tyran/`, never `/tmp` — they are
evidence for a report, and evidence a colleague cannot open is not evidence.
Name them for the run, not `screenshot.png`.

End the way you started: close the browser, and stop the server you started
with SIGTERM so it can release its port. `kill -9` leaves the port held and the
next run fails for a reason that has nothing to do with the code.

## The report

```
PAGES 13 · LINKS 24/24 · CONSOLE ERRORS 0 · PAGE ERRORS 0 · HTTP>=400 0
BROWSER PASS: OK
```

Then the failures, if any, with the URL that produced each. State plainly what
you did NOT drive — the viewport you skipped, the flow behind a login, the
browser you do not have. An unchecked area named in the report is a decision
for the conductor; an unchecked area left out of it is a claim.
