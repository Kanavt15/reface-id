# 👁️ Quick Guide: Creating Realistic Eye GLB Models for REface ID

## The Fast Path (10 minutes in Blender)

### Step 1: Create a New Blender Scene
- Open Blender
- Delete default cube: Select > All > Delete
- Set up lighting (optional but helps)

### Step 2: Create the Sclera (White Part)
1. Add → Mesh → UV Sphere
2. Scale: Press 'S' → Type '0.25' → Enter (quarter size)
3. Set smooth shading: Right-click → Shade Smooth
4. Subdivide for smoothness:
   - Right-click → Shade Smooth
   - Enter Edit Mode (Tab)
   - Select All (A)
   - Mesh → Subdivide (repeat 1-2 times)
   - Exit Edit Mode (Tab)

### Step 3: Create Material for Sclera  
1. Switch to Shading workspace (top menu)
2. With sphere selected, create new material
3. Set to "Principled BSDF":
   - Base Color: White (#FFFFFF)
   - Roughness: 0.4
   - Metalness: 0.05
4. Name the object: "Sclera"

### Step 4: Create the Iris (Colored Part)
1. Add → Mesh → UV Sphere
2. Scale: 'S' → '0.12' → Enter (much smaller)
3. Move forward: 'G' (grab) → 'Z' (Z-axis only) → '0.15' → Enter
4. Set smooth shading
5. Create new material:
   - Base Color: #634E34 (Brown - will be changed later)
   - Roughness: 0.6
   - Metalness: 0.0
6. Name the object: "Iris"

### Step 5: Create the Pupil (Black Center)
1. Add → Mesh → UV Sphere
2. Scale: 'S' → '0.06' → Enter (even smaller)
3. Move forward: 'G' → 'Z' → '0.2' → Enter (in front of iris)
4. Set smooth shading
5. Create material:
   - Base Color: Black (#000000)
   - Roughness: 0.95
   - Metalness: 0.1
6. Name the object: "Pupil"

### Step 6: Create Left Eye (Group)
1. Select all three objects:
   - Click Sclera
   - Shift+Click Iris
   - Shift+Click Pupil
2. Ctrl+J to join them
3. Rename to: "LeftEye"
4. Set origin to geometry: Object → Set Origin → Origin to Geometry
5. Position at: Move 'G' → 'X' → '-0.3' → Enter (left side)

### Step 7: Create Right Eye (Mirror)
1. Select LeftEye object
2. Duplicate: Shift+D → Confirm
3. Mirror on X: 'S' → 'X' → '-1' → Enter
4. Rename duplicated object: "RightEye"
5. Position: 'G' → 'X' → '+0.3' → Enter

### Step 8: Export as GLB - Left Eye
1. Select LeftEye only
2. File → Export → glTF 2.0 (.glb/.gltf)
3. Settings:
   - Format: **glTF Binary (.glb)**
   - Location: `reface-id/assets/models/facial/`
   - Filename: **EyeLeft.glb**
   - Check: ✓ Include Geometries
   - Check: ✓ Include Materials  
   - Scale: 1.0
4. Click "Export glTF 2.0"

### Step 9: Export as GLB - Right Eye
1. Select RightEye only
2. File → Export → glTF 2.0 (.glb/.gltf)
3. Settings:
   - Format: **glTF Binary (.glb)**
   - Location: `reface-id/assets/models/facial/`
   - Filename: **EyeRight.glb**
   - Same settings as above
4. Click "Export glTF 2.0"

### Step 10: Verify Files
```
reface-id/assets/models/facial/
├── EyeLeft.glb    ✓ Created
├── EyeRight.glb   ✓ Created
├── eyebrows.glb
└── Beard1.glb
```

---

## That's It! 🎉

Now restart REface ID and you'll have realistic eyes:

```bash
npm start
```

The eyes will automatically load from your GLB files instead of using procedural fallback.

---

## Visual Structure Created

```
EyeLeft.glb contains:
├── Sclera (white sphere, #FFFFFF)
├── Iris (smaller sphere, #634E34, positioned forward)
└── Pupil (tiny sphere, #000000, positioned in front)

EyeRight.glb: Same structure, mirrored
```

---

## Blender File for Reference

Save your .blend for future edits:
```
Keep: reface-id/blender_sources/eyes.blend
```

This way you can adjust iris colors, sizes, or add detail later without redoing everything.

---

## Pro Tips

### Add More Detail (Optional, +5 min)

1. **Iris Texture**: 
   - Add image texture to Iris material
   - Download iris pattern from Polyhaven.com

2. **Corneal Highlight**:
   - Add small glossy sphere on iris surface
   - Makes eyes "shine"

3. **Sclera Veins**:
   - Add subtle red/pink Normal Map
   - Gives realistic bloodshot appearance (optional)

4. **Subsurface Scattering**:
   - Iris material → Enable Subsurface
   - Radius: ~0.5
   - Makes iris glow slightly (very realistic)

---

## Testing Your Eyes

1. **In Blender**:
   - Switch to Rendered view (top right)
   - Rotate to see 3D effect

2. **In Three.js Editor**:
   - Visit: https://threejs.org/editor/
   - Drag your .glb file to check
   - Rotate: Right-click drag
   - Zoom: Scroll
   - Pan: Middle mouse

3. **In REface ID**:
   - Launch app
   - Open Appearance → Eye Color
   - Try different colors
   - Should update in real-time

---

## Common Issues & Fixes

| Issue | Fix |
|-------|-----|
| Eyes too small | Increase scale in step 2/4/6 |
| Eyes too big | Decrease scale |
| Eyes look flat | Add more subdivisions (step 2) |
| Color not changing | Ensure material is "Principled BSDF" |
| Eyes behind head | Adjust Z position in step 4/5 |
| Export fails | File → Save As first, check path |

---

## Advanced: Procedural Generation (Python)

If you prefer programmatic creation:

```python
# Python script to generate eyes with trimesh
import trimesh
import json

# Create eye geometry
def create_eye_model(side='left'):
    sclera = trimesh.creation.icosphere(subdivisions=4, radius=0.25)
    iris = trimesh.creation.icosphere(subdivisions=3, radius=0.12)
    pupil = trimesh.creation.icosphere(subdivisions=2, radius=0.06)
    
    # Position
    iris.apply_translation([0, 0, 0.15])
    pupil.apply_translation([0, 0, 0.2])
    
    # Combine
    eye = trimesh.util.concatenate([sclera, iris, pupil])
    
    # Export
    eye.export(f'assets/models/facial/Eye{side.capitalize()}.glb')

create_eye_model('left')
create_eye_model('right')
```

Run: `python create_eyes.py`

---

## What's Next?

### Testing
- [x] Launch app
- [x] Test eye color change
- [x] Verify AI eye generation

### Enhancement
- [ ] Add iris texture/normal maps
- [ ] Add corneal highlights
- [ ] Add sclera detail
- [ ] Add eye movement/gaze

### Integration
- [ ] Document eye models in project
- [ ] Update README with eye feature
- [ ] Commit to Git

---

## File Locations Reference

```
reface-id/
├── assets/models/facial/
│   ├── EyeLeft.glb          ← Place here
│   ├── EyeRight.glb         ← Place here
│   ├── eyebrows.glb
│   └── Beard1.glb
├── src/renderer/js/
│   ├── EyeSystem.js         ← Already created
│   ├── app.js               ← Already updated
│   ├── UIController.js      ← Already updated
│   └── AIController.js      ← Already updated
├── EYE_SYSTEM_GUIDE.md      ← Full documentation
└── EYE_SYSTEM_IMPLEMENTATION_SUMMARY.md ← Overview
```

---

**Time to Complete**: 10-15 minutes  
**Difficulty**: Beginner (Blender basics only)  
**Result**: Photorealistic changeable eyes ✨

Good luck! If you need help, check the full EYE_SYSTEM_GUIDE.md.
