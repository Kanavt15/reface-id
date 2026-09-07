# Hair and beard fibre atlases

Each of the 14 hairstyles, six shipped beards and the moustache has a separate
`<style>-fibres-v2.png` atlas, created with the built-in imagegen tool. Exact
prompts and filenames are recorded in `provenance.json`. They depict synthetic
human hair rather than measurements from a particular person.

The four columns contain pale fibres on black. The app supplies the selected
hair colour. `StrandShading.js` packs each image with a seeded fibre layout at
1024 x 1024; an immediate procedural fallback works while images load or when
one is missing. Four texture sets are cached with the selected styles retained.

The current viewport uses `HairStrands.js` to reconstruct many small, curved
ribbons along the imported cards. Repaired card UVs guide that reconstruction,
including Hair 7 and Hair 14's collapsed original UVs. Roots and tips vary between
fibres, with tapered diameters and small departures from the guide surface.
Beard 1's continuous foundation is sampled across its surface to grow shorter
hairs. Each facial-hair style has its own strand budget.

The original geometry and bounds remain cached as guides. The visible fibres
have new positions and topology. Two generated grooms are retained, with evicted
GPU buffers disposed; rebuilding a style is deterministic. Tint painting clones
the visible geometry and leaves the cached groom untouched.

Per-fibre tangents drive cylindrical diffuse lighting and shifted directional
highlights. The style's atlas supplies subtle pigment detail; it no longer cuts
holes in the fibres. Fine ribbons face the camera with a small minimum pixel
width to remain visible at portrait distance. The density control removes whole
fibres while surviving hairs stay solid and write depth. Dedicated depth and
distance materials apply the same density selection in shadows.

Images are local and included by the existing `assets/**/*` packaging rule.
`HairSystem.whenIdle()` waits for model loading and selected texture readiness.

This update applies to the Three.js viewport. The separate Blender render/export
builders still use the original models. Source guide shapes and head fitting
continue to limit realism in some close-ups; this is an approximate real-time
groom, not a photographic or physically measured hair simulation.

See [art/hair/review.html](../../../art/hair/review.html) for comparisons and
[art/hair/README.md](../../../art/hair/README.md) for validation commands.
