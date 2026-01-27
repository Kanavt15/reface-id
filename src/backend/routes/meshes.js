const express = require('express');
const { body, validationResult } = require('express-validator');
const Mesh = require('../models/Mesh');
const Case = require('../models/Case');
const AuditLog = require('../models/AuditLog');

const router = express.Router();

/**
 * GET /api/meshes/case/:caseId
 * Get all mesh versions for a case
 */
router.get('/case/:caseId', async (req, res) => {
  try {
    const meshes = await Mesh.find({ case: req.params.caseId })
      .select('-geometry.vertices -geometry.indices -geometry.normals -geometry.uvs')
      .populate('createdBy', 'name username')
      .sort({ version: -1 })
      .lean();

    res.json(meshes);
  } catch (error) {
    console.error('Error fetching meshes:', error);
    res.status(500).json({ error: 'Failed to fetch meshes' });
  }
});

/**
 * GET /api/meshes/:id
 * Get mesh by ID with full geometry
 */
router.get('/:id', async (req, res) => {
  try {
    const mesh = await Mesh.findById(req.params.id)
      .populate('createdBy', 'name username')
      .lean();

    if (!mesh) {
      return res.status(404).json({ error: 'Mesh not found' });
    }

    // Convert buffer to array for JSON response
    if (mesh.geometry) {
      if (mesh.geometry.vertices) {
        mesh.geometry.vertices = Array.from(new Float32Array(mesh.geometry.vertices.buffer));
      }
      if (mesh.geometry.indices) {
        mesh.geometry.indices = Array.from(new Uint32Array(mesh.geometry.indices.buffer));
      }
      if (mesh.geometry.normals) {
        mesh.geometry.normals = Array.from(new Float32Array(mesh.geometry.normals.buffer));
      }
      if (mesh.geometry.uvs) {
        mesh.geometry.uvs = Array.from(new Float32Array(mesh.geometry.uvs.buffer));
      }
    }

    res.json(mesh);
  } catch (error) {
    console.error('Error fetching mesh:', error);
    res.status(500).json({ error: 'Failed to fetch mesh' });
  }
});

/**
 * POST /api/meshes
 * Create new mesh version
 */
router.post('/', [
  body('caseId').notEmpty().withMessage('Case ID required'),
  body('geometry').notEmpty().withMessage('Geometry data required'),
  body('parameters').optional().isObject()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation Error', details: errors.array() });
    }

    const { caseId, geometry, parameters, name, description, landmarks } = req.body;

    // Verify case exists
    const caseDoc = await Case.findById(caseId);
    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Get next version number
    const latestMesh = await Mesh.findOne({ case: caseId })
      .sort({ version: -1 })
      .select('version');
    
    const version = latestMesh ? latestMesh.version + 1 : 1;

    // Convert arrays to buffers for storage
    const geometryData = {
      vertices: Buffer.from(new Float32Array(geometry.vertices).buffer),
      vertexCount: geometry.vertices.length / 3,
      format: 'float32'
    };

    if (geometry.indices) {
      geometryData.indices = Buffer.from(new Uint32Array(geometry.indices).buffer);
      geometryData.faceCount = geometry.indices.length / 3;
    }
    if (geometry.normals) {
      geometryData.normals = Buffer.from(new Float32Array(geometry.normals).buffer);
    }
    if (geometry.uvs) {
      geometryData.uvs = Buffer.from(new Float32Array(geometry.uvs).buffer);
    }

    const mesh = new Mesh({
      case: caseId,
      version,
      name: name || `Version ${version}`,
      description,
      geometry: geometryData,
      parameters: parameters || {},
      landmarks: landmarks || [],
      createdBy: req.user.userId,
      parentMesh: latestMesh?._id
    });

    await mesh.save();

    // Update case with current mesh
    caseDoc.currentMesh = mesh._id;
    caseDoc.meshVersions.push(mesh._id);
    await caseDoc.save();

    // Log creation
    await AuditLog.log({
      action: 'mesh_version_save',
      category: 'mesh',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'mesh',
      resourceId: mesh._id,
      resourceName: `${caseDoc.caseNumber} v${version}`,
      metadata: {
        caseId,
        version,
        vertexCount: geometryData.vertexCount
      }
    });

    // Return without full geometry
    const response = mesh.toObject();
    delete response.geometry;
    
    res.status(201).json(response);
  } catch (error) {
    console.error('Error creating mesh:', error);
    res.status(500).json({ error: 'Failed to create mesh' });
  }
});

/**
 * PUT /api/meshes/:id
 * Update mesh
 */
router.put('/:id', async (req, res) => {
  try {
    const mesh = await Mesh.findById(req.params.id);
    if (!mesh) {
      return res.status(404).json({ error: 'Mesh not found' });
    }

    const { geometry, parameters, name, description } = req.body;

    if (geometry) {
      mesh.geometry.vertices = Buffer.from(new Float32Array(geometry.vertices).buffer);
      mesh.geometry.vertexCount = geometry.vertices.length / 3;
      
      if (geometry.indices) {
        mesh.geometry.indices = Buffer.from(new Uint32Array(geometry.indices).buffer);
      }
      if (geometry.normals) {
        mesh.geometry.normals = Buffer.from(new Float32Array(geometry.normals).buffer);
      }
    }

    if (parameters) {
      mesh.parameters = { ...mesh.parameters, ...parameters };
    }

    if (name) mesh.name = name;
    if (description) mesh.description = description;

    mesh.stats.editCount += 1;
    mesh.updatedAt = new Date();

    await mesh.save();

    // Log update
    await AuditLog.log({
      action: 'mesh_update',
      category: 'mesh',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'mesh',
      resourceId: mesh._id
    });

    const response = mesh.toObject();
    delete response.geometry;
    
    res.json(response);
  } catch (error) {
    console.error('Error updating mesh:', error);
    res.status(500).json({ error: 'Failed to update mesh' });
  }
});

/**
 * PUT /api/meshes/:id/parameters
 * Update mesh parameters
 */
router.put('/:id/parameters', async (req, res) => {
  try {
    const mesh = await Mesh.findById(req.params.id);
    if (!mesh) {
      return res.status(404).json({ error: 'Mesh not found' });
    }

    const previousParams = { ...mesh.parameters };
    mesh.parameters = { ...mesh.parameters, ...req.body.parameters };
    mesh.stats.editCount += 1;
    
    await mesh.save();

    // Log parameter update
    await AuditLog.log({
      action: 'parameters_update',
      category: 'mesh',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'mesh',
      resourceId: mesh._id,
      previousState: { parameters: previousParams },
      newState: { parameters: mesh.parameters }
    });

    res.json({ parameters: mesh.parameters });
  } catch (error) {
    console.error('Error updating parameters:', error);
    res.status(500).json({ error: 'Failed to update parameters' });
  }
});

/**
 * DELETE /api/meshes/:id
 * Delete mesh version
 */
router.delete('/:id', async (req, res) => {
  try {
    const mesh = await Mesh.findById(req.params.id);
    if (!mesh) {
      return res.status(404).json({ error: 'Mesh not found' });
    }

    // Remove from case
    await Case.updateOne(
      { _id: mesh.case },
      { $pull: { meshVersions: mesh._id } }
    );

    await mesh.deleteOne();

    // Log deletion
    await AuditLog.log({
      action: 'mesh_delete',
      category: 'mesh',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'mesh',
      resourceId: mesh._id
    });

    res.json({ message: 'Mesh deleted successfully' });
  } catch (error) {
    console.error('Error deleting mesh:', error);
    res.status(500).json({ error: 'Failed to delete mesh' });
  }
});

/**
 * POST /api/meshes/:id/export
 * Export mesh to specified format
 */
router.post('/:id/export', [
  body('format').isIn(['gltf', 'glb', 'obj', 'stl', 'ply'])
], async (req, res) => {
  try {
    const mesh = await Mesh.findById(req.params.id);
    if (!mesh) {
      return res.status(404).json({ error: 'Mesh not found' });
    }

    const { format } = req.body;

    // Get geometry data
    const vertices = new Float32Array(mesh.geometry.vertices.buffer);
    const indices = mesh.geometry.indices 
      ? new Uint32Array(mesh.geometry.indices.buffer) 
      : null;
    const normals = mesh.geometry.normals 
      ? new Float32Array(mesh.geometry.normals.buffer) 
      : null;

    // Log export
    await AuditLog.log({
      action: 'mesh_export',
      category: 'mesh',
      user: req.user.userId,
      username: req.user.username,
      userRole: req.user.role,
      resourceType: 'mesh',
      resourceId: mesh._id,
      metadata: { format }
    });

    // Return geometry for client-side export
    res.json({
      geometry: {
        vertices: Array.from(vertices),
        indices: indices ? Array.from(indices) : null,
        normals: normals ? Array.from(normals) : null
      },
      parameters: mesh.parameters,
      format
    });
  } catch (error) {
    console.error('Error exporting mesh:', error);
    res.status(500).json({ error: 'Failed to export mesh' });
  }
});

module.exports = router;
