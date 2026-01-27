const express = require('express');
const AuditLog = require('../models/AuditLog');

const router = express.Router();

/**
 * Middleware to check admin role
 */
const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

/**
 * GET /api/audit
 * Get audit logs with filtering (admin only)
 */
router.get('/', adminOnly, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 100,
      category,
      action,
      userId,
      resourceType,
      resourceId,
      startDate,
      endDate,
      success
    } = req.query;

    const filter = {};

    if (category) filter.category = category;
    if (action) filter.action = action;
    if (userId) filter.user = userId;
    if (resourceType) filter.resourceType = resourceType;
    if (resourceId) filter.resourceId = resourceId;
    if (success !== undefined) filter.success = success === 'true';

    // Date range filter
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate);
      if (endDate) filter.timestamp.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate('user', 'name username')
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      AuditLog.countDocuments(filter)
    ]);

    res.json({
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

/**
 * GET /api/audit/stats
 * Get audit log statistics (admin only)
 */
router.get('/stats', adminOnly, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const [
      totalLogs,
      byCategory,
      byAction,
      recentFailures,
      dailyActivity
    ] = await Promise.all([
      // Total logs in period
      AuditLog.countDocuments({ timestamp: { $gte: startDate } }),
      
      // Group by category
      AuditLog.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      
      // Group by action
      AuditLog.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      
      // Recent failures
      AuditLog.find({ 
        success: false, 
        timestamp: { $gte: startDate } 
      })
        .sort({ timestamp: -1 })
        .limit(10)
        .populate('user', 'username')
        .lean(),
      
      // Daily activity
      AuditLog.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ])
    ]);

    res.json({
      period: { days: parseInt(days), startDate },
      totalLogs,
      byCategory: byCategory.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      topActions: byAction,
      recentFailures,
      dailyActivity
    });
  } catch (error) {
    console.error('Error fetching audit stats:', error);
    res.status(500).json({ error: 'Failed to fetch audit stats' });
  }
});

/**
 * GET /api/audit/user/:userId
 * Get audit logs for specific user (admin only)
 */
router.get('/user/:userId', adminOnly, async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const logs = await AuditLog.getUserActivity(req.params.userId, parseInt(limit));
    res.json(logs);
  } catch (error) {
    console.error('Error fetching user audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch user audit logs' });
  }
});

/**
 * GET /api/audit/case/:caseId
 * Get audit logs for specific case
 */
router.get('/case/:caseId', async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const logs = await AuditLog.getCaseActivity(req.params.caseId, parseInt(limit));
    res.json(logs);
  } catch (error) {
    console.error('Error fetching case audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch case audit logs' });
  }
});

/**
 * GET /api/audit/export
 * Export audit logs (admin only)
 */
router.get('/export', adminOnly, async (req, res) => {
  try {
    const { startDate, endDate, format = 'json' } = req.query;

    const filter = {};
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate);
      if (endDate) filter.timestamp.$lte = new Date(endDate);
    }

    const logs = await AuditLog.find(filter)
      .populate('user', 'name username')
      .sort({ timestamp: -1 })
      .lean();

    if (format === 'csv') {
      // Generate CSV
      const headers = ['Timestamp', 'Action', 'Category', 'User', 'Resource', 'Success'];
      const rows = logs.map(log => [
        log.timestamp.toISOString(),
        log.action,
        log.category,
        log.username || 'System',
        log.resourceName || log.resourceId || '',
        log.success ? 'Yes' : 'No'
      ]);

      const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=audit-log.csv');
      return res.send(csv);
    }

    res.json(logs);
  } catch (error) {
    console.error('Error exporting audit logs:', error);
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

module.exports = router;
