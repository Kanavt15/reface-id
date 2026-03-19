/**
 * OrbitControls for Three.js
 * Simplified orbit controls bundled for offline Electron use.
 */

THREE.OrbitControls = function (camera, domElement) {
  this.camera = camera;
  this.domElement = domElement;
  this.target = new THREE.Vector3();

  this.enabled = true;  // Enable/disable all controls
  this.enableRotate = true;
  this.enablePan = true;
  this.enableZoom = true;

  this.enableDamping = true;
  this.dampingFactor = 0.08;
  this.rotateSpeed = 0.8;
  this.panSpeed = 0.5;
  this.zoomSpeed = 1.0;
  this.minDistance = 0.5;
  this.maxDistance = 20;
  this.minPolarAngle = 0;
  this.maxPolarAngle = Math.PI;

  // Internal state
  let spherical = new THREE.Spherical();
  let sphericalDelta = new THREE.Spherical();
  let panOffset = new THREE.Vector3();
  let scale = 1;
  let rotateStart = new THREE.Vector2();
  let panStart = new THREE.Vector2();
  let state = 0; // 0 = none, 1 = rotate, 2 = pan

  const self = this;

  // Initialize spherical from camera position
  function updateSpherical() {
    let offset = new THREE.Vector3();
    offset.copy(self.camera.position).sub(self.target);
    spherical.setFromVector3(offset);
  }

  updateSpherical();

  this.update = function () {
    let offset = new THREE.Vector3();
    offset.copy(this.camera.position).sub(this.target);
    spherical.setFromVector3(offset);

    spherical.theta += sphericalDelta.theta;
    spherical.phi += sphericalDelta.phi;

    // Restrict phi
    spherical.phi = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, spherical.phi));
    spherical.makeSafe();

    spherical.radius *= scale;
    spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, spherical.radius));

    this.target.add(panOffset);

    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    // Damping
    if (this.enableDamping) {
      sphericalDelta.theta *= (1 - this.dampingFactor);
      sphericalDelta.phi *= (1 - this.dampingFactor);
      panOffset.multiplyScalar(1 - this.dampingFactor);
    } else {
      sphericalDelta.set(0, 0, 0);
      panOffset.set(0, 0, 0);
    }

    scale = 1;
  };

  // Mouse events
  function onMouseDown(event) {
    if (!self.enabled) return;
    event.preventDefault();

    if (event.button === 0 && self.enableRotate) {
      state = 1; // Rotate (left click)
      rotateStart.set(event.clientX, event.clientY);
    } else if (event.button === 2 && self.enablePan) {
      state = 2; // Pan (right click)
      panStart.set(event.clientX, event.clientY);
    } else if (event.button === 1 && self.enablePan) {
      state = 2; // Pan (middle click)
      panStart.set(event.clientX, event.clientY);
    }

    if (state !== 0) {
      domElement.addEventListener('mousemove', onMouseMove, false);
      domElement.addEventListener('mouseup', onMouseUp, false);
    }
  }

  function onMouseMove(event) {
    if (!self.enabled) return;

    if (state === 1 && self.enableRotate) {
      // Rotate
      let dx = event.clientX - rotateStart.x;
      let dy = event.clientY - rotateStart.y;
      sphericalDelta.theta -= dx * 0.005 * self.rotateSpeed;
      sphericalDelta.phi -= dy * 0.005 * self.rotateSpeed;
      rotateStart.set(event.clientX, event.clientY);
    } else if (state === 2 && self.enablePan) {
      // Pan - screen space panning
      let dx = event.clientX - panStart.x;
      let dy = event.clientY - panStart.y;

      let offset = new THREE.Vector3();
      offset.copy(self.camera.position).sub(self.target);
      let distance = offset.length();

      let panFactor = distance * 0.001 * self.panSpeed;
      let right = new THREE.Vector3();
      right.setFromMatrixColumn(self.camera.matrix, 0);
      let up = new THREE.Vector3();
      up.setFromMatrixColumn(self.camera.matrix, 1);

      // Pan direction: drag right = view moves right (target moves left)
      panOffset.addScaledVector(right, -dx * panFactor);
      panOffset.addScaledVector(up, dy * panFactor);

      panStart.set(event.clientX, event.clientY);
    }
  }

  function onMouseUp() {
    state = 0;
    domElement.removeEventListener('mousemove', onMouseMove, false);
    domElement.removeEventListener('mouseup', onMouseUp, false);
    document.removeEventListener('mouseup', onMouseUp, false);
  }

  function onWheel(event) {
    if (!self.enabled || !self.enableZoom) return;
    event.preventDefault();

    // Scroll up (deltaY < 0) = zoom in, scroll down = zoom out
    if (event.deltaY < 0) {
      scale /= Math.pow(0.95, self.zoomSpeed);
    } else if (event.deltaY > 0) {
      scale *= Math.pow(0.95, self.zoomSpeed);
    }
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  // Wrapper to handle global mouseup when dragging outside canvas
  function onMouseDownWrapper(event) {
    onMouseDown(event);
    if (state !== 0) {
      document.addEventListener('mouseup', onMouseUp, false);
    }
  }

  domElement.addEventListener('mousedown', onMouseDownWrapper, false);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  domElement.addEventListener('contextmenu', onContextMenu, false);

  // Touch support
  let touchStart = new THREE.Vector2();
  let touchStartDistance = 0;

  function onTouchStart(event) {
    if (!self.enabled) return;

    if (event.touches.length === 1 && self.enableRotate) {
      state = 1;
      rotateStart.set(event.touches[0].clientX, event.touches[0].clientY);
    } else if (event.touches.length === 2 && self.enableZoom) {
      state = 3; // Pinch zoom
      let dx = event.touches[0].clientX - event.touches[1].clientX;
      let dy = event.touches[0].clientY - event.touches[1].clientY;
      touchStartDistance = Math.sqrt(dx * dx + dy * dy);
    }
  }

  function onTouchMove(event) {
    if (!self.enabled) return;
    event.preventDefault();

    if (state === 1 && event.touches.length === 1 && self.enableRotate) {
      let dx = event.touches[0].clientX - rotateStart.x;
      let dy = event.touches[0].clientY - rotateStart.y;
      sphericalDelta.theta -= dx * 0.005 * self.rotateSpeed;
      sphericalDelta.phi -= dy * 0.005 * self.rotateSpeed;
      rotateStart.set(event.touches[0].clientX, event.touches[0].clientY);
    } else if (state === 3 && event.touches.length === 2 && self.enableZoom) {
      let dx = event.touches[0].clientX - event.touches[1].clientX;
      let dy = event.touches[0].clientY - event.touches[1].clientY;
      let distance = Math.sqrt(dx * dx + dy * dy);
      if (touchStartDistance > 0) {
        scale *= touchStartDistance / distance;
      }
      touchStartDistance = distance;
    }
  }

  function onTouchEnd() {
    state = 0;
  }

  domElement.addEventListener('touchstart', onTouchStart, { passive: false });
  domElement.addEventListener('touchmove', onTouchMove, { passive: false });
  domElement.addEventListener('touchend', onTouchEnd, false);

  this.dispose = function () {
    domElement.removeEventListener('mousedown', onMouseDownWrapper);
    domElement.removeEventListener('wheel', onWheel);
    domElement.removeEventListener('contextmenu', onContextMenu);
    domElement.removeEventListener('touchstart', onTouchStart);
    domElement.removeEventListener('touchmove', onTouchMove);
    domElement.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('mouseup', onMouseUp);
  };
};
