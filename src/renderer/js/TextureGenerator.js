/**
 * TextureGenerator.js
 * Generates procedural normal maps and displacement maps for wrinkles.
 * Uses HTML5 Canvas API to draw gradients representing wrinkle depth.
 */

class TextureGenerator {
  constructor() {
    this.resolution = 1024;  // Default texture resolution
  }

  /**
   * Generate normal and displacement textures from wrinkle data
   * @param {Array} wrinkles - Array of wrinkle objects
   * @param {number} resolution - Texture resolution (default 1024)
   * @returns {Object} { normalTexture, displacementTexture }
   */
  generateWrinkleTextures(wrinkles, resolution = this.resolution) {
    if (!wrinkles || wrinkles.length === 0) {
      return {
        normalTexture: this._createFlatNormalTexture(resolution),
        displacementTexture: this._createFlatDisplacementTexture(resolution),
      };
    }

    console.log(`[TextureGenerator] Generating textures for ${wrinkles.length} wrinkles at ${resolution}x${resolution}`);

    // Create canvases
    const normalCanvas = this._createCanvas(resolution);
    const displacementCanvas = this._createCanvas(resolution);

    const normalCtx = normalCanvas.getContext('2d', { willReadFrequently: true });
    const dispCtx = displacementCanvas.getContext('2d', { willReadFrequently: true });

    // Initialize with flat normal (128, 128, 255) = (0, 0, 1) pointing out
    normalCtx.fillStyle = 'rgb(128, 128, 255)';
    normalCtx.fillRect(0, 0, resolution, resolution);

    // Initialize displacement with neutral gray (128)
    dispCtx.fillStyle = 'rgb(128, 128, 128)';
    dispCtx.fillRect(0, 0, resolution, resolution);

    // Draw each wrinkle
    for (const wrinkle of wrinkles) {
      this._drawWrinkleOnCanvas(normalCtx, dispCtx, wrinkle, resolution);
    }

    // Apply Gaussian blur for smooth transitions
    this._applyGaussianBlur(normalCtx, normalCanvas, 1);
    this._applyGaussianBlur(dispCtx, displacementCanvas, 1);

    // Create Three.js textures
    const normalTexture = new THREE.CanvasTexture(normalCanvas);
    normalTexture.wrapS = THREE.ClampToEdgeWrapping;
    normalTexture.wrapT = THREE.ClampToEdgeWrapping;
    normalTexture.needsUpdate = true;

    const displacementTexture = new THREE.CanvasTexture(displacementCanvas);
    displacementTexture.wrapS = THREE.ClampToEdgeWrapping;
    displacementTexture.wrapT = THREE.ClampToEdgeWrapping;
    displacementTexture.needsUpdate = true;

    console.log('[TextureGenerator] Textures generated successfully');

    return { normalTexture, displacementTexture };
  }

  _createCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  }

  _createFlatNormalTexture(resolution) {
    const canvas = this._createCanvas(resolution);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(128, 128, 255)';
    ctx.fillRect(0, 0, resolution, resolution);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  _createFlatDisplacementTexture(resolution) {
    const canvas = this._createCanvas(resolution);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(128, 128, 128)';
    ctx.fillRect(0, 0, resolution, resolution);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  /**
   * Draw a single wrinkle on both normal and displacement canvases
   */
  _drawWrinkleOnCanvas(normalCtx, dispCtx, wrinkle, resolution) {
    const points = wrinkle.points;
    if (points.length < 2) return;

    // Get wrinkle type definition
    const typeDef = window.WrinkleSystem.WRINKLE_TYPES[wrinkle.type] ||
                    window.WrinkleSystem.WRINKLE_TYPES['fine'];

    const textureWidthPx = typeDef.textureWidthPx;
    const depth = wrinkle.depth;

    // Convert UV coordinates to pixel coordinates
    const pixelPoints = points.map(p => ({
      x: p.uv[0] * resolution,
      y: (1 - p.uv[1]) * resolution,  // Flip Y for canvas
      normal: p.normal,
    }));

    // Draw line segments
    for (let i = 0; i < pixelPoints.length - 1; i++) {
      const p1 = pixelPoints[i];
      const p2 = pixelPoints[i + 1];

      this._drawWrinkleSegment(normalCtx, dispCtx, p1, p2, textureWidthPx, depth, wrinkle);
    }
  }

  /**
   * Draw a wrinkle segment with gradient falloff
   * Creates a valley effect with raised ridges on the sides
   */
  _drawWrinkleSegment(normalCtx, dispCtx, p1, p2, width, depth, wrinkle) {
    // Calculate perpendicular direction for gradient
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < 0.1) return;  // Too short

    const dirX = dx / len;
    const dirY = dy / len;
    const perpX = -dirY;
    const perpY = dirX;

    // Wider influence area for more visible effect
    const effectWidth = width * 2.5;

    // Draw normal map gradient
    normalCtx.save();

    // Create gradient perpendicular to line
    const centerX = (p1.x + p2.x) / 2;
    const centerY = (p1.y + p2.y) / 2;

    const gradStart = {
      x: centerX - perpX * effectWidth,
      y: centerY - perpY * effectWidth
    };
    const gradEnd = {
      x: centerX + perpX * effectWidth,
      y: centerY + perpY * effectWidth
    };

    const gradient = normalCtx.createLinearGradient(
      gradStart.x, gradStart.y,
      gradEnd.x, gradEnd.y
    );

    // Normal map gradient: creates valley with raised edges
    // RGB(128, 128, 255) = flat surface pointing up
    // Lower values = surface tilting toward that direction
    const normalIntensity = Math.floor(128 - depth * 60);  // More pronounced
    const ridgeIntensity = Math.floor(128 + depth * 25);   // Raised ridges

    gradient.addColorStop(0, `rgb(128, 128, 255)`);        // Far edge: flat
    gradient.addColorStop(0.15, `rgb(${ridgeIntensity}, 128, 255)`);  // Outer ridge
    gradient.addColorStop(0.35, `rgb(128, 128, 255)`);     // Transition
    gradient.addColorStop(0.5, `rgb(${normalIntensity}, ${normalIntensity}, ${Math.floor(255 - depth * 40)})`);  // Center: valley
    gradient.addColorStop(0.65, `rgb(128, 128, 255)`);     // Transition
    gradient.addColorStop(0.85, `rgb(${ridgeIntensity}, 128, 255)`);  // Outer ridge
    gradient.addColorStop(1, `rgb(128, 128, 255)`);        // Far edge: flat

    normalCtx.strokeStyle = gradient;
    normalCtx.lineWidth = effectWidth * 2;
    normalCtx.lineCap = 'round';
    normalCtx.lineJoin = 'round';

    normalCtx.beginPath();
    normalCtx.moveTo(p1.x, p1.y);
    normalCtx.lineTo(p2.x, p2.y);
    normalCtx.stroke();

    normalCtx.restore();

    // Draw displacement map gradient
    dispCtx.save();

    const dispGradient = dispCtx.createLinearGradient(
      gradStart.x, gradStart.y,
      gradEnd.x, gradEnd.y
    );

    // Displacement: center is darker (pushed in), ridges are lighter (pushed out)
    const dispValley = Math.floor(128 - depth * 70);   // Valley: pushed inward
    const dispRidge = Math.floor(128 + depth * 30);    // Ridge: pushed outward

    dispGradient.addColorStop(0, `rgb(128, 128, 128)`);     // Far edge: neutral
    dispGradient.addColorStop(0.15, `rgb(${dispRidge}, ${dispRidge}, ${dispRidge})`);  // Outer ridge
    dispGradient.addColorStop(0.35, `rgb(128, 128, 128)`);  // Transition
    dispGradient.addColorStop(0.5, `rgb(${dispValley}, ${dispValley}, ${dispValley})`);  // Center: valley
    dispGradient.addColorStop(0.65, `rgb(128, 128, 128)`);  // Transition
    dispGradient.addColorStop(0.85, `rgb(${dispRidge}, ${dispRidge}, ${dispRidge})`);  // Outer ridge
    dispGradient.addColorStop(1, `rgb(128, 128, 128)`);     // Far edge: neutral

    dispCtx.strokeStyle = dispGradient;
    dispCtx.lineWidth = effectWidth * 2;
    dispCtx.lineCap = 'round';
    dispCtx.lineJoin = 'round';

    dispCtx.beginPath();
    dispCtx.moveTo(p1.x, p1.y);
    dispCtx.lineTo(p2.x, p2.y);
    dispCtx.stroke();

    dispCtx.restore();
  }

  /**
   * Apply simple Gaussian blur for smooth transitions
   */
  _applyGaussianBlur(ctx, canvas, radius) {
    if (radius < 1) return;

    // Get image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    // Simple box blur approximation of Gaussian (fast enough for our use case)
    const tempData = new Uint8ClampedArray(data);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;

        // Sample neighbors
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            const ny = y + dy;

            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const idx = (ny * width + nx) * 4;
              r += tempData[idx];
              g += tempData[idx + 1];
              b += tempData[idx + 2];
              a += tempData[idx + 3];
              count++;
            }
          }
        }

        // Write averaged value
        const idx = (y * width + x) * 4;
        data[idx] = Math.floor(r / count);
        data[idx + 1] = Math.floor(g / count);
        data[idx + 2] = Math.floor(b / count);
        data[idx + 3] = Math.floor(a / count);
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Set texture resolution (call before generating)
   */
  setResolution(resolution) {
    this.resolution = resolution;
    console.log(`[TextureGenerator] Resolution set to ${resolution}x${resolution}`);
  }
}

// Export to global scope
window.TextureGenerator = TextureGenerator;
