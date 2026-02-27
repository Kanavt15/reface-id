"""
REface ID — Python Backend Server
Handles Blender engine integration, mesh operations, 3D export, and AI face generation.
Uses Flask API to communicate with the Electron/Three.js frontend.
"""

import os
import sys
import json
import uuid
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from dotenv import load_dotenv
import anthropic
import speech_recognition as sr

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / '.env')

app = Flask(__name__)
CORS(app)

# ─── Anthropic AI Client ─────────────────────────────────────────────────────
ai_client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))

AI_SYSTEM_PROMPT = """You are the AI face builder for REface ID, a forensic 3D facial reconstruction tool.
Your job is to translate natural language face descriptions into precise parameter values.

You control these parameter categories:

## MORPH TARGETS (face shape) — all integer values 0-100, where 50 = neutral/default
Skull: faceWidth, faceLength, headWidth, headLength, faceTaper
Forehead: foreheadHeight, foreheadSlope, foreheadWidth, templeWidth, foreheadBulge
Brows: browHeight, browSpacing, browProminence, browArch, browThickness
Eyes: eyeSpacing, eyeHeight, eyeDepth, eyeSize, eyeTilt, eyeOpenness
Nose: noseLength, noseWidth, noseBridgeWidth, noseBridgeHeight, noseTipHeight, noseTipWidth, nostrilFlare
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
eyeColor: hex color string (e.g., "#634e34" brown, "#2e536f" blue, "#3d671d" green)
ageRange: "18-25", "25-35", "35-45", "45-55", "55-65", "65+"
sex: "male" or "female"

## RULES
1. ONLY output a valid JSON object. No explanations, no markdown, no comments.
2. Only include parameters you want to change. Omit parameters that should stay at default (50) or unchanged.
3. For refinement requests, you will receive the current parameter state. Apply RELATIVE changes based on the user's feedback.
4. Use the exact JSON structure shown below.
5. For "a bit" / "slightly" changes, adjust by 5-10 from current value. For "more" / "much more", adjust by 15-25.

## OUTPUT FORMAT (strict JSON, nothing else):
{
  "morphTargets": { "paramName": value, ... },
  "hair": { "style": "hair1", "color": "#hex", "length": 50, "density": 50, "volume": 50, "curl": 0 },
  "eyebrows": { "thickness": 50, "arch": 50, "spacing": 50, "density": 70 },
  "beard": { "style": "none", "color": "#hex" },
  "appearance": { "skinColor": "#hex", "eyeColor": "#hex", "ageRange": "25-35", "sex": "male" }
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
    
    # Pass arguments via temp JSON file
    args_file = None
    if args_dict:
        args_file = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        json.dump(args_dict, args_file)
        args_file.close()
    
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
        'base_model': str(MODELS_DIR / 'base_face.obj'),
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
        'base_model': str(MODELS_DIR / 'base_face.obj'),
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
    """Export the reconstructed face as OBJ/FBX/GLB."""
    data = request.json
    format_type = data.get('format', 'obj')
    case_data = data.get('caseData', {})
    
    export_filename = f"reface_export_{uuid.uuid4().hex[:8]}.{format_type}"
    export_path = str(EXPORTS_DIR / export_filename)
    
    result = run_blender_script('export_model.py', {
        'morph_targets': case_data.get('morphTargets', {}),
        'hair_params': case_data.get('hairParams', {}),
        'appearance': case_data.get('appearance', {}),
        'format': format_type,
        'output_path': export_path,
        'base_model': str(MODELS_DIR / 'base_face.obj')
    })
    
    if 'error' not in result:
        result['download_path'] = export_path
        result['filename'] = export_filename
    
    return jsonify(result)


@app.route('/api/export/download/<filename>', methods=['GET'])
def download_export(filename):
    """Download an exported file."""
    file_path = EXPORTS_DIR / filename
    if file_path.exists():
        return send_file(str(file_path), as_attachment=True)
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

@app.route('/api/ai/generate', methods=['POST'])
def ai_generate_face():
    """Use Claude AI to interpret a face description and return parameter values."""
    data = request.json
    prompt = data.get('prompt', '')
    current_state = data.get('currentState', None)
    conversation_history = data.get('history', [])

    if not prompt:
        return jsonify({"error": "No prompt provided"}), 400

    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        return jsonify({"error": "ANTHROPIC_API_KEY not set in .env file"}), 500

    # Build messages for Claude
    messages = []

    # Add conversation history (previous turns for refinement)
    for msg in conversation_history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    # Build the user message
    user_content = prompt
    if current_state:
        user_content = f"Current face state:\n```json\n{json.dumps(current_state, indent=2)}\n```\n\nUser request: {prompt}"

    messages.append({"role": "user", "content": user_content})

    try:
        response = ai_client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            system=AI_SYSTEM_PROMPT,
            messages=messages,
        )

        ai_text = response.content[0].text.strip()

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
        })

    except json.JSONDecodeError as e:
        return jsonify({
            "error": f"AI returned invalid JSON: {str(e)}",
            "rawResponse": ai_text if 'ai_text' in locals() else '',
        }), 500
    except anthropic.APIError as e:
        return jsonify({"error": f"Claude API error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500


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
    print("=" * 60)
    app.run(host='127.0.0.1', port=5001, debug=False)
