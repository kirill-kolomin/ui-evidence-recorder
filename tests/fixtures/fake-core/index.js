// A stand-in for @showitworks/core's main entry. Calls are recorded into
// globalThis.__harnessTest.calls; `location` tells a test which copy loaded.
// captureStructure throws when the test sets __harnessTest.captureError.
const record = (...call) => globalThis.__harnessTest?.calls.push(call);

export const location = import.meta.url;

export function createEventLog(options) {
  record('createEventLog', options);
  const events = [];
  let checkpoints = 0;
  return {
    console: (level, text, frame) => events.push({ type: 'console', level, text, frame }),
    pageError: (text) => events.push({ type: 'pageerror', text }),
    network: (method, url, status) => events.push({ type: 'network', method, url, status }),
    checkpoint(name, at) {
      record('log.checkpoint', name, at);
      const ordinal = checkpoints++;
      events.push({ type: 'checkpoint', name, ordinal });
      return ordinal;
    },
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

export async function captureStructure(frame, options) {
  record('captureStructure', frame.url(), options);
  const failure = globalThis.__harnessTest?.captureError;
  if (failure) throw new Error(failure);
  return { v: 1, url: frame.url(), testIdAttribute: options.testIdAttribute, elements: [] };
}

export function serializeSnapshot(snapshot) {
  return JSON.stringify(snapshot);
}

/** The real rule without the scrubbing: `name`, or `name#2`, `name#3`, ... */
export function uniqueCheckpointName(existing, name) {
  record('uniqueCheckpointName', [...existing], name);
  const taken = new Set(existing);
  const base = String(name) || 'checkpoint';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}#${n}`)) return `${base}#${n}`;
}
