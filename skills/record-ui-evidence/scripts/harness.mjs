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
 *  - THE SAME SCRIPT IS THE DEMO AND THE FAST E2E TEST. mode: 'test' keeps every
 *    real Playwright action and drops every hold and every drawn overlay, so a
 *    scenario written for the camera also runs as a quick test.
 *
 * Usage:
 *   import { createHarness } from '<plugin>/skills/record-ui-evidence/scripts/harness.mjs';
 *   const h = await createHarness({ scenario: 'my-case', appUrl: 'http://localhost:3000', ... });
 *
 * Full option and helper reference: ../references/api.md
 */
import { createServer } from 'http';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
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

const CORE = '@showitworks/core';

/** Both entries of a core package, or null when either lacks what the harness calls. */
function usableCore(core, node) {
  const fns = [core?.createEventLog, core?.attachCapture, core?.createClient, node?.uploadRunFromFiles, node?.collectGitMeta];
  return fns.every((fn) => typeof fn === 'function') ? { core, node } : null;
}

/** Import "." and "./node" of a package directory through its `exports` map. */
async function importCoreDir(dir) {
  const root = resolvePath(dir);
  const { exports: map } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entry = (key) => {
    let target = map?.[key];
    while (target && typeof target === 'object') target = target.import ?? target.node ?? target.default;
    if (typeof target !== 'string') throw new Error(`${root} exports no "${key}"`);
    return pathToFileURL(resolvePath(root, target)).href;
  };
  return usableCore(await import(entry('.')), await import(entry('./node')));
}

/**
 * Find @showitworks/core, which is optional: without it the harness records
 * exactly as it always has. Same order as loadChromium: an explicit package
 * directory, the EVIDENCE_SHOWITWORKS env var (also a package directory), a
 * plain bare import, then the package as seen from the current working
 * directory. Returns { core, node } or null; never throws.
 */
export async function loadShowItWorks(explicitDir) {
  for (const dir of [explicitDir, process.env.EVIDENCE_SHOWITWORKS]) {
    if (!dir) continue;
    try {
      const found = await importCoreDir(dir);
      if (found) return found;
    } catch {
      /* try the next candidate */
    }
  }
  try {
    const found = usableCore(await import(CORE), await import(`${CORE}/node`));
    if (found) return found;
  } catch {
    /* try the next candidate */
  }
  try {
    // require.resolve() cannot be used: core's exports offer only the `import`
    // condition. Find the package directory the way require would, then read it.
    const req = createRequire(resolvePath(process.cwd(), 'package.json'));
    const dir = (req.resolve.paths(CORE) ?? []).map((p) => join(p, CORE)).find((d) => existsSync(join(d, 'package.json')));
    if (dir) return await importCoreDir(dir);
  } catch {
    /* not installed */
  }
  return null;
}

/** At most this many checkpoints are captured and uploaded per run (core's RUN_FILE_LIMITS.checkpoints). */
const CHECKPOINT_LIMIT = 30;
const MAX_CHECKPOINT_NAME_CHARS = 120;

/** `name`, or `name#2`, `name#3`, ... — core's rule, for when core is not installed. */
function localUniqueName(taken, name) {
  const base = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, MAX_CHECKPOINT_NAME_CHARS) || 'checkpoint';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `#${n}`;
    const candidate = `${base.slice(0, MAX_CHECKPOINT_NAME_CHARS - suffix.length)}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Lowercase a-z0-9 words joined by '-', at most `max` characters; 'caption' when nothing is left. */
function slug(text, max) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return words.slice(0, max).replace(/-+$/, '') || 'caption';
}

/** Path segments that name one record rather than a page: a UUID, a digit run, a long id with a digit. */
const ID_SEGMENTS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\d+$/,
  /^(?=.*\d)[A-Za-z0-9_-]{16,}$/,
];

/** `load-<path>` with query and hash dropped and every id segment as `:id`, so runs compare by page. */
function loadCheckpointName(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url).split(/[?#]/)[0];
  }
  const normalized = path.split('/').map((s) => (ID_SEGMENTS.some((re) => re.test(s)) ? ':id' : s)).join('/');
  return `load-${normalized || '/'}`;
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
 * @param {object} [opts.showitworks] Optional run upload when @showitworks/core is installed:
 *   { apiKey, storage, baseUrl, flow, git, corePath, required }. See ../references/api.md.
 * @param {'demo'|'test'} [opts.mode] 'demo' (default) paces and draws for the camera; 'test'
 *   runs the same actions without a single hold or overlay.
 * @param {boolean} [opts.autoCheckpoints] Checkpoint every caption and every load. Default: mode === 'test'.
 * @param {string} [opts.testIdAttribute] Attribute structural snapshots key elements by. Default 'data-testid'.
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
  showitworks = {},
  mode = 'demo',
  autoCheckpoints = mode === 'test',
  testIdAttribute = 'data-testid',
} = {}) {
  if (!scenario) throw new Error('createHarness needs a scenario name');
  if (!appUrl) throw new Error('createHarness needs an appUrl');
  if (mode !== 'demo' && mode !== 'test') throw new Error(`createHarness mode must be 'demo' or 'test', not ${JSON.stringify(mode)}`);
  const testMode = mode === 'test';

  const PROFILE = `${root}/profile`;
  const RECORDINGS = `${root}/recordings`;
  const knownOrigins = [appUrl, ...origins];
  const {
    apiKey = process.env.SHOWITWORKS_API_KEY,
    storage = process.env.SHOWITWORKS_STORAGE,
    baseUrl = process.env.SHOWITWORKS_URL,
    flow = scenario,
    git,
    corePath,
    required = false,
  } = showitworks;

  const chromium = await loadChromium(playwrightPath);
  const siw = await loadShowItWorks(corePath);
  mkdirSync(RECORDINGS, { recursive: true });
  const { server, port } = await serveWrapper(wrapperPath, wrapperPort);

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless,
    viewport,
    ...(locale ? { locale } : {}),
    ...(record ? { recordVideo: { dir: `${RECORDINGS}/${scenario}`, size: viewport } } : {}),
    args: ['--disable-dev-shm-usage'],
  });

  // The run's clock starts with the video. With core installed, the app's console
  // and network are captured from here on; the studio page's own traffic is not.
  const t0 = Date.now();
  let log = null;
  let detach = null;
  let captureError = null;
  if (siw) {
    try {
      log = siw.core.createEventLog({ t0, source: 'harness', videoOffsetMs: 0 });
      detach = siw.core.attachCapture(context, log, { ignoreOrigins: [`http://127.0.0.1:${port}`] });
    } catch (error) {
      captureError = error;
    }
  }

  // The persistent profile keeps a session between runs, which silently skips the
  // sign-in step and robs the recording of its most convincing opening. Clear it
  // when the scenario wants to be signed out on camera.
  if (signedOut) await context.clearCookies();

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  // Test mode draws nothing, so nothing would ever lift the studio's opening
  // "Preparing…" card off the iframe — and it intercepts every click. Hide all
  // overlay layers once instead: hidden layers neither show nor hit-test.
  if (testMode) await page.evaluate(() => window.setOverlaysHidden?.(true));

  /** Elements of the app under test live in the iframe, never in the top page. */
  const app = page.frameLocator('#app');
  /** The raw Playwright Frame, for the things frameLocator cannot express. */
  const frame = () => page.frames().find((f) => knownOrigins.some((o) => f.url().startsWith(o)));

  /** Every hold goes through here: the camera needs it, a test does not. */
  const pause = (ms) => (testMode || !ms ? Promise.resolve() : page.waitForTimeout(ms));
  /** Every overlay call goes through here: a test draws nothing. */
  const draw = (...args) => (testMode ? Promise.resolve() : page.evaluate(...args));

  // ---------------------------------------------------------------------------
  // Checkpoints: named moments of the run. With @showitworks/core each one keeps
  // a structural snapshot of the app's frame and a screenshot, written to
  // run/checkpoints/ and uploaded with the run, so two runs can be compared
  // moment by moment. Without core only the name is kept.
  // ---------------------------------------------------------------------------
  const CHECKPOINTS_DIR = `${RECORDINGS}/${scenario}/run/checkpoints`;
  const uniqueName = typeof siw?.core.uniqueCheckpointName === 'function' ? siw.core.uniqueCheckpointName : localUniqueName;
  const checkpointNames = [];
  /** What finish() uploads, in ordinal order: { name, tMs, screenshotPath?, snapshotPath? }. */
  const checkpointFiles = [];

  /**
   * Record a named moment. Never throws: resolves { name, ordinal, tMs, captured: true }
   * or { name, ordinal?, tMs, captured: false, reason }.
   */
  const checkpoint = async (rawName, { screenshot = true } = {}) => {
    const at = Date.now();
    const tMs = at - t0;
    const name = uniqueName(checkpointNames, rawName);
    checkpointNames.push(name);
    if (!siw) return { name, tMs, captured: false, reason: `${CORE} not installed` };
    if (!log) return { name, tMs, captured: false, reason: captureError?.message ?? String(captureError) };
    // The event and its slot in the upload are taken together, before any await,
    // so the event's ordinal is the checkpoint's position in the upload.
    const ordinal = log.checkpoint(name, at);
    if (checkpointFiles.length >= CHECKPOINT_LIMIT) {
      return { name, ordinal, tMs, captured: false, reason: `checkpoint limit (${CHECKPOINT_LIMIT}) reached` };
    }
    const files = { name, tMs };
    checkpointFiles.push(files);
    try {
      const snapshot = await siw.core.captureStructure(frame() ?? page.mainFrame(), { testIdAttribute });
      let png = null;
      if (screenshot) {
        // In demo mode the captions and the cursor are hidden for this one frame,
        // so the screenshot shows the app and nothing the recorder drew over it.
        if (!testMode) await page.evaluate(() => window.setOverlaysHidden?.(true));
        try {
          png = await page.screenshot({ type: 'png' });
        } finally {
          if (!testMode) await page.evaluate(() => window.setOverlaysHidden?.(false));
        }
      }
      mkdirSync(CHECKPOINTS_DIR, { recursive: true });
      const base = `${CHECKPOINTS_DIR}/${String(ordinal).padStart(2, '0')}`;
      writeFileSync(`${base}.json`, siw.core.serializeSnapshot(snapshot));
      if (png) writeFileSync(`${base}.png`, png);
      files.snapshotPath = `${base}.json`;
      if (png) files.screenshotPath = `${base}.png`;
      return { name, ordinal, tMs, captured: true };
    } catch (error) {
      const reason = error?.message ?? String(error);
      console.error(`checkpoint failed: ${name}: ${reason}`);
      return { name, ordinal, tMs, captured: false, reason };
    }
  };

  // ---------------------------------------------------------------------------
  // Overlays
  // ---------------------------------------------------------------------------
  const card = (title, sub, tag = brand) =>
    draw(([t, s, g]) => window.showCard(t, s, g), [title, sub, tag]);
  const hideCard = () => draw(() => window.hideCard());

  /**
   * The narration bar. Hold long enough to actually be read: ~2.4s minimum.
   * With autoCheckpoints each caption also marks a checkpoint; an empty one,
   * which only clears the bar, does not.
   */
  const caption = async (text, holdMs = 2400) => {
    await draw((t) => window.setCaption(t), text);
    if (autoCheckpoints && text) await checkpoint(`caption-${slug(text, 40)}`);
    await pause(holdMs);
  };

  /**
   * The top-right note. `kind` is 'info' | 'pass' | 'fail'; omit it and a leading
   * PASS/FAIL in the text decides. Never force red on something that is not a
   * failure — a red corner box reads as an error whatever it says.
   */
  const note = (text, kind) =>
    draw(([t, k]) => window.setNote(t, k), [text, kind ?? null]);

  const ring = (box, label) =>
    draw(([b, l]) => window.showRing(b, l), [box ?? null, label ?? '']);

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
    // A test moves only the real mouse, in one step: hover states still apply.
    if (testMode) return page.mouse.move(x, y, { steps: 1 });
    if (!cursorParked) {
      await page.evaluate(([px, py]) => window.placeCursor(px, py), [
        Math.round(x),
        viewport.height - 40,
      ]);
      cursorParked = true;
    }
    await page.evaluate(([px, py]) => window.moveCursor(px, py), [Math.round(x), Math.round(y)]);
    await page.mouse.move(x, y, { steps: 12 });
    await pause(MOVE_MS);
  };

  /**
   * Point at something without touching it — "look here". Use it for elements
   * that matter to the story even though nothing is clicked on them.
   */
  const look = async (locator, label, { hold = 1500, keepRing = false } = {}) => {
    const { box, x, y } = await centreOf(locator);
    await cursorTo(x, y);
    await ring(box, label);
    await pause(hold);
    if (!keepRing) await ring(null);
  };

  /** Move the cursor to the target, show a click animation, then really click it. */
  const click = async (locator, label, { hold = 550, ringIt = true } = {}) => {
    const { box, x, y } = await centreOf(locator);
    await cursorTo(x, y);
    if (ringIt) await ring(box, label);
    await pause(hold);
    await draw(() => window.clickCursor());
    await pause(160);
    await locator.first().click();
    await pause(180);
    await ring(null);
  };

  /** Click into a field and type it out character by character, so the input is visibly real. */
  const typeInto = async (locator, text, label, { delay = 55 } = {}) => {
    await click(locator, label, { hold: 350 });
    await locator.first().pressSequentially(text, { delay: testMode ? 0 : delay });
    await pause(350);
  };

  /** Ring a target and click it without moving the cursor. The cheap variant of click(). */
  const ringClick = async (locator, label, { hold = 1000, click: doClick = true } = {}) => {
    const target = locator.first();
    await target.waitFor({ state: 'visible', timeout: 60000 });
    const box = await target.boundingBox();
    if (box) {
      await ring(box, label);
      await pause(hold);
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
   *
   * With autoCheckpoints the loaded page is checkpointed as `load-<path>`, ids
   * in the path written as `:id` — after the card has lifted, so a demo's
   * screenshot never makes the card blink.
   */
  const loadUrl = async (url, readySelector = defaultReadySelector, { title, sub, tag } = {}) => {
    if (title) await card(title, sub, tag);
    await page.evaluate((u) => window.loadFrame(u), url);
    await app.locator(readySelector).first().waitFor({ state: 'visible', timeout: 180000 });
    await pause(900);
    await hideCard();
    await pause(400);
    if (autoCheckpoints) await checkpoint(loadCheckpointName(url));
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
    await pause(900);
    await hideCard();
    return true;
  };

  let closed = false;
  let videoPath = null;
  let settleUpload;
  /** What became of the run upload; settles when finish() has run. Never rejects. */
  const upload = new Promise((done) => {
    settleUpload = done;
  });

  /**
   * After the take: write the event log next to the video and, given an API key
   * and a storage, upload both as one run. A failure is reported, never thrown.
   */
  const uploadRun = async (outcome, durationMs) => {
    if (!siw) return { status: 'skipped', reason: `${CORE} not installed` };
    if (captureError) return { status: 'failed', reason: captureError.message ?? String(captureError) };
    try {
      const eventsPath = `${RECORDINGS}/${scenario}/run/events.jsonl`;
      mkdirSync(dirname(eventsPath), { recursive: true });
      writeFileSync(eventsPath, log.toJSONL());
      if (!apiKey) return { status: 'skipped', reason: 'no API key' };
      if (!storage) return { status: 'skipped', reason: 'no storage' };
      const client = siw.core.createClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
      const answer = await siw.node.uploadRunFromFiles(client, {
        storage, flow, title: scenario, outcome, startedAt: t0, durationMs, source: 'harness',
        git: await siw.node.collectGitMeta({ overrides: git }),
        ...(videoPath ? { video: { path: videoPath } } : {}),
        events: { path: eventsPath },
        ...(checkpointFiles.length ? {
          checkpoints: checkpointFiles.map(({ name, tMs, screenshotPath, snapshotPath }) => ({
            name, tMs,
            ...(screenshotPath ? { screenshot: { path: screenshotPath } } : {}),
            ...(snapshotPath ? { snapshot: { path: snapshotPath } } : {}),
          })),
        } : {}),
      });
      return { status: 'uploaded', runId: answer?.run?.id, runUrl: answer?.runUrl };
    } catch (error) {
      return { status: 'failed', reason: error?.message ?? String(error) };
    }
  };

  /**
   * Close everything and return the path of the written video, or null.
   * Safe to call twice, so a scenario can call it from a `finally` without
   * having to track whether the happy path already did. `outcome` labels the
   * uploaded run (passed | failed | ...); it is unused without @showitworks/core.
   */
  const finish = async (options) => {
    if (closed) return videoPath;
    closed = true;
    // Read defensively: 1.1.0 ignored arguments, so `.then(h.finish)` must keep working.
    const outcome = options?.outcome ?? 'unknown';
    const durationMs = Date.now() - t0;
    // Stop listening before the close aborts whatever the app still had in flight.
    detach?.();
    const video = page.video();
    await context.close();
    server.close();
    // close() only stops new connections; a keep-alive socket from the studio
    // page would hold the process open long after the take is done.
    server.closeAllConnections?.();
    videoPath = video ? await video.path() : null;
    const result = await uploadRun(outcome, durationMs);
    settleUpload(result);
    if (siw || required) {
      const line = result.status === 'uploaded' ? `run uploaded: ${result.runUrl}` : `upload ${result.status}: ${result.reason}`;
      console.error(line);
      if (required && result.status !== 'uploaded') throw new Error(line);
    }
    return videoPath;
  };

  return {
    context, page, app, frame, viewport, appUrl, wrapperPort: port,
    card, hideCard, caption, note, ring,
    cursorTo, look, click, typeInto, ringClick,
    loadUrl, loadApp, signInIfNeeded, finish,
    upload, t0, mode, checkpoint,
  };
}
