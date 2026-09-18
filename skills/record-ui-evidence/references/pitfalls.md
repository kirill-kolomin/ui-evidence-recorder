# The failures behind the design

Every item here ruined at least one take. They are listed so you can recognise a
symptom instead of rediscovering the cause.

## The app renders signed out inside the studio page

**Cause.** The studio page was opened over `file://`. A session cookie set
`SameSite=Lax` is withheld on a `file:// → http://` iframe load, so the app inside
the frame is anonymous while the very same URL is signed in in a normal tab.
Nothing errors; you just get a login screen you cannot explain.

**Fix.** Always serve the studio page over HTTP. `harness.mjs` runs a tiny local
server for exactly this reason — do not "simplify" it into a `file://` load.

## The video opens on several seconds of blank white

**Cause.** Playwright begins capturing the moment the page is created, and a
single-page app spends seconds bootstrapping. Warming the HTTP cache barely helps,
because the cost is bootstrap and API calls, not assets.

**Fix.** The studio page paints instantly and holds a title card over the iframe
until the app's ready selector is visible. Use `loadApp`/`loadUrl`, which do this,
rather than navigating yourself.

## A click times out with the element "visible" and nothing overlapping it in the app

**Cause.** The title card is still shown. It sits above the iframe and intercepts
pointer events. `fill()` does not hit-test and works fine, which makes the failure
look inconsistent and sends you hunting in the wrong place.

**Fix.** Hide the card before clicking. Where the order genuinely has to be
inverted — as in `signInIfNeeded`, which submits and *then* raises the card over
the redirect — fill and click first, card second.

## The submit button stays disabled after the form is "filled"

**Cause.** `locator.fill()` writes the DOM value without producing the input
events a reactive form model listens to, so the framework still believes the field
is empty.

**Fix.** Use `typeInto`, which types character by character. This is also better
evidence: the viewer watches real input appear.

## A frame shows a status line that contradicts the picture

**Cause.** A phase ran without its own caption, so the previous phase's text stayed
on screen — e.g. "media elements: 0" while two videos are visibly playing.

**Fix.** Narrate every phase, and refresh any live readout during long ones. A
stale caption is worse than none: it is a confident wrong statement.

## The red banner said PASS

**Cause.** The top-right note used to be red unconditionally, while carrying three
different kinds of message: real failures, passing verdicts and neutral
measurements. A viewer reads a red corner box as "something went wrong" whatever
its text says.

**Fix.** `note()` is neutral slate by default, green-accented for a pass, red only
for a real failure, and infers the kind from a leading `PASS`/`FAIL`. Never pass
`'fail'` for emphasis.

## The scenario silently skipped the sign-in it was supposed to show

**Cause.** The persistent browser profile kept the session from the previous run.

**Fix.** `signedOut: true` clears cookies. Decide deliberately whether the take
should open logged in or logged out — starting signed in is fine for a short
scenario, but a first-run story loses its most convincing opening without it.

## Two runs fought over the same port

**Cause.** A hard-coded studio port. It surfaces as a stray `EADDRINUSE`, or worse,
one run recording another's page.

**Fix.** The default `wrapperPort: 0` asks the OS for a free port. Leave it alone
unless something outside genuinely has to reach the studio page.

## The machine crawled after a few takes

**Cause.** A scenario threw before reaching `finish()`, or the script was left
running after the video had been written. Each run holds a Chromium with its
renderer and GPU children, a persistent profile and the studio server, and none
of them are reclaimed when the `.webm` appears — so every take, and every
abandoned `probe-*.mjs`, adds another browser to the machine for the rest of the
session.

**Fix.** Call `finish()` from a `finally` so a failed take tears down as
thoroughly as a good one, and let the process exit instead of holding it open
for the next scenario. `finish()` is idempotent, so the `finally` is safe even
when the happy path already called it. After an interrupted run, look for the
surviving `chromium`/`node` process and stop it before recording again.

## The reviewer could not tell whether the app did the work

**Cause.** The take started in the middle and proved its point by reading the DOM
and printing to the console. Nothing on screen distinguished the app producing a
value from the script writing it in.

**Fix.** Walk the whole journey through the product's own controls, with the drawn
cursor visible, and read every value the verdict depends on off the screen. This
is the single most common reason evidence is rejected, and no amount of overlay
polish substitutes for it.
