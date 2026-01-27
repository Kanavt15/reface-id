const AuditLog = require('../models/AuditLog');

/**
 * Audit middleware
 * Logs all API requests for audit trail
 */
const auditMiddleware = async (req, res, next) => {
  // Store original end function
  const originalEnd = res.end;
  const startTime = Date.now();

  // Override end to capture response
  res.end = function(chunk, encoding) {
    // Restore original end
    res.end = originalEnd;

    // Calculate duration
    const duration = Date.now() - startTime;

    // Log the request (non-blocking)
    logRequest(req, res, duration).catch(err => {
      console.error('Audit logging error:', err);
    });

    // Call original end
    return res.end(chunk, encoding);
  };

  next();
};

/**
 * Log request to audit database
 */
async function logRequest(req, res, duration) {
  // Skip health check and other non-important endpoints
  const skipPaths = ['/api/health', '/api/status', '/favicon.ico'];
  if (skipPaths.some(path => req.path.startsWith(path))) {
    return;
  }

  // Determine action and category from request
  const { action, category, resourceType } = determineAction(req);

  // Skip if we couldn't determine an action
  if (!action) return;

  const logEntry = {
    action,
    category,
    user: req.user?.userId,
    username: req.user?.username,
    userRole: req.user?.role,
    resourceType,
    resourceId: extractResourceId(req),
    ipAddress: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
    endpoint: req.path,
    method: req.method,
    success: res.statusCode < 400,
    metadata: {
      statusCode: res.statusCode,
      duration,
      query: req.query,
      // Don't log sensitive body data
      bodyKeys: req.body ? Object.keys(req.body) : []
    }
  };

  if (res.statusCode >= 400) {
    logEntry.errorMessage = `HTTP ${res.statusCode}`;
  }

  await AuditLog.log(logEntry);
}

/**
 * Determine action and category from request
 */
function determineAction(req) {
  const path = req.path;
  const method = req.method;

  // Auth routes
  if (path.includes('/auth/login')) {
    return { action: 'login', category: 'auth', resourceType: 'user' };
  }
  if (path.includes('/auth/logout')) {
    return { action: 'logout', category: 'auth', resourceType: 'user' };
  }

  // Case routes
  if (path.includes('/cases')) {
    const resourceType = 'case';
    const category = 'case';

    if (path.includes('/status')) {
      return { action: 'case_status_change', category, resourceType };
    }
    if (path.includes('/assign')) {
      return { action: 'case_assign', category, resourceType };
    }
    if (path.includes('/export')) {
      return { action: 'case_export', category, resourceType };
    }

    switch (method) {
      case 'GET':
        return { action: 'case_view', category, resourceType };
      case 'POST':
        return { action: 'case_create', category, resourceType };
      case 'PUT':
      case 'PATCH':
        return { action: 'case_update', category, resourceType };
      case 'DELETE':
        return { action: 'case_delete', category, resourceType };
    }
  }

  // Mesh routes
  if (path.includes('/meshes')) {
    const resourceType = 'mesh';
    const category = 'mesh';

    if (path.includes('/parameters')) {
      return { action: 'parameters_update', category, resourceType };
    }
    if (path.includes('/export')) {
      return { action: 'mesh_export', category, resourceType };
    }

    switch (method) {
      case 'GET':
        return { action: 'mesh_version_load', category, resourceType };
      case 'POST':
        return { action: 'mesh_version_save', category, resourceType };
      case 'PUT':
      case 'PATCH':
        return { action: 'mesh_update', category, resourceType };
      case 'DELETE':
        return { action: 'mesh_delete', category, resourceType };
    }
  }

  // User routes
  if (path.includes('/users')) {
    const resourceType = 'user';
    const category = 'user';

    switch (method) {
      case 'POST':
        return { action: 'user_create', category, resourceType };
      case 'PUT':
      case 'PATCH':
        return { action: 'user_update', category, resourceType };
      case 'DELETE':
        return { action: 'user_delete', category, resourceType };
    }
  }

  return {};
}

/**
 * Extract resource ID from request
 */
function extractResourceId(req) {
  // Try to get ID from params
  if (req.params.id) return req.params.id;
  if (req.params.caseId) return req.params.caseId;
  if (req.params.userId) return req.params.userId;

  // Try to get from body for POST requests
  if (req.method === 'POST' && req.body?.id) return req.body.id;

  return null;
}

module.exports = { auditMiddleware };
