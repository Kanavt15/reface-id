# REface ID - Eye System Integration Guide

## Overview
A complete realistic eye system has been integrated into REface ID. The system includes:
- ✅ Procedural eye fallback (spheres + materials)
- ✅ GLB model support for realistic eyes
- ✅ Changeable eye color (iris color)
- ✅ Real-time eye color application
- ✅ Eye parameter controls (scale, position, rotation, opacity)
- ✅ AI-driven eye color generation

## Architecture

### Files Modified/Created
1. **EyeSystem.js** (NEW) - Main eye system class
   - Loads left/right eye GLB models
   - Applies materials (sclera, iris, pupil)
   - Handles color changes
   - Fallback to procedural geometry

2. **app.js** - Initialize EyeSystem
   - Instantiates EyeSystem
   - Binds head mesh to eye system
   - Sets up auto-refresh on morph changes
   - Passes eye system to UI and AI controllers

3. **UIController.js** - User interface integration
   - Eye color preset swatches
   - Eye color picker (HTML5 color input)
   - Real-time color application to 3D model
   - State restoration

4. **AIController.js** - AI integration
   - `_applyEyeColor()` now applies to 3D eyes
   - Eye color parameter in AI responses

### Files Unchanged (But Enhanced)
- **index.html** - Already has eyeColorPicker and eyeColorPresets elements
- **server.py** - Already supports eyeColor in appearance parameters

## Implementation Status

### ✅ Completed Features
1. **Procedural Eye Fallback**
   - Ball geometry (sclera - white)
   - Iris sphere with changeable color
   - Pupil (black center)
   - Automatically renders if GLB models unavailable

2. **Eye Color Control**
   - 6 preset colors (brown, blue, green, grey, amber, hazel)
   - Custom color picker
   - Real-time 3D update
   - Persistent storage in case manager

3. **System Integration**
   - Integrated with morph system
   - Eyes refresh when face shape changes
   - Full undo/redo support
   - AI-driven eye color generation

### ⏳ Pending: GLB Model Creation

The system supports loading custom GLB eye models. To use realistic eye models:

#### Option 1: Creating GLB Models in Blender

1. **Create Eye Geometry in Blender**
   - Create two separate objects: LeftEye and RightEye
   - Each should contain geometry groups:
     - Sclera (outer white part) - name it "Sclera" or "sclera"
     - Iris (colored part) - name it "Iris" or "iris"
     - Pupil (black center) - name it "Pupil" or "pupil"
   
2. **Apply Materials**
   - Sclera: White (#ffffff), slightly glossy
   - Iris: Use base color from AI/UI, matte finish
   - Pupil: Black (#000000), matted

3. **UV Unwrapping**
   - Ensure all parts have UVs for potential texture maps
   - Consider adding normal maps for realism

4. **Export as GLB**
   ```
   File > Export > glTF 2.0 (.glb/.gltf)
   Settings:
   - Format: Binary (.glb)
   - Include: Geometries, Materials, Textures
   - Scale: 1.0
   - Y Forward: Yes
   - Z Up: Yes
   ```

5. **Place Files**
   - Export as: `assets/models/facial/EyeLeft.glb`
   - Export as: `assets/models/facial/EyeRight.glb`

#### Option 2: Create Eyes Using Python + Three.js Export

Use a Python script with `trimesh` or `pyvista` to generate eye models:

```python
import trimesh
import numpy as np

# Create sclera (white sphere)
sclera = trimesh.creation.icosphere(subdivisions=4, radius=0.25)
sclera.export('eye_sclera.glb')

# Create iris (smaller sphere, slightly forward)
iris = trimesh.creation.icosphere(subdivisions=3, radius=0.12)
iris.apply_translation([0, 0, 0.15])
iris.export('eye_iris.glb')

# Combine in Blender or Three.js after
```

#### Option 3: Using Parametric Eye Generator

Consider using eye generation libraries:
- **Three.js EyeMaterial**: Custom shader-based eyes
- **Babylon.js EyeShader**: Built-in eye shader system
- **Toji's Eye Generator**: https://github.com/toji/eyes

## Current Eye Color Support

The system supports the following iris colors by default:

```
Brown:   #634e34
Blue:    #2e536f
Green:   #3d671d
Grey:    #5a5a5a
Amber:   #c7b446
Hazel:   #8b6914
Custom:  Any HTML color via picker
```

## API Reference

### EyeSystem Class

```javascript
// Create instance (in app.js)
const eyeSystem = new EyeSystem(sceneManager.scene);

// Bind to head mesh
eyeSystem.setHeadMesh(headGroup, regionData);

// Set eye color
eyeSystem.setEyeColor('#634e34');  // Brown
eyeSystem.setEyeColor('#2e536f');  // Blue

// Adjust eye parameters
eyeSystem.setParam('scale', 60);      // Scale 0-100
eyeSystem.setParam('posX', 55);       // Position X
eyeSystem.setParam('posY', 50);       // Position Y
eyeSystem.setParam('posZ', 50);       // Position Z
eyeSystem.setParam('rotX', 50);       // Rotation X
eyeSystem.setParam('rotY', 50);       // Rotation Y
eyeSystem.setParam('opacity', 100);   // Opacity %

// Generate eyes
eyeSystem.generateEyes();  // Load GLB or create procedural

// Get current state
const state = eyeSystem.exportState();
eyeSystem.restoreState(state);

// Get eye parameters
const params = eyeSystem.getParams();
const color = eyeSystem.getColor();

// Refresh on morphs
eyeSystem.refreshFromMesh();

// Cleanup
eyeSystem.dispose();
```

### UIController Integration

```javascript
// Eye system is passed as:
ui.eyeSystem = eyeSystem;

// Color controls automatically call:
eyeSystem.setEyeColor(hexColor);

// Eye color picker updates HTML input:
document.getElementById('eyeColorPicker')
```

### AIController Integration

```javascript
// Eye system passed to AI controller:
aiController.eyes = eyeSystem;

// AI color application:
aiController._applyEyeColor('#634e34');  // Updates 3D model
```

## Testing the Eye System

1. **Launch Application**
   ```bash
   npm start
   ```

2. **Verify Procedural Eyes**
   - Two spheres should appear on the face (left and right)
   - Spheres show iris color as set in defaults

3. **Test Color Changes**
   - Click appearance panel → Eye Color section
   - Select a preset color → eyes should update immediately
   - Use color picker → real-time color change in 3D view

4. **Test AI Generation**
   - Chat: "Give me blue eyes"
   - AI response parses eyeColor parameter
   - Eyes update to blue automatically

5. **Test Undo/Redo**
   - Change eye color
   - Press Ctrl+Z → eyes revert
   - Press Ctrl+Y → eyes update again

6. **Test with GLB Models** (when available)
   - Place EyeLeft.glb and EyeRight.glb in assets/models/facial/
   - Restart application
   - Eyes should load from GLB instead of procedural

## Troubleshooting

### Eyes not visible
- Check console for "[EyeSystem]" messages
- Ensure `EyeSystem.js` script is loaded in HTML
- Verify eye group is added to scene

### Color not changing
- Check if eyeColorPicker element exists in HTML
- Verify UIController has `this.eyeSystem` reference
- Check browser console for errors

### GLB models not loading
- Verify file paths: `assets/models/facial/EyeLeft.glb`
- Check browser Network tab for 404 errors
- Ensure GLB files are valid (test in Three.js editor)

### Eyes disappear on morph
- Ensure `eyeSystem.refreshFromMesh()` is called
- Check z-position doesn't go behind head

## Future Enhancements

1. **Eye Direction/Gaze**
   - Add eye look direction (where eyes are looking)
   - Implement pupil tracking to camera
   - Support different gaze angles for behavioral reconstruction

2. **Eye Details**
   - Bloodshot eyes
   - Tear ducts
   - Eye bags / dark circles
   - Sclera veinpattern

3. **Advanced Materials**
   - Subsurface scattering for iris
   - Corneal reflection (specular highlights)
   - Sclera transparency

4. **Eye Expressions**
   - Eyelid control separatey from morphs
   - Eye openness variations
   - Winking/blinking animation

5. **Eye Styles**
   - Multiple eye geometry styles (cartoon, realistic, stylized)
   - Eye shader variations
   - Procedural eye generation with customization

## Quick Start for Eye GLB Creation

### Minimal Blender Setup (5 minutes)

1. Create UV Sphere (radius 1.0)
2. Scale to 0.25 units
3. Name it "EyeSclera"
4. Add white material (color: #ffffff)
5. Duplicate and name "EyeIris"
6. Scale iris to 0.5 of sclera size
7. Move iris forward (Z: +0.15)
8. Add iris color material
9. Duplicate iris, scale smaller, name "EyePupil"
10. Use black material for pupil
11. Group all: Left Eye → Set Origin → Export as EyeLeft.glb
12. Mirror for right eye, export as EyeRight.glb

Done! 20 faces of eye geometry that's realistic and changeable.

## References

- **Three.js GLBLoader**: https://threejs.org/docs/#examples/en/loaders/GLTFLoader
- **Material System**: https://threejs.org/docs/#api/en/materials/MeshStandardMaterial
- **Eye Anatomy**: https://en.wikipedia.org/wiki/Human_eye
- **Procedural Eye Generation**: https://github.com/toji/eyes/wiki

---

**Status**: ✅ Core system complete. Awaiting high-quality GLB eye models for final visual enhancement.

**Created**: 2026-02-28  
**Framework**: Three.js + Electron  
**Backend**: Python Flask + Blender integration
