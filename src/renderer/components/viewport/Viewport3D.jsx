import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import { useAppStore } from '../../stores/appStore';
import { useMeshStore } from '../../stores/meshStore';
import './Viewport3D.css';

/**
 * Main 3D viewport for facial mesh visualization and editing
 */
function Viewport3D({ onMeshLoaded }) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const transformControlsRef = useRef(null);
  const faceMeshRef = useRef(null);
  const wireframeMeshRef = useRef(null);
  const skullMeshRef = useRef(null);
  const hairMeshRef = useRef(null);
  const landmarkPointsRef = useRef([]);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  
  const [isInitialized, setIsInitialized] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  
  const { 
    viewMode, 
    showSkullOverlay, 
    showLandmarks, 
    cameraView,
    activeTool,
    symmetryMode,
    addNotification 
  } = useAppStore();
  
  const { 
    initializeMesh, 
    selectedVertices, 
    moveVertices, 
    saveToHistory,
    selectVertices,
    parameters
  } = useMeshStore();

  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current) {
      console.log('Container ref not ready');
      return;
    }
    
    if (rendererRef.current) {
      console.log('Renderer already exists');
      return;
    }

    console.log('Initializing Three.js viewport...');
    console.log('Container dimensions:', containerRef.current.clientWidth, containerRef.current.clientHeight);

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    sceneRef.current = scene;

    // Camera setup
    const camera = new THREE.PerspectiveCamera(
      45,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      1000
    );
    camera.position.set(0, 0, 3);
    cameraRef.current = camera;

    // Renderer setup - try WebGL with fallback
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ 
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: 'default',
        failIfMajorPerformanceCaveat: false
      });
    } catch (e) {
      console.error('WebGL not available, trying without antialias:', e);
      renderer = new THREE.WebGLRenderer({ 
        antialias: false,
        preserveDrawingBuffer: true
      });
    }
    
    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 600;
    
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    
    console.log('Renderer created:', width, 'x', height);

    // Orbit controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 10;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // Transform controls for direct manipulation
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value;
    });
    scene.add(transformControls);
    transformControlsRef.current = transformControls;

    // Lighting
    setupLighting(scene);

    // Grid helper
    const gridHelper = new THREE.GridHelper(10, 20, 0x0f3460, 0x0f3460);
    gridHelper.position.y = -1.5;
    scene.add(gridHelper);

    // Add debug cube to verify Three.js is working
    const debugGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const debugMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const debugCube = new THREE.Mesh(debugGeometry, debugMaterial);
    debugCube.position.set(2, 0, 0);
    scene.add(debugCube);
    console.log('Debug cube added to scene');

    // Load default face mesh
    loadDefaultFace();

    // Animation loop
    let frameCount = 0;
    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      frameCount++;
      if (frameCount === 1) {
        console.log('First frame rendered');
        console.log('Camera position:', camera.position);
        console.log('Scene children:', scene.children.length);
      }
    };
    animate();

    // Handle resize
    const handleResize = () => {
      if (!containerRef.current) return;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);

    setIsInitialized(true);

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Setup scene lighting
  const setupLighting = (scene) => {
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    // Key light (main)
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(2, 3, 2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    scene.add(keyLight);

    // Fill light
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-2, 1, 2);
    scene.add(fillLight);

    // Back light (rim)
    const backLight = new THREE.DirectionalLight(0x64ffda, 0.3);
    backLight.position.set(0, 2, -3);
    scene.add(backLight);

    // Bottom fill
    const bottomLight = new THREE.DirectionalLight(0xffffff, 0.2);
    bottomLight.position.set(0, -2, 1);
    scene.add(bottomLight);
  };

  // Load default procedural face mesh
  const loadDefaultFace = () => {
    console.log('Loading default face mesh...');
    setIsLoading(true);
    
    // Create a procedural face geometry
    const geometry = createProceduralFaceGeometry();
    console.log('Geometry created with', geometry.attributes.position.count, 'vertices');
    
    // Material for shaded view
    const material = new THREE.MeshStandardMaterial({
      color: 0xd4a574,
      roughness: 0.7,
      metalness: 0.1,
      flatShading: false,
      side: THREE.DoubleSide
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'faceMesh';
    
    faceMeshRef.current = mesh;
    sceneRef.current.add(mesh);
    console.log('Face mesh added to scene');
    
    // Create wireframe overlay
    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x64ffda,
      wireframe: true,
      transparent: true,
      opacity: 0.3
    });
    
    const wireframeMesh = new THREE.Mesh(geometry.clone(), wireframeMaterial);
    wireframeMesh.visible = false;
    wireframeMesh.name = 'wireframeMesh';
    wireframeMeshRef.current = wireframeMesh;
    sceneRef.current.add(wireframeMesh);
    
    // Initialize mesh in store
    initializeMesh(mesh);
    
    // Create facial landmarks
    createLandmarkPoints();
    
    setIsLoading(false);
    setLoadingProgress(100);
    console.log('Face mesh loading complete');
    
    if (onMeshLoaded) {
      onMeshLoaded(mesh);
    }
  };

  // Create procedural face geometry
  const createProceduralFaceGeometry = () => {
    // Base sphere with high detail
    const geometry = new THREE.SphereGeometry(1, 64, 64);
    const positions = geometry.attributes.position;
    
    // Deform to face shape
    for (let i = 0; i < positions.count; i++) {
      let x = positions.getX(i);
      let y = positions.getY(i);
      let z = positions.getZ(i);
      
      // Only work on front face
      if (z > -0.3) {
        // Elongate vertically (face is taller than wide)
        y *= 1.3;
        
        // Narrow the sides
        const sideCompression = 1 - Math.abs(y) * 0.15;
        x *= sideCompression * 0.85;
        
        // Jaw shape
        if (y < -0.3) {
          const jawFactor = Math.abs(y + 0.3) * 0.5;
          x *= 1 - jawFactor * 0.4;
          z -= jawFactor * 0.1;
        }
        
        // Chin
        if (y < -0.7 && Math.abs(x) < 0.2) {
          z += 0.15 * (1 - Math.abs(x) * 5);
          y -= 0.1;
        }
        
        // Forehead
        if (y > 0.5) {
          z -= (y - 0.5) * 0.2;
        }
        
        // Nose
        if (y > -0.1 && y < 0.3 && Math.abs(x) < 0.15) {
          const noseProtrusion = 0.3 * (1 - Math.abs(x) * 7) * (1 - Math.abs(y - 0.1) * 2);
          z += Math.max(0, noseProtrusion);
        }
        
        // Eye sockets
        const leftEyeX = -0.25;
        const rightEyeX = 0.25;
        const eyeY = 0.35;
        
        const leftEyeDist = Math.sqrt(Math.pow(x - leftEyeX, 2) + Math.pow(y - eyeY, 2));
        const rightEyeDist = Math.sqrt(Math.pow(x - rightEyeX, 2) + Math.pow(y - eyeY, 2));
        
        if (leftEyeDist < 0.15) {
          z -= (0.15 - leftEyeDist) * 0.3;
        }
        if (rightEyeDist < 0.15) {
          z -= (0.15 - rightEyeDist) * 0.3;
        }
        
        // Cheekbones
        if (Math.abs(x) > 0.3 && Math.abs(x) < 0.5 && y > 0 && y < 0.4) {
          z += 0.08;
        }
        
        // Mouth area
        if (y > -0.5 && y < -0.2 && Math.abs(x) < 0.2) {
          z += 0.05 * (1 - Math.abs(x) * 5);
        }
        
        // Lips
        if (y > -0.35 && y < -0.2 && Math.abs(x) < 0.15) {
          z += 0.08 * (1 - Math.pow((y + 0.275) * 10, 2));
        }
      }
      
      positions.setXYZ(i, x, y, z);
    }
    
    geometry.computeVertexNormals();
    return geometry;
  };

  // Create facial landmark visualization points
  const createLandmarkPoints = () => {
    // 68 point facial landmarks (simplified positions)
    const landmarks = [
      // Jawline (0-16)
      [-0.45, -0.2, 0.3], [-0.48, -0.1, 0.25], [-0.5, 0, 0.2],
      [-0.48, 0.1, 0.15], [-0.45, 0.2, 0.1], [-0.4, 0.25, 0.1],
      [-0.3, 0.3, 0.15], [-0.15, 0.32, 0.2], [0, 0.35, 0.25],
      [0.15, 0.32, 0.2], [0.3, 0.3, 0.15], [0.4, 0.25, 0.1],
      [0.45, 0.2, 0.1], [0.48, 0.1, 0.15], [0.5, 0, 0.2],
      [0.48, -0.1, 0.25], [0.45, -0.2, 0.3],
      
      // Left eyebrow (17-21)
      [-0.35, -0.45, 0.4], [-0.3, -0.48, 0.42], [-0.25, -0.5, 0.43],
      [-0.2, -0.48, 0.42], [-0.15, -0.45, 0.4],
      
      // Right eyebrow (22-26)
      [0.15, -0.45, 0.4], [0.2, -0.48, 0.42], [0.25, -0.5, 0.43],
      [0.3, -0.48, 0.42], [0.35, -0.45, 0.4],
      
      // Nose (27-35)
      [0, -0.35, 0.5], [0, -0.25, 0.55], [0, -0.15, 0.6],
      [0, -0.05, 0.65], [-0.08, 0, 0.55], [-0.04, 0.02, 0.6],
      [0, 0.03, 0.62], [0.04, 0.02, 0.6], [0.08, 0, 0.55],
      
      // Left eye (36-41)
      [-0.32, -0.35, 0.45], [-0.28, -0.38, 0.47], [-0.22, -0.38, 0.47],
      [-0.18, -0.35, 0.45], [-0.22, -0.33, 0.46], [-0.28, -0.33, 0.46],
      
      // Right eye (42-47)
      [0.18, -0.35, 0.45], [0.22, -0.38, 0.47], [0.28, -0.38, 0.47],
      [0.32, -0.35, 0.45], [0.28, -0.33, 0.46], [0.22, -0.33, 0.46],
      
      // Mouth outer (48-59)
      [-0.15, 0.12, 0.5], [-0.1, 0.1, 0.52], [-0.05, 0.08, 0.53],
      [0, 0.08, 0.54], [0.05, 0.08, 0.53], [0.1, 0.1, 0.52],
      [0.15, 0.12, 0.5], [0.1, 0.15, 0.51], [0.05, 0.17, 0.52],
      [0, 0.17, 0.52], [-0.05, 0.17, 0.52], [-0.1, 0.15, 0.51],
      
      // Mouth inner (60-67)
      [-0.1, 0.12, 0.52], [-0.05, 0.11, 0.53], [0, 0.11, 0.54],
      [0.05, 0.11, 0.53], [0.1, 0.12, 0.52], [0.05, 0.14, 0.53],
      [0, 0.14, 0.54], [-0.05, 0.14, 0.53]
    ];
    
    const pointGeometry = new THREE.SphereGeometry(0.015, 8, 8);
    const pointMaterial = new THREE.MeshBasicMaterial({ color: 0xe94560 });
    
    landmarks.forEach((pos, index) => {
      const point = new THREE.Mesh(pointGeometry, pointMaterial);
      point.position.set(pos[0], -pos[1], pos[2]); // Invert Y for correct orientation
      point.userData.landmarkIndex = index;
      point.name = `landmark_${index}`;
      landmarkPointsRef.current.push(point);
      sceneRef.current.add(point);
    });
  };

  // Create or update hair mesh based on parameters
  const createHairMesh = useCallback((hairType, hairVolume, hairLength) => {
    // Remove existing hair
    if (hairMeshRef.current) {
      sceneRef.current.remove(hairMeshRef.current);
      hairMeshRef.current.geometry?.dispose();
      hairMeshRef.current.material?.dispose();
      hairMeshRef.current = null;
    }
    
    if (hairType === 0) return; // No hair
    
    const hairMaterial = new THREE.MeshStandardMaterial({
      color: 0x3d2314,  // Dark brown hair
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide
    });
    
    let geometry;
    const volumeFactor = 1 + (hairVolume - 50) / 100;
    const lengthFactor = 1 + (hairLength - 50) / 100;
    
    switch (hairType) {
      case 1: // Short hair
        geometry = createShortHairGeometry(volumeFactor, lengthFactor);
        break;
      case 2: // Medium hair
        geometry = createMediumHairGeometry(volumeFactor, lengthFactor);
        break;
      case 3: // Long hair
        geometry = createLongHairGeometry(volumeFactor, lengthFactor);
        break;
      case 4: // Receding hairline
        geometry = createRecedingHairGeometry(volumeFactor, lengthFactor);
        break;
      case 5: // Crew cut
        geometry = createCrewCutGeometry(volumeFactor);
        break;
      default:
        return;
    }
    
    const hairMesh = new THREE.Mesh(geometry, hairMaterial);
    hairMesh.name = 'hairMesh';
    hairMeshRef.current = hairMesh;
    sceneRef.current.add(hairMesh);
  }, []);
  
  // Short hair geometry
  const createShortHairGeometry = (volume, length) => {
    const geometry = new THREE.SphereGeometry(1.05 * volume, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2.5);
    const positions = geometry.attributes.position;
    
    for (let i = 0; i < positions.count; i++) {
      let x = positions.getX(i);
      let y = positions.getY(i);
      let z = positions.getZ(i);
      
      // Shape to head
      x *= 0.85;
      y = y * 1.1 + 0.55;
      
      // Add some volume on top
      if (y > 0.8) {
        y += 0.05 * length;
      }
      
      positions.setXYZ(i, x, y, z);
    }
    
    geometry.computeVertexNormals();
    return geometry;
  };
  
  // Medium hair geometry
  const createMediumHairGeometry = (volume, length) => {
    const geometry = new THREE.SphereGeometry(1.08 * volume, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2);
    const positions = geometry.attributes.position;
    
    for (let i = 0; i < positions.count; i++) {
      let x = positions.getX(i);
      let y = positions.getY(i);
      let z = positions.getZ(i);
      
      // Shape to head with more coverage
      x *= 0.88;
      y = y * 1.15 + 0.5;
      
      // Add length to sides
      if (y < 0.7 && Math.abs(x) > 0.3) {
        y -= 0.2 * length;
      }
      
      positions.setXYZ(i, x, y, z);
    }
    
    geometry.computeVertexNormals();
    return geometry;
  };
  
  // Long hair geometry  
  const createLongHairGeometry = (volume, length) => {
    const geometry = new THREE.SphereGeometry(1.1 * volume, 32, 48, 0, Math.PI * 2, 0, Math.PI * 0.7);
    const positions = geometry.attributes.position;
    
    for (let i = 0; i < positions.count; i++) {
      let x = positions.getX(i);
      let y = positions.getY(i);
      let z = positions.getZ(i);
      
      // Shape for long hair
      x *= 0.9;
      y = y * 1.5 * length + 0.3;
      
      // Narrower at bottom like hair draping
      if (y < 0) {
        x *= 1 + y * 0.3;
      }
      
      positions.setXYZ(i, x, y, z);
    }
    
    geometry.computeVertexNormals();
    return geometry;
  };
  
  // Receding hairline geometry
  const createRecedingHairGeometry = (volume, length) => {
    const geometry = new THREE.SphereGeometry(1.03 * volume, 32, 32, 0, Math.PI * 2, 0, Math.PI / 3);
    const positions = geometry.attributes.position;
    
    for (let i = 0; i < positions.count; i++) {
      let x = positions.getX(i);
      let y = positions.getY(i);
      let z = positions.getZ(i);
      
      // Receding at front
      x *= 0.85;
      y = y * 1.05 + 0.65;
      
      // Cut back hairline at front
      if (z > 0.3 && y < 0.9) {
        const recession = (z - 0.3) * 0.5;
        y += recession;
      }
      
      positions.setXYZ(i, x, y, z);
    }
    
    geometry.computeVertexNormals();
    return geometry;
  };
  
  // Crew cut geometry
  const createCrewCutGeometry = (volume) => {
    const geometry = new THREE.SphereGeometry(1.02 * volume, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2.8);
    const positions = geometry.attributes.position;
    
    for (let i = 0; i < positions.count; i++) {
      let x = positions.getX(i);
      let y = positions.getY(i);
      let z = positions.getZ(i);
      
      // Very close to head
      x *= 0.84;
      y = y * 1.05 + 0.58;
      
      positions.setXYZ(i, x, y, z);
    }
    
    geometry.computeVertexNormals();
    return geometry;
  };

  // Update hair when parameters change
  useEffect(() => {
    if (sceneRef.current && isInitialized) {
      createHairMesh(parameters.hairType, parameters.hairVolume, parameters.hairLength);
    }
  }, [parameters.hairType, parameters.hairVolume, parameters.hairLength, isInitialized, createHairMesh]);

  // Update view mode
  useEffect(() => {
    if (!faceMeshRef.current || !wireframeMeshRef.current) return;
    
    switch (viewMode) {
      case 'shaded':
        faceMeshRef.current.visible = true;
        wireframeMeshRef.current.visible = false;
        break;
      case 'wireframe':
        faceMeshRef.current.visible = false;
        wireframeMeshRef.current.visible = true;
        break;
      case 'both':
        faceMeshRef.current.visible = true;
        wireframeMeshRef.current.visible = true;
        break;
    }
  }, [viewMode]);

  // Update landmark visibility
  useEffect(() => {
    landmarkPointsRef.current.forEach(point => {
      point.visible = showLandmarks;
    });
  }, [showLandmarks]);

  // Update skull overlay visibility
  useEffect(() => {
    if (skullMeshRef.current) {
      skullMeshRef.current.visible = showSkullOverlay;
    }
  }, [showSkullOverlay]);

  // Handle camera view changes
  useEffect(() => {
    if (!cameraRef.current || !controlsRef.current) return;
    
    const positions = {
      front: { x: 0, y: 0, z: 3 },
      left: { x: -3, y: 0, z: 0 },
      right: { x: 3, y: 0, z: 0 },
      top: { x: 0, y: 3, z: 0 },
      back: { x: 0, y: 0, z: -3 }
    };
    
    const pos = positions[cameraView];
    if (pos) {
      cameraRef.current.position.set(pos.x, pos.y, pos.z);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [cameraView]);

  // Handle mouse interactions
  const handleMouseDown = useCallback((event) => {
    if (!containerRef.current || activeTool === 'select') return;
    
    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    
    if (faceMeshRef.current) {
      const intersects = raycasterRef.current.intersectObject(faceMeshRef.current);
      
      if (intersects.length > 0) {
        const face = intersects[0].face;
        const vertexIndices = [face.a, face.b, face.c];
        selectVertices(vertexIndices);
      }
    }
  }, [activeTool, selectVertices]);

  // Load external mesh file
  const loadMeshFile = useCallback((file) => {
    setIsLoading(true);
    setLoadingProgress(0);
    
    const loader = new GLTFLoader();
    
    loader.load(
      URL.createObjectURL(file),
      (gltf) => {
        // Remove existing mesh
        if (faceMeshRef.current) {
          sceneRef.current.remove(faceMeshRef.current);
        }
        
        const mesh = gltf.scene.children[0];
        mesh.name = 'faceMesh';
        faceMeshRef.current = mesh;
        sceneRef.current.add(mesh);
        
        initializeMesh(mesh);
        setIsLoading(false);
        setLoadingProgress(100);
        
        addNotification({
          type: 'success',
          title: 'Mesh Loaded',
          message: 'Face mesh loaded successfully'
        });
      },
      (progress) => {
        if (progress.total) {
          setLoadingProgress((progress.loaded / progress.total) * 100);
        }
      },
      (error) => {
        setIsLoading(false);
        addNotification({
          type: 'error',
          title: 'Load Error',
          message: 'Failed to load mesh file'
        });
        console.error('Error loading mesh:', error);
      }
    );
  }, [initializeMesh, addNotification]);

  // Export current mesh
  const exportMesh = useCallback((format = 'glb') => {
    if (!faceMeshRef.current) return;
    
    const exporter = new GLTFExporter();
    
    exporter.parse(
      faceMeshRef.current,
      (result) => {
        let blob;
        let filename;
        
        if (format === 'glb') {
          blob = new Blob([result], { type: 'application/octet-stream' });
          filename = 'face_reconstruction.glb';
        } else {
          const output = JSON.stringify(result, null, 2);
          blob = new Blob([output], { type: 'application/json' });
          filename = 'face_reconstruction.gltf';
        }
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        
        addNotification({
          type: 'success',
          title: 'Export Complete',
          message: `Mesh exported as ${format.toUpperCase()}`
        });
      },
      (error) => {
        addNotification({
          type: 'error',
          title: 'Export Error',
          message: 'Failed to export mesh'
        });
        console.error('Export error:', error);
      },
      { binary: format === 'glb' }
    );
  }, [addNotification]);

  // Capture screenshot
  const captureScreenshot = useCallback(() => {
    if (!rendererRef.current) return;
    
    const dataUrl = rendererRef.current.domElement.toDataURL('image/png');
    
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'face_render.png';
    link.click();
    
    addNotification({
      type: 'success',
      title: 'Screenshot Saved',
      message: 'High-resolution render exported'
    });
  }, [addNotification]);

  // Expose methods via ref
  useEffect(() => {
    if (onMeshLoaded) {
      onMeshLoaded({
        loadMeshFile,
        exportMesh,
        captureScreenshot,
        getMesh: () => faceMeshRef.current
      });
    }
  }, [loadMeshFile, exportMesh, captureScreenshot, onMeshLoaded]);

  return (
    <div className="viewport-3d" ref={containerRef} onMouseDown={handleMouseDown}>
      {isLoading && (
        <div className="viewport-loading">
          <div className="loading-spinner"></div>
          <p>Loading mesh... {Math.round(loadingProgress)}%</p>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${loadingProgress}%` }}></div>
          </div>
        </div>
      )}
      
      <div className="viewport-overlay">
        <div className="viewport-info">
          <span className="view-indicator">{cameraView.toUpperCase()}</span>
          <span className="mode-indicator">{viewMode}</span>
        </div>
      </div>
    </div>
  );
}

export default Viewport3D;
