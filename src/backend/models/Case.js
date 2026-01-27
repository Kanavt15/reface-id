const mongoose = require('mongoose');

const caseSchema = new mongoose.Schema({
  caseNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'pending_review', 'closed', 'archived'],
    default: 'open'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  // Subject information
  subject: {
    estimatedAge: {
      min: Number,
      max: Number
    },
    estimatedGender: {
      type: String,
      enum: ['male', 'female', 'unknown']
    },
    estimatedEthnicity: String,
    distinguishingFeatures: [String],
    notes: String
  },
  // Reference data
  referenceData: {
    skullScans: [{
      filename: String,
      format: String,
      uploadedAt: Date,
      path: String
    }],
    photographs: [{
      filename: String,
      description: String,
      uploadedAt: Date,
      path: String
    }],
    measurements: {
      cranialLength: Number,
      cranialWidth: Number,
      facialHeight: Number,
      nasalWidth: Number,
      orbitalWidth: Number,
      mandibleWidth: Number
    }
  },
  // Current reconstruction mesh
  currentMesh: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mesh'
  },
  // All mesh versions
  meshVersions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mesh'
  }],
  // Team assignment
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Metadata
  jurisdiction: String,
  agency: String,
  externalCaseId: String,
  tags: [String],
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  closedAt: Date
}, {
  timestamps: true
});

// Indexes
caseSchema.index({ caseNumber: 1 });
caseSchema.index({ status: 1 });
caseSchema.index({ assignedTo: 1 });
caseSchema.index({ createdBy: 1 });
caseSchema.index({ createdAt: -1 });
caseSchema.index({ tags: 1 });

// Generate case number before saving
caseSchema.pre('save', async function(next) {
  if (this.isNew && !this.caseNumber) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments();
    this.caseNumber = `RF-${year}-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Case', caseSchema);
