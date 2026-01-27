const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'reface-forensic-secret-key-change-in-production';
const JWT_EXPIRES_IN = '24h';

/**
 * POST /api/auth/login
 * Authenticate user and return JWT token
 */
router.post('/login', [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation Error',
        details: errors.array() 
      });
    }

    const { username, password } = req.body;

    // Find user
    let user = await User.findOne({ 
      $or: [{ username }, { email: username }] 
    });

    // Demo/fallback user for offline mode
    if (!user) {
      if (username === 'admin' && password === 'admin123') {
        // Create demo admin user
        user = {
          _id: 'demo-admin',
          username: 'admin',
          name: 'System Administrator',
          email: 'admin@reface.local',
          role: 'admin',
          department: 'System Administration'
        };
      } else if (username === 'expert' && password === 'expert123') {
        // Create demo forensic expert
        user = {
          _id: 'demo-expert',
          username: 'expert',
          name: 'Dr. Demo Expert',
          email: 'expert@reface.local',
          role: 'forensic_expert',
          department: 'Forensic Science Division'
        };
      } else {
        return res.status(401).json({ 
          error: 'Authentication Failed',
          message: 'Invalid username or password' 
        });
      }
    } else {
      // Verify password for real users
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        return res.status(401).json({ 
          error: 'Authentication Failed',
          message: 'Invalid username or password' 
        });
      }
    }

    // Generate token
    const token = jwt.sign(
      { 
        userId: user._id,
        username: user.username,
        role: user.role 
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Return user info and token
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Server Error',
      message: 'An error occurred during authentication' 
    });
  }
});

/**
 * GET /api/auth/verify
 * Verify JWT token validity
 */
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'No Token',
        message: 'Authorization token required' 
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    res.json({ 
      valid: true,
      user: {
        userId: decoded.userId,
        username: decoded.username,
        role: decoded.role
      }
    });
  } catch (error) {
    res.status(401).json({ 
      error: 'Invalid Token',
      message: 'Token is invalid or expired' 
    });
  }
});

/**
 * POST /api/auth/register
 * Register new user (admin only in production)
 */
router.post('/register', [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('email').isEmail().withMessage('Valid email required'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('role').isIn(['admin', 'forensic_expert', 'viewer']).withMessage('Invalid role')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation Error',
        details: errors.array() 
      });
    }

    const { username, password, email, name, role, department } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ 
      $or: [{ username }, { email }] 
    });

    if (existingUser) {
      return res.status(409).json({ 
        error: 'User Exists',
        message: 'Username or email already registered' 
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const user = new User({
      username,
      password: hashedPassword,
      email,
      name,
      role,
      department
    });

    await user.save();

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      error: 'Server Error',
      message: 'An error occurred during registration' 
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout user (client-side token removal)
 */
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

/**
 * POST /api/auth/change-password
 * Change user password
 */
router.post('/change-password', [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation Error',
        details: errors.array() 
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { currentPassword, newPassword } = req.body;

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
