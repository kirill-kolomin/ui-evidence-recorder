/**
 * Project-agnostic recording harness for browser evidence videos.
 *
 * Every design decision below came from a concrete failed take. Read
 * ../references/pitfalls.md before changing any of them.
 *
 *  - THE WRAPPER PAGE NEVER NAVIGATES. Playwright starts the video the moment a
 *    page is created, and a single-page app typically needs several seconds to
 *    bootstrap on every load. So the recorded page is a local "studio" page that
 *    paints instantly and shows a title card, while the app under test loads
 *    inside an iframe behind it. The viewer never watches a blank screen, and the
 *    recording survives every navigation the app makes.
 *  - THE WRAPPER IS SERVED OVER HTTP, NEVER file://. A session cookie set
 *    SameSite=Lax is withheld on a file:// -> http:// iframe load, so the app
 *    renders signed out inside the wrapper while the same URL is signed in in a
 *    normal tab, with nothing erroring to tell you why.
 *  - EVERY CLICK IS RINGED AND HAS A DRAWN CURSOR. A silent recording has no
 *    pointer of its own, so a click is otherwise invisible. Both are drawn in the
 *    wrapper, above every stacking context the app can create.
 *  - ONE SCENARIO PER PROCESS, ONE VIDEO PER SCENARIO.
 *
 * Usage:
 *   import { createHarness } from '<plugin>/skills/record-ui-evidence/scripts/harness.mjs';
 *   const h = await createHarness({ scenario: 'my-case', appUrl: 'http://localhost:3000', ... });
 *
 * Full option and helper reference: ../references/api.md
 */
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, resolve as resolvePath } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Find Playwright without forcing the consuming project to install this harness
 * as a dependency. In order: an explicit path, the EVIDENCE_PLAYWRIGHT env var,
 * a plain bare import, then a resolve from the current working directory (which
 * is what makes `node scenario.mjs` work from inside any project that already
 * has Playwright in its own node_modules).
 */
async function loadChromium(explicitPath) {
  const attempts = [];
  for (const candidate of [explicitPath, process.env.EVIDENCE_PLAYWRIGHT]) {
    if (candidate) attempts.push(pathToFileURL(resolvePath(candidate)).href);
  }
  attempts.push('playwright');
  for (const spec of attempts) {
    try {
      return (await import(spec)).chromium;
    } catch {
      /* try the next candidate */
    }
  }
  try {
    const req = createRequire(resolvePath(process.cwd(), 'package.json'));
    return (await import(pathToFileURL(req.resolve('playwright')).href)).chromium;
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    'Playwright could not be resolved. Install it in the project you are recording, ' +
      'or pass playwrightPath / set EVIDENCE_PLAYWRIGHT to its entry file.',
  );
}

/**
 * Serve the studio page. Port 0 asks the OS for a free port, which is what keeps
 * several scenarios (or several agents) from colliding on a hard-coded one.
 */
function serveWrapper(wrapperPath, port) {
  const html = readFileSync(wrapperPath, 'utf8');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

/**
 * @param {object} opts
 * @param {string} opts.scenario      Name of this take; the video lands in <root>/recordings/<scenario>/.
 * @param {string} opts.appUrl        Base URL of the app under test, e.g. 'http://localhost:3000'.
 * @param {string} [opts.root]        Where profile/ and recordings/ live. Default: process.cwd().
 * @param {string} [opts.readySelector] Default selector awaited after a load. Comma-separated list = alternatives.
 * @param {string[]} [opts.origins]   Extra origins counted as "the app" by frame(). appUrl is always included.
 * @param {string} [opts.brand]       Title-card tag text. Default: 'Evidence'.
 * @param {object} [opts.viewport]    Default { width: 1440, height: 900 }.
 * @param {string} [opts.locale]      Browser locale, e.g. 'fr-FR', when the scenario depends on it.
 * @param {boolean} [opts.record]     Write a video. Default true; false is for dry runs and probes.
 * @param {boolean} [opts.headless]   Default true.
 * @param {boolean} [opts.signedOut]  Clear cookies so the take opens on the sign-in screen.
 * @param {number} [opts.wrapperPort] Fixed studio port. Default 0 = a free one.
 * @param {string} [opts.wrapperPath] Alternative studio page. Default: the bundled wrapper.html.
 * @param {string} [opts.playwrightPath] Explicit path to Playwright's entry file.
 * @param {object} [opts.signInSelectors] Overrides for signInIfNeeded, see below.
 */
export async function createHarness({
  scenario,
  appUrl,
  root = process.cwd(),
  readySelector: defaultReadySelector = 'body',
  origins = [],
  brand = 'Evidence',
  viewport = { width: 1440, height: 900 },
  locale,
  record = true,
  headless = true,
  signedOut = false,
  wrapperPort = 0,
  wrapperPath = `${HERE}/wrapper.html`,
  playwrightPath,
  signInSelectors = {},
} = {}) {
  if (!scenario) throw new Error('createHarness needs a scenario name');
  if (!appUrl) throw new Error('createHarness needs an appUrl');

  const PROFILE = `${root}/profile`;
  const RECORDINGS = `${root}/recordings`;
  const knownOrigins = [appUrl, ...origins];

  const chromium = await loadChromium(playwrightPath);
  mkdirSync(RECORDINGS, { recursive: true });
  const { server, port } = await serveWrapper(wrapperPath, wrapperPort);

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless,
    viewport,
    ...(locale ? { locale } : {}),
    ...(record ? { recordVideo: { dir: `${RECORDINGS}/${scenario}`, size: viewport } } : {}),
    args: ['--disable-dev-shm-usage'],
  });

  // The persistent profile keeps a session between runs, which silently skips the
  // sign-in step and robs the recording of its most convincing opening. Clear it
  // when the scenario wants to be signed out on camera.
  if (signedOut) await context.clearCookies();

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

  /** Elements of the app under test live in the iframe, never in the top page. */
  const app = page.frameLocator('#app');
  /** The raw Playwright Frame, for the things frameLocator cannot express. */
  const frame = () => page.frames().find((f) => knownOrigins.some((o) => f.url().startsWith(o)));

  // ---------------------------------------------------------------------------
  // Overlays
  // ---------------------------------------------------------------------------
  const card = (title, sub, tag = brand) =>
    page.evaluate(([t, s, g]) => window.showCard(t, s, g), [title, sub, tag]);
  const hideCard = () => page.evaluate(() => window.hideCard());

  /** The narration bar. Hold long enough to actually be read: ~2.4s minimum. */
  const caption = async (text, holdMs = 2400) => {
    await page.evaluate((t) => window.setCaption(t), text);
    if (holdMs) await page.waitForTimeout(holdMs);
  };

  /**
   * The top-right note. `kind` is 'info' | 'pass' | 'fail'; omit it and a leading
   * PASS/FAIL in the text decides. Never force red on something that is not a
   * failure — a red corner box reads as an error whatever it says.
   */
  const note = (text, kind) =>
    page.evaluate(([t, k]) => window.setNote(t, k), [text, kind ?? null]);

  const ring = (box, label) =>
    page.evaluate(([b, l]) => window.showRing(b, l), [box ?? null, label ?? '']);

  // ---------------------------------------------------------------------------
  // Cursor. The drawn cursor and the real Playwright mouse move together, so the
  // app's hover states match what the viewer sees.
  // ---------------------------------------------------------------------------
  const MOVE_MS = 620;
  let cursorParked = false;

  const centreOf = async (locator) => {
    const target = locator.first();
    await target.waitFor({ state: 'visible', timeout: 60000 });
    await target.scrollIntoViewIfNeeded().catch(() => {});
    const box = await target.boundingBox();
    if (!box) throw new Error('target has no bounding box');
    return { box, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };

  /** Glide the drawn cursor (and the real mouse) to a point and wait out the travel. */
  const cursorTo = async (x, y) => {
    if (!cursorParked) {
      await page.evaluate(([px, py]) => window.placeCursor(px, py), [
        Math.round(x),
        viewport.height - 40,
      ]);
      cursorParked = true;
    }
    await page.evaluate(([px, py]) => window.moveCursor(px, py), [Math.round(x), Math.round(y)]);
    await page.mouse.move(x, y, { steps: 12 });
    await page.waitForTimeout(MOVE_MS);
  };

  /**
   * Point at something without touching it — "look here". Use it for elements
   * that matter to the story even though nothing is clicked on them.
   */
  const look = async (locator, label, { hold = 1500, keepRing = false } = {}) => {
    const { box, x, y } = await centreOf(locator);
    await cursorTo(x, y);
    await ring(box, label);
    await page.waitForTimeout(hold);
    if (!keepRing) await ring(null);
  };

  /** Move the cursor to the target, show a click animation, then really click it. */
  const click = async (locator, label, { hold = 550, ringIt = true } = {}) => {
    const { box, x, y } = await centreOf(locator);
    await cursorTo(x, y);
    if (ringIt) await ring(box, label);
    await page.waitForTimeout(hold);
    await page.evaluate(() => window.clickCursor());
    await page.waitForTimeout(160);
    await locator.first().click();
    await page.waitForTimeout(180);
    await ring(null);
  };

  /** Click into a field and type it out character by character, so the input is visibly real. */
  const typeInto = async (locator, text, label, { delay = 55 } = {}) => {
    await click(locator, label, { hold: 350 });
    await locator.first().pressSequentially(text, { delay });
    await page.waitForTimeout(350);
  };

  /** Ring a target and click it without moving the cursor. The cheap variant of click(). */
  const ringClick = async (locator, label, { hold = 1000, click: doClick = true } = {}) => {
    const target = locator.first();
    await target.waitFor({ state: 'visible', timeout: 60000 });
    const box = await target.boundingBox();
    if (box) {
      await ring(box, label);
      await page.waitForTimeout(hold);
    }
    if (doClick) await target.click();
    await ring(null);
  };

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  /**
   * Load a URL inside the iframe, holding the title card until `readySelector`
   * has rendered. Pass a comma-separated selector list to accept alternatives
   * (e.g. the app shell OR the sign-in form): a redirect to the login page can
   * be late, so the only reliable wait is for whichever of them paints.
   */
  const loadUrl = async (url, readySelector = defaultReadySelector, { title, sub, tag } = {}) => {
    if (title) await card(title, sub, tag);
    await page.evaluate((u) => window.loadFrame(u), url);
    await app.locator(readySelector).first().waitFor({ state: 'visible', timeout: 180000 });
    await page.waitForTimeout(900);
    await hideCard();
    await page.waitForTimeout(400);
  };

  /** loadUrl for a path relative to appUrl. */
  const loadApp = (path, readySelector, opts) => loadUrl(`${appUrl}${path}`, readySelector, opts);

  /**
   * Sign in when — and only when — the sign-in form is what rendered. Uses real
   * typed input, because writing .value directly leaves a framework's reactive
   * form model untouched and the submit button stays disabled.
   *
   * Override the selectors per project via createHarness({ signInSelectors }).
   */
  const signInIfNeeded = async (email, password, readySelector = defaultReadySelector) => {
    const {
      email: emailSel = '#email',
      password: passwordSel = '#password',
      submit: submitSel = 'button[type="submit"]',
    } = signInSelectors;
    const emailField = app.locator(emailSel);
    if ((await emailField.count()) === 0) return false;
    // Fill and submit BEFORE showing the card: the card sits above the iframe and
    // intercepts pointer events, so a click under it times out (fill does not hit-test).
    await emailField.fill(email);
    await app.locator(passwordSel).fill(password);
    await app.locator(submitSel).first().click();
    await card('Signing in', null, 'Setup');
    await app.locator(readySelector).first().waitFor({ state: 'visible', timeout: 180000 });
    await page.waitForTimeout(900);
    await hideCard();
    return true;
  };

  let closed = false;
  let videoPath = null;

  /**
   * Close everything and return the path of the written video, or null.
   * Safe to call twice, so a scenario can call it from a `finally` without
   * having to track whether the happy path already did.
   */
  const finish = async () => {
    if (closed) return videoPath;
    closed = true;
    const video = page.video();
    await context.close();
    server.close();
    // close() only stops new connections; a keep-alive socket from the studio
    // page would hold the process open long after the take is done.
    server.closeAllConnections?.();
    videoPath = video ? await video.path() : null;
    return videoPath;
  };

  return {
    context, page, app, frame, viewport, appUrl, wrapperPort: port,
    card, hideCard, caption, note, ring,
    cursorTo, look, click, typeInto, ringClick,
    loadUrl, loadApp, signInIfNeeded, finish,
  };
}
