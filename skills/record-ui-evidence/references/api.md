# `harness.mjs` reference

```js
import { createHarness } from '<plugin-root>/skills/record-ui-evidence/scripts/harness.mjs';
const h = await createHarness({ /* options */ });
```

## Options

| Option | Default | What it is for |
|---|---|---|
| `scenario` | *(required)* | Name of the take. The video is written to `<root>/recordings/<scenario>/`. |
| `appUrl` | *(required)* | Base URL of the app under test, e.g. `http://localhost:3000`. |
| `root` | `process.cwd()` | Where `profile/` and `recordings/` live. |
| `readySelector` | `'body'` | Default selector awaited after a load. A comma-separated list means "whichever paints first" — use it when a redirect to a login page may or may not happen. |
| `origins` | `[]` | Extra origins counted as "the app" by `frame()`. `appUrl` is always included. Needed when the journey crosses into a second app, e.g. a public player on another port. |
| `brand` | `'Evidence'` | Text of the small tag above the title card heading. |
| `viewport` | `{ width: 1440, height: 900 }` | Also the video size. |
| `locale` | *(browser default)* | Browser locale, e.g. `'fr-FR'`, when the scenario depends on the visitor's language. |
| `record` | `true` | Set `false` for probes and dry runs — no video is written. |
| `headless` | `true` | Set `false` to watch the run live while debugging a scenario. |
| `signedOut` | `false` | Clear cookies so the take opens on the sign-in screen. The persistent profile otherwise keeps the session between runs and silently skips the most convincing opening. |
| `wrapperPort` | `0` | `0` asks the OS for a free port. Only pin it if something outside needs to reach the studio page. |
| `wrapperPath` | bundled `wrapper.html` | An alternative studio page. |
| `playwrightPath` | *(auto)* | Explicit path to Playwright's entry file. |
| `signInSelectors` | `{ email: '#email', password: '#password', submit: 'button[type="submit"]' }` | Per-project overrides for `signInIfNeeded`. |
| `showitworks` | `{}` | Optional run upload to a Show It Works storage, see below. |

Playwright is resolved in this order: `playwrightPath`, `$EVIDENCE_PLAYWRIGHT`, a
bare `import('playwright')`, then a resolve from the current working directory.
That last step is what lets a scenario run from inside any project that already
has Playwright, without installing this plugin as a dependency.

## Optional: the run upload

When `@showitworks/core` can be resolved, the take also keeps a run log: the
app's console messages, uncaught errors and requests (method, URL and status —
never bodies or headers), scrubbed of secrets and timed from the moment the video
starts. `finish()` writes it to `<root>/recordings/<scenario>/run/events.jsonl`
and, given an API key and a storage, uploads it with the video as one run.
Without core none of this runs — no listeners, no files, no output.

| `showitworks.*` | Default | What it is for |
|---|---|---|
| `apiKey` | `$SHOWITWORKS_API_KEY` | Key from https://showitworks.app/settings; it decides the project. |
| `storage` | `$SHOWITWORKS_STORAGE` | Storage id or name in that project. |
| `baseUrl` | `$SHOWITWORKS_URL`, else `https://showitworks.app` | The service. |
| `flow` | `scenario` | History identity: every run of one flow is compared with the others. |
| `git` | *(detected)* | `{ commitSha, commitMessage, branch }` overrides; otherwise CI variables, then `git` in the cwd. |
| `corePath` | *(auto)* | Directory of the `@showitworks/core` package. |
| `required` | `false` | Make `finish()` throw when the run was not uploaded. |

Core is resolved like Playwright: `corePath`, `$EVIDENCE_SHOWITWORKS` (also a
package directory), a bare `import('@showitworks/core')`, then the package as
installed in the current working directory.

`finish()` prints exactly one line to stderr — `run uploaded: <url>`,
`upload skipped: <reason>` (`no API key`, `no storage`) or
`upload failed: <message>` — and still returns the video path. Without core it
prints nothing, unless `required` is set.

## Returned helpers

### Handles

| Name | What it is |
|---|---|
| `page` | The studio page. Overlay calls go here; the app is **not** here. |
| `app` | `FrameLocator` for the app under test. Every app element is located through this. |
| `frame()` | The raw Playwright `Frame` of the app, for what `FrameLocator` cannot express. |
| `context` | The persistent browser context. |
| `viewport`, `appUrl`, `wrapperPort` | Echoed back for convenience. |
| `t0` | Epoch ms the run's clock starts at: right after launch, when the video starts. |
| `upload` | Promise that settles once `finish()` has run: `{ status: 'uploaded' \| 'skipped' \| 'failed', runId?, runUrl?, reason? }`. Never rejects; without core it is `skipped` with reason `@showitworks/core not installed`. |

### Staging

| Call | Notes |
|---|---|
| `card(title, sub?, tag?)` | Show the full-screen title card. `tag` defaults to `brand`. |
| `hideCard()` | Reveal the app behind it. |
| `caption(text, holdMs = 2400)` | The narration bar. Awaits the hold, so it doubles as the scenario's pacing. |
| `note(text, kind?)` | Top-right note. `kind` is `'info' \| 'pass' \| 'fail'`; omitted, it is read off a leading `PASS`/`FAIL`. `note('')` clears it. |
| `ring(box \| null, label?)` | Draw the highlight ring by hand from a bounding box. Rarely needed directly. |

### Acting

| Call | Notes |
|---|---|
| `click(locator, label, { hold = 550, ringIt = true })` | Glide the cursor, ring, click-animate, then really click. |
| `look(locator, label, { hold = 1500, keepRing = false })` | Point at something **without** touching it. Use for elements that matter to the story. |
| `typeInto(locator, text, label, { delay = 55 })` | Click in and type character by character. Use instead of `fill` — a framework's reactive form model ignores a directly written `.value` and the submit button stays disabled. |
| `ringClick(locator, label, { hold = 1000, click = true })` | Ring and click without moving the cursor. The cheap variant. |
| `cursorTo(x, y)` | Move the drawn cursor and the real mouse together. |

### Navigation and teardown

| Call | Notes |
|---|---|
| `loadApp(path, readySelector?, { title, sub, tag }?)` | Load a path relative to `appUrl` behind the title card. |
| `loadUrl(url, readySelector?, { title, sub, tag }?)` | The absolute-URL form, for a second app. |
| `signInIfNeeded(email, password, readySelector?)` | Signs in only if the sign-in form is what rendered; returns whether it did. |
| `finish({ outcome }?)` | Close the browser, the profile and the studio server; returns the path of the written `.webm`, or `null` when `record: false`. Nothing is released until it runs, so call it from a `finally`; calling it twice is safe. With core it then writes the run log and uploads the run, labelled with `outcome` (`'passed' \| 'failed' \| 'timedOut' \| 'skipped' \| 'interrupted' \| 'unknown'`, default `'unknown'`). |

## Recipes

**A scenario that must start signed out**

```js
const h = await createHarness({ scenario: 'first-run', appUrl, signedOut: true,
  readySelector: 'main, form#login' });
await h.loadApp('/', 'main, form#login', { title: 'Signing in', tag: 'Setup' });
await h.signInIfNeeded('demo@example.com', 'password');
```

**A journey that crosses into a second app**

```js
const h = await createHarness({ scenario: 'visitor', appUrl: EDITOR,
  origins: [PLAYER], locale: 'fr-FR' });
await h.loadUrl(`${PLAYER}/share/abc`, '.player-root');
```

**A verdict at the end**

```js
const failures = checks.filter((c) => !c.ok);
await h.note(failures.length ? `FAIL - ${failures.length} check(s)` : 'PASS - all checks');
await h.caption('Read the result on screen, not from the console.', 5000);
await h.note('');
```

**A take uploaded as a run** (`@showitworks/core` installed, `SHOWITWORKS_API_KEY` set)

```js
const h = await createHarness({ scenario: 'saves-a-draft', appUrl,
  showitworks: { storage: 'evidence' } });
let outcome = 'failed';
try {
  // ... the scenario ...
  outcome = 'passed';
} finally {
  await h.finish({ outcome });
}
const { status, runUrl } = await h.upload;
```
