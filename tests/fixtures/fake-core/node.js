// A stand-in for @showitworks/core/node. uploadRunFromFiles reads the files it
// is given, as the real one does, and fails when the test sets uploadError.
import { readFileSync } from 'node:fs';

const record = (...call) => globalThis.__harnessTest?.calls.push(call);

export async function collectGitMeta(options) {
  record('collectGitMeta', options);
  return { commitSha: 'abc1234', branch: 'main' };
}

export async function uploadRunFromFiles(client, spec) {
  record('uploadRunFromFiles', {
    client,
    spec,
    video: spec.video ? readFileSync(spec.video.path, 'utf8') : null,
    events: readFileSync(spec.events.path, 'utf8'),
  });
  const failure = globalThis.__harnessTest?.uploadError;
  if (failure) throw new Error(failure);
  return { run: { id: 'run_1' }, runUrl: 'https://showitworks.test/runs/run_1', eventsDropped: 0 };
}
