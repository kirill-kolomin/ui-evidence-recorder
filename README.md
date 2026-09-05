# ui-evidence-recorder

An [Agent Plugin](https://agent-plugins.org/) that teaches an AI coding agent to
record **watchable** evidence videos of a web app instead of raw, unreadable
Playwright screencasts.

A plain screencast opens on a blank page while the app boots, clicks land with no
visible pointer, and nothing says what is being demonstrated. This plugin supplies
both the technique and the code: a studio page that never navigates and hosts the
overlays, plus a driver with a drawn cursor, highlight rings, a narration bar,
title cards and severity-coloured notes.

## Contents

```
ui-evidence-recorder/
├── plugin.json
└── skills/
    └── record-ui-evidence/
        ├── SKILL.md
        ├── scripts/
        │   ├── harness.mjs     # the driver, project-agnostic
        │   └── wrapper.html    # the studio page
        └── references/
            ├── api.md          # every option and helper
            └── pitfalls.md     # the failures behind each design decision
```

## Install

Clone or copy this directory, then point your client at it the way that client
documents for loading local plugins.

## Use it directly

The harness works without the skill, from inside any project that has Playwright
installed:

```js
import { createHarness } from './ui-evidence-recorder/skills/record-ui-evidence/scripts/harness.mjs';

const h = await createHarness({ scenario: 'demo', appUrl: 'http://localhost:3000' });
await h.loadApp('/');
await h.caption('Here is the thing that used to be broken.');
await h.click(h.app.getByRole('button', { name: 'Save' }), 'save');
console.log(await h.finish());
```

Playwright is resolved from the consuming project, so nothing needs installing here.

## Licence

MIT — see `LICENSE`.
