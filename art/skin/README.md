# Skin surface review

Current app captures (2026-09-07), with hair hidden so the surface is visible:

- [Clean starting skin](preview-clean.png): no drawn wrinkles, under-eye preset off.
- [Manually drawn forehead folds and the optional under-eye preset](preview-drawn-wrinkles.png): three real mouse strokes, brush strength 55, drawn intensity 100, under-eye intensity 65.
- [Under-eye preset only](preview-under-eye.png): no drawn wrinkles; under-eye intensity 65, with the corrected placement.
- [Eye creases at 100%](preview-under-eye-close.png): the first creases sit just below the lids; the fine folds have a stronger maximum intensity.
- [Drawing and preset controls](wrinkle-controls.png).

Restart the app and use Photoreal mode. Open **Skin → Skin Texture & Aging → Draw Wrinkles**, enable painting and drag on the face. Fold Width and Brush Strength affect new strokes; Drawn Wrinkle Intensity adjusts existing strokes. Eraser, Undo and Clear apply to drawn wrinkles. The separate **Under-eye Wrinkle Preset** starts off, has an independent intensity control, and remembers that intensity when disabled.

The forehead pattern is no longer automatic, including in older cases. Older manually painted wrinkles are imported. New cases clear the drawing and preset; saved cases restore them. The earlier `preview-default.png`, `preview-mature.png` and `preview-profile.png` are historical captures from the previous automatic-wrinkle version.

The under-eye preset follows each rendered eye's position and size, plus frontal tilt. Eye morphs update the eyes and wrinkle placement immediately while dragging. Head rotation does not slide the folds across the skin. The folds use a shared, locally generated gradient/depth map with the same tapered trough and soft shoulder profile as the authored wrinkles, so placement and intensity also work when external skin images are unavailable. The manual brush remains attached to the skin independently.

`skin-surface-v1.blend` is an editable skin study created in Blender 5.1. It contains a mature-crease shape key, a packed high-resolution crease height layer, packed original pore imagery, editable material nodes and soft studio lights. It omits the app's separate eyes, hair and accessories. Its material is separate from the live renderer and is not intended as an identical export of the viewport.

The live skin is improved, but the existing eye and hair assets still limit the complete head's photographic realism. The generated textures and authored wrinkles are cosmetic surface detail, not measured skin from a particular person.

Validation for the eye-placement update: `node scripts/under-eye-probe.mjs` checks visible fine creases, removal of the old cheek folds, rendered movement with eye controls, immediate morph updates, scale/tilt, head rotation, intensity and case restoration. The 32 Electron face/control checks, 15 UI checks and mouse-stroke checks with and without external skin images also pass. The texture/shadow checks and Blender rendering were completed in the earlier surface pass. Details and generation provenance are in `assets/textures/skin/`.
