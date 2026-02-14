# Models Folder Organization

This folder contains all 3D models used in the REface ID application, organized into subdirectories for better management.

## Folder Structure

### `/base/`
Base facial models and core assets:
- `head.glb` - Base head model
- `base_face.obj` - Base face mesh
- `base_face.mtl` - Material file for base face
- `head_regions.json` - Region mapping data
- `base_face_regions.json` - Face region definitions

### `/hair/`
Hair models (Hair1.glb through Hair12.glb):
- 12 different hair style models
- Used for head hair rendering
- GLB format with embedded materials

### `/facial/`
Facial feature models:
- `eyebrows.glb` - Eyebrow model
- `Beard1.glb` - Beard model
- Future additions: mustaches, additional beard styles

## Adding New Models

### New Hair Models
1. Export as GLB format
2. Name as `Hair[N].glb` (e.g., Hair13.glb)
3. Place in `/hair/` folder
4. Update `HairSystem.js` hairModels configuration
5. Add corresponding UI card in `index.html`

### New Beard Models
1. Export as GLB format
2. Name as `Beard[N].glb` (e.g., Beard2.glb)
3. Place in `/facial/` folder
4. Update `HairSystem.js` beardModels configuration
5. Add option to beard style dropdown in `index.html`

### New Facial Features
1. Create models in `/facial/` folder
2. Follow naming convention: {feature}[N].glb
3. Update corresponding system in `HairSystem.js`

## Model Requirements

- **Format**: GLB (recommended) or OBJ with MTL
- **Scale**: Models should be proportional to base head model
- **Origin**: Centered for proper alignment
- **Materials**: Embedded or separate (GLB preferred)
- **Optimization**: Keep polygon count reasonable for real-time rendering

## Current Inventory

- **Base Models**: 3 files (head, face, materials)
- **Hair Models**: 12 styles
- **Facial Models**: 2 (eyebrows, beard)
- **Total**: 17 model files + metadata

---
*Last Updated: February 2026*
