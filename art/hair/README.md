# Hair and beard strand review

Open [review.html](review.html) to compare the first texture update with the new
strand geometry. Seven representative styles use the same camera and colour in
the production Electron renderer. The comparison omits the separate eyes and
eyebrows to keep the hair visible.

All 14 hairstyles, six beards and the moustache now render curved fibres with
independent lengths, tapered tips, subtle flyaways and directional highlights.
Beard 1's continuous foundation grows shorter hairs across its surface. Facial
hair uses separate strand counts so a moustache does not become a solid block.
The 21 individual pigment atlases from the first pass remain in use.

Restart the app to load the renderer changes. Colour, tint painting, density and
placement controls remain available. The original GLBs supply shape guides and
alignment bounds; some clump outlines and scalp intersections remain visible.
The separate Blender render/export pipeline does not use this viewport groom.

[validation.json](validation.json) records the Electron checks: all 21 styles,
finite geometry, valid tangents, shadow materials, colour variants, density,
deterministic regeneration, bounded geometry caching and tint painting. In-flight
loads are also checked when selecting bald or no beard. The UI verifier passes
all 15 checks.

Run `node scripts/hair-texture-probe.mjs` for Chromium or add `--electron` for
local desktop loading. `--missing` checks missing-image fallback; `--portrait`
adds eyes and eyebrows. `node scripts/build-hair-review.mjs` rebuilds this review
from the saved first-pass captures and current desktop captures in the ignored
`scripts/verify/` directory.

Original texture images and exact imagegen prompts are documented in
[assets/textures/hair](../../assets/textures/hair/README.md).
