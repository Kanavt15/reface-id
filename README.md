<div align="center">

<img src="screenshots/01-hero.png" alt="ReFace" width="960">

# ReFace

**Intelligent 3D Facial Reconstruction for forensics**

A parametric human head, 180 live parameters, and an optional AI assist,
wrapped in a case file that records every adjustment.

<br>

[![Electron](https://img.shields.io/badge/Electron-28-2b2e3a?style=flat-square&logo=electron&logoColor=9feaf9)](https://www.electronjs.org/)
[![Three.js](https://img.shields.io/badge/Three.js-r160-000?style=flat-square&logo=three.js&logoColor=fff)](https://threejs.org/)
[![Python](https://img.shields.io/badge/Flask-Python_3.10+-000?style=flat-square&logo=flask&logoColor=fff)](https://flask.palletsprojects.com/)
[![Blender](https://img.shields.io/badge/Blender-render_engine-e87d0d?style=flat-square&logo=blender&logoColor=fff)](https://www.blender.org/)
[![License](https://img.shields.io/badge/license-ISC-c4e04f?style=flat-square)](#license)

</div>

---

An investigator opens a case, describes a face, and shapes it until the witness
agrees. ReFace gives them a real 3D head to do it on: 18,097 vertices that
deform live under 180 sliders, with hair, skin, marks and worn items layered on
top, and Blender behind it for the final render.

Language models are here as a **first draft, not the product**. Describe the
subject and the assist resolves it into validated parameter values in seconds;
everything it sets is a control you can then take over by hand. The app runs
without any API key at all.

Morphing, rendering, exports and case storage stay on the machine. The only
outbound calls are to the AI provider, and only when you ask for one.

---

## Opening a case

Every session starts as a case record. The reference and name are stamped onto
every export and snapshot that follows, so nothing leaves the app unattributed.

<table>
<tr>
<td width="50%"><img src="screenshots/02-case-record.png" alt="Case record form"></td>
<td width="50%"><img src="screenshots/03-method.png" alt="Choosing a source for the likeness"></td>
</tr>
<tr>
<td><sub><b>Step 1.</b> Case reference, name, investigating officer, and the
subject description as it was given.</sub></td>
<td><sub><b>Step 2.</b> Pick any combination of sources. The editor opens on
the first one; the rest stay available throughout.</sub></td>
</tr>
</table>

Four ways in: a **spoken or typed description**, **reference photographs**,
**live capture** from a camera, or straight to the **manual editor** from the
neutral head.

---

## The workspace

<img src="screenshots/04-editor-face.png" alt="The editor">

The viewport is full-bleed and everything else floats over it: section nav
top-left, subject readout top-right, tool rail on the right edge, camera dock
bottom-centre. The control sheet is dismissible (`\`), so the render is never
more than one keystroke from filling the screen.

The status strip along the bottom reports what is actually true right now:
backend reachability, whether Blender was found, the loaded mesh, live vertex
count, and how many parameters you have moved off default.

**Seven sections** carry the whole control surface:

| Section | What lives there |
|---|---|
| **Face** | 51 sliders across skull, forehead, brows, eyes, nose, cheeks, mouth, jaw, chin and ears, plus asymmetry and direct point editing |
| **Hair** | 43 sliders: hairstyle, properties, position, colour, facial hair, eyebrows, eyelashes, tint painting |
| **Skin** | Tone, lip and eye colour, ageing and texture, age progression, skin marks, decals, demographics |
| **Wear** | 61 sliders across glasses, face masks, earrings, eyebrow piercings and bandanas |
| **Assist** | Description-to-face generation, model picker, witness variant picker |
| **Frames** | Snapshots and turntable clip recording |
| **Case** | Reference photo comparison, case metadata, save / load |

---

## Facial structure

<img src="screenshots/05-face-nose.png" alt="Nose controls">

Nine anatomical groups, each broken into the sub-regions a forensic artist
actually works in. The nose alone splits into overall, bridge, tip and nostrils.
Vertex offsets are computed in a **web worker**, so dragging a slider on a
100,000-vertex scene never blocks the interface.

<img src="screenshots/28-point-editing.png" alt="Manual point editing">

When a slider cannot get there, **manual point editing** exposes the facial
landmarks directly. Drag any handle to reshape the mesh, with an adjustable
influence radius and falloff so the surrounding surface follows smoothly.

---

## Finding a control

<img src="screenshots/06-palette.png" alt="Command palette">

180 sliders across 39 collapsible groups and 91 sub-groups is more than anyone
should have to navigate by scrolling. `Ctrl/Cmd+K` indexes every slider, style
card, colour row and tool from the live DOM. Choose a result and it switches
section, expands the groups the control is nested inside, scrolls it into view
and flashes the row.

---

## Hair and facial hair

<table>
<tr>
<td width="50%"><img src="screenshots/07-hair-styles.png" alt="Hairstyle selection"></td>
<td width="50%"><img src="screenshots/08-facial-hair.png" alt="Facial hair and eyebrows"></td>
</tr>
<tr>
<td><sub>14 hairstyle meshes plus bald, each with length, volume, density,
curl, and full position / rotation / scale fitting.</sub></td>
<td><sub>Six beards and a moustache, with independent eyebrow shape, density,
arch, spacing and tilt. 14 eyebrow controls on their own.</sub></td>
</tr>
</table>

<img src="screenshots/09-hair-tint.png" alt="Manual tint painting">

Colour is not limited to presets. **Tint painting** lets you brush greying,
sun-bleaching or root regrowth directly onto the hair, beard or eyebrows, with
brush size, strength and an eraser.

---

## Skin

<table>
<tr>
<td width="50%"><img src="screenshots/10-skin-colour.png" alt="Skin tone, lip and eye colour"></td>
<td width="50%"><img src="screenshots/11-skin-texture.png" alt="Skin texture and ageing"></td>
</tr>
<tr>
<td><sub>Eight skin tones plus a custom picker, lip colour with a manual lip
pen, and iris colour.</sub></td>
<td><sub>Age, wrinkle depth, sun damage, roughness and pore detail, with
manual wrinkle and pigmentation brushes over the top.</sub></td>
</tr>
</table>

<img src="screenshots/12-age-progression.png" alt="Age progression preview">

**Age progression** projects the current face forward by 5, 10, 15, 20 or 25
years and reverts cleanly, for long-outstanding cases where the subject has
aged since the description was taken.

---

## Marks and decals

<table>
<tr>
<td width="50%"><img src="screenshots/13-skin-marks.png" alt="Skin marks placed on the mesh"></td>
<td width="50%"><img src="screenshots/14-decals.png" alt="Image decals"></td>
</tr>
<tr>
<td><sub>Moles, pimples, scars, birthmarks and wounds, placed by clicking the
mesh. Each mark stores barycentric coordinates inside its hit triangle, so it
stays put when the face morphs underneath it.</sub></td>
<td><sub>Image decals (tattoos and skin graphics) projected onto the surface
with <code>DecalGeometry</code> so they wrap real curvature rather than floating
flat.</sub></td>
</tr>
</table>

---

## Worn items

Five accessory systems, each with its own colour, fit and per-side controls.
Every frame below is the same subject, changed only by what he is wearing.

<table>
<tr>
<td width="50%"><img src="screenshots/15-wear-glasses.png" alt="Glasses"></td>
<td width="50%"><img src="screenshots/16-wear-mask.png" alt="Face mask"></td>
</tr>
<tr>
<td><sub><b>Glasses.</b> Four frames, separate frame and lens colour,
adjustable lens opacity, arm splay and length.</sub></td>
<td><sub><b>Face mask.</b> Cloth or medical, with cheek wrap, nose coverage
and independent left / right ear-loop angle and splay.</sub></td>
</tr>
<tr>
<td><img src="screenshots/17-wear-jewellery.png" alt="Earrings and eyebrow piercing"></td>
<td><img src="screenshots/18-wear-bandana.png" alt="Bandana"></td>
</tr>
<tr>
<td><sub><b>Earrings and eyebrow rings.</b> Hoop, stud or drop in gold,
silver, rose or black, worn on either side or both, with a matte-to-mirror
polish control.</sub></td>
<td><sub><b>Bandana.</b> Dyed or left printed, with wrap width, side depth and
hem flare. Shown over a bald head.</sub></td>
</tr>
</table>

---

## Description assist

<table>
<tr>
<td width="55%"><img src="screenshots/19-assist.png" alt="AI face builder"></td>
<td width="45%"><img src="screenshots/20-assist-settings.png" alt="Generation settings"></td>
</tr>
<tr>
<td><sub>Type or dictate the description; the model returns validated morph,
hair, colouring and accessory values and the head reshapes. Reference images
can be attached, or a photo taken from the camera.</sub></td>
<td><sub>Marks generated from an image can replace yours, merge with them, or
be ignored entirely. The investigator's own placements are never silently
overwritten.</sub></td>
</tr>
</table>

Six models are selectable per request: **Claude Haiku 4.5, Sonnet 4.6, Opus 4.7,
Sonnet 5, Opus 5**, and **Gemini Flash**.

**Build with a witness** takes a different approach. Rather than asking someone
to rate a nose from one to ten, which fights how face memory works, it shows a
set of complete candidate faces and asks which is closest, then generates a new
set around that choice and narrows in. Opening a session is one AI request;
every round after a pick is jittered locally at zero cost.

---

## Working the case

<table>
<tr>
<td width="50%"><img src="screenshots/21-snapshots.png" alt="Snapshots"></td>
<td width="50%"><img src="screenshots/22-turntable.png" alt="Turntable recording"></td>
</tr>
<tr>
<td><sub><b>Snapshots.</b> Save the full face state at any point, with a
thumbnail and the case stamp, and jump back to it later. Up to 30 per
case.</sub></td>
<td><sub><b>Turntable clips.</b> Record a rotating pass straight off the WebGL
canvas. A moving view carries depth and profile that a single frame flattens
away. Duration, sweep, camera height and frame rate are all set here.</sub></td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="screenshots/23-reference-overlay.png" alt="Reference photo comparison"></td>
<td width="50%"><img src="screenshots/24-case-record.png" alt="Case record and actions"></td>
</tr>
<tr>
<td><sub><b>Reference comparison.</b> Pin a mugshot or CCTV still over the
render and blend or wipe between them. The overlay never takes a pointer event,
so you can keep orbiting and editing through it, and it never leaks into a
screenshot.</sub></td>
<td><sub><b>Case record.</b> Metadata and notes stay editable throughout, and
the whole case saves to a single file that reopens exactly as you left
it.</sub></td>
</tr>
</table>

---

## The viewport

<table>
<tr>
<td width="50%"><img src="screenshots/25-viewport-profile.png" alt="Profile view"></td>
<td width="50%"><img src="screenshots/26-wireframe.png" alt="Wireframe"></td>
</tr>
<tr>
<td><sub>Front, three-quarter, profile and top presets, with free orbit and
zoom in between.</sub></td>
<td><sub>Wireframe over the shaded surface, for reading topology while worn
items stay solid.</sub></td>
</tr>
</table>

<img src="screenshots/27-lighting.png" alt="Lighting presets">

Three lighting rigs: studio, outdoor and dramatic. A face reads differently
under each, and the witness may have seen it under only one.

Two further tools live on the rail and need a camera: **live head tracking**,
which drives the model's pose from your own head via MediaPipe Face Mesh, and
**guided capture**, which walks you through seven angles (front, both
three-quarters, both profiles, tilt up and tilt down) and sends the set to the
assist as reconstruction input. Both pull MediaPipe from a CDN, so, like the
assist itself, they need a network connection. Everything else runs offline.

---

## How it fits together

```
  Electron renderer                          Flask · 127.0.0.1:5001
  ┌────────────────────────────┐             ┌──────────────────────────┐
  │  Three.js viewport         │──── POST ──▶│  17 routes               │
  │  180 parameter controls    │             │                          │
  │  OBJMorpher ──▶ MorphWorker│◀─── JSON ───│    ai · morph · hair     │
  │  hair · eyes · accessories │             │    render · export       │
  │  marks · decals · painters │             │    case · decal · speech │
  └────────────────────────────┘             └───────────┬──────────────┘
                                                         │
                                      ┌──────────────────┴──────────────────┐
                                      ▼                                     ▼
                            ┌──────────────────┐              ┌──────────────────────┐
                            │  Claude · Gemini │              │  Blender, headless   │
                            │  (only on assist)│              │  EEVEE / Cycles      │
                            └──────────────────┘              │  render · morph      │
                                                              │  export · bake       │
                                                              └──────────────────────┘
```

Morphing runs locally in the renderer whether or not the backend is up. The
status strip says which. Blender is only reached for high-fidelity renders,
decal baking and mesh export.

**Out:** OBJ, FBX and GLB from the File menu; PNG stills; WebM turntable clips;
and the case itself as a single reloadable file.

---

## Running it

**You will need** Node 18+ and Python 3.10+. Install **Blender** as well if you
want high-fidelity renders and mesh export. The backend finds it on its own in
the standard install locations on Windows, macOS and Linux, and reports what it
found in the status strip. A Conda environment named `reface` is used if one
exists; otherwise the system `python` is.

```bash
npm install
pip install -r backend/requirements.txt
```

Configuration is optional. Every control is editable by hand without a key.

```bash
cp .env.example .env
```

```ini
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
AI_PROVIDER=anthropic          # anthropic | gemini
ANTHROPIC_MODEL=claude-opus-5  # fallback when a request names no model
```

```bash
npm run dev            # backend and Electron together
```

Or run the halves separately with `npm run start:backend` and `npm start`.

**Shortcuts.** `Ctrl/Cmd+K` command palette, `Esc` dismiss, `\` toggle the
control sheet, `Ctrl+Z` / `Ctrl+Y` undo and redo, `Ctrl+S` save case,
`Ctrl+Shift+S` export screenshot.

---

## Repository layout

```
src/
  main/            Electron main process, menu, native dialogs, preload bridge
  renderer/
    index.html     generated, see the build pipeline below
    js/            37 modules: morphing, hair, eyes, accessories, marks,
                   decals, painters, AI, cases, snapshots, capture, shell
    js/vendor/     GLB / OBJ loaders, OrbitControls, DecalGeometry
    styles/        base · shell · controls · overlays · carried
    vendor/        GSAP, Motion One, Lenis, vendored, no bundler
backend/
  server.py        Flask API, 17 routes
  blender_scripts/ headless jobs: morph, render, export, hair, decal bake
assets/
  models/          base head, hair, facial-feature and mask meshes
  Glasses/         frame models
  accessories/     bandana, earring and piercing meshes
  Hair_Previews/   hairstyle preview clips
scripts/           interface build pipeline (see scripts/README.md)
```

### The interface is generated

`src/renderer/index.html` is **built, not hand-written**. The control inventory
lives in `scripts/ui-manifest.json`; `build-ui.js` renders it through a
component set into the document, and `verify-ui.js` proves that all 270-odd
element IDs the application logic reaches for still resolve.

```bash
npm run ui          # build + verify
npm run ui:smoke    # launch the app and drive it end to end
```

Edit the manifest or the components. A hand edit to `index.html` is lost on
the next build. Full detail in [scripts/README.md](scripts/README.md).

---

## Responsible use

ReFace is built for authorised investigative work. What it produces is an
approximation assembled from a description, an investigative aid subject to
human review, never an identification and never evidence in itself. Treat the
output accordingly.

## License

ISC. See the `license` field in [package.json](package.json).

---

<div align="center">
<sub>Built by the ReFace team</sub>
</div>
