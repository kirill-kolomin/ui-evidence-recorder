/**
 * A stand-in for Playwright, passed to createHarness as `playwrightPath`. It
 * records every call the harness makes into globalThis.__harnessTest.calls and
 * lets a test emit context events. The "video" is a small real file written on
 * close, as Playwright does, so an upload can read it.
 *
 * page.evaluate is recorded as ['page.evaluate', <the window function the
 * evaluated code calls, e.g. 'setCaption'>, arg]. Loading a URL into the studio
 * iframe makes page.frames() report an app frame with that URL. Set
 * __harnessTest.counts[selector] to change what locator.count() answers
 * (default 1) and __harnessTest.screenshotError to make page.screenshot() throw.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const record = (...call) => globalThis.__harnessTest.calls.push(call);

/** An app element: everything the harness does with a located target. */
const target = (selector) => ({
  async waitFor(options) {
    record('locator.waitFor', selector, options);
  },
  async scrollIntoViewIfNeeded() {
    record('locator.scrollIntoViewIfNeeded', selector);
  },
  async boundingBox() {
    record('locator.boundingBox', selector);
    return { x: 100, y: 200, width: 80, height: 40 };
  },
  async click() {
    record('locator.click', selector);
  },
  async pressSequentially(text, options) {
    record('locator.pressSequentially', selector, text, options);
  },
});

const locator = (selector) => ({
  first: () => target(selector),
  async count() {
    record('locator.count', selector);
    return globalThis.__harnessTest.counts?.[selector] ?? 1;
  },
  async fill(value) {
    record('locator.fill', selector, value);
  },
});

export const chromium = {
  async launchPersistentContext(profileDir, options) {
    record('launchPersistentContext', profileDir, options);
    const videoFile = options.recordVideo ? join(options.recordVideo.dir, 'take.webm') : null;
    const listeners = new Map();
    let studioUrl = 'about:blank';
    let appFrameUrl = null;
    const studioFrame = { url: () => studioUrl };

    const page = {
      async goto(url, opts) {
        record('page.goto', url, opts);
        studioUrl = url;
      },
      async evaluate(fn, arg) {
        const source = String(fn);
        record('page.evaluate', source.match(/window\.(\w+)/)?.[1] ?? source, arg);
        if (source.includes('window.loadFrame')) appFrameUrl = arg;
      },
      async waitForTimeout(ms) {
        record('page.waitForTimeout', ms);
      },
      mouse: {
        async move(x, y, options) {
          record('mouse.move', x, y, options);
        },
      },
      async screenshot(options) {
        record('page.screenshot', options);
        const failure = globalThis.__harnessTest.screenshotError;
        if (failure) throw new Error(failure);
        return Buffer.from('fake png bytes');
      },
      mainFrame() {
        record('page.mainFrame');
        return studioFrame;
      },
      frameLocator(selector) {
        record('page.frameLocator', selector);
        return {
          locator(inner) {
            record('app.locator', inner);
            return locator(inner);
          },
        };
      },
      frames: () => [studioFrame, ...(appFrameUrl ? [{ url: () => appFrameUrl }] : [])],
      video() {
        record('page.video');
        if (!videoFile) return null;
        return {
          async path() {
            record('video.path');
            return videoFile;
          },
        };
      },
    };

    const context = {
      pages() {
        record('context.pages');
        return [page];
      },
      async newPage() {
        record('context.newPage');
        return page;
      },
      async clearCookies() {
        record('context.clearCookies');
      },
      on(event, listener) {
        record('context.on', event);
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
        return context;
      },
      off(event, listener) {
        record('context.off', event);
        listeners.get(event)?.delete(listener);
        return context;
      },
      /** Test-only: deliver an event to whatever the harness registered. */
      emit(event, payload) {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      },
      listenerCount: (event) => listeners.get(event)?.size ?? 0,
      async close() {
        record('context.close');
        if (videoFile) {
          mkdirSync(options.recordVideo.dir, { recursive: true });
          writeFileSync(videoFile, 'fake webm bytes');
        }
      },
    };
    return context;
  },
};
