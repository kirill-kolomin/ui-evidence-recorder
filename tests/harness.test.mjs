/**
 * harness.mjs against a fake Playwright (no browser) and a fake
 * @showitworks/core. The harness under test is a byte-for-byte copy in a temp
 * directory, run from an empty temp cwd, so a core package installed near this
 * repository cannot leak into the "no core" cases.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(REPO, 'skills/record-ui-evidence/scripts');
const FAKE_PLAYWRIGHT = fileURLToPath(new URL('./fixtures/fake-playwright.mjs', import.meta.url));
const FAKE_CORE = fileURLToPath(new URL('./fixtures/fake-core', import.meta.url));
const APP_URL = 'http://localhost:3999';
const ENV_KEYS = ['SHOWITWORKS_API_KEY', 'SHOWITWORKS_STORAGE', 'SHOWITWORKS_URL', 'EVIDENCE_SHOWITWORKS', 'EVIDENCE_PLAYWRIGHT'];

let TMP;
let ORIGINAL_CWD;
const savedEnv = {};
let harness;
let rootCount = 0;

/** A copy of the plugin's scripts directory, optionally with a node_modules/@showitworks/core beside it. */
function copyHarness(dir, { withCore = false } = {}) {
  cpSync(join(SCRIPTS, 'harness.mjs'), join(dir, 'plugin/harness.mjs'));
  cpSync(join(SCRIPTS, 'wrapper.html'), join(dir, 'plugin/wrapper.html'));
  if (withCore) cpSync(FAKE_CORE, join(dir, 'node_modules/@showitworks/core'), { recursive: true });
  return import(pathToFileURL(join(dir, 'plugin/harness.mjs')).href);
}

const freshRoot = () => {
  const root = join(TMP, `root-${++rootCount}`);
  mkdirSync(root, { recursive: true });
  return root;
};

const calls = (name) => globalThis.__harnessTest.calls.filter(([n]) => n === name);
const indexOf = (name, arg) => globalThis.__harnessTest.calls.findIndex(([n, a]) => n === name && (arg === undefined || a === arg));

/** Every file under dir, as sorted relative paths. */
function filesUnder(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name), base) : [relative(base, join(dir, e.name))]))
    .sort();
}

/** Run fn while collecting everything written through console.*. */
async function captureConsole(fn) {
  const lines = [];
  const methods = ['log', 'error', 'warn', 'info', 'debug'];
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args) => lines.push(`${m}: ${args.join(' ')}`);
  try {
    return { value: await fn(), lines };
  } finally {
    methods.forEach((m, i) => { console[m] = saved[i]; });
  }
}

/** Harnesses started by the current test; afterEach closes them so a failed assertion cannot leave the studio server running. */
let started = [];

const start = async (options = {}) => {
  const h = await harness.createHarness({ scenario: 'demo', appUrl: APP_URL, playwrightPath: FAKE_PLAYWRIGHT, ...options });
  started.push(h);
  return h;
};

const withCore = (showitworks = {}) => ({ showitworks: { corePath: FAKE_CORE, ...showitworks } });

before(async () => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'harness-test-')));
  ORIGINAL_CWD = process.cwd();
  mkdirSync(join(TMP, 'cwd'));
  process.chdir(join(TMP, 'cwd'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  harness = await copyHarness(join(TMP, 'main'));
});

after(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  globalThis.__harnessTest = { calls: [], uploadError: null };
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  const open = started;
  started = [];
  await captureConsole(() => Promise.all(open.map((h) => h.finish().catch(() => {}))));
});

test('without core: same Playwright calls, files, output and return value as 1.1.0', async () => {
  const root = freshRoot();
  const { value: h, lines: startLines } = await captureConsole(() => start({ root }));
  const { value: videoPath, lines: finishLines } = await captureConsole(() => h.finish());

  const dir = `${root}/recordings/demo`;
  assert.deepEqual(globalThis.__harnessTest.calls, [
    ['launchPersistentContext', `${root}/profile`, {
      headless: true,
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir, size: { width: 1440, height: 900 } },
      args: ['--disable-dev-shm-usage'],
    }],
    ['context.pages'],
    ['page.goto', `http://127.0.0.1:${h.wrapperPort}/`, { waitUntil: 'load' }],
    ['page.frameLocator', '#app'],
    ['page.video'],
    ['context.close'],
    ['video.path'],
  ]);
  assert.equal(h.context.listenerCount('console'), 0);
  assert.equal(videoPath, `${dir}/take.webm`);
  assert.deepEqual(filesUnder(root), ['recordings/demo/take.webm']);
  assert.deepEqual([...startLines, ...finishLines], []);
  assert.deepEqual(await h.upload, { status: 'skipped', reason: '@showitworks/core not installed' });
  assert.equal(typeof h.t0, 'number');
  // Still idempotent, still the video path.
  assert.equal(await h.finish(), videoPath);
});

test('without core: record false still returns null and writes nothing', async () => {
  const root = freshRoot();
  const h = await start({ root, record: false });
  assert.equal(await h.finish(), null);
  assert.deepEqual(filesUnder(root), []);
  assert.equal((await h.upload).status, 'skipped');
});

test('core without an API key: events.jsonl written locally, upload skipped', async () => {
  const root = freshRoot();
  const h = await start({ root, ...withCore() });
  const [[, logOptions]] = calls('createEventLog');
  assert.deepEqual(logOptions, { t0: h.t0, source: 'harness', videoOffsetMs: 0 });
  const [[, captureOptions]] = calls('attachCapture');
  assert.deepEqual(captureOptions, { ignoreOrigins: [`http://127.0.0.1:${h.wrapperPort}`] });
  // Listening starts before the studio page loads.
  assert.ok(indexOf('context.on', 'console') < indexOf('page.goto'));

  h.context.emit('console', { type: () => 'error', text: () => 'boom', location: () => ({ url: `${APP_URL}/main.js` }) });
  const { value: videoPath, lines } = await captureConsole(() => h.finish({ outcome: 'passed' }));

  assert.equal(videoPath, `${root}/recordings/demo/take.webm`);
  assert.deepEqual(lines, ['error: upload skipped: no API key']);
  assert.deepEqual(await h.upload, { status: 'skipped', reason: 'no API key' });
  assert.deepEqual(filesUnder(root), ['recordings/demo/run/events.jsonl', 'recordings/demo/take.webm']);
  const events = readFileSync(`${root}/recordings/demo/run/events.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'header');
  assert.deepEqual(events[1], { type: 'console', level: 'error', text: 'boom', frame: `${APP_URL}/main.js` });
  // Detached before the context closed, so the close's aborted requests are not logged.
  assert.ok(indexOf('detach') < indexOf('context.close'));
  assert.equal(h.context.listenerCount('console'), 0);
  assert.equal(calls('uploadRunFromFiles').length, 0);
});

test('core with a key but no storage: skipped "no storage"', async () => {
  const h = await start({ root: freshRoot(), ...withCore({ apiKey: 'siw_test' }) });
  const { lines } = await captureConsole(() => h.finish());
  assert.deepEqual(lines, ['error: upload skipped: no storage']);
  assert.deepEqual(await h.upload, { status: 'skipped', reason: 'no storage' });
});

test('core + key + storage: the run is uploaded with flow = scenario', async () => {
  const root = freshRoot();
  const git = { branch: 'feature/x' };
  const h = await start({
    root,
    scenario: 'saves-a-draft',
    ...withCore({ apiKey: 'siw_test', storage: 'ci', baseUrl: 'https://example.test', git }),
  });
  const { value: videoPath, lines } = await captureConsole(() => h.finish({ outcome: 'passed' }));

  const dir = `${root}/recordings/saves-a-draft`;
  assert.equal(videoPath, `${dir}/take.webm`);
  assert.deepEqual(lines, ['error: run uploaded: https://showitworks.test/runs/run_1']);
  assert.deepEqual(await h.upload, { status: 'uploaded', runId: 'run_1', runUrl: 'https://showitworks.test/runs/run_1' });
  assert.deepEqual(calls('createClient'), [['createClient', { apiKey: 'siw_test', baseUrl: 'https://example.test' }]]);
  assert.deepEqual(calls('collectGitMeta'), [['collectGitMeta', { overrides: git }]]);
  assert.deepEqual(calls('attachCapture')[0][1].ignoreOrigins, [`http://127.0.0.1:${h.wrapperPort}`]);

  const [[, upload]] = calls('uploadRunFromFiles');
  const { durationMs, ...spec } = upload.spec;
  assert.deepEqual(spec, {
    storage: 'ci',
    flow: 'saves-a-draft',
    title: 'saves-a-draft',
    outcome: 'passed',
    startedAt: h.t0,
    source: 'harness',
    git: { commitSha: 'abc1234', branch: 'main' },
    video: { path: videoPath },
    events: { path: `${dir}/run/events.jsonl` },
  });
  assert.ok(Number.isInteger(durationMs) && durationMs >= 0);
  assert.equal(upload.video, 'fake webm bytes');
  assert.match(upload.events, /"type":"header"/);
  // The upload happens after the existing close sequence.
  assert.ok(indexOf('video.path') < indexOf('uploadRunFromFiles'));
});

test('env vars supply key, storage and URL; flow and outcome have defaults', async () => {
  process.env.SHOWITWORKS_API_KEY = 'siw_env';
  process.env.SHOWITWORKS_STORAGE = 'nightly';
  process.env.SHOWITWORKS_URL = 'https://env.example.test';
  const h = await start({ root: freshRoot(), record: false, ...withCore({ flow: 'checkout › pays' }) });
  await captureConsole(() => h.finish());
  assert.equal((await h.upload).status, 'uploaded');
  assert.deepEqual(calls('createClient')[0][1], { apiKey: 'siw_env', baseUrl: 'https://env.example.test' });
  const { spec } = calls('uploadRunFromFiles')[0][1];
  assert.equal(spec.storage, 'nightly');
  assert.equal(spec.flow, 'checkout › pays');
  assert.equal(spec.outcome, 'unknown');
  assert.equal('video' in spec, false, 'record: false uploads the events alone');
});

test('an upload failure is reported, finish() still resolves to the video path', async () => {
  globalThis.__harnessTest.uploadError = 'Show It Works answered HTTP 503';
  const root = freshRoot();
  const h = await start({ root, ...withCore({ apiKey: 'siw_test', storage: 'ci' }) });
  const { value: videoPath, lines } = await captureConsole(() => h.finish({ outcome: 'failed' }));
  assert.equal(videoPath, `${root}/recordings/demo/take.webm`);
  assert.deepEqual(lines, ['error: upload failed: Show It Works answered HTTP 503']);
  assert.deepEqual(await h.upload, { status: 'failed', reason: 'Show It Works answered HTTP 503' });
});

test('required: true turns a skipped or failed upload into a thrown error', async () => {
  const h = await start({ root: freshRoot(), ...withCore({ required: true }) });
  const { lines } = await captureConsole(() =>
    assert.rejects(h.finish(), { message: 'upload skipped: no API key' }));
  assert.deepEqual(lines, ['error: upload skipped: no API key']);
  assert.deepEqual(await h.upload, { status: 'skipped', reason: 'no API key' });
  // The take is closed all the same; a second finish() just returns the video.
  assert.equal(calls('context.close').length, 1);
  assert.match(await h.finish(), /take\.webm$/);

  globalThis.__harnessTest = { calls: [], uploadError: 'quota exceeded' };
  const failing = await start({ root: freshRoot(), ...withCore({ apiKey: 'k', storage: 's', required: true }) });
  await captureConsole(() => assert.rejects(failing.finish(), { message: 'upload failed: quota exceeded' }));

  globalThis.__harnessTest = { calls: [], uploadError: null };
  const noCore = await start({ root: freshRoot(), showitworks: { required: true } });
  await captureConsole(() =>
    assert.rejects(noCore.finish(), { message: 'upload skipped: @showitworks/core not installed' }));
});

// ---------------------------------------------------------------------------
// Test mode and checkpoints
// ---------------------------------------------------------------------------

const OVERLAY_FNS = ['showCard', 'hideCard', 'setCaption', 'setNote', 'showRing', 'placeCursor', 'moveCursor', 'clickCursor', 'hideCursor'];
const UUID = '3f2b8c1e-9d4a-4c1b-8e2f-0a1b2c3d4e5f';
const RUN_PATH = `/storages/${UUID}/runs/12345?tab=events#top`;
const CAPTION = 'Open the run — and compare all of its six checkpoints!';

/** [window function, arg] of every page.evaluate, in order. */
const evaluated = () => calls('page.evaluate').map(([, fn, arg]) => [fn, arg]);
const waits = () => calls('page.waitForTimeout').map(([, ms]) => ms);
/** The calls of the given kinds made since `from`, as [name, ...args]. */
const callsSince = (from, names) => globalThis.__harnessTest.calls.slice(from).filter(([n]) => names.includes(n));

/** One scenario, written once for the camera and run unchanged in both modes. */
async function scenario(h) {
  await h.loadApp(RUN_PATH, 'main', { title: 'A run' });
  await h.signInIfNeeded('demo@example.test', 'secret');
  await h.card('Checking the run', 'and its checkpoints');
  await h.hideCard();
  await h.caption(CAPTION);
  await h.note('PASS - all good');
  await h.look(h.app.locator('#status'), 'the status');
  await h.click(h.app.locator('#open'), 'open it');
  await h.typeInto(h.app.locator('#title'), 'Hello', 'type a title');
  await h.ringClick(h.app.locator('#save'), 'save');
}

test('demo mode: every hold, the typing delay and every overlay are those of 1.1.0', async () => {
  const h = await start({ root: freshRoot(), record: false });
  assert.equal(h.mode, 'demo');
  await scenario(h);

  assert.deepEqual(waits(), [
    900, 400, // loadApp
    900, // signInIfNeeded
    2400, // caption
    620, 1500, // look: the cursor's travel (MOVE_MS), then the hold
    620, 550, 160, 180, // click
    620, 350, 160, 180, 350, // typeInto
    1000, // ringClick
  ]);
  assert.deepEqual(calls('locator.pressSequentially'), [['locator.pressSequentially', '#title', 'Hello', { delay: 55 }]]);
  assert.deepEqual(calls('mouse.move').map(([, , , options]) => options), [{ steps: 12 }, { steps: 12 }, { steps: 12 }]);
  assert.deepEqual(evaluated().map(([fn]) => fn), [
    'showCard', 'loadFrame', 'hideCard', // loadApp
    'showCard', 'hideCard', // signInIfNeeded
    'showCard', 'hideCard', 'setCaption', 'setNote',
    'placeCursor', 'moveCursor', 'showRing', 'showRing', // look
    'moveCursor', 'showRing', 'clickCursor', 'showRing', // click
    'moveCursor', 'showRing', 'clickCursor', 'showRing', // typeInto
    'showRing', 'showRing', // ringClick
  ]);
  // No checkpoint is taken unless asked for.
  assert.equal(calls('page.screenshot').length, 0);
});

test('test mode: the same scenario without a hold or an overlay; captions and loads checkpointed', async () => {
  const root = freshRoot();
  const h = await start({ root, mode: 'test', ...withCore({ apiKey: 'siw_test', storage: 'ci' }) });
  assert.equal(h.mode, 'test');
  await scenario(h);

  assert.deepEqual(calls('page.waitForTimeout'), []);
  // The studio's layers are hidden once, right after it loads; nothing is drawn after.
  assert.deepEqual(evaluated(), [['setOverlaysHidden', true], ['loadFrame', `${APP_URL}${RUN_PATH}`]]);
  assert.equal(indexOf('page.evaluate'), indexOf('page.goto') + 1);
  assert.ok(evaluated().every(([fn]) => !OVERLAY_FNS.includes(fn)));
  // Every real action still happens.
  assert.deepEqual(calls('locator.click').map(([, s]) => s), ['button[type="submit"]', '#open', '#title', '#save']);
  assert.deepEqual(calls('locator.fill').map(([, s, v]) => [s, v]), [['#email', 'demo@example.test'], ['#password', 'secret']]);
  assert.deepEqual(calls('locator.pressSequentially'), [['locator.pressSequentially', '#title', 'Hello', { delay: 0 }]]);
  assert.deepEqual(calls('mouse.move').map(([, x, y, options]) => [x, y, options]), [
    [140, 220, { steps: 1 }], [140, 220, { steps: 1 }], [140, 220, { steps: 1 }],
  ]);
  assert.ok(calls('locator.waitFor').length >= 5);

  // A load and a caption, each with a snapshot of the app's frame and a screenshot.
  assert.deepEqual(calls('log.checkpoint').map(([, name]) => name), [
    'load-/storages/:id/runs/:id',
    'caption-open-the-run-and-compare-all-of-its-six',
  ]);
  assert.deepEqual(calls('captureStructure'), [
    ['captureStructure', `${APP_URL}${RUN_PATH}`, { testIdAttribute: 'data-testid' }],
    ['captureStructure', `${APP_URL}${RUN_PATH}`, { testIdAttribute: 'data-testid' }],
  ]);
  assert.deepEqual(calls('page.screenshot'), [['page.screenshot', { type: 'png' }], ['page.screenshot', { type: 'png' }]]);
  // The load is checkpointed once the app has rendered.
  assert.ok(indexOf('locator.waitFor') < indexOf('log.checkpoint'));

  const { value: videoPath } = await captureConsole(() => h.finish({ outcome: 'passed' }));
  const run = `${root}/recordings/demo/run`;
  assert.deepEqual(filesUnder(root), [
    'recordings/demo/run/checkpoints/00.json', 'recordings/demo/run/checkpoints/00.png',
    'recordings/demo/run/checkpoints/01.json', 'recordings/demo/run/checkpoints/01.png',
    'recordings/demo/run/events.jsonl', 'recordings/demo/take.webm',
  ]);
  assert.equal(videoPath, `${root}/recordings/demo/take.webm`);
  assert.deepEqual(JSON.parse(readFileSync(`${run}/checkpoints/00.json`, 'utf8')),
    { v: 1, url: `${APP_URL}${RUN_PATH}`, testIdAttribute: 'data-testid', elements: [] });
  const events = readFileSync(`${run}/events.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.filter((e) => e.type === 'checkpoint').map((e) => [e.name, e.ordinal]),
    [['load-/storages/:id/runs/:id', 0], ['caption-open-the-run-and-compare-all-of-its-six', 1]]);

  const [[, upload]] = calls('uploadRunFromFiles');
  const uploaded = upload.spec.checkpoints;
  assert.deepEqual(uploaded.map(({ tMs, ...rest }) => rest), [
    { name: 'load-/storages/:id/runs/:id', screenshot: { path: `${run}/checkpoints/00.png` }, snapshot: { path: `${run}/checkpoints/00.json` } },
    { name: 'caption-open-the-run-and-compare-all-of-its-six', screenshot: { path: `${run}/checkpoints/01.png` }, snapshot: { path: `${run}/checkpoints/01.json` } },
  ]);
  assert.ok(uploaded.every(({ tMs }) => Number.isInteger(tMs) && tMs >= 0));
  assert.ok(uploaded[0].tMs <= uploaded[1].tMs);
  assert.deepEqual(upload.checkpoints.map((c) => c.screenshot), ['fake png bytes', 'fake png bytes']);
});

test('load checkpoints: query and hash dropped, UUIDs, digit runs and long ids as :id, repeats numbered', async () => {
  const h = await start({ root: freshRoot(), record: false, mode: 'test', ...withCore() });
  for (const path of [
    '/',
    RUN_PATH,
    '/v/AbCdEfGh1234567890xyz',
    '/docs/getting-started-guide', // long, but no digit: a page, not an id
    '/users/42/settings',
    '/a/build_2024-10-24T12/b',
    '/?next=/runs/1',
  ]) await h.loadApp(path);
  await h.loadUrl('http://localhost:4000/share/0a1b2c3d4e5f6a7b8c9d#t=3');
  await h.caption('Hello, world');
  await h.caption('Hello — world!');
  await h.caption('Привет'); // nothing of [a-z0-9] is left
  await h.caption(''); // clears the bar; not a moment worth keeping

  assert.deepEqual(calls('log.checkpoint').map(([, name]) => name), [
    'load-/',
    'load-/storages/:id/runs/:id',
    'load-/v/:id',
    'load-/docs/getting-started-guide',
    'load-/users/:id/settings',
    'load-/a/:id/b',
    'load-/#2',
    'load-/share/:id',
    'caption-hello-world',
    'caption-hello-world#2',
    'caption-caption',
  ]);
  // Names are made unique by core's rule, against every name taken so far.
  const [, existing, requested] = calls('uniqueCheckpointName').at(-1);
  assert.equal(requested, 'caption-caption');
  assert.equal(existing.length, 10);
});

test('demo mode checkpoints: overlays hidden for the screenshot only, unique names, failures reported', async () => {
  const root = freshRoot();
  const h = await start({ root, record: false, autoCheckpoints: true, ...withCore({ apiKey: 'siw_test', storage: 'ci' }) });
  const shot = ['log.checkpoint', 'captureStructure', 'page.evaluate', 'page.screenshot', 'page.waitForTimeout'];

  // A demo load is checkpointed after the card has lifted, so the card never blinks.
  let mark = globalThis.__harnessTest.calls.length;
  await h.loadApp('/runs/42', 'main', { title: 'A run' });
  assert.deepEqual(callsSince(mark, shot).map(([n, a]) => [n, a]), [
    ['page.evaluate', 'showCard'],
    ['page.evaluate', 'loadFrame'],
    ['page.waitForTimeout', 900],
    ['page.evaluate', 'hideCard'],
    ['page.waitForTimeout', 400],
    ['log.checkpoint', 'load-/runs/:id'],
    ['captureStructure', `${APP_URL}/runs/42`],
    ['page.evaluate', 'setOverlaysHidden'],
    ['page.screenshot', { type: 'png' }],
    ['page.evaluate', 'setOverlaysHidden'],
  ]);
  assert.deepEqual(evaluated().filter(([fn]) => fn === 'setOverlaysHidden'), [['setOverlaysHidden', true], ['setOverlaysHidden', false]]);

  // A demo caption is drawn, checkpointed, then held.
  mark = globalThis.__harnessTest.calls.length;
  await h.caption('Saved!');
  assert.deepEqual(callsSince(mark, shot).map(([n, a]) => [n, a]), [
    ['page.evaluate', 'setCaption'],
    ['log.checkpoint', 'caption-saved'],
    ['captureStructure', `${APP_URL}/runs/42`],
    ['page.evaluate', 'setOverlaysHidden'],
    ['page.screenshot', { type: 'png' }],
    ['page.evaluate', 'setOverlaysHidden'],
    ['page.waitForTimeout', 2400],
  ]);

  const first = await h.checkpoint('saved');
  assert.deepEqual({ ...first, tMs: 0 }, { name: 'saved', ordinal: 2, tMs: 0, captured: true });
  assert.ok(Number.isInteger(first.tMs) && first.tMs >= 0);

  // screenshot: false takes the snapshot alone and leaves the overlays alone.
  mark = globalThis.__harnessTest.calls.length;
  const second = await h.checkpoint('saved', { screenshot: false });
  assert.equal(second.name, 'saved#2');
  assert.equal(second.captured, true);
  assert.deepEqual(callsSince(mark, shot).map(([n]) => n), ['log.checkpoint', 'captureStructure']);

  // A failed capture is one stderr line and captured: false; the overlays come back.
  globalThis.__harnessTest.screenshotError = 'Target page has been closed';
  const { value: third, lines } = await captureConsole(() => h.checkpoint('saved'));
  globalThis.__harnessTest.screenshotError = null;
  assert.deepEqual({ ...third, tMs: 0 }, { name: 'saved#3', ordinal: 4, tMs: 0, captured: false, reason: 'Target page has been closed' });
  assert.deepEqual(lines, ['error: checkpoint failed: saved#3: Target page has been closed']);
  assert.deepEqual(evaluated().filter(([fn]) => fn === 'setOverlaysHidden').at(-1), ['setOverlaysHidden', false]);

  globalThis.__harnessTest.captureError = 'Execution context was destroyed';
  const { value: fourth, lines: lines4 } = await captureConsole(() => h.checkpoint('gone'));
  globalThis.__harnessTest.captureError = null;
  assert.equal(fourth.captured, false);
  assert.deepEqual(lines4, ['error: checkpoint failed: gone: Execution context was destroyed']);

  await captureConsole(() => h.finish());
  const dir = `${root}/recordings/demo/run/checkpoints`;
  assert.deepEqual(filesUnder(dir), ['00.json', '00.png', '01.json', '01.png', '02.json', '02.png', '03.json']);
  const [[, upload]] = calls('uploadRunFromFiles');
  assert.deepEqual(upload.spec.checkpoints.map(({ tMs, ...rest }) => rest), [
    { name: 'load-/runs/:id', screenshot: { path: `${dir}/00.png` }, snapshot: { path: `${dir}/00.json` } },
    { name: 'caption-saved', screenshot: { path: `${dir}/01.png` }, snapshot: { path: `${dir}/01.json` } },
    { name: 'saved', screenshot: { path: `${dir}/02.png` }, snapshot: { path: `${dir}/02.json` } },
    { name: 'saved#2', snapshot: { path: `${dir}/03.json` } },
    { name: 'saved#3' },
    { name: 'gone' },
  ]);
});

test('checkpoints past the 30th are logged but neither captured nor uploaded', async () => {
  const h = await start({ root: freshRoot(), record: false, mode: 'test', ...withCore({ apiKey: 'siw_test', storage: 'ci' }) });
  const answers = [];
  for (let i = 0; i < 31; i++) answers.push(await h.checkpoint(`step ${i}`, { screenshot: false }));
  assert.ok(answers.slice(0, 30).every((a) => a.captured));
  assert.deepEqual({ ...answers[30], tMs: 0 }, { name: 'step 30', ordinal: 30, tMs: 0, captured: false, reason: 'checkpoint limit (30) reached' });
  assert.equal(calls('log.checkpoint').length, 31);
  assert.equal(calls('captureStructure').length, 30);
  await captureConsole(() => h.finish());
  assert.equal(calls('uploadRunFromFiles')[0][1].spec.checkpoints.length, 30);
});

test('without core: checkpoint() keeps the name only (captured: false) and writes nothing', async () => {
  const root = freshRoot();
  const h = await start({ root, mode: 'test' });
  const first = await h.checkpoint('saved');
  assert.deepEqual({ ...first, tMs: 0 }, { name: 'saved', tMs: 0, captured: false, reason: '@showitworks/core not installed' });
  assert.ok(Number.isInteger(first.tMs) && first.tMs >= 0);
  assert.equal((await h.checkpoint('saved')).name, 'saved#2');
  await h.caption('Saved'); // an auto-checkpoint, kept as a name only
  await h.loadApp('/runs/1');
  assert.equal(calls('page.screenshot').length + calls('page.mainFrame').length, 0);
  assert.deepEqual(evaluated(), [['setOverlaysHidden', true], ['loadFrame', `${APP_URL}/runs/1`]]);
  const { lines } = await captureConsole(() => h.finish());
  assert.deepEqual(lines, []);
  assert.deepEqual(filesUnder(root), ['recordings/demo/take.webm']);

  // Demo mode without core: a checkpoint touches neither the page nor the disk.
  globalThis.__harnessTest = { calls: [], uploadError: null };
  const demo = await start({ root: freshRoot(), record: false });
  assert.equal((await demo.checkpoint('x')).captured, false);
  assert.deepEqual(evaluated(), []);
});

test('an unknown mode is refused before anything starts', async () => {
  await assert.rejects(start({ root: freshRoot(), mode: 'fast' }), { message: `createHarness mode must be 'demo' or 'test', not "fast"` });
  assert.deepEqual(globalThis.__harnessTest.calls, []);
});

test('loadShowItWorks: explicit dir, then $EVIDENCE_SHOWITWORKS, then bare import, then cwd', async () => {
  const base = join(TMP, 'order');
  const explicit = join(base, 'explicit');
  const fromEnv = join(base, 'env');
  const cwd = join(base, 'cwd');
  const empty = join(base, 'empty');
  cpSync(FAKE_CORE, explicit, { recursive: true });
  cpSync(FAKE_CORE, fromEnv, { recursive: true });
  cpSync(FAKE_CORE, join(cwd, 'node_modules/@showitworks/core'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{}');
  mkdirSync(empty, { recursive: true });
  const notAPackage = mkdtempSync(join(base, 'not-a-package-'));
  // A copy of the harness with core installed beside it: its bare import resolves.
  const withBare = await copyHarness(join(base, 'bare'), { withCore: true });
  const bareCore = join(base, 'bare/node_modules/@showitworks/core');

  const from = async (load, dir) => {
    const found = await load(dir);
    return found && fileURLToPath(found.core.location);
  };

  try {
    process.chdir(cwd);
    process.env.EVIDENCE_SHOWITWORKS = fromEnv;
    assert.equal(await from(withBare.loadShowItWorks, explicit), join(explicit, 'index.js'));
    assert.equal(await from(withBare.loadShowItWorks), join(fromEnv, 'index.js'));
    // A candidate that is not a usable package is skipped, not fatal.
    assert.equal(await from(withBare.loadShowItWorks, notAPackage), join(fromEnv, 'index.js'));
    delete process.env.EVIDENCE_SHOWITWORKS;
    assert.equal(await from(withBare.loadShowItWorks), join(bareCore, 'index.js'));
    assert.equal(await from(harness.loadShowItWorks), join(cwd, 'node_modules/@showitworks/core/index.js'));
    const found = await harness.loadShowItWorks();
    assert.equal(typeof found.node.uploadRunFromFiles, 'function');
    process.chdir(empty);
    assert.equal(await harness.loadShowItWorks(), null);
    assert.equal(await harness.loadShowItWorks(notAPackage), null);
  } finally {
    process.chdir(join(TMP, 'cwd'));
  }
});
