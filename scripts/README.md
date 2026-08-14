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
