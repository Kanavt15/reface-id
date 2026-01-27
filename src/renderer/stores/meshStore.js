import { create } from 'zustand';
import * as THREE from 'three';

/**
 * Mesh editing store with undo/redo and version history
 */
export const useMeshStore = create((set, get) => ({
  // Current mesh state
  mesh: null,
  geometry: null,
  originalGeometry: null,
  hairMesh: null,
  
  // Mesh parameters (for slider-based editing)
  parameters: {
    // Jaw parameters
    jawWidth: 0,
    jawAngle: 0,
    jawLength: 0,
    chinProjection: 0,
    chinWidth: 0,
    
    // Nose parameters
    noseLength: 0,
    noseWidth: 0,
    noseProjection: 0,
    noseBridge: 0,
    nostrilWidth: 0,
    
    // Cheek parameters
    cheekboneHeight: 0,
    cheekboneProminence: 0,
    cheekFullness: 0,
    
    // Forehead parameters
    foreheadHeight: 0,
    foreheadSlope: 0,
    browRidge: 0,
    
    // Eye parameters
    eyeWidth: 0,
    eyeDepth: 0,
    eyeSpacing: 0,
    
    // Mouth parameters
    mouthWidth: 0,
    lipFullness: 0,
    philtrum: 0,
    
    // Overall parameters
    faceWidth: 0,
    faceLength: 0,
    facialSymmetry: 100,
    
    // Age parameters
    ageDeformation: 0,
    skinSagging: 0,
    wrinkleDepth: 0,
    
    // Hair parameters
    hairType: 0,  // 0=none, 1=short, 2=medium, 3=long, 4=bald, 5=receding
    hairVolume: 50,
    hairLength: 50
  },
  
  // Undo/Redo history
  history: [],
  historyIndex: -1,
  maxHistoryLength: 50,
  
  // Version history for saving
  versions: [],
  currentVersionId: null,
  
  // Selection state
  selectedVertices: [],
  selectedRegion: null,
  
  // Regions for region-based editing
  regions: {
    forehead: { vertices: [], center: new THREE.Vector3(0, 0.8, 0.1) },
    leftEye: { vertices: [], center: new THREE.Vector3(-0.15, 0.6, 0.1) },
    rightEye: { vertices: [], center: new THREE.Vector3(0.15, 0.6, 0.1) },
    nose: { vertices: [], center: new THREE.Vector3(0, 0.4, 0.2) },
    leftCheek: { vertices: [], center: new THREE.Vector3(-0.25, 0.35, 0.05) },
    rightCheek: { vertices: [], center: new THREE.Vector3(0.25, 0.35, 0.05) },
    mouth: { vertices: [], center: new THREE.Vector3(0, 0.15, 0.15) },
    chin: { vertices: [], center: new THREE.Vector3(0, -0.1, 0.1) },
    leftJaw: { vertices: [], center: new THREE.Vector3(-0.2, 0, -0.05) },
    rightJaw: { vertices: [], center: new THREE.Vector3(0.2, 0, -0.05) }
  },
  
  // Initialize mesh
  initializeMesh: (mesh) => {
    const geometry = mesh.geometry.clone();
    const originalGeometry = mesh.geometry.clone();
    
    set({
      mesh,
      geometry,
      originalGeometry,
      history: [{ geometry: geometry.clone(), parameters: { ...get().parameters } }],
      historyIndex: 0
    });
    
    // Auto-detect regions based on vertex positions
    get().detectRegions();
  },
  
  // Detect facial regions from geometry
  detectRegions: () => {
    const { geometry, regions } = get();
    if (!geometry) return;
    
    const positions = geometry.attributes.position;
    const newRegions = { ...regions };
    
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const vertex = new THREE.Vector3(x, y, z);
      
      // Assign vertex to closest region
      let closestRegion = null;
      let closestDistance = Infinity;
      
      for (const [name, region] of Object.entries(newRegions)) {
        const distance = vertex.distanceTo(region.center);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestRegion = name;
        }
      }
      
      if (closestRegion && closestDistance < 0.3) {
        newRegions[closestRegion].vertices.push(i);
      }
    }
    
    set({ regions: newRegions });
  },
  
  // Update parameter and apply to mesh
  updateParameter: (name, value) => {
    const currentParams = get().parameters;
    const newParams = { ...currentParams, [name]: value };
    
    set({ parameters: newParams });
    
    // Apply with new parameters directly
    const { mesh, originalGeometry, regions } = get();
    if (!mesh || !originalGeometry) {
      console.log('updateParameter: mesh or originalGeometry not available');
      return;
    }
    
    console.log('Updating parameter:', name, '=', value);
    console.log('Regions:', Object.keys(regions).map(k => `${k}: ${regions[k].vertices.length} vertices`));
    
    const geometry = mesh.geometry;
    const origPositions = originalGeometry.attributes.position;
    const newPositions = geometry.attributes.position;
    
    // Reset to original first
    for (let i = 0; i < origPositions.count; i++) {
      newPositions.setXYZ(
        i,
        origPositions.getX(i),
        origPositions.getY(i),
        origPositions.getZ(i)
      );
    }
    
    // Apply GLOBAL modifications to ALL vertices based on parameters
    for (let i = 0; i < newPositions.count; i++) {
      let x = newPositions.getX(i);
      let y = newPositions.getY(i);
      let z = newPositions.getZ(i);
      
      // Only affect front-facing vertices
      if (z > -0.2) {
        // Jaw width - affects lower face
        if (y < 0) {
          x *= 1 + (newParams.jawWidth / 100) * 0.3;
        }
        
        // Jaw length - extends chin downward
        if (y < -0.3) {
          y += (newParams.jawLength / 100) * 0.15;
        }
        
        // Chin projection
        if (y < -0.5 && Math.abs(x) < 0.3) {
          z += (newParams.chinProjection / 100) * 0.1;
        }
        
        // Nose modifications
        if (y > -0.1 && y < 0.4 && Math.abs(x) < 0.2) {
          // Nose length
          if (z > 0.2) {
            y += (newParams.noseLength / 100) * 0.1;
          }
          // Nose width
          x *= 1 + (newParams.noseWidth / 100) * 0.2;
          // Nose projection
          z += (newParams.noseProjection / 100) * 0.08;
        }
        
        // Cheekbone modifications
        if (Math.abs(x) > 0.2 && Math.abs(x) < 0.5 && y > 0 && y < 0.5) {
          z += (newParams.cheekboneProminence / 100) * 0.08;
          y += (newParams.cheekboneHeight / 100) * 0.05;
        }
        
        // Face width
        x *= 1 + (newParams.faceWidth / 100) * 0.15;
        
        // Face length
        y *= 1 + (newParams.faceLength / 100) * 0.1;
        
        // Forehead
        if (y > 0.5) {
          y += (newParams.foreheadHeight / 100) * 0.1;
          z -= (newParams.foreheadSlope / 100) * 0.05;
        }
        
        // Eye modifications
        const eyeY = 0.35;
        const leftEyeX = -0.25;
        const rightEyeX = 0.25;
        const leftDist = Math.sqrt(Math.pow(x - leftEyeX, 2) + Math.pow(y - eyeY, 2));
        const rightDist = Math.sqrt(Math.pow(x - rightEyeX, 2) + Math.pow(y - eyeY, 2));
        
        if (leftDist < 0.15 || rightDist < 0.15) {
          z -= (newParams.eyeDepth / 100) * 0.05;
        }
        
        // Mouth width
        if (y > -0.4 && y < -0.1 && Math.abs(x) < 0.25) {
          x *= 1 + (newParams.mouthWidth / 100) * 0.15;
          z += (newParams.lipFullness / 100) * 0.03;
        }
        
        // Age deformations
        if (newParams.ageDeformation !== 0) {
          // Sagging effect
          if (y < 0.2) {
            y -= Math.abs(newParams.ageDeformation / 100) * 0.05 * (0.2 - y);
          }
          // Volume loss in cheeks
          if (Math.abs(x) > 0.15 && y > -0.2 && y < 0.3) {
            z -= Math.abs(newParams.ageDeformation / 100) * 0.03;
          }
        }
      }
      
      newPositions.setXYZ(i, x, y, z);
    }
    
    newPositions.needsUpdate = true;
    geometry.computeVertexNormals();
    console.log('Mesh updated with', newPositions.count, 'vertices');
  },
  
  // Batch update parameters
  updateParameters: (updates) => {
    const { parameters, applyParameters } = get();
    
    set({
      parameters: { ...parameters, ...updates }
    });
    
    applyParameters();
  },
  
  // Apply all parameters to mesh geometry
  applyParameters: () => {
    const { mesh, originalGeometry, parameters, regions } = get();
    if (!mesh || !originalGeometry) return;
    
    const geometry = mesh.geometry;
    const origPositions = originalGeometry.attributes.position;
    const newPositions = geometry.attributes.position;
    
    // Reset to original first
    for (let i = 0; i < origPositions.count; i++) {
      newPositions.setXYZ(
        i,
        origPositions.getX(i),
        origPositions.getY(i),
        origPositions.getZ(i)
      );
    }
    
    // Apply jaw modifications
    applyJawModifications(newPositions, regions, parameters);
    
    // Apply nose modifications
    applyNoseModifications(newPositions, regions, parameters);
    
    // Apply cheek modifications
    applyCheekModifications(newPositions, regions, parameters);
    
    // Apply overall face modifications
    applyFaceModifications(newPositions, parameters);
    
    // Apply age deformations
    applyAgeDeformations(newPositions, parameters);
    
    // Apply symmetry if less than 100%
    if (parameters.facialSymmetry < 100) {
      applyAsymmetry(newPositions, parameters.facialSymmetry);
    }
    
    newPositions.needsUpdate = true;
    geometry.computeVertexNormals();
  },
  
  // Move specific vertices
  moveVertices: (vertexIndices, delta) => {
    const { mesh, symmetryMode } = get();
    if (!mesh) return;
    
    const positions = mesh.geometry.attributes.position;
    
    vertexIndices.forEach(index => {
      const x = positions.getX(index) + delta.x;
      const y = positions.getY(index) + delta.y;
      const z = positions.getZ(index) + delta.z;
      
      positions.setXYZ(index, x, y, z);
      
      // Apply symmetry if enabled
      if (symmetryMode) {
        const mirrorIndex = findMirrorVertex(positions, index);
        if (mirrorIndex !== -1) {
          positions.setXYZ(mirrorIndex, -x, y, z);
        }
      }
    });
    
    positions.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  },
  
  // Scale region
  scaleRegion: (regionName, scale) => {
    const { mesh, regions } = get();
    if (!mesh || !regions[regionName]) return;
    
    const positions = mesh.geometry.attributes.position;
    const region = regions[regionName];
    
    region.vertices.forEach(index => {
      const x = positions.getX(index);
      const y = positions.getY(index);
      const z = positions.getZ(index);
      
      // Scale relative to region center
      const dx = (x - region.center.x) * scale.x + region.center.x;
      const dy = (y - region.center.y) * scale.y + region.center.y;
      const dz = (z - region.center.z) * scale.z + region.center.z;
      
      positions.setXYZ(index, dx, dy, dz);
    });
    
    positions.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  },
  
  // Save current state to history
  saveToHistory: () => {
    const { mesh, parameters, history, historyIndex, maxHistoryLength } = get();
    if (!mesh) return;
    
    const newState = {
      geometry: mesh.geometry.clone(),
      parameters: { ...parameters },
      timestamp: Date.now()
    };
    
    // Remove any states after current index (for redo)
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newState);
    
    // Limit history length
    if (newHistory.length > maxHistoryLength) {
      newHistory.shift();
    }
    
    set({
      history: newHistory,
      historyIndex: newHistory.length - 1
    });
  },
  
  // Undo
  undo: () => {
    const { mesh, history, historyIndex } = get();
    if (historyIndex <= 0 || !mesh) return;
    
    const newIndex = historyIndex - 1;
    const state = history[newIndex];
    
    mesh.geometry.copy(state.geometry);
    mesh.geometry.attributes.position.needsUpdate = true;
    
    set({
      historyIndex: newIndex,
      parameters: { ...state.parameters }
    });
  },
  
  // Redo
  redo: () => {
    const { mesh, history, historyIndex } = get();
    if (historyIndex >= history.length - 1 || !mesh) return;
    
    const newIndex = historyIndex + 1;
    const state = history[newIndex];
    
    mesh.geometry.copy(state.geometry);
    mesh.geometry.attributes.position.needsUpdate = true;
    
    set({
      historyIndex: newIndex,
      parameters: { ...state.parameters }
    });
  },
  
  // Reset to original
  reset: () => {
    const { mesh, originalGeometry, saveToHistory } = get();
    if (!mesh || !originalGeometry) return;
    
    mesh.geometry.copy(originalGeometry);
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    
    // Reset parameters with proper defaults
    const resetParameters = Object.fromEntries(
      Object.keys(get().parameters).map(key => {
        if (key === 'facialSymmetry') return [key, 100];
        if (key === 'hairVolume' || key === 'hairLength') return [key, 50];
        return [key, 0];
      })
    );
    
    set({ parameters: resetParameters });
    saveToHistory();
  },
  
  // Save version
  saveVersion: (name, description = '') => {
    const { mesh, parameters, versions } = get();
    if (!mesh) return;
    
    const versionId = 'v-' + Date.now();
    const version = {
      id: versionId,
      name,
      description,
      geometry: mesh.geometry.clone(),
      parameters: { ...parameters },
      createdAt: new Date().toISOString()
    };
    
    set({
      versions: [...versions, version],
      currentVersionId: versionId
    });
    
    return versionId;
  },
  
  // Load version
  loadVersion: (versionId) => {
    const { mesh, versions } = get();
    const version = versions.find(v => v.id === versionId);
    
    if (!version || !mesh) return;
    
    mesh.geometry.copy(version.geometry);
    mesh.geometry.attributes.position.needsUpdate = true;
    
    set({
      parameters: { ...version.parameters },
      currentVersionId: versionId
    });
    
    get().saveToHistory();
  },
  
  // Select vertices
  selectVertices: (indices) => {
    set({ selectedVertices: indices });
  },
  
  // Select region
  selectRegion: (regionName) => {
    const { regions } = get();
    if (regions[regionName]) {
      set({
        selectedRegion: regionName,
        selectedVertices: regions[regionName].vertices
      });
    }
  },
  
  // Clear selection
  clearSelection: () => {
    set({
      selectedVertices: [],
      selectedRegion: null
    });
  },
  
  // Export geometry data
  exportGeometry: () => {
    const { mesh, parameters } = get();
    if (!mesh) return null;
    
    return {
      geometry: mesh.geometry.toJSON(),
      parameters: { ...parameters }
    };
  },
  
  // Import geometry data
  importGeometry: (data) => {
    const { mesh } = get();
    if (!mesh || !data) return;
    
    const loader = new THREE.BufferGeometryLoader();
    const geometry = loader.parse(data.geometry);
    
    mesh.geometry.copy(geometry);
    mesh.geometry.attributes.position.needsUpdate = true;
    
    if (data.parameters) {
      set({ parameters: { ...data.parameters } });
    }
    
    get().saveToHistory();
  }
}));

// Helper functions for mesh modifications
function applyJawModifications(positions, regions, params) {
  const jawVertices = [
    ...regions.leftJaw.vertices,
    ...regions.rightJaw.vertices,
    ...regions.chin.vertices
  ];
  
  jawVertices.forEach(i => {
    let x = positions.getX(i);
    let y = positions.getY(i);
    let z = positions.getZ(i);
    
    // Jaw width
    x *= 1 + (params.jawWidth / 100) * 0.2;
    
    // Jaw angle (rotate outward)
    const angle = (params.jawAngle / 100) * 0.1;
    const newX = x * Math.cos(angle) - z * Math.sin(angle);
    const newZ = x * Math.sin(angle) + z * Math.cos(angle);
    
    // Chin projection
    if (y < 0) {
      z += (params.chinProjection / 100) * 0.05;
      x *= 1 + (params.chinWidth / 100) * 0.1;
    }
    
    positions.setXYZ(i, newX, y, newZ);
  });
}

function applyNoseModifications(positions, regions, params) {
  regions.nose.vertices.forEach(i => {
    let x = positions.getX(i);
    let y = positions.getY(i);
    let z = positions.getZ(i);
    
    // Nose length
    y += (y - regions.nose.center.y) * (params.noseLength / 100) * 0.2;
    
    // Nose width
    x *= 1 + (params.noseWidth / 100) * 0.15;
    
    // Nose projection
    z += (params.noseProjection / 100) * 0.03;
    
    // Nose bridge
    if (y > regions.nose.center.y) {
      z += (params.noseBridge / 100) * 0.02;
    }
    
    // Nostril width (lower nose area)
    if (y < regions.nose.center.y) {
      x *= 1 + (params.nostrilWidth / 100) * 0.1;
    }
    
    positions.setXYZ(i, x, y, z);
  });
}

function applyCheekModifications(positions, regions, params) {
  [...regions.leftCheek.vertices, ...regions.rightCheek.vertices].forEach(i => {
    let x = positions.getX(i);
    let y = positions.getY(i);
    let z = positions.getZ(i);
    
    // Cheekbone height
    y += (params.cheekboneHeight / 100) * 0.02;
    
    // Cheekbone prominence
    z += (params.cheekboneProminence / 100) * 0.02;
    
    // Cheek fullness
    const fullness = (params.cheekFullness / 100) * 0.03;
    z += fullness;
    x *= 1 + (params.cheekFullness / 100) * 0.05;
    
    positions.setXYZ(i, x, y, z);
  });
}

function applyFaceModifications(positions, params) {
  for (let i = 0; i < positions.count; i++) {
    let x = positions.getX(i);
    let y = positions.getY(i);
    let z = positions.getZ(i);
    
    // Overall face width
    x *= 1 + (params.faceWidth / 100) * 0.1;
    
    // Overall face length
    y *= 1 + (params.faceLength / 100) * 0.1;
    
    positions.setXYZ(i, x, y, z);
  }
}

function applyAgeDeformations(positions, params) {
  const ageFactor = params.ageDeformation / 100;
  const saggingFactor = params.skinSagging / 100;
  
  if (ageFactor === 0 && saggingFactor === 0) return;
  
  for (let i = 0; i < positions.count; i++) {
    let x = positions.getX(i);
    let y = positions.getY(i);
    let z = positions.getZ(i);
    
    // Skin sagging (lower face droops)
    if (y < 0.3) {
      y -= saggingFactor * 0.02 * (0.3 - y);
    }
    
    // Age-related volume loss in cheeks
    if (y > 0.2 && y < 0.5) {
      z -= ageFactor * 0.015;
    }
    
    // Nose growth with age
    if (y > 0.2 && y < 0.6 && Math.abs(x) < 0.1) {
      y += ageFactor * 0.005;
      z += ageFactor * 0.005;
    }
    
    positions.setXYZ(i, x, y, z);
  }
}

function applyAsymmetry(positions, symmetryPercent) {
  const asymmetryFactor = (100 - symmetryPercent) / 100;
  
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    
    // Only affect left side (negative x)
    if (x < 0) {
      const randomOffset = (Math.random() - 0.5) * asymmetryFactor * 0.02;
      positions.setY(i, positions.getY(i) + randomOffset);
      positions.setZ(i, positions.getZ(i) + randomOffset);
    }
  }
}

function findMirrorVertex(positions, index) {
  const x = positions.getX(index);
  const y = positions.getY(index);
  const z = positions.getZ(index);
  const threshold = 0.01;
  
  for (let i = 0; i < positions.count; i++) {
    if (i === index) continue;
    
    const mx = positions.getX(i);
    const my = positions.getY(i);
    const mz = positions.getZ(i);
    
    if (
      Math.abs(mx + x) < threshold &&
      Math.abs(my - y) < threshold &&
      Math.abs(mz - z) < threshold
    ) {
      return i;
    }
  }
  
  return -1;
}
