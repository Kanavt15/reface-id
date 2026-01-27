const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

// Import routes
const authRoutes = require('./routes/auth');
const caseRoutes = require('./routes/cases');
const meshRoutes = require('./routes/meshes');
const userRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');

// Import middleware
const { authMiddleware } = require('./middleware/auth');
const { auditMiddleware } = require('./middleware/audit');
const { errorHandler } = require('./middleware/error');

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/reface';

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Static files for mesh storage
app.use('/meshes', express.static(path.join(__dirname, '../../data/meshes')));
app.use('/exports', express.static(path.join(__dirname, '../../data/exports')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Public routes
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/cases', authMiddleware, auditMiddleware, caseRoutes);
app.use('/api/meshes', authMiddleware, auditMiddleware, meshRoutes);
app.use('/api/users', authMiddleware, auditMiddleware, userRoutes);
app.use('/api/audit', authMiddleware, auditRoutes);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Database connection and server start
async function startServer() {
  try {
    // Connect to MongoDB (with offline fallback)
    try {
      await mongoose.connect(MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log('📦 Connected to MongoDB');
    } catch (dbError) {
      console.warn('⚠️  MongoDB connection failed. Running in offline mode.');
      console.warn('   Some features may be limited.');
    }

    // Start server
    app.listen(PORT, () => {
      console.log(`\n🚀 REface Backend Server`);
      console.log(`   Version: 1.0.0`);
      console.log(`   Port: ${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   API: http://localhost:${PORT}/api`);
      console.log(`\n⚠️  FORENSIC FACIAL APPROXIMATION ONLY`);
      console.log(`   Not for identity verification\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

startServer();

module.exports = app;
