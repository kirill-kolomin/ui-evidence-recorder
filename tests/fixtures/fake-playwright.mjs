/**
 * A stand-in for Playwright, passed to createHarness as `playwrightPath`. It
 * records every call the harness makes into globalThis.__harnessTest.calls and
 * lets a test emit context events. The "video" is a small real file written on
 * close, as Playwright does, so an upload can read it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const record = (...call) => globalThis.__harnessTest.calls.push(call);

export const chromium = {
  async launchPersistentContext(profileDir, options) {
    record('launchPersistentContext', profileDir, options);
    const videoFile = options.recordVideo ? join(options.recordVideo.dir, 'take.webm') : null;
    const listeners = new Map();

    const page = {
      async goto(url, opts) {
        record('page.goto', url, opts);
      },
      frameLocator(selector) {
        record('page.frameLocator', selector);
        return {};
      },
      frames: () => [],
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
