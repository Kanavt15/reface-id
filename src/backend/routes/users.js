const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
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
 * GET /api/users
 * List all users (admin only)
 */
router.get('/', adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50, role, isActive, search } = req.query;

    const filter = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      User.countDocuments(filter)
    ]);

    res.json({
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * GET /api/users/:id
 * Get user by ID
 */
router.get('/:id', async (req, res) => {
  try {
    // Users can view their own profile, admins can view anyone
    if (req.params.id !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = await User.findById(req.params.id).select('-password').lean();
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * POST /api/users
 * Create new user (admin only)
 */
router.post('/', adminOnly, [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('email').isEmail().withMessage('Valid email required'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('role').isIn(['admin', 'forensic_expert', 'viewer']).withMessage('Invalid role')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation Error', details: errors.array() });
    }

    const { username, password, email, name, role, department } = req.body;

    // Check existing
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = new User({
      username,
      password: hashedPassword,
      email,
      name,
      role,
      department
    });

    await user.save();

    // Log creation
    await AuditLog.log({
      action: 'user_create',
      category: 'user',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'user',
      resourceId: user._id,
      resourceName: user.username
    });

    res.status(201).json({
      id: user._id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * PUT /api/users/:id
 * Update user
 */
router.put('/:id', async (req, res) => {
  try {
    // Users can update their own profile (limited fields), admins can update anyone
    const isSelf = req.params.id === req.user.userId;
    const isAdmin = req.user.role === 'admin';

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { name, email, department, role, isActive } = req.body;
    const changes = [];

    // All users can update these
    if (name && name !== user.name) {
      changes.push({ field: 'name', oldValue: user.name, newValue: name });
      user.name = name;
    }
    if (email && email !== user.email) {
      changes.push({ field: 'email', oldValue: user.email, newValue: email });
      user.email = email;
    }
    if (department !== undefined && department !== user.department) {
      changes.push({ field: 'department', oldValue: user.department, newValue: department });
      user.department = department;
    }

    // Only admins can update these
    if (isAdmin) {
      if (role && role !== user.role) {
        changes.push({ field: 'role', oldValue: user.role, newValue: role });
        user.role = role;

        // Log role change separately
        await AuditLog.log({
          action: 'user_role_change',
          category: 'user',
          user: req.user.userId,
          username: req.user.username,
          userRole: req.user.role,
          resourceType: 'user',
          resourceId: user._id,
          resourceName: user.username,
          changes: [{ field: 'role', oldValue: user.role, newValue: role }]
        });
      }
      if (isActive !== undefined && isActive !== user.isActive) {
        changes.push({ field: 'isActive', oldValue: user.isActive, newValue: isActive });
        user.isActive = isActive;
      }
    }

    await user.save();

    // Log update
    if (changes.length > 0) {
      await AuditLog.log({
        action: 'user_update',
        category: 'user',
        user: req.user.userId,
        username: req.user.username,
        userRole: req.user.role,
        resourceType: 'user',
        resourceId: user._id,
        resourceName: user.username,
        changes
      });
    }

    res.json({
      id: user._id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department,
      isActive: user.isActive
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * DELETE /api/users/:id
 * Delete user (admin only)
 */
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.deleteOne();

    // Log deletion
    await AuditLog.log({
      action: 'user_delete',
      category: 'user',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'user',
      resourceId: user._id,
      resourceName: user.username
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * GET /api/users/:id/activity
 * Get user activity log
 */
router.get('/:id/activity', async (req, res) => {
  try {
    // Users can view their own activity, admins can view anyone
    if (req.params.id !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { limit = 50 } = req.query;
    const activity = await AuditLog.getUserActivity(req.params.id, parseInt(limit));

    res.json(activity);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
