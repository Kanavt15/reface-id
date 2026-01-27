const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  // Action information
  action: {
    type: String,
    required: true,
    enum: [
      // Auth actions
      'login', 'logout', 'login_failed', 'password_change',
      // Case actions
      'case_create', 'case_view', 'case_update', 'case_delete', 
      'case_assign', 'case_status_change', 'case_export',
      // Mesh actions
      'mesh_create', 'mesh_update', 'mesh_delete', 'mesh_export',
      'mesh_version_save', 'mesh_version_load',
      // Parameter actions
      'parameters_update', 'parameters_reset',
      // User management
      'user_create', 'user_update', 'user_delete', 'user_role_change',
      // System actions
      'system_settings_change', 'system_backup', 'system_restore'
    ]
  },
  category: {
    type: String,
    enum: ['auth', 'case', 'mesh', 'user', 'system'],
    required: true
  },
  // Actor
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  username: String,
  userRole: String,
  // Target
  resourceType: {
    type: String,
    enum: ['user', 'case', 'mesh', 'system']
  },
  resourceId: mongoose.Schema.Types.ObjectId,
  resourceName: String,
  // Request details
  ipAddress: String,
  userAgent: String,
  endpoint: String,
  method: String,
  // Change details
  previousState: mongoose.Schema.Types.Mixed,
  newState: mongoose.Schema.Types.Mixed,
  changes: [{
    field: String,
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed
  }],
  // Status
  success: {
    type: Boolean,
    default: true
  },
  errorMessage: String,
  // Metadata
  metadata: mongoose.Schema.Types.Mixed,
  // Timestamp
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: false
});

// Indexes for efficient querying
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ user: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ category: 1, timestamp: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });
auditLogSchema.index({ success: 1 });

// Static method to create audit log entry
auditLogSchema.statics.log = async function(data) {
  try {
    const entry = new this(data);
    await entry.save();
    return entry;
  } catch (error) {
    console.error('Failed to create audit log:', error);
    // Don't throw - audit logging should not break the application
  }
};

// Static method to get recent activity for a user
auditLogSchema.statics.getUserActivity = function(userId, limit = 50) {
  return this.find({ user: userId })
    .sort({ timestamp: -1 })
    .limit(limit)
    .exec();
};

// Static method to get activity for a case
auditLogSchema.statics.getCaseActivity = function(caseId, limit = 100) {
  return this.find({ 
    resourceType: 'case', 
    resourceId: caseId 
  })
    .sort({ timestamp: -1 })
    .limit(limit)
    .populate('user', 'username name')
    .exec();
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
