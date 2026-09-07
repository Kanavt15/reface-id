# Interface build pipeline

`src/renderer/index.html` is **generated**. Edit the generator, not the HTML —
a hand edit is lost the next time anyone runs the build.

```
index.legacy.html ──▶ extract-ui-manifest.js ──▶ ui-manifest.json
                                                       │
                              components in build-ui.js ▼
                                                  index.html
                                                       │
                                                 verify-ui.js
```

## Commands

| command | what it does |
|---|---|
| `npm run ui:build` | render `ui-manifest.json` through the components → `index.html` |
| `npm run ui:verify` | prove every binding the engine relies on still resolves |
| `npm run ui` | build + verify |
| `npm run ui:smoke` | launch the app, drive intake → editor, report console errors |
| `npm run ui:workbench` | drive the working layer — typing a value, undo, revert, filter, the bench, the mode banner, sheet resize |
| `npm run test:snapshots` | launch the app **twice**, capture snapshots in the first run and read them back in the second |
| `npm run ui:vendor` | re-copy libraries, fonts and the icon sprite from `node_modules` |
| `npm run ui:extract` | re-read the control inventory from `index.legacy.html` |

## Why a manifest

The interface was rebuilt from scratch; the ~232 KB of application logic in
`UIController.js` was not. That logic reaches into the DOM in 588 places and
resolves 270 element ids, so the seam between the two is large and entirely
implicit.

`extract-ui-manifest.js` reads the old document once and records what each
control *is* — parameter name, range, option list, swatch values, element id —
with nothing about how it used to look. `build-ui.js` then renders that data
through a new component set. The inventory is preserved exactly; the
presentation shares nothing with what came before.

`index.legacy.html` is kept for two reasons: the extractor reads it, and
`verify-ui.js` uses it to catch ids that reach the DOM indirectly (a string
passed to a constructor, for example) which no amount of scanning
`getElementById` calls would find.

## Making a change

- **New control, or a changed range/label** → edit `ui-manifest.json`, then
  `npm run ui`.
- **Changed appearance of a control** → edit the component in `build-ui.js`
  and/or the CSS in `src/renderer/styles/`, then `npm run ui`.
- **Changed shell** (command bar, stage, sheet, status strip, overlays) → edit
  the `doc` template at the bottom of `build-ui.js`, then `npm run ui`.
- **New icon** → add it to `ICONS` in `vendor-assets.js`, run `npm run ui:vendor`,
  then `npm run ui` (the sprite is inlined at build time).

Always finish with `npm run ui:verify`. It is the only thing standing between a
markup change and a control that silently stops doing anything.

## Before you rebuild: check for hand edits

`index.html` being generated is a rule, not a mechanism — nothing stops an
edit, and the loss only shows up the next time someone runs the build. It has
already happened once: the asymmetry morph, the micro-relief slider, the cheek
flush toggle, the render-mode and quality buttons and six `<script>` tags were
all added straight to the generated file, and a rebuild silently deleted every
one of them.

So before the first build in a while, prove the generator still reproduces what
is committed:

```sh
git stash                     # if you have generator changes in flight
node scripts/build-ui.js
git diff --stat src/renderer/index.html
```

An empty diff means the generator is the source of truth and you can work
normally. Anything else is a hand edit that has to be folded back in first —
into `ui-manifest.json` if it is a control, into the `doc` template in
`build-ui.js` if it is shell or a script tag — or it is about to be lost.

`npm run ui:verify` catches the subset of these that the JS names by id (that
is how the three missing controls were found), but it cannot see a hand-added
element nothing looks up by id.

## The working layer

`src/renderer/js/k-workbench.js` loads after `k-shell` and `k-palette` and owns
what happens to a control once you have found it: typing an exact value into
the readout, reverting one parameter, pinning to the bench, filtering the
section, and the banner that names a latched tool.

It never edits the subject itself. A value set from code is delivered by
writing the control and dispatching the same event sequence a real drag
produces (`mousedown` → `input` → `change` → `mouseup`), because the undo
stack, the activity log and the case record are all built out of those events.
Firing only `input` applies the change and leaves it unundoable.

Two rules it depends on:

- **Edited means the operator moved it**, not "differs from the markup". The
  hair, eye and skin systems write their own starting values into sliders as
  their assets arrive, so any fixed-time baseline is a race. A hand on a
  control raises a *trusted* `input` event; an engine write is a property
  assignment that raises nothing.
- **Pinning moves the real node**, it does not clone it. A clone would be a
  second element for one parameter with none of UIController's listeners. A
  hidden placeholder holds the seat so unpinning restores it exactly.

## Verifier checks

1. every id resolved by `getElementById` in `src/renderer/js/` exists
2. every literal selector passed to `querySelector(All)` matches something
   (runtime-built UI is whitelisted explicitly)
3. ids that were in the previous document and are still named in the JS are
   still present — catches indirect references
4. collapse headers are immediately followed by their body
5. group bodies wrap a single child (required by the `0fr`/`1fr` height
   transition)
6. every morph slider has `data-param`, a range input and a `.slider-value`
7. section tabs and panels correspond one-to-one, exactly one starts active
8. reset buttons are scoped inside a `.control-group`
9. every `<use href="#i-…">` resolves against the inlined sprite
10. no references to removed stylesheets, scripts, or CDN assets
11. every referenced local file exists
