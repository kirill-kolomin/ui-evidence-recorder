---
name: record-ui-evidence
description: Record a watchable evidence video of a web app with Playwright - a studio page that never navigates, a title card over the app's boot, a drawn cursor, highlight rings before every click, a narration bar along the bottom and severity-coloured notes. Use this whenever someone asks you to show that a change works in the real UI, to record a demo, repro, regression or QA walkthrough, to produce a screencast for a PR or ticket, or to prove a fix rather than assert it - and also when a plain Playwright screencast you already made turned out to be unwatchable (blank boot, invisible clicks, no narration).
license: MIT
metadata:
  author: Kirill Kolomin
  version: "1.0.0"
---

# Record UI evidence

A raw Playwright screencast is nearly worthless as evidence. It opens on a blank
white page while the app boots, clicks land with no visible pointer, nothing says
what is being demonstrated, and a reviewer cannot tell whether the app did the
work or the script wrote the values in. This skill turns the same run into
something a person can watch once and believe.

## The one structural idea

**The recorded page is not the app.** It is a local studio page that paints
instantly and loads the app inside an `iframe`. Playwright starts the video the
moment the page is created, so recording the app directly means recording its
boot; and every navigation the app makes would otherwise restart the capture.
The studio page never navigates, so one video covers the whole journey, and all
overlays are drawn in it — above every stacking context the app can create,
including the browser top layer.

Both files are bundled: `scripts/wrapper.html` (the studio page) and
`scripts/harness.mjs` (the driver). Use them as they are; they encode fixes for
failures that are not obvious until a take is already ruined.

## How to use it

1. **Find out how to reach the app.** Its base URL, whether it needs a sign-in,
   and one selector that proves it has finished rendering. Ask, or read the
   project's dev-server config — do not guess a port.
2. **Probe before you record.** Write throwaway `probe-*.mjs` scripts with
   `record: false` that navigate and screenshot until you know the real
   selectors. Probing is cheap; a ruined take costs the whole run.
3. **Write one scenario file per claim.** One video per scenario, self-contained,
   with its own title card, so any single video can be watched alone.
4. **Run it**, then check the produced `.webm` before handing it over.

Minimal scenario:

```js
import { createHarness } from '<path>/skills/record-ui-evidence/scripts/harness.mjs';

const h = await createHarness({
  scenario: 'saves-a-draft',
  appUrl: 'http://localhost:3000',
  readySelector: 'main',
  brand: 'My App',
});

await h.card('Saving a draft', 'The bug was that the draft was lost on reload', 'Ticket 123');
await h.loadApp('/documents');
await h.caption('Open the document that used to lose its draft.');
await h.click(h.app.getByRole('link', { name: 'Quarterly report' }), 'open the document');
await h.typeInto(h.app.locator('#body'), 'A draft nobody should lose', 'type a draft');
await h.look(h.app.getByText('Saved'), 'the save indicator');
await h.note('PASS - draft survived the reload');
await h.caption('The draft is still there after a full reload.', 4000);
console.log(await h.finish());
```

Full option and helper reference: `references/api.md`.

## Rules that make the video worth watching

- **Narrate every phase.** The caption bar is the only thing telling the viewer
  what they are looking at. A phase with no caption leaves the previous one's
  text on screen, which actively misinforms. Hold captions 2.4–6s.
- **Never let a viewer watch a blank screen.** Hold the title card over the boot,
  and cut the waiting: the harness does this for you in `loadUrl`.
- **Highlight before you click, and highlight what matters.** `click()` rings its
  target first. Use `look()` for elements that matter to the story even though
  nothing is clicked on them — a viewer's eye needs to be sent to the right place.
- **Do everything through the product's own controls.** Type into fields with
  `typeInto` rather than filling values, and read results off the screen rather
  than asserting them from the DOM. A reviewer who cannot see the app do the work
  has no reason to believe it did.
- **Colour notes by meaning, never uniformly.** `note()` takes `'info'`, `'pass'`
  or `'fail'`, and infers it from a leading PASS/FAIL. Red is reserved for a real
  failure — a red corner box reads as "something went wrong" whatever it says, so
  a measurement or a passing check announced in red misleads the viewer.
- **One scenario per process, one video per scenario.**

## When something looks wrong in the output

Read `references/pitfalls.md` before changing the harness. It lists the failures
that produced each design decision — the signed-out iframe, the click that times
out under the title card, the disabled submit button, the stale status line — and
each is much easier to recognise than to rediscover.

## Reference files

- `references/api.md` — every `createHarness` option and every returned helper
- `references/pitfalls.md` — the failures behind the design, and how to spot them
- `scripts/harness.mjs` — the driver; import it, do not copy it per project
- `scripts/wrapper.html` — the studio page; override via `wrapperPath` only if
  you genuinely need different overlays
