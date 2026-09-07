# Original facial skin surface

The live skin combines original pore imagery, fine surface folds, facial colour detail, manually drawn wrinkles and an optional under-eye preset. Wrinkle gradients affect lighting as well as diffuse contact shading, so folds remain readable at portrait distance. Automatic forehead and general age wrinkles are disabled.

| Asset | Purpose |
| --- | --- |
| `cheek-skin-v2.png` | Irregular follicular pores and relative complexion variation |
| `microfold-skin-v1.png` | A weaker secondary normal layer, concentrated on forehead and around eyes |
| `face-colour-v1.png` | Original front-projected facial colour and fine surface detail |
| `anatomy-fine-v1.png` | Lip detail; its fixed eye and forehead creases are excluded |
| `anatomy-age-v1.png` | Original authored study; its fixed creases are no longer sampled by the live renderer |
| `anatomy-v1.json` | Coordinate bounds and channel encoding for the crease maps |

New cases start at Age 30 and Micro Relief 50 with no drawn wrinkles and the under-eye preset off. Age changes complexion, not wrinkle placement. Under **Skin → Skin Texture & Aging → Draw Wrinkles**, enable painting and drag to draw a fold. **Fold Width** and **Brush Strength** apply to subsequent strokes; **Drawn Wrinkle Intensity** adjusts all existing drawn folds (default 100). Eraser, Undo and Clear affect the manual layer only.

**Under-eye Wrinkle Preset** has its own enable switch and intensity (default 50, initially disabled). Switching it off preserves the selected intensity. It is independent of age and manual drawing. Skin reset restores these defaults; Clear removes painted wrinkles. The old `wrinkleDepth` case field now controls drawn intensity, so previously saved values are retained without reintroducing the automatic forehead pattern.

Under-eye folds now use a shared 1024 × 512 gradient/depth atlas generated once by `SkinShader.getUnderEyeMap()`. It adapts the authored trough/shoulder curves into eye-local coordinates: the nearest crease is 0.060 model units below the eye centre, with tighter fold spacing and fine crease depth increased from 0.00065 to 0.0021 at full intensity. `EyeSystem` supplies each rendered eye's centre in head-mesh space, relative scale and frontal tilt. The shader samples current mesh positions for this layer; pores, lips and manual strokes retain their existing attachment. Position changes and morphs update immediately without rebuilding the skin maps or saving extra coordinates in a case. This atlas is also the missing-image fallback, avoiding stationary duplicate folds in the macro normal map.

The replacement brush records continuous paths in mesh UV space with rest-space surface metrics. Each path produces a tapered Gaussian trough with soft raised shoulders, using the same shape profile as the Blender-authored forehead folds. Depth does not accumulate with pointer event count. A separate 2048px gradient/depth texture keeps brush detail independent of the macro-map quality tier; it is allocated on first use. Mouse capture and cancellation release camera controls correctly. Commands make undo and version-2 case serialization compact; older sparse brush maps are imported. The old format omitted resolution, so legacy maps default to 512 unless their indices imply a larger grid; new saves carry explicit metadata.

The face-colour image was generated from a render of this project's own head, with its silhouette and feature positions preserved. It is used only for relative colour: broad luminance and average colour are removed before projection from a fixed authoring camera. Its forehead and under-eye regions are excluded so baked lines do not remain when wrinkles are off. The layer fades toward side-facing surfaces, where seamless triplanar skin remains active. It is an artistic colour/detail layer, not a calibrated albedo or displacement scan.

The studio key uses a broad variance shadow filter. This softens the former diagonal cast-shadow edge on the neck while retaining shadows under the nose and chin. The outdoor light uses a narrower filter.

## Editable Blender study

`art/skin/skin-surface-v1.blend` contains a subdivided copy of the existing head, an editable mature-crease shape key, a packed high-resolution crease height layer, packed original pore imagery, a node-based skin material, soft area lights and a camera. It is a skin-surface study, without the app's separate eyes, hair and accessories. The app continues to use its original morph-compatible mesh; the Blender study is not substituted for that mesh.

Rebuild the crease maps and study with:

```powershell
& 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe' --background --factory-startup --python scripts/build-skin-surface.py
```

The builder authors tapered curved height fields with a trough and soft raised shoulder, then encodes their gradients and depth. PNG alpha stays opaque to prevent browser premultiplication of data channels. The same fields drive the Blender shape key. The native Blender material is separately editable; it is not a pixel-identical implementation of the live Three.js shader.

## Runtime pore detail

Active asset: `cheek-skin-v2.png`, generated with the built-in imagegen tool on 2026-09-06. Source resolution: 1254 x 1254 pixels. The asset ships locally; no API key or image service is needed at runtime.

The live renderer imports the image into two 1024 x 1024 linear RGBA data textures once per session:
- A: surface normal XY, a pore-depression mask and broader complexion variation.
- B: relative RGB complexion variation and fine pigment contrast.

The source's average beige tone is removed; the selected complexion still sets skin colour. Periodic edge blending prevents visible tile seams. Rest-position triplanar mapping keeps pores attached during morphs and avoids compressed nose UVs. The tile covers about 48 mm using the project's 100 mm/model-unit convention. This is an artistic scale, not anatomical calibration. Ageing, painted wrinkles and marks continue to use the existing controls.

For full-face viewing, a band of broader colour variation is extracted from the same image and stored in A's alpha channel. It survives texture filtering at portrait size while the original pore scale stays fixed. It changes diffuse colour rather than adding shine or deeper bumps, and fades on low-pore areas such as the lips. The pore image uses two detail textures; microfold, face-colour, lip anatomy and eye folds use four shared samplers, and the manual brush uses one independent map. Source image processing and eye-atlas generation run once on load; painting updates only the affected CPU region before uploading the brush map.

Generated detail and contrast-derived normals are cosmetic approximations, not measured subject skin or validation of identification accuracy. This change covers the live Three.js renderer and its image/video captures. Unbaked 3D exports do not inherit this custom shader. The existing eye geometry and hair assets also limit the realism of the complete head.

If the asset cannot load, deterministic procedural detail remains active. Slider updates reuse the loaded textures. Existing cases retain their selected complexion and texture parameters.

Restart the app after updating the files. Use Photoreal mode; the Micro Relief slider controls pore depth.

The studio lighting uses a moderate neutral key, gentle fill and subdued rim lights. Skin has restrained specular, clearcoat and sheen layers, with broader, dimmer environment reflections and increased surface roughness. Bloom is off and contrast is neutral to retain shadow detail. Shared material settings persist through skin regeneration and render-mode changes.

## Verification

- `npm run ui:verify`: UI contracts.
- `npm run face:verify`: Electron rendering, skin controls, capture parity and quality tiers.
- `node scripts/skin-detail-probe.mjs`: headless Chromium checks and renders, including spatial detail contrast at full-face framing in 1000px and 520px viewports, absence of automatic forehead wrinkles, neck-shadow edge softness, close-up detail, light/deep complexions, seams and morph attachment.
- `node scripts/wrinkle-brush-probe.mjs`: real mouse strokes, visible fold profiles, the forehead centre seam, intensity, under-eye isolation, erasing, undo/clear, JSON round-trip, quality changes, pointer cancellation, event-density independence and legacy import. Add `--missing` to repeat without the source images.
- `node scripts/under-eye-probe.mjs`: Electron render checks for lid placement, stronger fine creases, live eye movement and morphs, size/tilt, head rotation, zero/half/full intensity and case restoration.
- `node scripts/skin-detail-probe.mjs --missing`: fallback with all external skin images unavailable.
- `node scripts/face-probe.mjs scripts/verify/skin-app`: full-app renders.

The headless probe uses installed Chrome/Edge or `CHROME_PATH`, requires no backend, and creates no case. Output goes into ignored `scripts/verify/`; `--label=name` selects a named capture directory. The optional `--before` comparison requires local baseline JS copies in `scripts/verify/skin-baseline/`.

## Final generation prompt

Built-in imagegen, new-image mode:

```text
Use case: photorealistic-natural
Asset type: original 3D facial skin diffuse texture, one square tile, highest available detail.
Create a photographic macro close-up of genuine-looking bare HUMAN FACIAL CHEEK SKIN. The frame covers a 4 centimetre square of an adult cheek. Only skin fills every pixel, viewed straight-on, all in focus. Hundreds of naturally irregular follicle openings: little round and elliptical slightly darker pores, unevenly spaced, with very subtle reddish rims and smooth transitions. Most of the skin between pores is soft and quite smooth; a few faint short microfolds, but NO continuous network of grooves. Include delicate natural variation in pale brown melanin and faint pink capillary colour at several scales, slight dry versus oily irregularities without shine. It must look like unretouched human facial skin photographed from life, not a procedural surface, not hand skin, leather, orange peel, reptile scales, foam, sand or cracked clay. Pores should be visibly recognizable small depressions surrounded by otherwise supple smooth skin, not raised bumps or polygonal cells.
Neutral medium-light warm beige complexion with some tiny rose-tinted follicular openings and gentle muted variations. Uniform cross-polarized diffuse illumination, evenly exposed with no directional highlights or shadows. This is a texture/albedo image, NOT a portrait or a 3D render. Opposite edges tile seamlessly with no distinctive feature at the border. No recognizable facial feature, eyes, nose, lips, hair, stubble, freckles, moles, acne, scars, lesions, text, labels, borders, watermarks or multiple panels. Avoid regular spacing, repeated grid, high-contrast red patches, deep wrinkles and any plastic or airbrushed surface.
```
