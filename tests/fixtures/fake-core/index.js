// A stand-in for @showitworks/core's main entry. Calls are recorded into
// globalThis.__harnessTest.calls; `location` tells a test which copy loaded.
const record = (...call) => globalThis.__harnessTest?.calls.push(call);

export const location = import.meta.url;

export function createEventLog(options) {
  record('createEventLog', options);
  const events = [];
  return {
    console: (level, text, frame) => events.push({ type: 'console', level, text, frame }),
    pageError: (text) => events.push({ type: 'pageerror', text }),
    network: (method, url, status) => events.push({ type: 'network', method, url, status }),
    checkpoint: () => 0,
    setVideoOffset: () => {},
    toJSONL: () => `${[{ type: 'header', ...options }, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`,
  };
}

export function attachCapture(context, log, options) {
  record('attachCapture', options);
  const onConsole = (message) => log.console(message.type(), message.text(), message.location?.()?.url);
  const onRequest = (request) => log.network(request.method(), request.url(), 200);
  context.on('console', onConsole);
  context.on('requestfinished', onRequest);
  return function detach() {
    record('detach');
    context.off('console', onConsole);
    context.off('requestfinished', onRequest);
  };
}

export function createClient(options) {
  record('createClient', options);
  return { fake: true };
}
