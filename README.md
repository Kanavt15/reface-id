# REface ID — 3D Forensic Facial Reconstruction

A desktop application for **3D facial reconstruction** used in forensic and law enforcement investigations. Upgrades the traditional 2D composite sketch workflow into an interactive 3D system powered by **Blender Engine** and **Three.js**.

---

## Features

- **3D Face Morphing** — 30+ parametric controls for skull structure, facial features, jaw, chin, ears, and neck
- **Hair System** — 12 hair style presets, adjustable length/density/volume/curl, facial hair, and custom colors
- **Appearance Controls** — Skin tones, eye colors, age ranges, accessories, and demographic metadata
- **Case Management** — Save/load investigation cases (.rfc format) with full reconstruction state
- **Blender Integration** — High-quality mesh operations, particle hair, and multi-format export (OBJ/FBX/GLB)
- **Undo/Redo** — Full state history with keyboard shortcuts
- **Screenshots** — Capture viewport for reports and documentation
- **Dark Forensic UI** — Purpose-built interface for professional forensic use

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electron |
| 3D Rendering | Three.js |
| UI | HTML/CSS/JavaScript |
| Backend | Python + Flask |
| 3D Engine | Blender (bpy, background mode) |

## Setup

### Prerequisites

- **Node.js** 18+ (https://nodejs.org)
- **Python** 3.9+ (https://python.org)
- **Blender** 3.6+ (https://blender.org) — install normally, the app auto-detects the path

### Installation

```bash
# 1. Install Node dependencies
npm install

# 2. Install Python dependencies
pip install -r backend/requirements.txt

# 3. Run the application
npm start
```

### Quick Start (Development)

```bash
# Start backend + Electron together
npm run dev
```

## Project Structure

```
REface ID/
├── src/
│   ├── main/
│   │   ├── main.js              # Electron main process
│   │   └── preload.js           # Context bridge
│   └── renderer/
│       ├── index.html           # Main UI layout
│       ├── js/
│       │   ├── app.js           # App entry point
│       │   ├── SceneManager.js  # Three.js scene, camera, lighting
│       │   ├── BaseFaceGeometry.js  # Procedural head mesh
│       │   ├── FaceMorpher.js   # Real-time facial morphing
│       │   ├── HairSystem.js    # Procedural hair preview
│       │   ├── UIController.js  # DOM event handling
│       │   ├── BackendAPI.js    # Python backend communication
│       │   ├── CaseManager.js   # Case save/load/undo
│       │   └── vendor/          # OrbitControls, OBJLoader
│       └── styles/
│           ├── main.css         # Core layout & theme
│           ├── panels.css       # Panel & control group styles
│           └── controls.css     # Sliders, inputs, buttons
├── backend/
│   ├── server.py                # Flask REST API
│   ├── requirements.txt
│   └── blender_scripts/
│       ├── apply_morphs.py      # Blender morph operations
│       ├── generate_hair.py     # Blender particle hair
│       └── export_model.py      # Multi-format export
├── assets/
│   └── models/                  # Place base_face.obj here
├── package.json
└── README.md
```

## Usage Guide

### Face Reconstruction Workflow

1. **Start a new case** — Enter case number, investigator name, and witness description
2. **Sculpt the face** — Use the Face tab sliders to adjust skull structure, eyes, nose, mouth, jaw, etc.
3. **Add hair** — Select a hairstyle preset, adjust properties, choose color
4. **Set appearance** — Pick skin tone, eye color, age range, and accessories
5. **Export** — Save as OBJ/FBX/GLB for 3D printing or sharing, or take screenshots for reports
6. **Save case** — Preserves full state for later editing or courtroom presentation

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+N` | New Case |
| `Ctrl+O` | Open Case |
| `Ctrl+S` | Save Case |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `1` | Front View |
| `3` | Side View |
| `5` | 3/4 View |
| `7` | Top View |

### Loading a Custom Base Face

Place your OBJ head model as `assets/models/base_face.obj`. The app will load it automatically at startup. For best results, the model should:

- Be oriented with Y-forward, Z-up
- Have proper UV coordinates
- Include shape keys (blend shapes) for precise morphing

## Blender Integration

When Blender is installed and detected, additional capabilities unlock:

- **High-quality hair** via Blender's particle system
- **Subsurface scattering** skin materials
- **Production-quality exports** with proper materials
- **Advanced mesh operations**

The app works without Blender in preview mode using Three.js for real-time manipulation.

## License

ISC — For authorized forensic and law enforcement use.
