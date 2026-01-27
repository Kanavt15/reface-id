const mongoose = require('mongoose');

const meshSchema = new mongoose.Schema({
  case: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Case',
    required: true
  },
  // Version information
  version: {
    type: Number,
    required: true,
    default: 1
  },
  name: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  // Geometry data
  geometry: {
    vertices: {
      type: Buffer,
      required: true
    },
    indices: Buffer,
    normals: Buffer,
    uvs: Buffer,
    vertexCount: Number,
    faceCount: Number,
    format: {
      type: String,
      enum: ['float32', 'float64'],
      default: 'float32'
    }
  },
  // Facial parameters used to generate this mesh
  parameters: {
    // Jaw
    jawWidth: { type: Number, default: 0 },
    jawAngle: { type: Number, default: 0 },
    jawLength: { type: Number, default: 0 },
    chinProjection: { type: Number, default: 0 },
    chinWidth: { type: Number, default: 0 },
    // Cheeks
    cheekboneHeight: { type: Number, default: 0 },
    cheekboneProminence: { type: Number, default: 0 },
    cheekFullness: { type: Number, default: 0 },
    // Nose
    noseLength: { type: Number, default: 0 },
    noseWidth: { type: Number, default: 0 },
    noseProjection: { type: Number, default: 0 },
    noseBridge: { type: Number, default: 0 },
    nostrilFlare: { type: Number, default: 0 },
    noseTipAngle: { type: Number, default: 0 },
    // Forehead
    foreheadHeight: { type: Number, default: 0 },
    foreheadWidth: { type: Number, default: 0 },
    foreheadSlope: { type: Number, default: 0 },
    browRidgeProminence: { type: Number, default: 0 },
    // Eyes
    eyeSpacing: { type: Number, default: 0 },
    eyeSize: { type: Number, default: 0 },
    eyeDepth: { type: Number, default: 0 },
    eyeTilt: { type: Number, default: 0 },
    // Mouth
    mouthWidth: { type: Number, default: 0 },
    lipFullness: { type: Number, default: 0 },
    philtrumDepth: { type: Number, default: 0 },
    // Overall
    facialWidth: { type: Number, default: 0 },
    facialLength: { type: Number, default: 0 },
    asymmetry: { type: Number, default: 0 },
    // Age effects
    skinSagging: { type: Number, default: 0 },
    wrinkleDepth: { type: Number, default: 0 },
    fatLoss: { type: Number, default: 0 }
  },
  // Landmarks (68-point facial landmarks)
  landmarks: [{
    id: Number,
    name: String,
    position: {
      x: Number,
      y: Number,
      z: Number
    }
  }],
  // Region definitions
  regions: {
    type: Map,
    of: [Number]
  },
  // Textures and materials
  materials: [{
    name: String,
    color: String,
    metalness: Number,
    roughness: Number,
    textureMap: String
  }],
  // Export formats available
  exportFormats: [{
    format: String,
    path: String,
    exportedAt: Date
  }],
  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  isBaseMesh: {
    type: Boolean,
    default: false
  },
  parentMesh: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mesh'
  },
  // Statistics
  stats: {
    editCount: { type: Number, default: 0 },
    lastEditDuration: Number,
    totalEditTime: { type: Number, default: 0 }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes
meshSchema.index({ case: 1, version: -1 });
meshSchema.index({ createdBy: 1 });
meshSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Mesh', meshSchema);
