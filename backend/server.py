"""
REface ID — Python Backend Server
Handles Blender engine integration, mesh operations, 3D export, and AI face generation.
Uses Flask API to communicate with the Electron/Three.js frontend.
"""

import os
import sys
import json
import uuid
import base64
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from dotenv import load_dotenv
import anthropic
import google.generativeai as genai
import speech_recognition as sr

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / '.env')

app = Flask(__name__)
CORS(app)

# ─── AI Clients (Anthropic & Gemini) ─────────────────────────────────────────
anthropic_client = None
gemini_client = None

# Initialize Anthropic client if API key exists
anthropic_key = os.getenv('ANTHROPIC_API_KEY')
if anthropic_key:
    try:
        anthropic_client = anthropic.Anthropic(api_key=anthropic_key)
    except Exception as e:
        print(f"Warning: Failed to initialize Anthropic client: {e}")

# Initialize Gemini client if API key exists
gemini_key = os.getenv('GEMINI_API_KEY')
if gemini_key:
    try:
        genai.configure(api_key=gemini_key)
        # Use gemini-1.5-flash (stable model) instead of experimental one
        gemini_client = genai.GenerativeModel('gemini-1.5-flash')
    except Exception as e:
        print(f"Warning: Failed to initialize Gemini client: {e}")
        gemini_client = None

# Default AI provider (can be overridden per request)
DEFAULT_AI_PROVIDER = os.getenv('AI_PROVIDER', 'anthropic')  # 'anthropic' or 'gemini'

AI_SYSTEM_PROMPT = """You are the AI face builder for REface ID, a forensic 3D facial reconstruction tool.
Your job is to translate natural language face descriptions into precise parameter values.

You control these parameter categories:

## MORPH TARGETS (face shape) — all integer values 0-100, where 50 = neutral/default
Skull: faceWidth, faceLength, headWidth, headLength, faceTaper
Forehead: foreheadHeight, foreheadSlope, foreheadWidth, templeWidth, foreheadBulge
Brows: browHeight, browSpacing, browProminence, browArch, browThickness
Eyes: eyeSpacing, eyeHeight, eyeDepth, eyeSize, eyeTilt, eyeOpenness
Nose: noseLength, noseWidth, noseBridgeWidth, noseBridgeHeight, noseTipHeight, noseTipWidth, nostrilFlare
  ⚠ Nose width parameters (noseWidth, noseBridgeWidth, noseTipWidth, nostrilFlare) are HIGH SENSITIVITY — small value changes produce large visible effects. Use conservative values closer to 50. For "slightly wide" use 55-58, "wide" use 60-65, "slightly narrow" use 42-45, "narrow" use 38-40. Avoid extreme values unless explicitly requested.
Cheeks: cheekFullness, cheekboneProminence, cheekHeight, nasolabialDepth
Mouth: mouthWidth, mouthHeight, lipProtrusion, upperLipThickness, lowerLipThickness, cupidBow, philtrumDepth, philtrumWidth, lipCornerAngle
Jaw/Chin: jawWidth, chinHeight, chinWidth, chinProtrusion, jawDefinition
Ears: earSize, earProtrusion, earHeight, earlobeSize

Value guide for morphs:
- 0 = minimum (e.g., very narrow, very small, very short)
- 50 = neutral/average
- 100 = maximum (e.g., very wide, very large, very long)
- "slightly wide" ≈ 60-65, "wide" ≈ 70-75, "very wide" ≈ 80-90
- "slightly narrow" ≈ 35-40, "narrow" ≈ 25-30, "very narrow" ≈ 10-20

## HAIR — style is a string, properties are 0-100
Available styles and their descriptions:
- "hair1": Short textured crop (default)
- "hair2": Slicked back medium
- "hair3": Long straight parted
- "hair4": Curly afro volume
- "hair5": Buzz cut / military
- "hair6": Pompadour styled
- "hair7": Side swept medium
- "hair8": Long wavy flowing
- "hair9": Short spiky
- "hair10": Dreadlocks / locs
- "hair11": Mohawk style
- "hair12": Bob / shoulder length
- "bald": No hair

Hair properties (0-100): length, density, volume, curl
Hair color: hex color string (e.g., "#1a1a1a" for black, "#d4a23f" for blonde)

## EYEBROWS — all 0-100
Properties: thickness, arch, spacing, density

## BEARD
Style: "none" or "beard1" (full beard)
Color: hex color string

## APPEARANCE
skinColor: hex color string (e.g., "#f5deb3" very light, "#d4a574" medium, "#3b2010" very dark)
lipColor: hex color string or null (e.g., "#c44569" rose, "#b33939" red, "#e08283" pink, "#cc8e7a" nude). Only set if the user mentions lip color/lipstick.
eyeColor: hex color string (e.g., "#634e34" brown, "#2e536f" blue, "#3d671d" green)
ageRange: "18-25", "25-35", "35-45", "45-55", "55-65", "65+"
sex: "male" or "female"

## FACIAL MARKS (scars, birthmarks, moles, pimples, wounds) — OPTIONAL
Only include if the user explicitly requests mark generation or if reference images show visible marks.
- type: "scar", "birthmark", "mole", "pimple", or "wound"
- region: "cheek", "nose", "chin", "temple", "forehead", "jaw", "mouth", "ear", "eye", "brow", "bridge"
- side: "left", "right", or "center"
- offset_x: normalized X position within region (-1 to 1, where 0 = center)
- offset_y: normalized Y position within region (-1 to 1, where 0 = center)
- size: mark size (0.01-0.1 scale)

Example facial marks:
```json
"facialMarks": [
  {"type": "scar", "region": "cheek", "side": "right", "offset_x": 0.2, "offset_y": -0.1, "size": 0.03},
  {"type": "birthmark", "region": "temple", "side": "left", "offset_x": -0.15, "offset_y": 0.05, "size": 0.02}
]
```

## RULES
1. ONLY output a valid JSON object. No explanations, no markdown, no comments.
2. Only include parameters you want to change. Omit parameters that should stay at default (50) or unchanged.
3. For refinement requests, you will receive the current parameter state. Apply RELATIVE changes based on the user's feedback.
4. Use the exact JSON structure shown below.
5. For "a bit" / "slightly" changes, adjust by 5-10 from current value. For "more" / "much more", adjust by 15-25.
6. If one or more reference images are attached, infer visible facial traits from them and combine that with user text instructions.
7. IMPORTANT: Only include "facialMarks" if the user explicitly requests mark generation (e.g., "add scars", "include visible marks from the image") OR if you're analyzing reference images and marks are prominently visible.

## OUTPUT FORMAT (strict JSON, nothing else):
{
  "morphTargets": { "paramName": value, ... },
  "hair": { "style": "hair1", "color": "#hex", "length": 50, "density": 50, "volume": 50, "curl": 0 },
  "eyebrows": { "thickness": 50, "arch": 50, "spacing": 50, "density": 70 },
  "beard": { "style": "none", "color": "#hex" },
  "appearance": { "skinColor": "#hex", "lipColor": "#hex", "eyeColor": "#hex", "ageRange": "25-35", "sex": "male" },
  "facialMarks": [
    { "type": "scar", "region": "cheek", "side": "right", "offset_x": 0.2, "offset_y": -0.1, "size": 0.03 }
  ]
}"""

# Paths
BASE_DIR = Path(__file__).parent
ASSETS_DIR = BASE_DIR.parent / 'assets'
MODELS_DIR = ASSETS_DIR / 'models'
EXPORTS_DIR = BASE_DIR / 'exports'
BLENDER_SCRIPTS_DIR = BASE_DIR / 'blender_scripts'
CASES_DIR = BASE_DIR / 'cases'

# Ensure directories exist
for d in [EXPORTS_DIR, CASES_DIR, MODELS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# Try to find Blender executable
BLENDER_PATH = None
POSSIBLE_BLENDER_PATHS = [
    # Blender 5.x
    r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe",
    # Blender 4.x
    r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
    # Blender 3.x
    r"C:\Program Files\Blender Foundation\Blender 3.6\blender.exe",
    # macOS / Linux
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/usr/bin/blender",
    "/snap/bin/blender",
]

# Also search dynamically for any Blender installation
import glob
for pattern in [r"C:\Program Files\Blender Foundation\Blender *\blender.exe"]:
    for path in sorted(glob.glob(pattern), reverse=True):  # newest first
        POSSIBLE_BLENDER_PATHS.insert(0, path)

for p in POSSIBLE_BLENDER_PATHS:
    if os.path.exists(p):
        BLENDER_PATH = p
        break


def run_blender_script(script_name, args_dict=None):
    """Execute a Blender Python script in background mode."""
    if not BLENDER_PATH:
        return {"error": "Blender not found. Please install Blender and update the path."}

    script_path = BLENDER_SCRIPTS_DIR / script_name
    if not script_path.exists():
        return {"error": f"Script {script_name} not found"}

    print(f"[Blender] Running {script_name} with Blender at {BLENDER_PATH}")

    # Pass arguments via temp JSON file
    args_file = None
    if args_dict:
        # Normalize all paths to use forward slashes to avoid JSON escape issues
        for key, value in args_dict.items():
            if isinstance(value, str) and '\\' in value:
                args_dict[key] = value.replace('\\', '/')

        args_file = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        json.dump(args_dict, args_file, indent=2)
        args_file.close()
        print(f"[Blender] Args file: {args_file.name}")
    
    cmd = [
        BLENDER_PATH,
        '--background',
        '--python', str(script_path)
    ]
    
    if args_file:
        cmd.extend(['--', args_file.name])
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300
        )
        
        # Clean up args file
        if args_file:
            os.unlink(args_file.name)
        
        # Parse output for JSON result
        output = result.stdout
        
        # Log Blender output for debugging
        if output.strip():
            print(f"[Blender stdout] {script_name}:")
            for line in output.strip().split('\n'):
                print(f"  {line}")
        if result.stderr and result.stderr.strip():
            print(f"[Blender stderr] {script_name}:")
            for line in result.stderr.strip().split('\n')[-20:]:
                print(f"  {line}")
        
        for line in output.split('\n'):
            if line.startswith('RESULT:'):
                return json.loads(line[7:])
        
        if result.returncode != 0:
            return {"error": result.stderr}
        
        return {"success": True, "output": output}
        
    except subprocess.TimeoutExpired:
        return {"error": "Blender operation timed out"}
    except Exception as e:
        return {"error": str(e)}


# ─── Health Check ──────────────────────────────────────────────────────────────

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        "status": "running",
        "blender_available": BLENDER_PATH is not None,
        "blender_path": BLENDER_PATH
    })


# ─── Face Morphing ─────────────────────────────────────────────────────────────

@app.route('/api/morph', methods=['POST'])
def apply_morph():
    """Apply morph targets to the base face mesh using Blender."""
    data = request.json
    morph_params = data.get('morphTargets', {})
    
    result = run_blender_script('apply_morphs.py', {
        'base_model': str(MODELS_DIR / 'base' / 'base_face.obj'),
        'morph_targets': morph_params,
        'output_path': str(EXPORTS_DIR / 'morphed_face.obj')
    })
    
    return jsonify(result)


# ─── Hair System ───────────────────────────────────────────────────────────────

@app.route('/api/hair/generate', methods=['POST'])
def generate_hair():
    """Generate hair particle system using Blender and return downloadable OBJ."""
    data = request.json
    hair_params = data.get('hairParams', {})
    
    output_file = f"hair_mesh_{uuid.uuid4().hex[:8]}.obj"
    output_path = str(EXPORTS_DIR / output_file)
    
    result = run_blender_script('generate_hair.py', {
        'base_model': str(MODELS_DIR / 'base' / 'base_face.obj'),
        'hair_params': hair_params,
        'output_path': output_path
    })
    
    if result.get('success') and os.path.exists(output_path):
        result['hair_obj_url'] = f'/api/hair/download/{output_file}'
        result['filename'] = output_file
    
    return jsonify(result)


@app.route('/api/hair/download/<filename>', methods=['GET'])
def download_hair(filename):
    """Serve a generated hair mesh OBJ file."""
    file_path = EXPORTS_DIR / filename
    if file_path.exists():
        return send_file(str(file_path), mimetype='text/plain')
    return jsonify({"error": "Hair mesh not found"}), 404


# ─── Export ────────────────────────────────────────────────────────────────────

@app.route('/api/export', methods=['POST'])
def export_model():
    """Export the reconstructed face as OBJ/FBX/GLB with all edited features."""
    data = request.json
    format_type = data.get('format', 'obj')
    case_data = data.get('caseData', {})

    print(f"[Export] Starting export as {format_type}")

    export_filename = f"reface_export_{uuid.uuid4().hex[:8]}.{format_type}"
    export_path = str(EXPORTS_DIR / export_filename)

    base_model_path = str(MODELS_DIR / 'base' / 'base_face.obj')
    if not os.path.exists(base_model_path):
        error_msg = f"Base model not found at {base_model_path}"
        print(f"[Export] Error: {error_msg}")
        return jsonify({"error": error_msg})

    # Check if a morphed mesh exists (uploaded before this export call)
    morphed_mesh_path = str(EXPORTS_DIR / 'morphed_head_for_render.obj')
    use_morphed = os.path.exists(morphed_mesh_path)

    print(f"[Export] Using morphed mesh: {use_morphed}")
    print(f"[Export] Output path: {export_path}")
    print(f"[Export] MODELS_DIR: {MODELS_DIR}")
    print(f"[Export] MODELS_DIR exists: {MODELS_DIR.exists()}")
    print(f"[Export] Hair style: {case_data.get('hairStyle', 'bald')}")
    print(f"[Export] Beard style: {case_data.get('beardStyle', 'none')}")

    # Prepare the export arguments for Blender
    export_args = {
        'morph_targets': case_data.get('morphTargets', {}),
        'hair_params': case_data.get('hairParams', {}),
        'appearance': case_data.get('appearance', {}),
        'format': format_type,
        'output_path': export_path,
        'base_model': base_model_path,
        'morphed_mesh_path': morphed_mesh_path if use_morphed else '',
        'models_dir': str(MODELS_DIR),
        # Hair data
        'hairStyle': case_data.get('hairStyle', 'bald'),
        'hairColor': case_data.get('hairColor', '#2c1b0e'),
        'hairTransform': case_data.get('hairTransform', None),
        # Beard data
        'beardStyle': case_data.get('beardStyle', 'none'),
        'beardColor': case_data.get('beardColor', '#2c1b0e'),
        'beardParams': case_data.get('beardParams', {}),
        'beardTransform': case_data.get('beardTransform', None),
        # Eyebrow data
        'eyebrowColor': case_data.get('eyebrowColor', '#2c1b0e'),
        'eyebrowParams': case_data.get('eyebrowParams', {}),
        'eyebrowTransform': case_data.get('eyebrowTransform', None),
        # Eye data
        'eyeState': case_data.get('eyeState', {}),
        'eyeTransforms': case_data.get('eyeTransforms', None),
        'eyelashTransforms': case_data.get('eyelashTransforms', None),
        # Skin color
        'skinColor': case_data.get('skinColor', '#d4a574'),
    }

    result = run_blender_script('export_model.py', export_args)

    print(f"[Export] Blender result: {result}")

    # Verify file was actually created
    if result.get('success'):
        if os.path.exists(export_path):
            file_size = os.path.getsize(export_path)
            print(f"[Export] File verified: {export_filename} ({file_size} bytes)")
            result['download_path'] = export_path
            result['filename'] = export_filename
        else:
            print(f"[Export] ERROR: Blender reported success but file not found at {export_path}")
            result['error'] = f"Export failed: file not created"
            result['success'] = False
    elif 'error' not in result:
        result['error'] = 'Export operation failed'
    else:
        print(f"[Export] Error: {result.get('error')}")

    return jsonify(result)


@app.route('/api/decal/bake', methods=['POST'])
def bake_decals():
    """Bake decal textures onto the face mesh skin diffuse map.
    Accepts base OBJ + array of decal texture/projection params.
    Returns baked texture PNG + updated OBJ/MTL."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    decals = data.get('decals', [])
    if not decals:
        return jsonify({"error": "No decals to bake"}), 400

    obj_data = data.get('objData', '')
    skin_color = data.get('skinColor', '#d4a574')
    texture_size = data.get('textureSize', 2048)

    # Save OBJ data to temp file if provided
    obj_path = str(EXPORTS_DIR / 'decal_bake_input.obj')
    if obj_data:
        with open(obj_path, 'w') as f:
            f.write(obj_data)
    elif (EXPORTS_DIR / 'morphed_face.obj').exists():
        obj_path = str(EXPORTS_DIR / 'morphed_face.obj')
    else:
        obj_path = str(MODELS_DIR / 'base' / 'base_face.obj')

    output_dir = str(EXPORTS_DIR / 'decal_bake')

    result = run_blender_script('bake_decals.py', {
        'obj_path': obj_path,
        'output_dir': output_dir,
        'texture_size': texture_size,
        'skin_color': skin_color,
        'decals': decals,
    })

    if result.get('success'):
        result_json_path = Path(output_dir) / 'bake_result.json'
        if result_json_path.exists():
            with open(result_json_path, 'r') as f:
                bake_result = json.load(f)

            # Read the baked texture as base64 for the frontend
            baked_tex_path = bake_result.get('baked_texture', '')
            if baked_tex_path and os.path.exists(baked_tex_path):
                with open(baked_tex_path, 'rb') as f:
                    tex_data = base64.b64encode(f.read()).decode('utf-8')
                bake_result['baked_texture_data'] = f'data:image/png;base64,{tex_data}'

            bake_result['success'] = True
            return jsonify(bake_result)

        return jsonify({"success": True, "message": "Bake completed but no result metadata found"})

    return jsonify(result)


@app.route('/api/export/download/<filename>', methods=['GET'])
def download_export(filename):
    """Download an exported file."""
    file_path = EXPORTS_DIR / filename
    if file_path.exists():
        file_size = file_path.stat().st_size
        print(f"[Download] Serving {filename} ({file_size} bytes)")

        # Determine MIME type based on extension
        if filename.endswith('.obj'):
            mimetype = 'application/octet-stream'
        elif filename.endswith('.fbx'):
            mimetype = 'application/octet-stream'
        elif filename.endswith('.glb'):
            mimetype = 'model/gltf-binary'
        else:
            mimetype = 'application/octet-stream'

        return send_file(str(file_path), as_attachment=True, mimetype=mimetype, download_name=filename)

    print(f"[Download] File not found: {filename} at {file_path}")
    return jsonify({"error": "File not found"}), 404


# ─── Case Management ──────────────────────────────────────────────────────────

@app.route('/api/case/save', methods=['POST'])
def save_case():
    """Save current reconstruction state as a case file."""
    data = request.json
    case_id = data.get('caseId', str(uuid.uuid4()))
    
    case_file = CASES_DIR / f"{case_id}.rfc"
    case_data = {
        'caseId': case_id,
        'caseName': data.get('caseName', 'Untitled Case'),
        'caseNumber': data.get('caseNumber', ''),
        'investigator': data.get('investigator', ''),
        'description': data.get('description', ''),
        'morphTargets': data.get('morphTargets', {}),
        'hairParams': data.get('hairParams', {}),
        'appearance': data.get('appearance', {}),
        'cameraState': data.get('cameraState', {}),
        'notes': data.get('notes', ''),
    }
    
    with open(case_file, 'w') as f:
        json.dump(case_data, f, indent=2)
    
    return jsonify({"success": True, "caseId": case_id, "path": str(case_file)})


@app.route('/api/case/load', methods=['POST'])
def load_case():
    """Load a case file."""
    data = request.json
    case_path = data.get('path', '')
    
    if not os.path.exists(case_path):
        return jsonify({"error": "Case file not found"}), 404
    
    with open(case_path, 'r') as f:
        case_data = json.load(f)
    
    return jsonify(case_data)


# ─── Blender Render ────────────────────────────────────────────────────────────

RENDERS_DIR = BASE_DIR / 'renders'
RENDERS_DIR.mkdir(parents=True, exist_ok=True)


@app.route('/api/render/upload-mesh', methods=['POST'])
def upload_morphed_mesh():
    """Receive the morphed head mesh OBJ from the frontend and save it
    so the Blender render script can import it instead of the base model."""
    data = request.json
    obj_data = data.get('objData', '')
    if not obj_data:
        return jsonify({"error": "No OBJ data provided"}), 400

    mesh_file = EXPORTS_DIR / 'morphed_head_for_render.obj'
    with open(mesh_file, 'w') as f:
        f.write(obj_data)

    return jsonify({"success": True, "path": str(mesh_file).replace('\\', '/')})


@app.route('/api/render', methods=['POST'])
def render_scene():
    """Render the current scene with Blender for a realistic output image.
    If a morphed mesh was uploaded via /api/render/upload-mesh, it will be
    used in place of the base head.glb."""
    data = request.json
    hair_style = data.get('hairStyle', 'hair1')
    hair_color = data.get('hairColor', '#2c1b0e')
    skin_color = data.get('skinColor', '#d4a574')
    engine = data.get('engine', 'EEVEE')
    quality = data.get('quality', 'medium')

    render_filename = f"render_{uuid.uuid4().hex[:8]}"
    render_path = str(RENDERS_DIR / render_filename)

    # Check if a morphed mesh exists (uploaded before this render call)
    morphed_mesh_path = str(EXPORTS_DIR / 'morphed_head_for_render.obj')
    use_morphed = os.path.exists(morphed_mesh_path)

    hair_transform = data.get('hairTransform', None)

    result = run_blender_script('render_scene.py', {
        'hairStyle': hair_style,
        'hairColor': hair_color,
        'skinColor': skin_color,
        'engine': engine,
        'quality': quality,
        'output_path': render_path,
        'models_dir': str(MODELS_DIR),
        'morphed_mesh_path': morphed_mesh_path if use_morphed else '',
        'hairTransform': hair_transform,
    })

    if result.get('error'):
        return jsonify(result), 500

    # Find the output file (Blender may append .png)
    actual_path = result.get('output_path', render_path)
    for candidate in [actual_path, render_path + '.png', render_path + '0001.png']:
        if os.path.exists(candidate):
            actual_path = candidate
            break

    actual_filename = os.path.basename(actual_path)
    result['render_url'] = f'/api/render/download/{actual_filename}'
    result['filename'] = actual_filename
    return jsonify(result)


@app.route('/api/render/download/<filename>', methods=['GET'])
def download_render(filename):
    """Serve a rendered image."""
    file_path = RENDERS_DIR / filename
    if file_path.exists():
        return send_file(str(file_path), mimetype='image/png')
    return jsonify({"error": "Render file not found"}), 404


# ─── AI Face Generation ───────────────────────────────────────────────────────

@app.route('/api/ai/providers', methods=['GET'])
def ai_providers():
    """Return which AI providers are available (have API keys configured)."""
    return jsonify({
        "providers": {
            "anthropic": {"available": anthropic_client is not None, "label": "Claude"},
            "gemini": {"available": gemini_client is not None, "label": "Gemini"},
        },
        "default": DEFAULT_AI_PROVIDER,
    })


@app.route('/api/ai/generate', methods=['POST'])
def ai_generate_face():
    """Use AI (Claude or Gemini) to interpret a face description and return parameter values."""
    data = request.json
    prompt = data.get('prompt', '')
    current_state = data.get('currentState', None)
    conversation_history = data.get('history', [])
    reference_images = data.get('referenceImages', None)
    generate_facial_marks = data.get('generateFacialMarks', False)  # New flag for mark generation
    # Backward compatibility with previous single-image payload
    if reference_images is None:
        single_ref = data.get('referenceImage', None)
        reference_images = [single_ref] if single_ref else []
    provider = data.get('provider', DEFAULT_AI_PROVIDER).lower()  # Allow override via request
    model = data.get('model', None)  # Optional specific model override

    if not prompt:
        if not reference_images:
            return jsonify({"error": "No prompt provided"}), 400

    image_payloads = []
    if reference_images:
        try:
            image_payloads = _parse_reference_images(reference_images)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    # Validate provider and check if API key is available
    if provider == 'anthropic':
        if not anthropic_client:
            return jsonify({"error": "Anthropic API key not set in .env file (ANTHROPIC_API_KEY)"}), 500
    elif provider == 'gemini':
        if not gemini_client:
            return jsonify({"error": "Gemini API key not set in .env file (GEMINI_API_KEY)"}), 500
    else:
        return jsonify({"error": f"Invalid provider '{provider}'. Use 'anthropic' or 'gemini'"}), 400

    # Build user content with current state if available
    user_content = prompt
    if image_payloads:
        img_count = len(image_payloads)
        suffix = 'images are' if img_count > 1 else 'image is'
        if user_content:
            user_content = f"{user_content}\n\n{img_count} reference {suffix} attached."
        else:
            user_content = f"Use the {img_count} attached reference image{'s' if img_count > 1 else ''} to generate the face parameters."

    if generate_facial_marks:
        marks_instruction = "\n\nIMPORTANT: The user wants you to also generate facial marks (scars, birthmarks, moles, etc.). Analyze the reference images for visible marks and include them in your facialMarks output."
        user_content += marks_instruction

    if current_state:
        user_content = f"Current face state:\n```json\n{json.dumps(current_state, indent=2)}\n```\n\nUser request: {prompt}"
        if image_payloads:
            user_content += f"\n\n{len(image_payloads)} reference image{'s are' if len(image_payloads) > 1 else ' is'} attached."
        if generate_facial_marks:
            marks_instruction = "\n\nIMPORTANT: The user wants you to also generate facial marks (scars, birthmarks, moles, etc.). Analyze the reference images for visible marks and include them in your facialMarks output."
            user_content += marks_instruction

    try:
        if provider == 'anthropic':
            # Use Anthropic Claude
            messages = []
            # Add conversation history — strip image blocks to save tokens
            # (the AI already analyzed them on the first call)
            for i, msg in enumerate(conversation_history):
                content = msg["content"]
                if isinstance(content, list):
                    # Keep only text blocks, drop image blocks
                    content = [block for block in content if block.get("type") != "image"]
                    if not content:
                        continue
                entry = {"role": msg["role"], "content": content}
                # Mark last history message for prompt caching
                if i == len(conversation_history) - 1:
                    if isinstance(entry["content"], str):
                        entry["content"] = [
                            {"type": "text", "text": entry["content"], "cache_control": {"type": "ephemeral"}}
                        ]
                    elif isinstance(entry["content"], list):
                        entry["content"] = list(entry["content"])
                        if entry["content"]:
                            entry["content"][-1] = {**entry["content"][-1], "cache_control": {"type": "ephemeral"}}
                messages.append(entry)
            if image_payloads:
                user_blocks = [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": payload["mime_type"],
                            "data": payload["base64_data"],
                        },
                    }
                    for payload in image_payloads
                ]
                user_blocks.append({"type": "text", "text": user_content})
                messages.append({
                    "role": "user",
                    "content": user_blocks,
                })
            else:
                messages.append({"role": "user", "content": user_content})

            anthropic_model = model if model else "claude-sonnet-4-6"
            response = anthropic_client.messages.create(
                model=anthropic_model,
                max_tokens=1024,
                system=[
                    {
                        "type": "text",
                        "text": AI_SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"}
                    }
                ],
                messages=messages,
            )
            ai_text = response.content[0].text.strip()

        elif provider == 'gemini':
            # Use Google Gemini
            # For Gemini, we'll use generate_content with the full prompt including system instructions
            full_prompt = f"{AI_SYSTEM_PROMPT}\n\n"
            
            # Add conversation history if exists
            if conversation_history:
                full_prompt += "Previous conversation:\n"
                for msg in conversation_history:
                    role_name = "User" if msg['role'] == 'user' else "Assistant"
                    full_prompt += f"{role_name}: {msg['content']}\n"
                full_prompt += "\n"
            
            # Add current request
            full_prompt += f"User: {user_content}\n\nAssistant: "
            
            # Generate response (use specified model or default)
            gemini_model = genai.GenerativeModel(model) if model else gemini_client
            if image_payloads:
                parts = [full_prompt]
                parts.extend({"mime_type": payload["mime_type"], "data": payload["raw_bytes"]} for payload in image_payloads)
                response = gemini_model.generate_content(parts)
            else:
                response = gemini_model.generate_content(full_prompt)
            ai_text = response.text.strip()

        # Extract JSON from response (handle potential markdown wrapping)
        if ai_text.startswith('```'):
            lines = ai_text.split('\n')
            json_lines = []
            in_block = False
            for line in lines:
                if line.startswith('```') and not in_block:
                    in_block = True
                    continue
                elif line.startswith('```') and in_block:
                    break
                elif in_block:
                    json_lines.append(line)
            ai_text = '\n'.join(json_lines)

        face_params = json.loads(ai_text)

        return jsonify({
            "success": True,
            "params": face_params,
            "aiResponse": ai_text,
            "provider": provider,
        })

    except json.JSONDecodeError as e:
        error_msg = f"AI returned invalid JSON: {str(e)}"
        print(f"[AI Error - JSON] {error_msg}")
        print(f"[AI Raw Response] {ai_text if 'ai_text' in locals() else 'No response'}")
        return jsonify({
            "error": error_msg,
            "rawResponse": ai_text if 'ai_text' in locals() else '',
            "provider": provider,
        }), 500
    except Exception as e:
        error_msg = f"{provider.capitalize()} API error: {str(e)}"
        print(f"[AI Error - {provider}] {error_msg}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": error_msg, "provider": provider}), 500


def _parse_reference_images(reference_images):
    """Validate and parse frontend-provided image payloads for multimodal models."""
    if not isinstance(reference_images, list):
        raise ValueError("Invalid reference images payload")
    if len(reference_images) == 0:
        return []

    max_images = 10
    if len(reference_images) > max_images:
        raise ValueError(f"Too many reference images. Max allowed is {max_images}.")

    parsed = []
    for reference_image in reference_images:
        parsed.append(_parse_reference_image(reference_image))
    return parsed


def _parse_reference_image(reference_image):
    """Validate and parse a single frontend-provided image payload."""
    if not isinstance(reference_image, dict):
        raise ValueError("Invalid reference image payload")

    data_url = reference_image.get('dataUrl', '')
    mime_type = reference_image.get('mimeType', '')
    if not data_url:
        raise ValueError("Reference image data is empty")

    if data_url.startswith('data:'):
        if ',' not in data_url:
            raise ValueError("Reference image data URL is malformed")
        header, b64_data = data_url.split(',', 1)
        if ';base64' not in header:
            raise ValueError("Reference image must be base64 encoded")
        detected_mime = header[5:].split(';')[0]
        if not mime_type:
            mime_type = detected_mime
    else:
        b64_data = data_url

    if mime_type == 'image/jpg':
        mime_type = 'image/jpeg'

    allowed = {'image/png', 'image/jpeg', 'image/webp'}
    if mime_type not in allowed:
        raise ValueError("Unsupported reference image format. Use PNG, JPEG, or WEBP.")

    try:
        raw_bytes = base64.b64decode(b64_data, validate=True)
    except Exception:
        raise ValueError("Reference image payload is not valid base64 data")

    if len(raw_bytes) > 5 * 1024 * 1024:
        raise ValueError("Reference image is too large. Please use an image under 5MB.")

    return {
        "mime_type": mime_type,
        "base64_data": b64_data,
        "raw_bytes": raw_bytes,
    }


# ─── Speech-to-Text ──────────────────────────────────────────────────────────

@app.route('/api/speech/transcribe', methods=['POST'])
def transcribe_speech():
    """Transcribe audio to text using Google Speech Recognition."""
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    filename = audio_file.filename or 'audio.webm'
    recognizer = sr.Recognizer()

    # Save uploaded file
    suffix = '.webm' if 'webm' in filename else '.wav'
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    wav_path = tmp_path
    try:
        # Convert webm to wav if needed (using ffmpeg via pydub)
        if suffix == '.webm':
            from pydub import AudioSegment
            wav_path = tmp_path.replace('.webm', '.wav')
            audio_seg = AudioSegment.from_file(tmp_path, format='webm')
            audio_seg.export(wav_path, format='wav')

        with sr.AudioFile(wav_path) as source:
            audio_data = recognizer.record(source)
        text = recognizer.recognize_google(audio_data)
        return jsonify({"success": True, "text": text})
    except sr.UnknownValueError:
        return jsonify({"error": "Could not understand audio. Try speaking more clearly."}), 400
    except sr.RequestError as e:
        return jsonify({"error": f"Speech service error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Audio processing error: {str(e)}"}), 500
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        if wav_path != tmp_path and os.path.exists(wav_path):
            os.unlink(wav_path)


# ─── Blender Status ───────────────────────────────────────────────────────────

@app.route('/api/blender/config', methods=['POST'])
def set_blender_path():
    """Manually set the Blender executable path."""
    global BLENDER_PATH
    data = request.json
    path = data.get('path', '')
    
    if os.path.exists(path):
        BLENDER_PATH = path
        return jsonify({"success": True, "blender_path": BLENDER_PATH})
    
    return jsonify({"error": "Path does not exist"}), 400


if __name__ == '__main__':
    print("=" * 60)
    print("  REface ID — Backend Server")
    print(f"  Blender: {'Found at ' + BLENDER_PATH if BLENDER_PATH else 'NOT FOUND'}")
    print(f"  AI Provider: {DEFAULT_AI_PROVIDER.upper()}")
    print(f"  - Anthropic: {'✓ Ready' if anthropic_client else '✗ No API key'}")
    print(f"  - Gemini: {'✓ Ready' if gemini_client else '✗ No API key'}")
    print("=" * 60)
    app.run(host='127.0.0.1', port=5001, debug=False)
