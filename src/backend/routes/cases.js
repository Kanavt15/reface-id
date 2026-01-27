const express = require('express');
const { body, query, validationResult } = require('express-validator');
const Case = require('../models/Case');
const Mesh = require('../models/Mesh');
const AuditLog = require('../models/AuditLog');

const router = express.Router();

/**
 * GET /api/cases
 * List all cases with pagination and filtering
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      priority,
      assignedTo,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const filter = {};
    
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (search) {
      filter.$or = [
        { caseNumber: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    // Role-based filtering
    if (req.user.role === 'viewer') {
      filter.$or = [
        { createdBy: req.user.userId },
        { reviewers: req.user.userId }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const [cases, total] = await Promise.all([
      Case.find(filter)
        .populate('assignedTo', 'name username')
        .populate('createdBy', 'name username')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Case.countDocuments(filter)
    ]);

    res.json({
      cases,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching cases:', error);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

/**
 * GET /api/cases/:id
 * Get case by ID with full details
 */
router.get('/:id', async (req, res) => {
  try {
    const caseDoc = await Case.findById(req.params.id)
      .populate('assignedTo', 'name username email')
      .populate('createdBy', 'name username email')
      .populate('reviewers', 'name username email')
      .populate('currentMesh')
      .lean();

    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Log view action
    await AuditLog.log({
      action: 'case_view',
      category: 'case',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'case',
      resourceId: caseDoc._id,
      resourceName: caseDoc.caseNumber
    });

    res.json(caseDoc);
  } catch (error) {
    console.error('Error fetching case:', error);
    res.status(500).json({ error: 'Failed to fetch case' });
  }
});

/**
 * POST /api/cases
 * Create new case
 */
router.post('/', [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('priority').optional().isIn(['low', 'medium', 'high', 'critical']),
  body('status').optional().isIn(['open', 'in_progress', 'pending_review', 'closed', 'archived'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation Error', details: errors.array() });
    }

    const caseData = {
      ...req.body,
      createdBy: req.user.userId
    };

    const newCase = new Case(caseData);
    await newCase.save();

    // Log creation
    await AuditLog.log({
      action: 'case_create',
      category: 'case',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'case',
      resourceId: newCase._id,
      resourceName: newCase.caseNumber,
      newState: newCase.toObject()
    });

    res.status(201).json(newCase);
  } catch (error) {
    console.error('Error creating case:', error);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

/**
 * PUT /api/cases/:id
 * Update case
 */
router.put('/:id', async (req, res) => {
  try {
    const caseDoc = await Case.findById(req.params.id);
    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const previousState = caseDoc.toObject();
    const updates = req.body;
    
    // Track changes
    const changes = [];
    for (const [key, value] of Object.entries(updates)) {
      if (JSON.stringify(caseDoc[key]) !== JSON.stringify(value)) {
        changes.push({
          field: key,
          oldValue: caseDoc[key],
          newValue: value
        });
      }
    }

    Object.assign(caseDoc, updates);
    caseDoc.updatedAt = new Date();
    await caseDoc.save();

    // Log update
    await AuditLog.log({
      action: 'case_update',
      category: 'case',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'case',
      resourceId: caseDoc._id,
      resourceName: caseDoc.caseNumber,
      previousState,
      newState: caseDoc.toObject(),
      changes
    });

    res.json(caseDoc);
  } catch (error) {
    console.error('Error updating case:', error);
    res.status(500).json({ error: 'Failed to update case' });
  }
});

/**
 * DELETE /api/cases/:id
 * Delete case (admin only)
 */
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const caseDoc = await Case.findById(req.params.id);
    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Delete associated meshes
    await Mesh.deleteMany({ case: caseDoc._id });
    
    await caseDoc.deleteOne();

    // Log deletion
    await AuditLog.log({
      action: 'case_delete',
      category: 'case',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'case',
      resourceId: caseDoc._id,
      resourceName: caseDoc.caseNumber,
      previousState: caseDoc.toObject()
    });

    res.json({ message: 'Case deleted successfully' });
  } catch (error) {
    console.error('Error deleting case:', error);
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

/**
 * PUT /api/cases/:id/status
 * Update case status
 */
router.put('/:id/status', [
  body('status').isIn(['open', 'in_progress', 'pending_review', 'closed', 'archived'])
], async (req, res) => {
  try {
    const caseDoc = await Case.findById(req.params.id);
    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const previousStatus = caseDoc.status;
    caseDoc.status = req.body.status;
    
    if (req.body.status === 'closed') {
      caseDoc.closedAt = new Date();
    }
    
    await caseDoc.save();

    // Log status change
    await AuditLog.log({
      action: 'case_status_change',
      category: 'case',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'case',
      resourceId: caseDoc._id,
      resourceName: caseDoc.caseNumber,
      changes: [{
        field: 'status',
        oldValue: previousStatus,
        newValue: req.body.status
      }]
    });

    res.json(caseDoc);
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * PUT /api/cases/:id/assign
 * Assign case to user
 */
router.put('/:id/assign', [
  body('userId').notEmpty().withMessage('User ID required')
], async (req, res) => {
  try {
    const caseDoc = await Case.findById(req.params.id);
    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const previousAssignee = caseDoc.assignedTo;
    caseDoc.assignedTo = req.body.userId;
    await caseDoc.save();

    await caseDoc.populate('assignedTo', 'name username');

    // Log assignment
    await AuditLog.log({
      action: 'case_assign',
      category: 'case',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'case',
      resourceId: caseDoc._id,
      resourceName: caseDoc.caseNumber,
      changes: [{
        field: 'assignedTo',
        oldValue: previousAssignee,
        newValue: req.body.userId
      }]
    });

    res.json(caseDoc);
  } catch (error) {
    console.error('Error assigning case:', error);
    res.status(500).json({ error: 'Failed to assign case' });
  }
});

/**
 * GET /api/cases/:id/activity
 * Get case activity/audit log
 */
router.get('/:id/activity', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    
    const activity = await AuditLog.getCaseActivity(
      req.params.id, 
      parseInt(limit)
    );

    res.json(activity);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
