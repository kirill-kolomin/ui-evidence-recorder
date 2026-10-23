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
