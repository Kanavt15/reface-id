#!/usr/bin/env python3
"""
REFACE - Forensic Facial Reconstruction Tool
Version 2.0

A desktop application for forensic facial reconstruction using parametric
mesh deformation. Works with any humanoid face mesh using geometric landmark
detection and mathematical deformations.

Author: REFACE Development Team
"""

import sys
import json
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any

import trimesh
from scipy.spatial import cKDTree

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QSplitter, QTabWidget, QSlider, QLabel, QPushButton, QCheckBox,
    QFileDialog, QMessageBox, QGroupBox, QScrollArea, QFrame,
    QSpinBox, QDoubleSpinBox, QComboBox, QToolBar, QStatusBar,
    QMenu, QMenuBar, QColorDialog, QListWidget, QListWidgetItem,
    QInputDialog
)
from PyQt6.QtCore import Qt, QTimer, pyqtSignal, QPoint
from PyQt6.QtGui import QAction, QKeySequence, QFont, QColor, QPixmap, QIcon

import pyqtgraph.opengl as gl
from pyqtgraph.opengl import GLViewWidget


# =============================================================================
# CONSTANTS AND CONFIGURATION
# =============================================================================

APP_NAME = "REFACE - Forensic Facial Reconstruction"
APP_VERSION = "2.0"
DEFAULT_MODEL = "head.glb"

# Model-specific configuration (for Untitled.glb)
# X: Left (-0.9566) to Right (+0.9566) - HORIZONTAL
# Y: Bottom (-1.7372) to Top (+1.3854) - VERTICAL
# Z: Back (-0.9321) to Front (+1.2969) - DEPTH (front is positive Z)
MODEL_CONFIG = {
    'face_y_min': -0.80,   # Below this is body/shoulders
    'face_y_max': 1.30,    # Above this is top of head
    'scale_factor': 0.19,  # Max displacement per 100% slider (~3.75x original)
    'z_front_direction': 1, # Positive = forward in this model
    'radius_scale': 3.5,   # Scale factor for influence radii
    'transition_width': 0.075,  # Smooth center-line transition width
    'boundary_falloff': 0.19,   # Smooth falloff at face boundaries
}

# Skin tone presets (RGB values 0-1)
SKIN_TONE_PRESETS = {
    'Fair': (0.95, 0.87, 0.79),
    'Light': (0.91, 0.81, 0.71),
    'Medium Light': (0.87, 0.74, 0.63),
    'Medium': (0.78, 0.63, 0.52),
    'Medium Dark': (0.68, 0.52, 0.40),
    'Dark': (0.55, 0.40, 0.30),
    'Deep': (0.42, 0.30, 0.22),
    'Ebony': (0.30, 0.22, 0.17),
}

# Mole/mark presets
MARK_COLORS = {
    'Dark Brown': (0.25, 0.15, 0.10),
    'Light Brown': (0.45, 0.30, 0.20),
    'Black': (0.15, 0.10, 0.08),
    'Red (Birthmark)': (0.6, 0.25, 0.25),
}

# Scar color (slightly lighter/pinker than skin)
SCAR_COLOR_OFFSET = (0.1, 0.05, 0.05)

# Hair models list and color presets
HAIR_MODELS = [
    ("Style 1", "hair_mesh.glb"),
    ("Style 2", "hair2_mesh.glb"),
    ("Style 3", "hair2.glb"),
]
HAIR_COLOR_PRESETS = {
    'Black': (0.05, 0.05, 0.05),
    'Dark Brown': (0.20, 0.12, 0.06),
    'Brown': (0.35, 0.20, 0.10),
    'Light Brown': (0.50, 0.35, 0.20),
    'Blonde': (0.75, 0.60, 0.35),
    'Platinum': (0.85, 0.80, 0.70),
    'Red': (0.55, 0.15, 0.08),
    'Auburn': (0.45, 0.18, 0.10),
    'Gray': (0.55, 0.55, 0.55),
    'White': (0.85, 0.85, 0.85),
}

# Landmark positions adapted for Untitled.glb
# Coordinates: (X, Y, Z) where Z positive is front (nose tip)
LANDMARKS = {
    # JAW & CHIN
    'chin': (0.0, -0.60, 1.08),
    'chin_left': (-0.15, -0.55, 1.06),
    'chin_right': (0.15, -0.55, 1.06),
    'jaw_left': (-0.45, -0.45, 0.85),
    'jaw_right': (0.45, -0.45, 0.85),
    'jaw_angle_left': (-0.60, -0.35, 0.60),
    'jaw_angle_right': (0.60, -0.35, 0.60),

    # CHEEKS
    'cheek_left': (-0.40, -0.15, 0.95),
    'cheek_right': (0.40, -0.15, 0.95),
    'cheekbone_left': (-0.50, 0.05, 0.90),
    'cheekbone_right': (0.50, 0.05, 0.90),
    'lower_cheek_left': (-0.35, -0.30, 1.00),
    'lower_cheek_right': (0.35, -0.30, 1.00),

    # NOSE
    'nose_tip': (0.0, 0.02, 1.30),
    'nose_bridge': (0.0, 0.20, 1.19),
    'nose_bridge_top': (0.0, 0.30, 1.14),
    'nostril_left': (-0.12, -0.05, 1.15),
    'nostril_right': (0.12, -0.05, 1.15),
    'nose_base': (0.0, -0.08, 1.18),
    'alar_left': (-0.16, -0.03, 1.12),
    'alar_right': (0.16, -0.03, 1.12),

    # EYES
    'eye_left_outer': (-0.45, 0.22, 0.95),
    'eye_left_inner': (-0.15, 0.22, 1.05),
    'eye_right_inner': (0.15, 0.22, 1.05),
    'eye_right_outer': (0.45, 0.22, 0.95),
    'eye_left_center': (-0.30, 0.22, 1.00),
    'eye_right_center': (0.30, 0.22, 1.00),
    'eye_left_upper': (-0.30, 0.28, 1.02),
    'eye_left_lower': (-0.30, 0.16, 0.98),
    'eye_right_upper': (0.30, 0.28, 1.02),
    'eye_right_lower': (0.30, 0.16, 0.98),

    # BROWS
    'brow_left_inner': (-0.15, 0.38, 1.06),
    'brow_left_center': (-0.30, 0.40, 1.00),
    'brow_left_outer': (-0.45, 0.38, 0.90),
    'brow_right_inner': (0.15, 0.38, 1.06),
    'brow_right_center': (0.30, 0.40, 1.00),
    'brow_right_outer': (0.45, 0.38, 0.90),
    'glabella': (0.0, 0.38, 1.08),

    # FOREHEAD
    'forehead_center': (0.0, 0.60, 1.07),
    'forehead_left': (-0.35, 0.58, 0.98),
    'forehead_right': (0.35, 0.58, 0.98),
    'temple_left': (-0.60, 0.35, 0.70),
    'temple_right': (0.60, 0.35, 0.70),
    'hairline_center': (0.0, 0.90, 0.98),

    # MOUTH & LIPS
    'mouth_left': (-0.20, -0.30, 1.10),
    'mouth_right': (0.20, -0.30, 1.10),
    'upper_lip_center': (0.0, -0.25, 1.15),
    'upper_lip_left': (-0.08, -0.25, 1.14),
    'upper_lip_right': (0.08, -0.25, 1.14),
    'lower_lip_center': (0.0, -0.35, 1.13),
    'lower_lip_left': (-0.08, -0.35, 1.12),
    'lower_lip_right': (0.08, -0.35, 1.12),
    'cupid_bow_left': (-0.06, -0.23, 1.16),
    'cupid_bow_right': (0.06, -0.23, 1.16),
    'philtrum_top': (0.0, -0.15, 1.14),
    'philtrum_bottom': (0.0, -0.22, 1.16),

    # EARS
    'ear_left_top': (-0.78, 0.30, -0.05),
    'ear_left_center': (-0.85, 0.15, -0.10),
    'ear_left_bottom': (-0.78, 0.00, -0.05),
    'ear_right_top': (0.78, 0.30, -0.05),
    'ear_right_center': (0.85, 0.15, -0.10),
    'ear_right_bottom': (0.78, 0.00, -0.05),
    'tragus_left': (-0.72, 0.15, 0.10),
    'tragus_right': (0.72, 0.15, 0.10),

    # HEAD OVERALL
    'crown': (0.0, 1.35, 0.10),
    'occiput': (0.0, 0.50, -0.80),
    'skull_left': (-0.75, 0.50, -0.20),
    'skull_right': (0.75, 0.50, -0.20),
}


# =============================================================================
# FACE DEFORMER CLASS
# =============================================================================

class FaceDeformer:
    """
    Handles all mesh deformation operations using parametric transformations.
    Uses geometric landmark detection for model-agnostic operation.
    """

    def __init__(self, mesh_path: str):
        """Load mesh and initialize deformation system."""
        self.mesh_path = mesh_path
        self._load_mesh(mesh_path)
        self._build_spatial_index()
        self._detect_landmarks()
        self._create_face_mask()

    def _load_mesh(self, mesh_path: str) -> None:
        """Load the 3D mesh from file."""
        mesh = trimesh.load(mesh_path, force='mesh')
        self.original_vertices = mesh.vertices.copy().astype(np.float64)
        self.faces = mesh.faces.copy()
        self.vertex_count = len(self.original_vertices)
        self.face_count = len(self.faces)

    def _build_spatial_index(self) -> None:
        """Build KD-tree for fast spatial queries."""
        self.kdtree = cKDTree(self.original_vertices)

    def _detect_landmarks(self) -> None:
        """Detect facial landmarks using nearest-neighbor search."""
        self.landmark_indices = {}
        self.landmark_positions = {}

        for name, pos in LANDMARKS.items():
            pos_array = np.array(pos)
            distance, idx = self.kdtree.query(pos_array)
            self.landmark_indices[name] = idx
            self.landmark_positions[name] = self.original_vertices[idx].copy()

    def _create_face_mask(self) -> None:
        """Create mask to protect non-face regions from deformation."""
        y_coords = self.original_vertices[:, 1]

        # Smooth transition at boundaries
        y_min = MODEL_CONFIG['face_y_min']
        y_max = MODEL_CONFIG['face_y_max']
        falloff = MODEL_CONFIG.get('boundary_falloff', 0.05)

        # Create soft mask with smooth falloff
        self.face_mask = np.ones(self.vertex_count, dtype=np.float64)

        # Bottom falloff (chin/neck region)
        bottom_mask = y_coords < y_min + falloff
        bottom_factor = np.clip((y_coords - y_min) / falloff, 0, 1)
        self.face_mask = np.where(bottom_mask, bottom_factor, self.face_mask)

        # Top falloff (crown region)
        top_mask = y_coords > y_max - falloff
        top_factor = np.clip((y_max - y_coords) / falloff, 0, 1)
        self.face_mask = np.where(top_mask, top_factor, self.face_mask)

    def get_region_weights(self, landmark_names: List[str], radius: float,
                          falloff: str = 'gaussian') -> np.ndarray:
        """
        Calculate influence weights for vertices near given landmarks.

        Args:
            landmark_names: List of landmark names to use as influence centers
            radius: How far the influence extends
            falloff: Type of falloff ('gaussian', 'linear', 'smooth')

        Returns:
            Array of weights (0.0 to 1.0) for each vertex
        """
        # Apply model-specific radius scaling
        radius *= MODEL_CONFIG.get('radius_scale', 1.0)

        weights = np.zeros(self.vertex_count, dtype=np.float64)

        for name in landmark_names:
            if name not in self.landmark_positions:
                continue

            landmark_pos = self.landmark_positions[name]
            distances = np.linalg.norm(
                self.original_vertices - landmark_pos, axis=1
            )

            if falloff == 'gaussian':
                local_weights = np.exp(-(distances ** 2) / (2 * radius ** 2))
            elif falloff == 'linear':
                local_weights = np.maximum(0, 1 - distances / radius)
            elif falloff == 'smooth':
                # Smoothstep function
                t = np.clip(distances / radius, 0, 1)
                local_weights = 1 - (t * t * (3 - 2 * t))
            else:
                local_weights = np.exp(-(distances ** 2) / (2 * radius ** 2))

            weights = np.maximum(weights, local_weights)

        # Apply face mask
        weights *= self.face_mask

        return weights

    def get_directional_weights(self, landmark_names: List[str], radius: float,
                                direction: str = 'outward') -> Tuple[np.ndarray, np.ndarray]:
        """
        Get weights with directional component for symmetric deformations.
        Uses smooth transitions near the center line to avoid artifacts.

        Args:
            landmark_names: Landmark names to use as centers
            radius: Influence radius
            direction: 'outward' (expand), 'inward' (contract), or 'uniform'

        Returns:
            Tuple of (weights, direction_multipliers)
        """
        weights = self.get_region_weights(landmark_names, radius)

        # Use smooth transition near center instead of hard sign
        # This prevents the center-line artifact
        x_coords = self.original_vertices[:, 0]
        
        # Smooth transition width (adjust based on model scale)
        transition_width = MODEL_CONFIG.get('transition_width', 0.02)
        
        if direction == 'outward':
            # Smooth sign function using tanh for gradual transition
            # tanh approaches -1/+1 away from center, smooth through 0
            directions = np.tanh(x_coords / transition_width)
        elif direction == 'inward':
            directions = -np.tanh(x_coords / transition_width)
        else:
            directions = np.ones(self.vertex_count)

        return weights, directions

    def apply_deformations(self, params: Dict[str, float]) -> np.ndarray:
        """
        Apply all deformations based on parameter values.

        Args:
            params: Dictionary of parameter names to values (-100 to +100)

        Returns:
            Deformed vertex array
        """
        vertices = self.original_vertices.copy()
        scale = MODEL_CONFIG['scale_factor']
        z_dir = MODEL_CONFIG['z_front_direction']

        # =====================================================================
        # JAW & CHIN DEFORMATIONS
        # =====================================================================

        # Jaw Width - expands/contracts the jaw laterally
        if params.get('jaw_width', 0) != 0:
            landmarks = ['jaw_left', 'jaw_right', 'jaw_angle_left', 'jaw_angle_right']
            weights, directions = self.get_directional_weights(landmarks, 0.12)
            disp = params['jaw_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Chin Height - lengthens/shortens the chin
        if params.get('chin_height', 0) != 0:
            landmarks = ['chin', 'chin_left', 'chin_right']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['chin_height'] / 100.0 * scale
            # Positive = longer chin = move down
            vertices[:, 1] -= weights * disp

        # Chin Width - widens/narrows the chin
        if params.get('chin_width', 0) != 0:
            landmarks = ['chin', 'chin_left', 'chin_right']
            weights, directions = self.get_directional_weights(landmarks, 0.08)
            disp = params['chin_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Chin Protrusion - pushes chin forward/back
        if params.get('chin_protrusion', 0) != 0:
            landmarks = ['chin', 'chin_left', 'chin_right']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['chin_protrusion'] / 100.0 * scale
            # Positive Z = forward in this model (towards 0)
            vertices[:, 2] += z_dir * weights * disp

        # Jaw Definition - sharpens/softens jawline
        if params.get('jaw_definition', 0) != 0:
            landmarks = ['jaw_angle_left', 'jaw_angle_right']
            weights, directions = self.get_directional_weights(landmarks, 0.10)
            disp = params['jaw_definition'] / 100.0 * scale
            # Move jaw angles outward and slightly down
            vertices[:, 0] += directions * weights * disp * 0.7
            vertices[:, 1] -= weights * disp * 0.3

        # =====================================================================
        # NOSE DEFORMATIONS
        # =====================================================================

        # Nose Length - extends/retracts nose tip
        if params.get('nose_length', 0) != 0:
            landmarks = ['nose_tip', 'nose_base']
            weights = self.get_region_weights(landmarks, 0.06)
            disp = params['nose_length'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp

        # Nose Width - widens/narrows the whole nose
        if params.get('nose_width', 0) != 0:
            landmarks = ['nostril_left', 'nostril_right', 'alar_left', 'alar_right']
            weights, directions = self.get_directional_weights(landmarks, 0.06)
            disp = params['nose_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Nose Bridge Width
        if params.get('nose_bridge_width', 0) != 0:
            landmarks = ['nose_bridge', 'nose_bridge_top']
            weights, directions = self.get_directional_weights(landmarks, 0.05)
            disp = params['nose_bridge_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Nose Bridge Height - raises/lowers the bridge
        if params.get('nose_bridge_height', 0) != 0:
            landmarks = ['nose_bridge', 'nose_bridge_top']
            weights = self.get_region_weights(landmarks, 0.05)
            disp = params['nose_bridge_height'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp

        # Nose Tip Height - raises/lowers nose tip
        if params.get('nose_tip_height', 0) != 0:
            landmarks = ['nose_tip']
            weights = self.get_region_weights(landmarks, 0.04)
            disp = params['nose_tip_height'] / 100.0 * scale
            vertices[:, 1] += weights * disp

        # Nose Tip Width
        if params.get('nose_tip_width', 0) != 0:
            landmarks = ['nose_tip']
            weights, directions = self.get_directional_weights(landmarks, 0.04)
            disp = params['nose_tip_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Nostril Flare
        if params.get('nostril_flare', 0) != 0:
            landmarks = ['nostril_left', 'nostril_right', 'alar_left', 'alar_right']
            weights, directions = self.get_directional_weights(landmarks, 0.04)
            disp = params['nostril_flare'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # =====================================================================
        # EYE DEFORMATIONS
        # =====================================================================

        # Eye Spacing
        if params.get('eye_spacing', 0) != 0:
            landmarks = ['eye_left_center', 'eye_right_center',
                        'eye_left_inner', 'eye_right_inner',
                        'eye_left_outer', 'eye_right_outer']
            weights, directions = self.get_directional_weights(landmarks, 0.08)
            disp = params['eye_spacing'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Eye Height - raises/lowers eyes
        if params.get('eye_height', 0) != 0:
            landmarks = ['eye_left_center', 'eye_right_center']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['eye_height'] / 100.0 * scale
            vertices[:, 1] += weights * disp

        # Eye Depth - pushes eyes deeper/shallower
        if params.get('eye_depth', 0) != 0:
            landmarks = ['eye_left_center', 'eye_right_center']
            weights = self.get_region_weights(landmarks, 0.06)
            disp = params['eye_depth'] / 100.0 * scale
            # Negative = deeper (away from front)
            vertices[:, 2] -= z_dir * weights * disp

        # Eye Size - scales eye region
        if params.get('eye_size', 0) != 0:
            for side in ['left', 'right']:
                center_name = f'eye_{side}_center'
                if center_name in self.landmark_positions:
                    center = self.landmark_positions[center_name]
                    landmarks = [f'eye_{side}_center', f'eye_{side}_inner',
                                f'eye_{side}_outer', f'eye_{side}_upper', f'eye_{side}_lower']
                    weights = self.get_region_weights(landmarks, 0.05)
                    disp = params['eye_size'] / 100.0 * 0.15

                    # Scale from center
                    diff = self.original_vertices - center
                    vertices += diff * weights[:, np.newaxis] * disp

        # Eye Tilt - tilts outer corners
        if params.get('eye_tilt', 0) != 0:
            # Raise outer corners, lower inner corners
            outer_landmarks = ['eye_left_outer', 'eye_right_outer']
            weights_outer = self.get_region_weights(outer_landmarks, 0.04)

            inner_landmarks = ['eye_left_inner', 'eye_right_inner']
            weights_inner = self.get_region_weights(inner_landmarks, 0.04)

            disp = params['eye_tilt'] / 100.0 * scale * 0.5
            vertices[:, 1] += weights_outer * disp
            vertices[:, 1] -= weights_inner * disp * 0.5

        # Eye Openness
        if params.get('eye_openness', 0) != 0:
            upper_landmarks = ['eye_left_upper', 'eye_right_upper']
            lower_landmarks = ['eye_left_lower', 'eye_right_lower']

            weights_upper = self.get_region_weights(upper_landmarks, 0.03)
            weights_lower = self.get_region_weights(lower_landmarks, 0.03)

            disp = params['eye_openness'] / 100.0 * scale * 0.3
            vertices[:, 1] += weights_upper * disp
            vertices[:, 1] -= weights_lower * disp

        # =====================================================================
        # BROW DEFORMATIONS
        # =====================================================================

        # Brow Height
        if params.get('brow_height', 0) != 0:
            landmarks = ['brow_left_center', 'brow_right_center',
                        'brow_left_inner', 'brow_right_inner',
                        'brow_left_outer', 'brow_right_outer']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['brow_height'] / 100.0 * scale
            vertices[:, 1] += weights * disp

        # Brow Spacing
        if params.get('brow_spacing', 0) != 0:
            landmarks = ['brow_left_center', 'brow_right_center',
                        'brow_left_inner', 'brow_right_inner']
            weights, directions = self.get_directional_weights(landmarks, 0.06)
            disp = params['brow_spacing'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Brow Prominence - pushes brow ridge forward
        if params.get('brow_prominence', 0) != 0:
            landmarks = ['brow_left_center', 'brow_right_center', 'glabella']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['brow_prominence'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp

        # Brow Arch - increases/decreases arch
        if params.get('brow_arch', 0) != 0:
            # Raise center, keep ends stable
            center_landmarks = ['brow_left_center', 'brow_right_center']
            weights_center = self.get_region_weights(center_landmarks, 0.04)

            disp = params['brow_arch'] / 100.0 * scale * 0.5
            vertices[:, 1] += weights_center * disp

        # Brow Thickness
        if params.get('brow_thickness', 0) != 0:
            landmarks = ['brow_left_center', 'brow_right_center']
            weights = self.get_region_weights(landmarks, 0.06)
            disp = params['brow_thickness'] / 100.0 * scale * 0.5
            # Thicken by moving forward and slightly up
            vertices[:, 2] += z_dir * weights * disp
            vertices[:, 1] += weights * disp * 0.3

        # =====================================================================
        # FOREHEAD DEFORMATIONS
        # =====================================================================

        # Forehead Height
        if params.get('forehead_height', 0) != 0:
            landmarks = ['forehead_center', 'forehead_left', 'forehead_right', 'hairline_center']
            weights = self.get_region_weights(landmarks, 0.12)
            disp = params['forehead_height'] / 100.0 * scale
            vertices[:, 1] += weights * disp

        # Forehead Slope
        if params.get('forehead_slope', 0) != 0:
            landmarks = ['forehead_center', 'forehead_left', 'forehead_right']
            weights = self.get_region_weights(landmarks, 0.10)
            disp = params['forehead_slope'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp

        # Forehead Width
        if params.get('forehead_width', 0) != 0:
            landmarks = ['forehead_left', 'forehead_right']
            weights, directions = self.get_directional_weights(landmarks, 0.10)
            disp = params['forehead_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Temple Width
        if params.get('temple_width', 0) != 0:
            landmarks = ['temple_left', 'temple_right']
            weights, directions = self.get_directional_weights(landmarks, 0.08)
            disp = params['temple_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Forehead Bulge
        if params.get('forehead_bulge', 0) != 0:
            landmarks = ['forehead_center']
            weights = self.get_region_weights(landmarks, 0.10)
            disp = params['forehead_bulge'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp

        # =====================================================================
        # CHEEK DEFORMATIONS
        # =====================================================================

        # Cheek Fullness
        if params.get('cheek_fullness', 0) != 0:
            landmarks = ['cheek_left', 'cheek_right', 'lower_cheek_left', 'lower_cheek_right']
            weights = self.get_region_weights(landmarks, 0.10)
            disp = params['cheek_fullness'] / 100.0 * scale

            # Expand both outward (X) and forward (Z)
            # Use smooth directional function to avoid center artifacts
            x_coords = self.original_vertices[:, 0]
            tw = MODEL_CONFIG.get('transition_width', 0.02)
            directions = np.tanh(x_coords / tw)
            vertices[:, 0] += directions * weights * disp * 0.7
            vertices[:, 2] += z_dir * weights * disp * 0.5

        # Cheekbone Prominence
        if params.get('cheekbone_prominence', 0) != 0:
            landmarks = ['cheekbone_left', 'cheekbone_right']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['cheekbone_prominence'] / 100.0 * scale

            # Use smooth directional function to avoid center artifacts
            x_coords = self.original_vertices[:, 0]
            tw = MODEL_CONFIG.get('transition_width', 0.02)
            directions = np.tanh(x_coords / tw)
            vertices[:, 0] += directions * weights * disp * 0.6
            vertices[:, 2] += z_dir * weights * disp * 0.4

        # Cheek Height
        if params.get('cheek_height', 0) != 0:
            landmarks = ['cheek_left', 'cheek_right', 'cheekbone_left', 'cheekbone_right']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['cheek_height'] / 100.0 * scale
            vertices[:, 1] += weights * disp

        # Nasolabial Depth
        if params.get('nasolabial_depth', 0) != 0:
            # Area between nose and mouth corners
            landmarks = ['lower_cheek_left', 'lower_cheek_right']
            weights = self.get_region_weights(landmarks, 0.06)
            disp = params['nasolabial_depth'] / 100.0 * scale
            # Negative = deeper folds (push back)
            vertices[:, 2] -= z_dir * weights * disp

        # =====================================================================
        # MOUTH & LIP DEFORMATIONS
        # =====================================================================

        # Mouth Width
        if params.get('mouth_width', 0) != 0:
            landmarks = ['mouth_left', 'mouth_right']
            weights, directions = self.get_directional_weights(landmarks, 0.06)
            disp = params['mouth_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Mouth Height Position
        if params.get('mouth_height', 0) != 0:
            landmarks = ['mouth_left', 'mouth_right', 'upper_lip_center', 'lower_lip_center']
            weights = self.get_region_weights(landmarks, 0.08)
            disp = params['mouth_height'] / 100.0 * scale
            vertices[:, 1] += weights * disp

        # Lip Protrusion
        if params.get('lip_protrusion', 0) != 0:
            landmarks = ['upper_lip_center', 'lower_lip_center',
                        'upper_lip_left', 'upper_lip_right',
                        'lower_lip_left', 'lower_lip_right']
            weights = self.get_region_weights(landmarks, 0.06)
            disp = params['lip_protrusion'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp

        # Upper Lip Thickness
        if params.get('upper_lip_thickness', 0) != 0:
            landmarks = ['upper_lip_center', 'upper_lip_left', 'upper_lip_right']
            weights = self.get_region_weights(landmarks, 0.04)
            disp = params['upper_lip_thickness'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp * 0.5
            vertices[:, 1] += weights * disp * 0.3

        # Lower Lip Thickness
        if params.get('lower_lip_thickness', 0) != 0:
            landmarks = ['lower_lip_center', 'lower_lip_left', 'lower_lip_right']
            weights = self.get_region_weights(landmarks, 0.04)
            disp = params['lower_lip_thickness'] / 100.0 * scale
            vertices[:, 2] += z_dir * weights * disp * 0.5
            vertices[:, 1] -= weights * disp * 0.3

        # Cupid's Bow
        if params.get('cupid_bow', 0) != 0:
            landmarks = ['cupid_bow_left', 'cupid_bow_right']
            weights = self.get_region_weights(landmarks, 0.03)
            disp = params['cupid_bow'] / 100.0 * scale * 0.5
            vertices[:, 1] += weights * disp
            vertices[:, 2] += z_dir * weights * disp * 0.3

        # Philtrum Depth
        if params.get('philtrum_depth', 0) != 0:
            landmarks = ['philtrum_top', 'philtrum_bottom']
            weights = self.get_region_weights(landmarks, 0.03)
            disp = params['philtrum_depth'] / 100.0 * scale
            vertices[:, 2] -= z_dir * weights * disp

        # Philtrum Width
        if params.get('philtrum_width', 0) != 0:
            landmarks = ['philtrum_top', 'philtrum_bottom']
            weights, directions = self.get_directional_weights(landmarks, 0.03)
            disp = params['philtrum_width'] / 100.0 * scale * 0.5
            vertices[:, 0] += directions * weights * disp

        # Lip Corner Angle (smile/frown)
        if params.get('lip_corner_angle', 0) != 0:
            landmarks = ['mouth_left', 'mouth_right']
            weights = self.get_region_weights(landmarks, 0.04)
            disp = params['lip_corner_angle'] / 100.0 * scale * 0.5
            vertices[:, 1] += weights * disp

        # =====================================================================
        # EAR DEFORMATIONS
        # =====================================================================

        # Ear Size
        if params.get('ear_size', 0) != 0:
            for side in ['left', 'right']:
                center_name = f'ear_{side}_center'
                if center_name in self.landmark_positions:
                    center = self.landmark_positions[center_name]
                    landmarks = [f'ear_{side}_top', f'ear_{side}_center',
                                f'ear_{side}_bottom', f'tragus_{side}']
                    weights = self.get_region_weights(landmarks, 0.06)
                    disp = params['ear_size'] / 100.0 * 0.15

                    diff = self.original_vertices - center
                    vertices += diff * weights[:, np.newaxis] * disp

        # Ear Protrusion
        if params.get('ear_protrusion', 0) != 0:
            landmarks = ['ear_left_center', 'ear_right_center',
                        'ear_left_top', 'ear_right_top']
            weights, directions = self.get_directional_weights(landmarks, 0.06)
            disp = params['ear_protrusion'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Ear Height Position
        if params.get('ear_height', 0) != 0:
            landmarks = ['ear_left_center', 'ear_right_center',
                        'ear_left_top', 'ear_right_top',
                        'ear_left_bottom', 'ear_right_bottom']
            weights = self.get_region_weights(landmarks, 0.06)
            disp = params['ear_height'] / 100.0 * scale
            vertices[:, 1] += weights * disp

        # Earlobe Size
        if params.get('earlobe_size', 0) != 0:
            landmarks = ['ear_left_bottom', 'ear_right_bottom']
            weights = self.get_region_weights(landmarks, 0.04)
            disp = params['earlobe_size'] / 100.0 * scale
            vertices[:, 1] -= weights * disp

        # =====================================================================
        # OVERALL HEAD/FACE DEFORMATIONS
        # =====================================================================

        # Face Width
        if params.get('face_width', 0) != 0:
            # Scale entire face horizontally from center
            weights = self.face_mask.copy()
            disp = params['face_width'] / 100.0 * 0.1
            vertices[:, 0] += self.original_vertices[:, 0] * weights * disp

        # Face Length
        if params.get('face_length', 0) != 0:
            # Scale face vertically from center
            center_y = self.original_vertices[:, 1].mean()
            weights = self.face_mask.copy()
            disp = params['face_length'] / 100.0 * 0.1
            vertices[:, 1] += (self.original_vertices[:, 1] - center_y) * weights * disp

        # Head Width
        if params.get('head_width', 0) != 0:
            landmarks = ['skull_left', 'skull_right', 'temple_left', 'temple_right']
            weights, directions = self.get_directional_weights(landmarks, 0.15)
            disp = params['head_width'] / 100.0 * scale
            vertices[:, 0] += directions * weights * disp

        # Head Length (front-back)
        if params.get('head_length', 0) != 0:
            landmarks = ['occiput', 'crown']
            weights = self.get_region_weights(landmarks, 0.15)
            disp = params['head_length'] / 100.0 * scale
            vertices[:, 2] -= z_dir * weights * disp  # Push back

        # Face Taper (narrow at chin)
        if params.get('face_taper', 0) != 0:
            # More effect at bottom, less at top
            y_factor = 1 - (self.original_vertices[:, 1] - MODEL_CONFIG['face_y_min']) / \
                      (MODEL_CONFIG['face_y_max'] - MODEL_CONFIG['face_y_min'])
            y_factor = np.clip(y_factor, 0, 1) ** 2

            # Use smooth directional function to avoid center artifacts
            x_coords = self.original_vertices[:, 0]
            tw = MODEL_CONFIG.get('transition_width', 0.02)
            directions = np.tanh(x_coords / tw)
            disp = params['face_taper'] / 100.0 * scale
            vertices[:, 0] -= directions * y_factor * self.face_mask * disp

        return vertices

    def get_landmark_points(self) -> Tuple[np.ndarray, List[str]]:
        """Get all landmark positions and names for visualization."""
        points = []
        names = []

        for name, idx in self.landmark_indices.items():
            points.append(self.original_vertices[idx])
            names.append(name)

        return np.array(points), names

    def export_obj(self, vertices: np.ndarray, filepath: str) -> None:
        """Export deformed mesh as OBJ file."""
        mesh = trimesh.Trimesh(vertices=vertices, faces=self.faces)
        mesh.export(filepath)

    def export_glb(self, vertices: np.ndarray, filepath: str) -> None:
        """Export deformed mesh as GLB file."""
        mesh = trimesh.Trimesh(vertices=vertices, faces=self.faces)
        mesh.export(filepath)


# =============================================================================
# PARAMETER SLIDER WIDGET
# =============================================================================

class ParameterSlider(QWidget):
    """Custom slider widget for facial parameters."""

    valueChanged = pyqtSignal(str, float)

    def __init__(self, name: str, display_name: str, parent=None):
        super().__init__(parent)
        self.name = name
        self.display_name = display_name

        self._setup_ui()

    def _setup_ui(self):
        layout = QHBoxLayout(self)
        layout.setContentsMargins(5, 2, 5, 2)

        # Label
        self.label = QLabel(self.display_name)
        self.label.setMinimumWidth(120)
        self.label.setMaximumWidth(150)
        layout.addWidget(self.label)

        # Slider
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setMinimum(-100)
        self.slider.setMaximum(100)
        self.slider.setValue(0)
        self.slider.setTickPosition(QSlider.TickPosition.TicksBelow)
        self.slider.setTickInterval(25)
        self.slider.valueChanged.connect(self._on_value_changed)
        layout.addWidget(self.slider, 1)

        # Value display
        self.value_label = QLabel("0")
        self.value_label.setMinimumWidth(40)
        self.value_label.setAlignment(Qt.AlignmentFlag.AlignRight)
        layout.addWidget(self.value_label)

        # Reset button
        self.reset_btn = QPushButton("⟲")
        self.reset_btn.setMaximumWidth(30)
        self.reset_btn.setToolTip("Reset to 0")
        self.reset_btn.clicked.connect(self.reset)
        layout.addWidget(self.reset_btn)

        self.setToolTip(f"Adjust {self.display_name}")

    def _on_value_changed(self, value: int):
        self.value_label.setText(str(value))
        self.valueChanged.emit(self.name, value)

    def value(self) -> int:
        return self.slider.value()

    def setValue(self, value: int):
        self.slider.setValue(value)

    def reset(self):
        self.slider.setValue(0)


# =============================================================================
# MAIN APPLICATION WINDOW
# =============================================================================

class RefaceMainWindow(QMainWindow):
    """Main application window for REFACE."""

    # View modes
    VIEW_STANDING = "standing"
    VIEW_LYING = "lying"

    def __init__(self, model_path: str = None):
        super().__init__()

        self.model_path = model_path or DEFAULT_MODEL
        self.params = {}
        self.sliders = {}
        self.landmark_items = []
        self.show_landmarks = False
        self.view_mode = self.VIEW_STANDING  # Default to standing position

        # Skin tone settings
        self.skin_color = np.array([0.88, 0.78, 0.68])  # Default skin color

        # Moles/marks: list of dicts with 'position', 'size', 'color'
        self.moles = []
        self.mole_items = []  # GL items for rendering moles

        # Scars: list of dicts with 'start', 'end', 'width', 'depth'
        self.scars = []

        # Theme setting
        self.is_dark_mode = True

        # Hair system
        self.hair_styles = {}       # name -> {'vertices': ..., 'faces': ...}
        self.current_hair = None    # currently selected style name
        self.hair_item = None       # GL mesh item for hair
        self.hair_color = np.array([0.05, 0.05, 0.05])  # Default black hair
        self.hair_offset_y = 0.0    # Y offset adjustment
        self.hair_scale_adjust = 1.0  # Scale fine-tuning

        self._init_deformer()
        self._load_all_hair_models()
        self._setup_ui()
        self._setup_menu()
        self._update_mesh()

    def _init_deformer(self):
        """Initialize the face deformer."""
        try:
            self.deformer = FaceDeformer(self.model_path)
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to load model: {e}")
            sys.exit(1)

    def _load_all_hair_models(self):
        """Load and align all hair meshes to the head model."""
        head_verts = self.deformer.original_vertices
        head_min = head_verts.min(axis=0)
        head_max = head_verts.max(axis=0)
        head_center = (head_min + head_max) / 2
        head_width = head_max[0] - head_min[0]

        # Scalp region: top 20% of head for anchor point
        y_threshold = head_max[1] - (head_max[1] - head_min[1]) * 0.20
        scalp_mask = head_verts[:, 1] > y_threshold
        scalp_verts = head_verts[scalp_mask]
        scalp_center = scalp_verts.mean(axis=0) if len(scalp_verts) > 0 else head_center

        for style_name, filename in HAIR_MODELS:
            hair_path = Path(filename)
            if not hair_path.exists():
                print(f"Hair model not found: {filename}")
                continue
            try:
                hair_mesh = trimesh.load(str(hair_path), force='mesh')
                if hair_mesh.vertices.shape[0] == 0:
                    print(f"Hair model empty: {filename}")
                    continue

                hair_verts = hair_mesh.vertices.copy().astype(np.float64)
                hair_faces = hair_mesh.faces.copy()

                # Hair bounds and center
                h_min = hair_verts.min(axis=0)
                h_max = hair_verts.max(axis=0)
                hair_center = (h_min + h_max) / 2
                hair_width = h_max[0] - h_min[0]

                # Scale to match head width
                scale = (head_width * 0.80) / hair_width
                hair_verts = hair_center + (hair_verts - hair_center) * scale

                # Recompute after scaling
                h_min = hair_verts.min(axis=0)
                h_max = hair_verts.max(axis=0)
                hair_center = (h_min + h_max) / 2

                # Align: center X/Z on scalp center, Y bottom at scalp center Y
                tx = scalp_center[0] - hair_center[0]
                tz = scalp_center[2] - hair_center[2]
                ty = scalp_center[1] - hair_center[1]
                hair_verts += np.array([tx, ty, tz])

                self.hair_styles[style_name] = {
                    'vertices': hair_verts,
                    'faces': hair_faces,
                }
                print(f"Loaded hair '{style_name}': {len(hair_verts)} verts, {len(hair_faces)} faces")

            except Exception as e:
                print(f"Failed to load hair '{style_name}' ({filename}): {e}")

    def _transform_for_view(self, vertices: np.ndarray) -> np.ndarray:
        """
        Transform vertices based on current view mode.

        Standing mode: Rotate -90 degrees around X axis (Y-up to Z-up)
        Lying mode: No transformation (original model coordinates)
        """
        if self.view_mode == self.VIEW_STANDING:
            # Rotate around X axis: Y -> Z, Z -> -Y
            transformed = vertices.copy()
            transformed[:, 1] = -vertices[:, 2]  # New Y = -old Z
            transformed[:, 2] = vertices[:, 1]   # New Z = old Y
            return transformed
        else:
            # Lying mode - original coordinates
            return vertices.copy()

    def _transform_point_for_view(self, point: np.ndarray) -> np.ndarray:
        """Transform a single point based on current view mode."""
        if self.view_mode == self.VIEW_STANDING:
            transformed = point.copy()
            new_y = -point[2]
            new_z = point[1]
            transformed[1] = new_y
            transformed[2] = new_z
            return transformed
        else:
            return point.copy()

    def _setup_ui(self):
        """Set up the main UI layout."""
        self.setWindowTitle(f"{APP_NAME} v{APP_VERSION}")
        self.setMinimumSize(1200, 800)

        # Central widget
        central = QWidget()
        self.setCentralWidget(central)

        # Main layout with splitter
        layout = QHBoxLayout(central)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        layout.addWidget(splitter)

        # Left panel - Controls
        control_panel = self._create_control_panel()
        splitter.addWidget(control_panel)

        # Right panel - 3D View
        view_panel = self._create_view_panel()
        splitter.addWidget(view_panel)

        # Set splitter sizes (30% controls, 70% view)
        splitter.setSizes([400, 800])

        # Status bar
        self.statusBar().showMessage("Ready")

    def _create_control_panel(self) -> QWidget:
        """Create the control panel with parameter tabs."""
        panel = QWidget()
        layout = QVBoxLayout(panel)

        # Title
        title = QLabel(APP_NAME)
        title.setFont(QFont('Arial', 14, QFont.Weight.Bold))
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(title)

        # View mode toggle
        view_mode_layout = QHBoxLayout()
        view_mode_label = QLabel("View Mode:")
        view_mode_layout.addWidget(view_mode_label)

        self.view_mode_combo = QComboBox()
        self.view_mode_combo.addItem("Standing", self.VIEW_STANDING)
        self.view_mode_combo.addItem("Lying", self.VIEW_LYING)
        self.view_mode_combo.setCurrentIndex(0)  # Default to Standing
        self.view_mode_combo.currentIndexChanged.connect(self._on_view_mode_changed)
        view_mode_layout.addWidget(self.view_mode_combo)
        view_mode_layout.addStretch()
        layout.addLayout(view_mode_layout)

        # Landmark toggle
        self.landmark_checkbox = QCheckBox("Show Landmark Points")
        self.landmark_checkbox.toggled.connect(self._toggle_landmarks)
        layout.addWidget(self.landmark_checkbox)

        # Theme toggle button
        self.theme_btn = QPushButton("☀ Light Mode")
        self.theme_btn.setToolTip("Toggle Light/Dark Mode (Ctrl+T)")
        self.theme_btn.clicked.connect(self._toggle_theme)
        layout.addWidget(self.theme_btn)

        # Parameter tabs
        tabs = QTabWidget()
        tabs.addTab(self._create_jaw_tab(), "Jaw/Chin")
        tabs.addTab(self._create_nose_tab(), "Nose")
        tabs.addTab(self._create_eyes_tab(), "Eyes")
        tabs.addTab(self._create_brows_tab(), "Brows")
        tabs.addTab(self._create_forehead_tab(), "Forehead")
        tabs.addTab(self._create_cheeks_tab(), "Cheeks")
        tabs.addTab(self._create_mouth_tab(), "Mouth/Lips")
        tabs.addTab(self._create_ears_tab(), "Ears")
        tabs.addTab(self._create_overall_tab(), "Head/Face")
        tabs.addTab(self._create_appearance_tab(), "Appearance")
        layout.addWidget(tabs, 1)

        # Action buttons
        btn_layout = QHBoxLayout()

        reset_btn = QPushButton("Reset All")
        reset_btn.clicked.connect(self._reset_all)
        btn_layout.addWidget(reset_btn)

        save_btn = QPushButton("Save Config")
        save_btn.clicked.connect(self._save_config)
        btn_layout.addWidget(save_btn)

        load_btn = QPushButton("Load Config")
        load_btn.clicked.connect(self._load_config)
        btn_layout.addWidget(load_btn)

        layout.addLayout(btn_layout)

        # Export buttons
        export_layout = QHBoxLayout()

        export_obj_btn = QPushButton("Export OBJ")
        export_obj_btn.clicked.connect(self._export_obj)
        export_layout.addWidget(export_obj_btn)

        export_glb_btn = QPushButton("Export GLB")
        export_glb_btn.clicked.connect(self._export_glb)
        export_layout.addWidget(export_glb_btn)

        layout.addLayout(export_layout)

        return panel

    def _create_slider_group(self, params: List[Tuple[str, str]]) -> QWidget:
        """Create a scrollable group of parameter sliders."""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(5)

        for param_name, display_name in params:
            slider = ParameterSlider(param_name, display_name)
            slider.valueChanged.connect(self._on_param_changed)
            self.sliders[param_name] = slider
            self.params[param_name] = 0
            layout.addWidget(slider)

        layout.addStretch()

        scroll = QScrollArea()
        scroll.setWidget(widget)
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)

        return scroll

    def _create_jaw_tab(self) -> QWidget:
        params = [
            ('jaw_width', 'Jaw Width'),
            ('jaw_definition', 'Jaw Definition'),
            ('chin_height', 'Chin Height'),
            ('chin_width', 'Chin Width'),
            ('chin_protrusion', 'Chin Protrusion'),
        ]
        return self._create_slider_group(params)

    def _create_nose_tab(self) -> QWidget:
        params = [
            ('nose_length', 'Nose Length'),
            ('nose_width', 'Nose Width'),
            ('nose_bridge_width', 'Bridge Width'),
            ('nose_bridge_height', 'Bridge Height'),
            ('nose_tip_height', 'Tip Height'),
            ('nose_tip_width', 'Tip Width'),
            ('nostril_flare', 'Nostril Flare'),
        ]
        return self._create_slider_group(params)

    def _create_eyes_tab(self) -> QWidget:
        params = [
            ('eye_spacing', 'Eye Spacing'),
            ('eye_height', 'Eye Height'),
            ('eye_depth', 'Eye Depth'),
            ('eye_size', 'Eye Size'),
            ('eye_tilt', 'Eye Tilt'),
            ('eye_openness', 'Eye Openness'),
        ]
        return self._create_slider_group(params)

    def _create_brows_tab(self) -> QWidget:
        params = [
            ('brow_height', 'Brow Height'),
            ('brow_spacing', 'Brow Spacing'),
            ('brow_prominence', 'Brow Prominence'),
            ('brow_arch', 'Brow Arch'),
            ('brow_thickness', 'Brow Thickness'),
        ]
        return self._create_slider_group(params)

    def _create_forehead_tab(self) -> QWidget:
        params = [
            ('forehead_height', 'Forehead Height'),
            ('forehead_slope', 'Forehead Slope'),
            ('forehead_width', 'Forehead Width'),
            ('forehead_bulge', 'Forehead Bulge'),
            ('temple_width', 'Temple Width'),
        ]
        return self._create_slider_group(params)

    def _create_cheeks_tab(self) -> QWidget:
        params = [
            ('cheek_fullness', 'Cheek Fullness'),
            ('cheekbone_prominence', 'Cheekbone Prominence'),
            ('cheek_height', 'Cheek Height'),
            ('nasolabial_depth', 'Nasolabial Depth'),
        ]
        return self._create_slider_group(params)

    def _create_mouth_tab(self) -> QWidget:
        params = [
            ('mouth_width', 'Mouth Width'),
            ('mouth_height', 'Mouth Position'),
            ('lip_protrusion', 'Lip Protrusion'),
            ('upper_lip_thickness', 'Upper Lip Thickness'),
            ('lower_lip_thickness', 'Lower Lip Thickness'),
            ('cupid_bow', 'Cupid\'s Bow'),
            ('philtrum_depth', 'Philtrum Depth'),
            ('philtrum_width', 'Philtrum Width'),
            ('lip_corner_angle', 'Lip Corner Angle'),
        ]
        return self._create_slider_group(params)

    def _create_ears_tab(self) -> QWidget:
        params = [
            ('ear_size', 'Ear Size'),
            ('ear_protrusion', 'Ear Protrusion'),
            ('ear_height', 'Ear Height'),
            ('earlobe_size', 'Earlobe Size'),
        ]
        return self._create_slider_group(params)

    def _create_overall_tab(self) -> QWidget:
        params = [
            ('face_width', 'Face Width'),
            ('face_length', 'Face Length'),
            ('face_taper', 'Face Taper'),
            ('head_width', 'Head Width'),
            ('head_length', 'Head Length'),
        ]
        return self._create_slider_group(params)

    def _create_appearance_tab(self) -> QWidget:
        """Create the appearance tab with skin tone, moles, and scars."""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(10)

        # ===== SKIN TONE SECTION =====
        skin_group = QGroupBox("Skin Tone")
        skin_layout = QVBoxLayout(skin_group)

        # Preset buttons
        preset_label = QLabel("Presets:")
        skin_layout.addWidget(preset_label)

        preset_layout = QHBoxLayout()
        for i, (name, color) in enumerate(SKIN_TONE_PRESETS.items()):
            btn = QPushButton()
            btn.setFixedSize(30, 30)
            btn.setToolTip(name)
            # Create color icon
            pixmap = QPixmap(24, 24)
            qcolor = QColor(int(color[0]*255), int(color[1]*255), int(color[2]*255))
            pixmap.fill(qcolor)
            btn.setIcon(QIcon(pixmap))
            btn.clicked.connect(lambda checked, c=color: self._set_skin_tone(c))
            preset_layout.addWidget(btn)
            if i == 3:  # Break into two rows
                skin_layout.addLayout(preset_layout)
                preset_layout = QHBoxLayout()
        skin_layout.addLayout(preset_layout)

        # RGB Sliders
        rgb_label = QLabel("Custom Color (RGB):")
        skin_layout.addWidget(rgb_label)

        # Red slider
        red_layout = QHBoxLayout()
        red_layout.addWidget(QLabel("R:"))
        self.skin_red_slider = QSlider(Qt.Orientation.Horizontal)
        self.skin_red_slider.setRange(0, 255)
        self.skin_red_slider.setValue(int(self.skin_color[0] * 255))
        self.skin_red_slider.valueChanged.connect(self._on_skin_color_changed)
        red_layout.addWidget(self.skin_red_slider)
        self.skin_red_label = QLabel(str(self.skin_red_slider.value()))
        self.skin_red_label.setMinimumWidth(30)
        red_layout.addWidget(self.skin_red_label)
        skin_layout.addLayout(red_layout)

        # Green slider
        green_layout = QHBoxLayout()
        green_layout.addWidget(QLabel("G:"))
        self.skin_green_slider = QSlider(Qt.Orientation.Horizontal)
        self.skin_green_slider.setRange(0, 255)
        self.skin_green_slider.setValue(int(self.skin_color[1] * 255))
        self.skin_green_slider.valueChanged.connect(self._on_skin_color_changed)
        green_layout.addWidget(self.skin_green_slider)
        self.skin_green_label = QLabel(str(self.skin_green_slider.value()))
        self.skin_green_label.setMinimumWidth(30)
        green_layout.addWidget(self.skin_green_label)
        skin_layout.addLayout(green_layout)

        # Blue slider
        blue_layout = QHBoxLayout()
        blue_layout.addWidget(QLabel("B:"))
        self.skin_blue_slider = QSlider(Qt.Orientation.Horizontal)
        self.skin_blue_slider.setRange(0, 255)
        self.skin_blue_slider.setValue(int(self.skin_color[2] * 255))
        self.skin_blue_slider.valueChanged.connect(self._on_skin_color_changed)
        blue_layout.addWidget(self.skin_blue_slider)
        self.skin_blue_label = QLabel(str(self.skin_blue_slider.value()))
        self.skin_blue_label.setMinimumWidth(30)
        blue_layout.addWidget(self.skin_blue_label)
        skin_layout.addLayout(blue_layout)

        # Color picker button
        color_picker_btn = QPushButton("Pick Color...")
        color_picker_btn.clicked.connect(self._pick_skin_color)
        skin_layout.addWidget(color_picker_btn)

        layout.addWidget(skin_group)

        # ===== MOLES/MARKS SECTION =====
        moles_group = QGroupBox("Moles / Marks")
        moles_layout = QVBoxLayout(moles_group)

        # Mole color selection
        mole_color_layout = QHBoxLayout()
        mole_color_layout.addWidget(QLabel("Color:"))
        self.mole_color_combo = QComboBox()
        for name in MARK_COLORS.keys():
            self.mole_color_combo.addItem(name)
        mole_color_layout.addWidget(self.mole_color_combo)
        moles_layout.addLayout(mole_color_layout)

        # Mole size
        mole_size_layout = QHBoxLayout()
        mole_size_layout.addWidget(QLabel("Size:"))
        self.mole_size_slider = QSlider(Qt.Orientation.Horizontal)
        self.mole_size_slider.setRange(1, 10)
        self.mole_size_slider.setValue(3)
        mole_size_layout.addWidget(self.mole_size_slider)
        self.mole_size_label = QLabel("3")
        mole_size_layout.addWidget(self.mole_size_label)
        self.mole_size_slider.valueChanged.connect(
            lambda v: self.mole_size_label.setText(str(v)))
        moles_layout.addLayout(mole_size_layout)

        # Add mole button
        add_mole_btn = QPushButton("Add Mole at Landmark...")
        add_mole_btn.clicked.connect(self._add_mole_at_landmark)
        moles_layout.addWidget(add_mole_btn)

        # Mole list
        self.mole_list = QListWidget()
        self.mole_list.setMaximumHeight(80)
        moles_layout.addWidget(self.mole_list)

        # Remove mole button
        remove_mole_btn = QPushButton("Remove Selected Mole")
        remove_mole_btn.clicked.connect(self._remove_selected_mole)
        moles_layout.addWidget(remove_mole_btn)

        # Clear all moles
        clear_moles_btn = QPushButton("Clear All Moles")
        clear_moles_btn.clicked.connect(self._clear_all_moles)
        moles_layout.addWidget(clear_moles_btn)

        layout.addWidget(moles_group)

        # ===== SCARS SECTION =====
        scars_group = QGroupBox("Scars")
        scars_layout = QVBoxLayout(scars_group)

        # Scar width
        scar_width_layout = QHBoxLayout()
        scar_width_layout.addWidget(QLabel("Width:"))
        self.scar_width_slider = QSlider(Qt.Orientation.Horizontal)
        self.scar_width_slider.setRange(1, 10)
        self.scar_width_slider.setValue(3)
        scar_width_layout.addWidget(self.scar_width_slider)
        self.scar_width_label = QLabel("3")
        scar_width_layout.addWidget(self.scar_width_label)
        self.scar_width_slider.valueChanged.connect(
            lambda v: self.scar_width_label.setText(str(v)))
        scars_layout.addLayout(scar_width_layout)

        # Scar depth
        scar_depth_layout = QHBoxLayout()
        scar_depth_layout.addWidget(QLabel("Depth:"))
        self.scar_depth_slider = QSlider(Qt.Orientation.Horizontal)
        self.scar_depth_slider.setRange(1, 10)
        self.scar_depth_slider.setValue(3)
        scar_depth_layout.addWidget(self.scar_depth_slider)
        self.scar_depth_label = QLabel("3")
        scar_depth_layout.addWidget(self.scar_depth_label)
        self.scar_depth_slider.valueChanged.connect(
            lambda v: self.scar_depth_label.setText(str(v)))
        scars_layout.addLayout(scar_depth_layout)

        # Add scar button
        add_scar_btn = QPushButton("Add Scar Between Landmarks...")
        add_scar_btn.clicked.connect(self._add_scar_between_landmarks)
        scars_layout.addWidget(add_scar_btn)

        # Scar list
        self.scar_list = QListWidget()
        self.scar_list.setMaximumHeight(80)
        scars_layout.addWidget(self.scar_list)

        # Remove scar button
        remove_scar_btn = QPushButton("Remove Selected Scar")
        remove_scar_btn.clicked.connect(self._remove_selected_scar)
        scars_layout.addWidget(remove_scar_btn)

        # Clear all scars
        clear_scars_btn = QPushButton("Clear All Scars")
        clear_scars_btn.clicked.connect(self._clear_all_scars)
        scars_layout.addWidget(clear_scars_btn)

        layout.addWidget(scars_group)

        # ===== HAIR SECTION =====
        hair_group = QGroupBox("Hair")
        hair_layout = QVBoxLayout(hair_group)

        # Hair style selector
        style_layout = QHBoxLayout()
        style_layout.addWidget(QLabel("Style:"))
        self.hair_combo = QComboBox()
        self.hair_combo.addItem("No Hair", None)
        for name in self.hair_styles:
            self.hair_combo.addItem(name, name)
        self.hair_combo.currentIndexChanged.connect(self._on_hair_changed)
        style_layout.addWidget(self.hair_combo)
        hair_layout.addLayout(style_layout)

        # Hair color presets
        hair_color_label = QLabel("Color Presets:")
        hair_layout.addWidget(hair_color_label)

        hair_preset_layout = QHBoxLayout()
        for i, (cname, cval) in enumerate(HAIR_COLOR_PRESETS.items()):
            btn = QPushButton()
            btn.setFixedSize(24, 24)
            btn.setToolTip(cname)
            pixmap = QPixmap(20, 20)
            qcolor = QColor(int(cval[0]*255), int(cval[1]*255), int(cval[2]*255))
            pixmap.fill(qcolor)
            btn.setIcon(QIcon(pixmap))
            btn.clicked.connect(lambda checked, c=cval: self._set_hair_color(c))
            hair_preset_layout.addWidget(btn)
            if i == 4:  # Break into two rows
                hair_layout.addLayout(hair_preset_layout)
                hair_preset_layout = QHBoxLayout()
        hair_layout.addLayout(hair_preset_layout)

        # Hair color picker
        hair_pick_btn = QPushButton("Pick Hair Color...")
        hair_pick_btn.clicked.connect(self._pick_hair_color)
        hair_layout.addWidget(hair_pick_btn)

        # Hair Y offset slider
        offset_layout = QHBoxLayout()
        offset_layout.addWidget(QLabel("Y Offset:"))
        self.hair_offset_slider = QSlider(Qt.Orientation.Horizontal)
        self.hair_offset_slider.setRange(-50, 50)
        self.hair_offset_slider.setValue(0)
        self.hair_offset_slider.valueChanged.connect(self._on_hair_offset_changed)
        offset_layout.addWidget(self.hair_offset_slider)
        self.hair_offset_label = QLabel("0")
        self.hair_offset_label.setMinimumWidth(30)
        offset_layout.addWidget(self.hair_offset_label)
        hair_layout.addLayout(offset_layout)

        # Hair scale slider
        hscale_layout = QHBoxLayout()
        hscale_layout.addWidget(QLabel("Scale:"))
        self.hair_scale_slider = QSlider(Qt.Orientation.Horizontal)
        self.hair_scale_slider.setRange(50, 150)
        self.hair_scale_slider.setValue(100)
        self.hair_scale_slider.valueChanged.connect(self._on_hair_scale_changed)
        hscale_layout.addWidget(self.hair_scale_slider)
        self.hair_scale_label = QLabel("100%")
        self.hair_scale_label.setMinimumWidth(40)
        hscale_layout.addWidget(self.hair_scale_label)
        hair_layout.addLayout(hscale_layout)

        layout.addWidget(hair_group)

        layout.addStretch()

        scroll = QScrollArea()
        scroll.setWidget(widget)
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)

        return scroll

    def _create_view_panel(self) -> QWidget:
        """Create the 3D view panel."""
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)

        # GL Widget
        self.gl_widget = GLViewWidget()
        self.gl_widget.setCameraPosition(distance=7.0, elevation=15, azimuth=180)
        self.gl_widget.setBackgroundColor((40, 40, 45))
        layout.addWidget(self.gl_widget)

        # Add grid for reference
        grid = gl.GLGridItem()
        grid.setSize(6, 6, 1)
        grid.setSpacing(0.5, 0.5, 0.5)
        grid.translate(0, 0, -1.8)
        self.gl_widget.addItem(grid)

        # Initialize mesh item
        self.mesh_item = None

        return panel

    def _setup_menu(self):
        """Set up the menu bar."""
        menubar = self.menuBar()

        # File menu
        file_menu = menubar.addMenu("File")

        open_action = QAction("Open Model...", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self._open_model)
        file_menu.addAction(open_action)

        file_menu.addSeparator()

        save_config_action = QAction("Save Configuration...", self)
        save_config_action.setShortcut(QKeySequence.StandardKey.Save)
        save_config_action.triggered.connect(self._save_config)
        file_menu.addAction(save_config_action)

        load_config_action = QAction("Load Configuration...", self)
        load_config_action.triggered.connect(self._load_config)
        file_menu.addAction(load_config_action)

        file_menu.addSeparator()

        export_obj_action = QAction("Export OBJ...", self)
        export_obj_action.triggered.connect(self._export_obj)
        file_menu.addAction(export_obj_action)

        export_glb_action = QAction("Export GLB...", self)
        export_glb_action.triggered.connect(self._export_glb)
        file_menu.addAction(export_glb_action)

        file_menu.addSeparator()

        exit_action = QAction("Exit", self)
        exit_action.setShortcut(QKeySequence.StandardKey.Quit)
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)

        # Edit menu
        edit_menu = menubar.addMenu("Edit")

        reset_action = QAction("Reset All Parameters", self)
        reset_action.setShortcut("Ctrl+R")
        reset_action.triggered.connect(self._reset_all)
        edit_menu.addAction(reset_action)

        # View menu
        view_menu = menubar.addMenu("View")

        # View mode submenu
        view_mode_menu = view_menu.addMenu("View Mode")

        self.standing_action = QAction("Standing", self)
        self.standing_action.setCheckable(True)
        self.standing_action.setChecked(True)
        self.standing_action.triggered.connect(lambda: self._set_view_mode(self.VIEW_STANDING))
        view_mode_menu.addAction(self.standing_action)

        self.lying_action = QAction("Lying", self)
        self.lying_action.setCheckable(True)
        self.lying_action.triggered.connect(lambda: self._set_view_mode(self.VIEW_LYING))
        view_mode_menu.addAction(self.lying_action)

        view_menu.addSeparator()

        landmarks_action = QAction("Show Landmarks", self)
        landmarks_action.setCheckable(True)
        landmarks_action.toggled.connect(self._toggle_landmarks)
        view_menu.addAction(landmarks_action)

        view_menu.addSeparator()

        front_action = QAction("Front View", self)
        front_action.triggered.connect(lambda: self.gl_widget.setCameraPosition(
            distance=7.0, elevation=15, azimuth=180))
        view_menu.addAction(front_action)

        side_action = QAction("Side View", self)
        side_action.triggered.connect(lambda: self.gl_widget.setCameraPosition(
            distance=7.0, elevation=15, azimuth=90))
        view_menu.addAction(side_action)

        top_action = QAction("Top View", self)
        top_action.triggered.connect(lambda: self.gl_widget.setCameraPosition(
            distance=7.0, elevation=90, azimuth=180))
        view_menu.addAction(top_action)

        view_menu.addSeparator()

        # Theme toggle
        self.theme_action = QAction("Switch to Light Mode", self)
        self.theme_action.setShortcut("Ctrl+T")
        self.theme_action.triggered.connect(self._toggle_theme)
        view_menu.addAction(self.theme_action)

        # Help menu
        help_menu = menubar.addMenu("Help")

        about_action = QAction("About", self)
        about_action.triggered.connect(self._show_about)
        help_menu.addAction(about_action)

    def _calculate_lit_colors(self, display_vertices: np.ndarray,
                                original_vertices: np.ndarray = None) -> np.ndarray:
        """Calculate per-vertex colors with proper lighting.

        Args:
            display_vertices: Vertices transformed for display (used for lighting)
            original_vertices: Vertices in original model space (used for scar mask)
        """
        # Compute face normals using display vertices
        v0 = display_vertices[self.deformer.faces[:, 0]]
        v1 = display_vertices[self.deformer.faces[:, 1]]
        v2 = display_vertices[self.deformer.faces[:, 2]]
        face_normals = np.cross(v1 - v0, v2 - v0)
        norms = np.linalg.norm(face_normals, axis=1, keepdims=True)
        norms[norms == 0] = 1
        face_normals = face_normals / norms

        # Accumulate to vertex normals
        vertex_normals = np.zeros_like(display_vertices)
        for i in range(3):
            np.add.at(vertex_normals, self.deformer.faces[:, i], face_normals)
        norms = np.linalg.norm(vertex_normals, axis=1, keepdims=True)
        norms[norms == 0] = 1
        vertex_normals = vertex_normals / norms

        # Light setup - three-point lighting
        lights = [
            {'dir': np.array([0.3, 0.3, 1.0]), 'color': np.array([1.0, 0.98, 0.95]), 'intensity': 0.65},
            {'dir': np.array([-0.5, 0.2, 0.5]), 'color': np.array([0.85, 0.9, 1.0]), 'intensity': 0.35},
            {'dir': np.array([0.0, -0.3, -0.8]), 'color': np.array([1.0, 0.95, 0.9]), 'intensity': 0.2},
        ]

        # Use current skin color
        base_color = self.skin_color.copy()
        ambient = 0.35

        colors = np.zeros((len(display_vertices), 4))
        colors[:, :3] = base_color * ambient

        for light in lights:
            light_dir = light['dir'] / np.linalg.norm(light['dir'])
            ndotl = np.maximum(0, np.dot(vertex_normals, light_dir))
            for i in range(3):
                colors[:, i] += ndotl * light['color'][i] * light['intensity'] * base_color[i]

        # Apply scar coloring (lighter/pinker areas where scars are)
        # Use original vertices for scar mask since scar coords are in original space
        if hasattr(self, 'scars') and self.scars and original_vertices is not None:
            scar_mask = self._calculate_scar_mask(original_vertices)
            scar_color = base_color + np.array(SCAR_COLOR_OFFSET)
            scar_color = np.clip(scar_color, 0, 1)
            for i in range(3):
                colors[:, i] = colors[:, i] * (1 - scar_mask) + scar_color[i] * scar_mask * 0.8

        colors[:, :3] = np.clip(colors[:, :3], 0, 1)
        colors[:, 3] = 1.0  # Alpha

        return colors.astype(np.float32)

    def _calculate_scar_mask(self, vertices: np.ndarray) -> np.ndarray:
        """Calculate which vertices are affected by scars."""
        mask = np.zeros(len(vertices))

        for scar in self.scars:
            start = np.array(scar['start'])
            end = np.array(scar['end'])
            width = scar['width'] * 0.01  # Scale width

            # Calculate distance from each vertex to the scar line
            line_vec = end - start
            line_len = np.linalg.norm(line_vec)
            if line_len == 0:
                continue
            line_unit = line_vec / line_len

            # Vector from start to each vertex
            to_vertex = vertices - start

            # Project onto line
            proj_length = np.dot(to_vertex, line_unit)
            proj_length = np.clip(proj_length, 0, line_len)

            # Closest point on line
            closest = start + proj_length[:, np.newaxis] * line_unit

            # Distance to line
            dist = np.linalg.norm(vertices - closest, axis=1)

            # Gaussian falloff
            scar_weight = np.exp(-(dist ** 2) / (2 * width ** 2))
            scar_weight *= (proj_length >= 0) & (proj_length <= line_len)

            mask = np.maximum(mask, scar_weight)

        return mask

    def _update_mesh(self):
        """Update the 3D mesh display with current parameters."""
        # Apply deformations (in original model space)
        deformed_vertices = self.deformer.apply_deformations(self.params)

        # Transform for current view mode (for display)
        display_vertices = self._transform_for_view(deformed_vertices)

        # Calculate colors with lighting
        # Pass both display vertices (for lighting) and deformed vertices (for scar mask)
        colors = self._calculate_lit_colors(display_vertices, deformed_vertices)

        # Remove old mesh
        if self.mesh_item is not None:
            self.gl_widget.removeItem(self.mesh_item)

        # Create new mesh item
        self.mesh_item = gl.GLMeshItem(
            vertexes=display_vertices.astype(np.float32),
            faces=self.deformer.faces,
            vertexColors=colors,
            smooth=True,
            shader=None,
            drawEdges=False
        )
        self.gl_widget.addItem(self.mesh_item)

        # Update landmarks if visible
        if self.show_landmarks:
            self._update_landmarks()

        # Update moles
        if hasattr(self, 'moles') and self.moles:
            self._update_moles()

        # Update hair
        self._update_hair()

    def _on_param_changed(self, name: str, value: float):
        """Handle parameter value change."""
        self.params[name] = value
        self._update_mesh()
        self.statusBar().showMessage(f"{name}: {value}")

    def _toggle_landmarks(self, show: bool):
        """Toggle landmark visibility."""
        self.show_landmarks = show
        self.landmark_checkbox.setChecked(show)

        if show:
            self._update_landmarks()
        else:
            self._remove_landmarks()

    def _update_landmarks(self):
        """Update landmark visualization."""
        self._remove_landmarks()

        points, names = self.deformer.get_landmark_points()

        for point, name in zip(points, names):
            # Transform point for current view mode
            display_point = self._transform_point_for_view(point)

            sphere = gl.MeshData.sphere(rows=8, cols=8, radius=0.02)
            item = gl.GLMeshItem(
                meshdata=sphere,
                smooth=True,
                color=(1, 0, 0, 1),
                shader='shaded'
            )
            item.translate(display_point[0], display_point[1], display_point[2])
            self.gl_widget.addItem(item)
            self.landmark_items.append(item)

    def _remove_landmarks(self):
        """Remove landmark visualization."""
        for item in self.landmark_items:
            self.gl_widget.removeItem(item)
        self.landmark_items = []

    # =========================================================================
    # SKIN TONE METHODS
    # =========================================================================

    # =========================================================================
    # HAIR METHODS
    # =========================================================================

    def _on_hair_changed(self, index: int):
        """Handle hair style selection change."""
        self.current_hair = self.hair_combo.itemData(index)
        self._update_hair()
        style = self.current_hair if self.current_hair else "None"
        self.statusBar().showMessage(f"Hair style: {style}")

    def _set_hair_color(self, color: Tuple[float, float, float]):
        """Set hair color from preset."""
        self.hair_color = np.array(color)
        self._update_hair()
        self.statusBar().showMessage("Hair color updated")

    def _pick_hair_color(self):
        """Open color picker for hair color."""
        current = QColor(
            int(self.hair_color[0] * 255),
            int(self.hair_color[1] * 255),
            int(self.hair_color[2] * 255)
        )
        color = QColorDialog.getColor(current, self, "Select Hair Color")
        if color.isValid():
            self._set_hair_color((
                color.red() / 255.0,
                color.green() / 255.0,
                color.blue() / 255.0
            ))

    def _on_hair_offset_changed(self, value: int):
        """Handle hair Y offset slider change."""
        self.hair_offset_y = value * 0.01  # Scale to reasonable range
        self.hair_offset_label.setText(str(value))
        self._update_hair()

    def _on_hair_scale_changed(self, value: int):
        """Handle hair scale slider change."""
        self.hair_scale_adjust = value / 100.0
        self.hair_scale_label.setText(f"{value}%")
        self._update_hair()

    def _update_hair(self):
        """Update hair mesh display."""
        # Remove old hair item
        if self.hair_item is not None:
            self.gl_widget.removeItem(self.hair_item)
            self.hair_item = None

        if self.current_hair is None or self.current_hair not in self.hair_styles:
            return

        hair_data = self.hair_styles[self.current_hair]
        hair_verts = hair_data['vertices'].copy()
        hair_faces = hair_data['faces']

        # Apply scale adjustment from center
        if self.hair_scale_adjust != 1.0:
            center = hair_verts.mean(axis=0)
            hair_verts = center + (hair_verts - center) * self.hair_scale_adjust

        # Apply Y offset
        if self.hair_offset_y != 0:
            hair_verts[:, 1] += self.hair_offset_y

        # Transform for current view mode
        display_verts = self._transform_for_view(hair_verts)

        # Calculate simple lighting for hair
        hair_colors = self._calculate_hair_colors(display_verts, hair_faces)

        self.hair_item = gl.GLMeshItem(
            vertexes=display_verts.astype(np.float32),
            faces=hair_faces,
            vertexColors=hair_colors,
            smooth=True,
            shader=None,
            drawEdges=False
        )
        self.gl_widget.addItem(self.hair_item)

    def _calculate_hair_colors(self, vertices: np.ndarray,
                                faces: np.ndarray) -> np.ndarray:
        """Calculate per-vertex colors with lighting for hair."""
        # Compute normals
        v0 = vertices[faces[:, 0]]
        v1 = vertices[faces[:, 1]]
        v2 = vertices[faces[:, 2]]
        face_normals = np.cross(v1 - v0, v2 - v0)
        norms = np.linalg.norm(face_normals, axis=1, keepdims=True)
        norms[norms == 0] = 1
        face_normals = face_normals / norms

        vertex_normals = np.zeros_like(vertices)
        for i in range(3):
            np.add.at(vertex_normals, faces[:, i], face_normals)
        norms = np.linalg.norm(vertex_normals, axis=1, keepdims=True)
        norms[norms == 0] = 1
        vertex_normals = vertex_normals / norms

        # Lighting
        lights = [
            {'dir': np.array([0.3, 0.3, 1.0]), 'intensity': 0.55},
            {'dir': np.array([-0.5, 0.2, 0.5]), 'intensity': 0.30},
            {'dir': np.array([0.0, -0.3, -0.8]), 'intensity': 0.15},
        ]

        base_color = self.hair_color.copy()
        ambient = 0.30

        colors = np.zeros((len(vertices), 4))
        colors[:, :3] = base_color * ambient

        for light in lights:
            light_dir = light['dir'] / np.linalg.norm(light['dir'])
            ndotl = np.maximum(0, np.dot(vertex_normals, light_dir))
            for c in range(3):
                colors[:, c] += ndotl * light['intensity'] * base_color[c]

        colors[:, :3] = np.clip(colors[:, :3], 0, 1)
        colors[:, 3] = 1.0
        return colors.astype(np.float32)

    # =========================================================================
    # SKIN TONE METHODS
    # =========================================================================

    def _set_skin_tone(self, color: Tuple[float, float, float]):
        """Set skin tone from preset."""
        self.skin_color = np.array(color)
        # Update sliders
        if hasattr(self, 'skin_red_slider'):
            self.skin_red_slider.blockSignals(True)
            self.skin_green_slider.blockSignals(True)
            self.skin_blue_slider.blockSignals(True)

            self.skin_red_slider.setValue(int(color[0] * 255))
            self.skin_green_slider.setValue(int(color[1] * 255))
            self.skin_blue_slider.setValue(int(color[2] * 255))

            self.skin_red_label.setText(str(int(color[0] * 255)))
            self.skin_green_label.setText(str(int(color[1] * 255)))
            self.skin_blue_label.setText(str(int(color[2] * 255)))

            self.skin_red_slider.blockSignals(False)
            self.skin_green_slider.blockSignals(False)
            self.skin_blue_slider.blockSignals(False)

        self._update_mesh()
        self.statusBar().showMessage("Skin tone updated")

    def _on_skin_color_changed(self):
        """Handle skin color slider changes."""
        r = self.skin_red_slider.value()
        g = self.skin_green_slider.value()
        b = self.skin_blue_slider.value()

        self.skin_red_label.setText(str(r))
        self.skin_green_label.setText(str(g))
        self.skin_blue_label.setText(str(b))

        self.skin_color = np.array([r / 255.0, g / 255.0, b / 255.0])
        self._update_mesh()

    def _pick_skin_color(self):
        """Open color picker dialog for skin tone."""
        current = QColor(
            int(self.skin_color[0] * 255),
            int(self.skin_color[1] * 255),
            int(self.skin_color[2] * 255)
        )
        color = QColorDialog.getColor(current, self, "Select Skin Tone")
        if color.isValid():
            self._set_skin_tone((
                color.red() / 255.0,
                color.green() / 255.0,
                color.blue() / 255.0
            ))

    # =========================================================================
    # MOLE METHODS
    # =========================================================================

    def _add_mole_at_landmark(self):
        """Add a mole at a selected landmark position."""
        # Get list of landmarks
        landmark_names = list(LANDMARKS.keys())

        # Show selection dialog
        name, ok = QInputDialog.getItem(
            self, "Add Mole",
            "Select landmark position for mole:",
            landmark_names, 0, False
        )

        if ok and name:
            # Get landmark position
            if name in self.deformer.landmark_positions:
                pos = self.deformer.landmark_positions[name].copy()

                # Get mole properties
                color_name = self.mole_color_combo.currentText()
                color = MARK_COLORS[color_name]
                size = self.mole_size_slider.value() * 0.002  # Scale size

                # Add mole
                mole = {
                    'position': pos,
                    'size': size,
                    'color': color,
                    'landmark': name
                }
                self.moles.append(mole)

                # Update list widget
                self.mole_list.addItem(f"Mole at {name}")

                # Update display
                self._update_moles()
                self.statusBar().showMessage(f"Added mole at {name}")

    def _remove_selected_mole(self):
        """Remove the selected mole from the list."""
        row = self.mole_list.currentRow()
        if row >= 0 and row < len(self.moles):
            del self.moles[row]
            self.mole_list.takeItem(row)
            self._update_moles()
            self.statusBar().showMessage("Mole removed")

    def _clear_all_moles(self):
        """Remove all moles."""
        self.moles = []
        self.mole_list.clear()
        self._update_moles()
        self.statusBar().showMessage("All moles cleared")

    def _update_moles(self):
        """Update mole visualization."""
        # Remove existing mole items
        for item in self.mole_items:
            self.gl_widget.removeItem(item)
        self.mole_items = []

        # Add mole spheres
        for mole in self.moles:
            pos = mole['position']
            # Transform for view mode
            display_pos = self._transform_point_for_view(pos)

            # Create sphere
            sphere = gl.MeshData.sphere(rows=8, cols=8, radius=mole['size'])
            color = mole['color']
            item = gl.GLMeshItem(
                meshdata=sphere,
                smooth=True,
                color=(color[0], color[1], color[2], 1.0),
                shader='shaded'
            )
            item.translate(display_pos[0], display_pos[1], display_pos[2])
            self.gl_widget.addItem(item)
            self.mole_items.append(item)

    # =========================================================================
    # SCAR METHODS
    # =========================================================================

    def _add_scar_between_landmarks(self):
        """Add a scar between two landmark positions."""
        landmark_names = list(LANDMARKS.keys())

        # Get start landmark
        start_name, ok1 = QInputDialog.getItem(
            self, "Add Scar - Start Point",
            "Select starting landmark:",
            landmark_names, 0, False
        )

        if not ok1 or not start_name:
            return

        # Get end landmark
        end_name, ok2 = QInputDialog.getItem(
            self, "Add Scar - End Point",
            "Select ending landmark:",
            landmark_names, 0, False
        )

        if not ok2 or not end_name:
            return

        if start_name == end_name:
            QMessageBox.warning(self, "Error", "Start and end points must be different")
            return

        # Get positions
        if start_name in self.deformer.landmark_positions and \
           end_name in self.deformer.landmark_positions:
            start_pos = self.deformer.landmark_positions[start_name].copy()
            end_pos = self.deformer.landmark_positions[end_name].copy()

            # Get scar properties
            width = self.scar_width_slider.value()
            depth = self.scar_depth_slider.value()

            # Add scar
            scar = {
                'start': start_pos,
                'end': end_pos,
                'width': width,
                'depth': depth,
                'start_name': start_name,
                'end_name': end_name
            }
            self.scars.append(scar)

            # Update list widget
            self.scar_list.addItem(f"Scar: {start_name} to {end_name}")

            # Update display
            self._update_mesh()
            self.statusBar().showMessage(f"Added scar from {start_name} to {end_name}")

    def _remove_selected_scar(self):
        """Remove the selected scar from the list."""
        row = self.scar_list.currentRow()
        if row >= 0 and row < len(self.scars):
            del self.scars[row]
            self.scar_list.takeItem(row)
            self._update_mesh()
            self.statusBar().showMessage("Scar removed")

    def _clear_all_scars(self):
        """Remove all scars."""
        self.scars = []
        self.scar_list.clear()
        self._update_mesh()
        self.statusBar().showMessage("All scars cleared")

    def _on_view_mode_changed(self, index: int):
        """Handle view mode change from combo box."""
        mode = self.view_mode_combo.itemData(index)
        self._set_view_mode(mode)

    def _set_view_mode(self, mode: str):
        """Set the view mode and update display."""
        if mode == self.view_mode:
            return

        self.view_mode = mode

        # Update combo box if called from menu
        if hasattr(self, 'view_mode_combo'):
            index = 0 if mode == self.VIEW_STANDING else 1
            self.view_mode_combo.blockSignals(True)
            self.view_mode_combo.setCurrentIndex(index)
            self.view_mode_combo.blockSignals(False)

        # Update menu checkmarks
        if hasattr(self, 'standing_action'):
            self.standing_action.setChecked(mode == self.VIEW_STANDING)
            self.lying_action.setChecked(mode == self.VIEW_LYING)

        # Update mesh and landmarks
        self._update_mesh()

        self.statusBar().showMessage(f"View mode: {mode.capitalize()}")

    def _reset_all(self):
        """Reset all parameters to zero."""
        for slider in self.sliders.values():
            slider.setValue(0)
        self.statusBar().showMessage("All parameters reset")

    def _save_config(self):
        """Save current configuration to JSON file."""
        filepath, _ = QFileDialog.getSaveFileName(
            self, "Save Configuration", "", "JSON Files (*.json)"
        )
        if filepath:
            if not filepath.endswith('.json'):
                filepath += '.json'

            # Prepare moles for JSON (convert numpy arrays)
            moles_data = []
            for mole in self.moles:
                moles_data.append({
                    'position': mole['position'].tolist(),
                    'size': mole['size'],
                    'color': mole['color'],
                    'landmark': mole.get('landmark', '')
                })

            # Prepare scars for JSON
            scars_data = []
            for scar in self.scars:
                scars_data.append({
                    'start': scar['start'].tolist(),
                    'end': scar['end'].tolist(),
                    'width': scar['width'],
                    'depth': scar['depth'],
                    'start_name': scar.get('start_name', ''),
                    'end_name': scar.get('end_name', '')
                })

            config = {
                'version': APP_VERSION,
                'model': self.model_path,
                'parameters': self.params,
                'skin_color': self.skin_color.tolist(),
                'moles': moles_data,
                'scars': scars_data,
                'hair_style': self.current_hair,
                'hair_color': self.hair_color.tolist(),
                'hair_offset_y': self.hair_offset_y,
                'hair_scale': self.hair_scale_adjust,
            }
            with open(filepath, 'w') as f:
                json.dump(config, f, indent=2)
            self.statusBar().showMessage(f"Configuration saved to {filepath}")

    def _load_config(self):
        """Load configuration from JSON file."""
        filepath, _ = QFileDialog.getOpenFileName(
            self, "Load Configuration", "", "JSON Files (*.json)"
        )
        if filepath:
            try:
                with open(filepath, 'r') as f:
                    config = json.load(f)

                # Load parameters
                params = config.get('parameters', {})
                for name, value in params.items():
                    if name in self.sliders:
                        self.sliders[name].setValue(int(value))

                # Load skin color
                if 'skin_color' in config:
                    self._set_skin_tone(tuple(config['skin_color']))

                # Load moles
                if 'moles' in config:
                    self.moles = []
                    self.mole_list.clear()
                    for mole_data in config['moles']:
                        mole = {
                            'position': np.array(mole_data['position']),
                            'size': mole_data['size'],
                            'color': tuple(mole_data['color']),
                            'landmark': mole_data.get('landmark', '')
                        }
                        self.moles.append(mole)
                        self.mole_list.addItem(f"Mole at {mole_data.get('landmark', 'unknown')}")
                    self._update_moles()

                # Load scars
                if 'scars' in config:
                    self.scars = []
                    self.scar_list.clear()
                    for scar_data in config['scars']:
                        scar = {
                            'start': np.array(scar_data['start']),
                            'end': np.array(scar_data['end']),
                            'width': scar_data['width'],
                            'depth': scar_data['depth'],
                            'start_name': scar_data.get('start_name', ''),
                            'end_name': scar_data.get('end_name', '')
                        }
                        self.scars.append(scar)
                        self.scar_list.addItem(
                            f"Scar: {scar_data.get('start_name', '?')} to {scar_data.get('end_name', '?')}"
                        )
                    self._update_mesh()

                # Load hair settings
                if 'hair_style' in config and config['hair_style'] in self.hair_styles:
                    idx = self.hair_combo.findData(config['hair_style'])
                    if idx >= 0:
                        self.hair_combo.setCurrentIndex(idx)
                if 'hair_color' in config:
                    self.hair_color = np.array(config['hair_color'])
                    self._update_hair()
                if 'hair_offset_y' in config:
                    self.hair_offset_y = config['hair_offset_y']
                    self.hair_offset_slider.blockSignals(True)
                    self.hair_offset_slider.setValue(int(config['hair_offset_y'] / 0.01))
                    self.hair_offset_slider.blockSignals(False)
                if 'hair_scale' in config:
                    self.hair_scale_adjust = config['hair_scale']
                    self.hair_scale_slider.blockSignals(True)
                    self.hair_scale_slider.setValue(int(config['hair_scale'] * 100))
                    self.hair_scale_slider.blockSignals(False)

                self.statusBar().showMessage(f"Configuration loaded from {filepath}")
            except Exception as e:
                QMessageBox.warning(self, "Error", f"Failed to load configuration: {e}")

    def _open_model(self):
        """Open a new 3D model."""
        filepath, _ = QFileDialog.getOpenFileName(
            self, "Open Model", "", "3D Models (*.glb *.gltf *.obj)"
        )
        if filepath:
            try:
                self.model_path = filepath
                self._init_deformer()
                self._reset_all()
                self._update_mesh()
                self.statusBar().showMessage(f"Loaded model: {filepath}")
            except Exception as e:
                QMessageBox.warning(self, "Error", f"Failed to load model: {e}")

    def _export_obj(self):
        """Export deformed mesh as OBJ."""
        filepath, _ = QFileDialog.getSaveFileName(
            self, "Export OBJ", "", "OBJ Files (*.obj)"
        )
        if filepath:
            if not filepath.endswith('.obj'):
                filepath += '.obj'
            vertices = self.deformer.apply_deformations(self.params)
            self.deformer.export_obj(vertices, filepath)
            self.statusBar().showMessage(f"Exported to {filepath}")

    def _export_glb(self):
        """Export deformed mesh as GLB."""
        filepath, _ = QFileDialog.getSaveFileName(
            self, "Export GLB", "", "GLB Files (*.glb)"
        )
        if filepath:
            if not filepath.endswith('.glb'):
                filepath += '.glb'
            vertices = self.deformer.apply_deformations(self.params)
            self.deformer.export_glb(vertices, filepath)
            self.statusBar().showMessage(f"Exported to {filepath}")

    def _toggle_theme(self):
        """Toggle between light and dark mode."""
        self.is_dark_mode = not self.is_dark_mode
        app = QApplication.instance()

        if self.is_dark_mode:
            app.setStyleSheet(DARK_STYLESHEET)
            self.gl_widget.setBackgroundColor((40, 40, 45))
            self.theme_action.setText("Switch to Light Mode")
            self.theme_btn.setText("☀ Light Mode")
            self.statusBar().showMessage("Dark mode enabled")
        else:
            app.setStyleSheet(LIGHT_STYLESHEET)
            self.gl_widget.setBackgroundColor((220, 225, 230))
            self.theme_action.setText("Switch to Dark Mode")
            self.theme_btn.setText("🌙 Dark Mode")
            self.statusBar().showMessage("Light mode enabled")

        # Refresh mesh to update display
        self._update_mesh()

    def _show_about(self):
        """Show about dialog."""
        QMessageBox.about(
            self,
            f"About {APP_NAME}",
            f"""<h2>{APP_NAME}</h2>
            <p>Version {APP_VERSION}</p>
            <p>A forensic facial reconstruction tool using parametric mesh deformation.</p>
            <p><b>Features:</b></p>
            <ul>
                <li>Model-agnostic design</li>
                <li>Geometric landmark detection</li>
                <li>50+ facial parameters</li>
                <li>Export to OBJ/GLB</li>
            </ul>
            <p><i>For forensic use only. Always verify with professional expertise.</i></p>
            """
        )


# =============================================================================
# THEME STYLESHEETS
# =============================================================================

DARK_STYLESHEET = """
    /* ===== GLOBAL STYLES ===== */
    QMainWindow, QWidget {
        background-color: #1a1a2e;
        color: #eaeaea;
        font-family: 'Segoe UI', 'Roboto', sans-serif;
        font-size: 10pt;
    }
    
    /* ===== LABELS ===== */
    QLabel {
        color: #eaeaea;
        padding: 2px;
    }
    
    /* ===== BUTTONS ===== */
    QPushButton {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #4a4a6a, stop:1 #3a3a5a);
        color: #ffffff;
        border: 1px solid #5a5a7a;
        border-radius: 6px;
        padding: 8px 16px;
        font-weight: 500;
        min-height: 20px;
    }
    
    QPushButton:hover {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #5a5a8a, stop:1 #4a4a7a);
        border: 1px solid #7a7aaa;
    }
    
    QPushButton:pressed {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #3a3a5a, stop:1 #2a2a4a);
    }
    
    QPushButton:disabled {
        background: #2a2a3a;
        color: #6a6a7a;
        border: 1px solid #3a3a4a;
    }
    
    /* ===== TAB WIDGET ===== */
    QTabWidget::pane {
        background-color: #16213e;
        border: 1px solid #3a3a5a;
        border-radius: 8px;
        margin-top: -1px;
    }
    
    QTabBar::tab {
        background: #1a1a2e;
        color: #9a9ab0;
        border: 1px solid #3a3a5a;
        border-bottom: none;
        padding: 8px 14px;
        margin-right: 2px;
        border-top-left-radius: 6px;
        border-top-right-radius: 6px;
        font-weight: 500;
    }
    
    QTabBar::tab:selected {
        background: #16213e;
        color: #00d4ff;
        border-bottom: 2px solid #00d4ff;
    }
    
    QTabBar::tab:hover:!selected {
        background: #252550;
        color: #ffffff;
    }
    
    /* ===== SLIDERS ===== */
    QSlider::groove:horizontal {
        background: #2a2a4a;
        height: 8px;
        border-radius: 4px;
    }
    
    QSlider::handle:horizontal {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #00d4ff, stop:1 #0099cc);
        width: 18px;
        height: 18px;
        margin: -5px 0;
        border-radius: 9px;
        border: 2px solid #16213e;
    }
    
    QSlider::handle:horizontal:hover {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #33e0ff, stop:1 #00bbee);
    }
    
    QSlider::sub-page:horizontal {
        background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
            stop:0 #0066aa, stop:1 #00d4ff);
        border-radius: 4px;
    }
    
    /* ===== SCROLL AREA ===== */
    QScrollArea {
        background-color: transparent;
        border: none;
    }
    
    QScrollArea > QWidget > QWidget {
        background-color: transparent;
    }
    
    QScrollBar:vertical {
        background: #1a1a2e;
        width: 12px;
        border-radius: 6px;
        margin: 2px;
    }
    
    QScrollBar::handle:vertical {
        background: #4a4a6a;
        border-radius: 5px;
        min-height: 30px;
    }
    
    QScrollBar::handle:vertical:hover {
        background: #5a5a8a;
    }
    
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
        height: 0;
    }
    
    QScrollBar:horizontal {
        background: #1a1a2e;
        height: 12px;
        border-radius: 6px;
        margin: 2px;
    }
    
    QScrollBar::handle:horizontal {
        background: #4a4a6a;
        border-radius: 5px;
        min-width: 30px;
    }
    
    QScrollBar::handle:horizontal:hover {
        background: #5a5a8a;
    }
    
    QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {
        width: 0;
    }
    
    /* ===== GROUP BOX ===== */
    QGroupBox {
        background-color: #16213e;
        border: 1px solid #3a3a5a;
        border-radius: 8px;
        margin-top: 12px;
        padding-top: 12px;
        font-weight: bold;
        color: #00d4ff;
    }
    
    QGroupBox::title {
        subcontrol-origin: margin;
        subcontrol-position: top left;
        left: 12px;
        padding: 0 6px;
        background-color: #16213e;
    }
    
    /* ===== COMBO BOX ===== */
    QComboBox {
        background-color: #2a2a4a;
        color: #eaeaea;
        border: 1px solid #4a4a6a;
        border-radius: 6px;
        padding: 6px 12px;
        min-width: 100px;
    }
    
    QComboBox:hover {
        border: 1px solid #00d4ff;
    }
    
    QComboBox::drop-down {
        border: none;
        width: 24px;
    }
    
    QComboBox::down-arrow {
        image: none;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-top: 6px solid #00d4ff;
        margin-right: 8px;
    }
    
    QComboBox QAbstractItemView {
        background-color: #2a2a4a;
        color: #eaeaea;
        selection-background-color: #00d4ff;
        selection-color: #1a1a2e;
        border: 1px solid #4a4a6a;
        border-radius: 6px;
    }
    
    /* ===== CHECK BOX ===== */
    QCheckBox {
        color: #eaeaea;
        spacing: 8px;
    }
    
    QCheckBox::indicator {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        border: 2px solid #4a4a6a;
        background: #2a2a4a;
    }
    
    QCheckBox::indicator:checked {
        background: #00d4ff;
        border: 2px solid #00d4ff;
    }
    
    QCheckBox::indicator:hover {
        border: 2px solid #00d4ff;
    }
    
    /* ===== LIST WIDGET ===== */
    QListWidget {
        background-color: #16213e;
        color: #eaeaea;
        border: 1px solid #3a3a5a;
        border-radius: 6px;
        padding: 4px;
    }
    
    QListWidget::item {
        padding: 6px;
        border-radius: 4px;
    }
    
    QListWidget::item:selected {
        background-color: #00d4ff;
        color: #1a1a2e;
    }
    
    QListWidget::item:hover:!selected {
        background-color: #2a2a4a;
    }
    
    /* ===== SPLITTER ===== */
    QSplitter::handle {
        background: #3a3a5a;
        width: 4px;
    }
    
    QSplitter::handle:hover {
        background: #00d4ff;
    }
    
    /* ===== MENU BAR ===== */
    QMenuBar {
        background-color: #0f0f23;
        color: #eaeaea;
        border-bottom: 1px solid #3a3a5a;
        padding: 4px;
    }
    
    QMenuBar::item {
        padding: 6px 12px;
        border-radius: 4px;
    }
    
    QMenuBar::item:selected {
        background-color: #2a2a4a;
    }
    
    QMenu {
        background-color: #1a1a2e;
        color: #eaeaea;
        border: 1px solid #3a3a5a;
        border-radius: 8px;
        padding: 6px;
    }
    
    QMenu::item {
        padding: 8px 24px;
        border-radius: 4px;
    }
    
    QMenu::item:selected {
        background-color: #00d4ff;
        color: #1a1a2e;
    }
    
    QMenu::separator {
        height: 1px;
        background: #3a3a5a;
        margin: 6px 12px;
    }
    
    /* ===== STATUS BAR ===== */
    QStatusBar {
        background-color: #0f0f23;
        color: #9a9ab0;
        border-top: 1px solid #3a3a5a;
        padding: 4px;
    }
    
    /* ===== SPIN BOX ===== */
    QSpinBox, QDoubleSpinBox {
        background-color: #2a2a4a;
        color: #eaeaea;
        border: 1px solid #4a4a6a;
        border-radius: 6px;
        padding: 4px 8px;
    }
    
    QSpinBox:hover, QDoubleSpinBox:hover {
        border: 1px solid #00d4ff;
    }
    
    /* ===== TOOL TIP ===== */
    QToolTip {
        background-color: #2a2a4a;
        color: #ffffff;
        border: 1px solid #00d4ff;
        border-radius: 6px;
        padding: 6px;
        font-size: 9pt;
    }
    
    /* ===== MESSAGE BOX ===== */
    QMessageBox {
        background-color: #1a1a2e;
    }
    
    QMessageBox QLabel {
        color: #eaeaea;
    }
    
    /* ===== INPUT DIALOG ===== */
    QInputDialog {
        background-color: #1a1a2e;
    }
    
    /* ===== COLOR DIALOG ===== */
    QColorDialog {
        background-color: #1a1a2e;
    }
    
    /* ===== FILE DIALOG ===== */
    QFileDialog {
        background-color: #1a1a2e;
    }
"""

LIGHT_STYLESHEET = """
    /* ===== GLOBAL STYLES ===== */
    QMainWindow, QWidget {
        background-color: #f0f2f5;
        color: #2d2d2d;
        font-family: 'Segoe UI', 'Roboto', sans-serif;
        font-size: 10pt;
    }
    
    /* ===== LABELS ===== */
    QLabel {
        color: #2d2d2d;
        padding: 2px;
    }
    
    /* ===== BUTTONS ===== */
    QPushButton {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #ffffff, stop:1 #e8e8e8);
        color: #2d2d2d;
        border: 1px solid #c0c0c0;
        border-radius: 6px;
        padding: 8px 16px;
        font-weight: 500;
        min-height: 20px;
    }
    
    QPushButton:hover {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #e8f4fd, stop:1 #d0e8f8);
        border: 1px solid #0078d4;
    }
    
    QPushButton:pressed {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #d0e0f0, stop:1 #b8d0e8);
    }
    
    QPushButton:disabled {
        background: #e8e8e8;
        color: #a0a0a0;
        border: 1px solid #d0d0d0;
    }
    
    /* ===== TAB WIDGET ===== */
    QTabWidget::pane {
        background-color: #ffffff;
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        margin-top: -1px;
    }
    
    QTabBar::tab {
        background: #e8e8e8;
        color: #666666;
        border: 1px solid #d0d0d0;
        border-bottom: none;
        padding: 8px 14px;
        margin-right: 2px;
        border-top-left-radius: 6px;
        border-top-right-radius: 6px;
        font-weight: 500;
    }
    
    QTabBar::tab:selected {
        background: #ffffff;
        color: #0078d4;
        border-bottom: 2px solid #0078d4;
    }
    
    QTabBar::tab:hover:!selected {
        background: #f0f0f0;
        color: #333333;
    }
    
    /* ===== SLIDERS ===== */
    QSlider::groove:horizontal {
        background: #d0d4da;
        height: 8px;
        border-radius: 4px;
    }
    
    QSlider::handle:horizontal {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #0078d4, stop:1 #005a9e);
        width: 18px;
        height: 18px;
        margin: -5px 0;
        border-radius: 9px;
        border: 2px solid #ffffff;
    }
    
    QSlider::handle:horizontal:hover {
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            stop:0 #1a8fe0, stop:1 #0078d4);
    }
    
    QSlider::sub-page:horizontal {
        background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
            stop:0 #005a9e, stop:1 #0078d4);
        border-radius: 4px;
    }
    
    /* ===== SCROLL AREA ===== */
    QScrollArea {
        background-color: transparent;
        border: none;
    }
    
    QScrollArea > QWidget > QWidget {
        background-color: transparent;
    }
    
    QScrollBar:vertical {
        background: #f0f2f5;
        width: 12px;
        border-radius: 6px;
        margin: 2px;
    }
    
    QScrollBar::handle:vertical {
        background: #c0c4ca;
        border-radius: 5px;
        min-height: 30px;
    }
    
    QScrollBar::handle:vertical:hover {
        background: #a0a4aa;
    }
    
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
        height: 0;
    }
    
    QScrollBar:horizontal {
        background: #f0f2f5;
        height: 12px;
        border-radius: 6px;
        margin: 2px;
    }
    
    QScrollBar::handle:horizontal {
        background: #c0c4ca;
        border-radius: 5px;
        min-width: 30px;
    }
    
    QScrollBar::handle:horizontal:hover {
        background: #a0a4aa;
    }
    
    QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {
        width: 0;
    }
    
    /* ===== GROUP BOX ===== */
    QGroupBox {
        background-color: #ffffff;
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        margin-top: 12px;
        padding-top: 12px;
        font-weight: bold;
        color: #0078d4;
    }
    
    QGroupBox::title {
        subcontrol-origin: margin;
        subcontrol-position: top left;
        left: 12px;
        padding: 0 6px;
        background-color: #ffffff;
    }
    
    /* ===== COMBO BOX ===== */
    QComboBox {
        background-color: #ffffff;
        color: #2d2d2d;
        border: 1px solid #c0c0c0;
        border-radius: 6px;
        padding: 6px 12px;
        min-width: 100px;
    }
    
    QComboBox:hover {
        border: 1px solid #0078d4;
    }
    
    QComboBox::drop-down {
        border: none;
        width: 24px;
    }
    
    QComboBox::down-arrow {
        image: none;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-top: 6px solid #0078d4;
        margin-right: 8px;
    }
    
    QComboBox QAbstractItemView {
        background-color: #ffffff;
        color: #2d2d2d;
        selection-background-color: #0078d4;
        selection-color: #ffffff;
        border: 1px solid #c0c0c0;
        border-radius: 6px;
    }
    
    /* ===== CHECK BOX ===== */
    QCheckBox {
        color: #2d2d2d;
        spacing: 8px;
    }
    
    QCheckBox::indicator {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        border: 2px solid #c0c0c0;
        background: #ffffff;
    }
    
    QCheckBox::indicator:checked {
        background: #0078d4;
        border: 2px solid #0078d4;
    }
    
    QCheckBox::indicator:hover {
        border: 2px solid #0078d4;
    }
    
    /* ===== LIST WIDGET ===== */
    QListWidget {
        background-color: #ffffff;
        color: #2d2d2d;
        border: 1px solid #d0d0d0;
        border-radius: 6px;
        padding: 4px;
    }
    
    QListWidget::item {
        padding: 6px;
        border-radius: 4px;
    }
    
    QListWidget::item:selected {
        background-color: #0078d4;
        color: #ffffff;
    }
    
    QListWidget::item:hover:!selected {
        background-color: #e8f4fd;
    }
    
    /* ===== SPLITTER ===== */
    QSplitter::handle {
        background: #d0d0d0;
        width: 4px;
    }
    
    QSplitter::handle:hover {
        background: #0078d4;
    }
    
    /* ===== MENU BAR ===== */
    QMenuBar {
        background-color: #e8e8ec;
        color: #2d2d2d;
        border-bottom: 1px solid #d0d0d0;
        padding: 4px;
    }
    
    QMenuBar::item {
        padding: 6px 12px;
        border-radius: 4px;
    }
    
    QMenuBar::item:selected {
        background-color: #d0e0f0;
    }
    
    QMenu {
        background-color: #ffffff;
        color: #2d2d2d;
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        padding: 6px;
    }
    
    QMenu::item {
        padding: 8px 24px;
        border-radius: 4px;
    }
    
    QMenu::item:selected {
        background-color: #0078d4;
        color: #ffffff;
    }
    
    QMenu::separator {
        height: 1px;
        background: #d0d0d0;
        margin: 6px 12px;
    }
    
    /* ===== STATUS BAR ===== */
    QStatusBar {
        background-color: #e8e8ec;
        color: #555555;
        border-top: 1px solid #d0d0d0;
        padding: 4px;
    }
    
    /* ===== SPIN BOX ===== */
    QSpinBox, QDoubleSpinBox {
        background-color: #ffffff;
        color: #2d2d2d;
        border: 1px solid #c0c0c0;
        border-radius: 6px;
        padding: 4px 8px;
    }
    
    QSpinBox:hover, QDoubleSpinBox:hover {
        border: 1px solid #0078d4;
    }
    
    /* ===== TOOL TIP ===== */
    QToolTip {
        background-color: #ffffff;
        color: #2d2d2d;
        border: 1px solid #0078d4;
        border-radius: 6px;
        padding: 6px;
        font-size: 9pt;
    }
    
    /* ===== MESSAGE BOX ===== */
    QMessageBox {
        background-color: #f0f2f5;
    }
    
    QMessageBox QLabel {
        color: #2d2d2d;
    }
    
    /* ===== INPUT DIALOG ===== */
    QInputDialog {
        background-color: #f0f2f5;
    }
    
    /* ===== COLOR DIALOG ===== */
    QColorDialog {
        background-color: #f0f2f5;
    }
    
    /* ===== FILE DIALOG ===== */
    QFileDialog {
        background-color: #f0f2f5;
    }
"""


# =============================================================================
# APPLICATION ENTRY POINT
# =============================================================================

def main():
    """Main entry point."""
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(APP_VERSION)

    # Set application style
    app.setStyle('Fusion')

    # Apply default dark theme
    app.setStyleSheet(DARK_STYLESHEET)

    # Create and show main window
    window = RefaceMainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == '__main__':
    main()
