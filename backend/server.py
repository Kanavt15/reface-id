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

import db

# Windows gives a piped stdout the cp1252 codepage, and this file prints box
# drawing and check/cross marks. Under Electron — which always pipes — the
# startup banner therefore raised UnicodeEncodeError and killed the server
# before app.run() was ever reached, so the whole backend looked "offline"
# while python exited 1. Force UTF-8 and never let an unprintable character
# take the process down again.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass  # already a UTF-8 stream, or not reconfigurable

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / '.env')

app = Flask(__name__)
CORS(app)

# Open the SQLite store at import time rather than under __main__, so the
# schema exists whether this file is run directly or imported by a WSGI host.
try:
    _DB_PATH = db.init()
    print(f"[DB] SQLite ready: {_DB_PATH}")
except Exception as _db_err:
    print(f"[DB] FAILED to initialize: {_db_err}")

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

# Claude model used when the request doesn't specify one
DEFAULT_ANTHROPIC_MODEL = os.getenv('ANTHROPIC_MODEL', 'claude-opus-5')

# Models that take adaptive thinking plus output_config.effort.
# Older models (Haiku 4.5) reject both parameters.
ADAPTIVE_THINKING_MODELS = {
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
}

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
- "hair13": Medium crop, a little fuller and taller than hair1
- "hair14": Near-duplicate of hair7, cut slightly tighter. Prefer "hair7" for a
  side-swept medium; reach for this only to distinguish two similar faces.
- "bald": No hair

Hair properties (0-100): length, density, volume, curl
Hair color: hex color string (e.g., "#1a1a1a" for black, "#d4a23f" for blonde)

## EYEBROWS — all 0-100
Properties: thickness, arch, spacing, density

⚠ These are NOT centred on 50, and thickness in particular is not a percentage
of "normal" — it scales the brow mesh vertically, and past about 62 the mesh
grows down over the upper eyelid and merges with the eye. Sit inside these:
- Normal brows: thickness 52-60, density 70-80
- Heavy / bushy brows: thickness 60-62, density 85-100. Express a heavy brow
  through density, which darkens it, rather than thickness, which drops it
  onto the eye.
- Thin or sparse brows: thickness 38-48, density 45-60
- arch is a HEIGHT control, not a shape one: 50 sits the brow at the ridge, 0
  is the lowest, 100 the highest. Use 45-55 normally, higher for a
  high-set brow, lower for one that sits close to the eye.
- Keep spacing near 42; raise it only for a notably wide-set brow.

## BEARD
Style: one of "none", "beard1", "beard2", "beard3", "beard4", "beard5",
"beard6", "moustache1".
The numbers mean nothing. Each style is a combination of three parts — a jaw
curtain, a chin patch, and a moustache — so pick by which parts you need:

- "beard2" = jaw curtain + chin patch + moustache. The COMPLETE full beard, and
  the right answer for most bearded faces.
- "beard5" = jaw curtain + moustache. A full beard, slightly lighter on the chin.
- "beard6" = jaw curtain ONLY — no moustache. A jawline beard with a bare lip.
  Only pick this when the upper lip is clearly shaved.
- "beard3" = chin patch + moustache. A goatee with a moustache, bare jaw.
- "beard4" = chin patch only. A goatee or chin tuft, bare lip and bare jaw.
- "moustache1" = moustache only. Bare chin, bare jaw.
- "beard1" = a separate, older asset, not built from the three parts above.
  Prefer "beard2" for a full beard; it is the one whose coverage is known.

Choosing:
- Hair along the jaw AND on the upper lip ⇒ "beard2" (or "beard5"). This is the
  ordinary full beard, thick or trimmed.
- Bare jaw with hair only on the chin ⇒ "beard3" (with moustache) or "beard4".
- A moustache with a clean-shaven chin ⇒ "moustache1".
- "none" means clean-shaven. Use it whenever no facial hair is described.
- When a reference image is attached, read the jawline: if it is dark with hair
  down to the jaw edge, that is a full beard — "beard2" — whatever the
  description says. Check the upper lip separately before choosing "beard6".
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

## GLASSES / SPECTACLES — OPTIONAL
Include this block only when the face description mentions glasses, spectacles, reading glasses, sunglasses, eyewear, or similar.
- enabled: true to show glasses on the face, false or omit for no glasses
- frameColor: hex color for the frame (e.g., "#1a1a1a" black, "#8b4513" tortoiseshell, "#c0c0c0" silver)
- lensColor: hex color for the lens tint (e.g., "#88ccff" light blue, "#333333" dark sunglasses, "#ffffff" clear)
- lensOpacity: 0–100 (0 = fully clear/no tint, 20 = light tint, 60 = medium sunglasses, 100 = fully opaque)

Example glasses:
```json
"glasses": {
  "enabled": true,
  "frameColor": "#1a1a1a",
  "lensColor": "#88ccff",
  "lensOpacity": 20
}
```

Color hints:
- Reading glasses / clear lenses: lensOpacity 0–10, lensColor "#ffffff"
- Light-tinted prescription: lensOpacity 10–25, lensColor "#88ccff" or "#e8d4a2"
- Aviator sunglasses: lensOpacity 50–70, lensColor "#333333" or "#2c4a1d"
- Dark sunglasses: lensOpacity 70–100, lensColor "#1a1a1a"
- Wire frames: frameColor "#c0c0c0" or "#d4af37"
- Thick plastic frames: frameColor "#1a1a1a" or "#8b4513"
- If the user says "no glasses" or "remove glasses", set enabled: false

## FACE MASK — OPTIONAL
Include this block only when the description mentions a face mask, surgical mask, medical mask, cloth mask, or covering the mouth and nose with a mask.
- enabled: true to show the mask, false to remove it
- style: "mask1" (cloth mask) or "mask2" (medical / surgical mask)
- maskColor: hex color of the mask body
- strapColor: hex color of the ear loops
- opacity: 0-100 (100 = solid)

Example face mask:
```json
"faceMask": {
  "enabled": true,
  "style": "mask2",
  "maskColor": "#7fb5d4",
  "strapColor": "#e6e6e6",
  "opacity": 100
}
```

Hints:
- Surgical / medical / disposable mask: style "mask2", maskColor "#7fb5d4" (blue) or "#ffffff"
- Cloth / fabric / fashion mask: style "mask1", maskColor to match the description
- Black mask: style "mask1", maskColor "#1c1c1e"

## EARRINGS — OPTIONAL
Include this block only when the description mentions earrings, studs, hoops, or a pierced ear.
- enabled: true to show earrings, false to remove them
- style: "hoop", "stud", or "drop"
- sideMode: "both", "left", or "right" — which ear. Left and right are the subject's own sides. A single piercing is common, so use "left" or "right" when the description says one ear.
- metalColor: hex color of the metal
- polish: 0-100 (0 = matte/brushed, 100 = mirror)

Example earrings:
```json
"earrings": {
  "enabled": true,
  "style": "hoop",
  "sideMode": "left",
  "metalColor": "#d4af37",
  "polish": 82
}
```

Metal hints:
- Gold: "#d4af37"   Silver: "#c8cdd2"   Rose gold: "#b76e79"   Black / gunmetal: "#3a3d42"

## EYEBROW PIERCING — OPTIONAL
Include this block only when the description mentions an eyebrow piercing, brow
bar, brow ring, or a stud through the eyebrow.
- enabled: true to show it, false to remove it
- sideMode: "both", "left", or "right" — the subject's own sides. A brow
  piercing is usually on one side, so prefer "left" or "right".
- metalColor: hex color of the metal
- polish: 0-100 (0 = matte, 100 = mirror)

Example eyebrow piercing:
```json
"browPiercing": {
  "enabled": true,
  "sideMode": "right",
  "metalColor": "#c8cdd2",
  "polish": 85
}
```

## BANDANA — OPTIONAL
Include this block only when the description mentions a bandana, kerchief, or a cloth pulled up over the lower face outlaw-style.
- enabled: true to show the bandana, false to remove it
- style: "paisley" (the only style available)
- tint: hex color multiplied over the printed cloth. The print is red by default, so use "#ffffff" to keep it red and a colour only to dye it.
- opacity: 0-100 (100 = solid)

Example bandana:
```json
"bandana": {
  "enabled": true,
  "style": "paisley",
  "tint": "#ffffff",
  "opacity": 100
}
```

Tint hints:
- Red bandana (the default print): tint "#ffffff"
- Blue: "#5f7fc4"   Green: "#6fae72"   Black: "#5d5d5d"

## RULES
1. ONLY output a valid JSON object. No explanations, no markdown, no comments.
2. Only include parameters you want to change. Omit parameters that should stay at default (50) or unchanged.
3. For refinement requests, you will receive the current parameter state. Apply RELATIVE changes based on the user's feedback.
4. Use the exact JSON structure shown below.
5. For "a bit" / "slightly" changes, adjust by 5-10 from current value. For "more" / "much more", adjust by 15-25.
6. If one or more reference images are attached, infer visible facial traits from them and combine that with user text instructions.
7. IMPORTANT: Only include "facialMarks" if the user explicitly requests mark generation (e.g., "add scars", "include visible marks from the image") OR if you're analyzing reference images and marks are prominently visible.
8. Only include "glasses" if the description mentions glasses, spectacles, eyewear, sunglasses, or similar. If the user says "remove glasses", set enabled: false.
9. The same applies to "faceMask", "earrings", "browPiercing" and "bandana": include each block ONLY when the description mentions that item, and set enabled: false when the user asks to remove it. Omit the block entirely otherwise.
10. A bandana and a face mask both cover the lower face, so never enable both at once. Pick whichever the description actually calls for.
11. Accessories are worn items, not facial features. Never invent them — a face described without eyewear or jewellery should return none of these blocks.

## OUTPUT FORMAT (strict JSON, nothing else):
{
  "morphTargets": { "paramName": value, ... },
  "hair": { "style": "hair1", "color": "#hex", "length": 50, "density": 50, "volume": 50, "curl": 0 },
  "eyebrows": { "thickness": 56, "arch": 50, "spacing": 42, "density": 74 },
  "beard": { "style": "none", "color": "#hex" },
  "appearance": { "skinColor": "#hex", "lipColor": "#hex", "eyeColor": "#hex", "ageRange": "25-35", "sex": "male" },
  "facialMarks": [
    { "type": "scar", "region": "cheek", "side": "right", "offset_x": 0.2, "offset_y": -0.1, "size": 0.03 }
  ],
  "glasses": {
    "enabled": true,
    "frameColor": "#1a1a1a",
    "lensColor": "#88ccff",
    "lensOpacity": 20
  },
  "faceMask": {
    "enabled": false,
    "style": "mask2",
    "maskColor": "#7fb5d4",
    "strapColor": "#e6e6e6",
    "opacity": 100
  },
  "earrings": {
    "enabled": false,
    "style": "hoop",
    "sideMode": "both",
    "metalColor": "#d4af37",
    "polish": 82
  },
  "browPiercing": {
    "enabled": false,
    "sideMode": "right",
    "metalColor": "#c8cdd2",
    "polish": 85
  },
  "bandana": {
    "enabled": false,
    "style": "paisley",
    "tint": "#ffffff",
    "opacity": 100
  }
}"""

# Variant mode reuses every parameter definition above and replaces only the
# task and the output shape, so the shared prefix stays identical between the
# two prompts and keeps hitting the prompt cache.
AI_VARIANTS_PROMPT = AI_SYSTEM_PROMPT + """

# ══════════════════════════════════════════════════════════════════════
# VARIANT MODE — THIS SECTION OVERRIDES THE OUTPUT FORMAT ABOVE
# ══════════════════════════════════════════════════════════════════════

You are now producing SEVERAL candidate faces in one response, not one face.

A witness will see them side by side and pick whichever is closest to the
person they remember. People are poor at describing individual features but
very good at recognising a face, so the job here is to offer a genuine choice
— not one face plus a handful of near-copies.

Only BONE STRUCTURE varies between candidates. Everything else about the
person — colouring, hair, beard, age, sex, marks, anything they are wearing —
is the same in all of them, because it is the same person being described. So
you produce that part ONCE, in a "shared" block, exactly as you would for a
single face, and then one "morphTargets" set per candidate.

## THE SHARED BLOCK
Build it with the full care you would give a single face: read the description
and the reference images for skin tone, eye colour, hair style and colour,
eyebrows, beard, age range and sex, and include the accessory blocks under
exactly the same conditions as always — only when the description actually
mentions that item. Every rule from the format above still governs this block.
Getting it right matters more than the morphs do: a witness rejects a face on
colouring and hair long before they weigh up its jaw.

## WHAT MAKES A GOOD SET
- Every candidate must be a plausible reading of the SAME description. Never
  contradict something the user stated explicitly.
- Where the description is vague or silent, make a DIFFERENT decision in each
  candidate. That ambiguity is exactly what the witness is there to resolve.
- Differentiate through the parameters that carry recognition: overall head
  shape, face length and width, jaw, brow, nose bridge, eye spacing and set.
  These matter far more than small surface details.
- Separate the candidates by giving them different COMBINATIONS, not by pushing
  sliders toward their extremes. Every candidate must still read as a real
  person you could pass in the street — six believable faces beat six merely
  distinguishable ones, because the witness is matching a memory of a real
  face, and a caricature matches nothing.
- The value guide and the ⚠ high-sensitivity warnings above apply here in full.
  Nose width parameters especially stay near 50 unless the description calls
  for otherwise; separate noses by bridge height and length instead.
- Move a face as a whole. Real structure is correlated — a broad skull usually
  carries a broad jaw and wide cheekbones, a long face a longer nose and chin.
  Shift related parameters together rather than varying them independently, or
  the candidate stops looking like a person.
- Leave out eyeOpenness. It moves the eyelids themselves, so below 50 the eyes
  simply close, and nobody is recognised from a portrait with its eyes shut.
  Every candidate is a neutral, eyes-open portrait. The other eye parameters —
  eyeSpacing, eyeHeight, eyeDepth, eyeSize, eyeTilt — are all yours to vary,
  but keep them within a few points of the range below; the eyeball is a
  separate mesh that follows the socket, and it follows a moderate change far
  more convincingly than an extreme one.
- Keep every value between 30 and 70. Beyond that this rig stops looking like
  bone and starts looking melted, and a melted face is not a candidate. There
  is more than enough room inside that range to build six distinct people.
- Give each a short `label` of 2-4 words naming what makes it distinct, for
  example "Narrow jaw, deep-set eyes" or "Broad face, heavy brow".

## OUTPUT FORMAT (strict JSON, nothing else) — REPLACES THE FORMAT ABOVE
{
  "shared": {
    "hair": { "style": "hair1", "color": "#hex", "length": 50, "density": 50, "volume": 50, "curl": 0 },
    "eyebrows": { "thickness": 56, "arch": 50, "spacing": 42, "density": 74 },
    "beard": { "style": "none", "color": "#hex" },
    "appearance": { "skinColor": "#hex", "eyeColor": "#hex", "ageRange": "25-35", "sex": "male" }
  },
  "variants": [
    { "label": "Short description", "morphTargets": { "paramName": value, ... } }
  ]
}

Rules for this mode:
1. "shared" carries everything EXCEPT morphTargets, in the same shape and under
   the same conditions as the single-face format above. Omit any block the
   description gives you nothing to say about — an omitted block is left alone,
   so never invent hair or accessories to fill it out.
2. "variants" carries ONLY "label" and "morphTargets". No appearance keys there.
3. Produce exactly the number of candidates requested.
4. Each candidate carries its own complete "morphTargets" object. Include every
   parameter you are varying; omit any that should stay at the neutral 50.
5. Integer values 0-100 only.
"""

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
    """Save current reconstruction state to the database and a .rfc file.

    The database is the working store; the .rfc file stays because Open Case
    and the export flow both address cases by path.
    """
    data = request.json

    # `data.get('caseId', <uuid>)` used to sit here, and the default never
    # fired: currentCase always *has* a caseId key, so a brand new case sent
    # an explicit null and this returned None. Every unsaved case wrote to
    # "None.rfc" and reported caseId None back to the renderer, which is why
    # no case ever acquired an id. Treat null and '' as absent too.
    case_id = data.get('caseId') or str(uuid.uuid4())

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

    try:
        db.upsert_case(case_id, case_data)
        db.log_event(case_id, 'case.save', case_data.get('caseName', ''))
    except Exception as e:
        # A database problem must not cost the operator their .rfc file, which
        # is already on disk by this point.
        print(f"[DB] case save failed: {e}")

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


@app.route('/api/case/list', methods=['GET'])
def list_cases_route():
    """Every case the database knows about, newest activity first."""
    try:
        return jsonify({"success": True, "cases": db.list_cases()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Snapshots ────────────────────────────────────────────────────────────────
#
# Snapshots used to live in renderer localStorage under a key rebuilt on every
# write from the case id, while the only load happened once at boot before any
# case existed. Anything written after that point was never read back. They are
# rows now, addressed by a case id the renderer mints up front.

@app.route('/api/snapshots', methods=['GET'])
def list_snapshots_route():
    case_id = request.args.get('caseId', '').strip()
    if not case_id:
        return jsonify({"error": "caseId is required"}), 400
    try:
        return jsonify({"success": True, "snapshots": db.list_snapshots(case_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/snapshots/<int:snapshot_id>', methods=['GET'])
def get_snapshot_route(snapshot_id):
    try:
        snap = db.get_snapshot(snapshot_id)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if not snap:
        return jsonify({"error": "Snapshot not found"}), 404
    return jsonify({"success": True, "snapshot": snap})


@app.route('/api/snapshots', methods=['POST'])
def create_snapshot_route():
    data = request.json or {}
    case_id = (data.get('caseId') or '').strip()
    if not case_id:
        return jsonify({"error": "caseId is required"}), 400

    state = data.get('state')
    if not isinstance(state, dict):
        return jsonify({"error": "state must be an object"}), 400

    try:
        snap = db.create_snapshot(
            case_id=case_id,
            name=(data.get('name') or 'Snapshot').strip(),
            state=state,
            thumbnail=data.get('thumbnail'),
            client_uuid=data.get('clientUuid'),
            case_meta=data.get('caseMeta'),
        )
        return jsonify({"success": True, "snapshot": snap})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/snapshots/<int:snapshot_id>', methods=['PATCH'])
def rename_snapshot_route(snapshot_id):
    data = request.json or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    try:
        if not db.rename_snapshot(snapshot_id, name):
            return jsonify({"error": "Snapshot not found"}), 404
        return jsonify({"success": True, "snapshot": db.get_snapshot(snapshot_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/snapshots/<int:snapshot_id>', methods=['DELETE'])
def delete_snapshot_route(snapshot_id):
    try:
        if not db.delete_snapshot(snapshot_id):
            return jsonify({"error": "Snapshot not found"}), 404
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/snapshots/adopt', methods=['POST'])
def adopt_snapshots_route():
    """Attach snapshots recovered from localStorage to a real case."""
    data = request.json or {}
    case_id = (data.get('caseId') or '').strip()
    if not case_id:
        return jsonify({"error": "caseId is required"}), 400
    try:
        adopted = db.adopt_pending_snapshots(case_id, data.get('caseMeta'))
        return jsonify({"success": True, "adopted": adopted})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/snapshots/clear', methods=['POST'])
def clear_snapshots_route():
    data = request.json or {}
    case_id = (data.get('caseId') or '').strip()
    if not case_id:
        return jsonify({"error": "caseId is required"}), 400
    try:
        return jsonify({"success": True, "cleared": db.delete_all_snapshots(case_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/db/stats', methods=['GET'])
def db_stats_route():
    """Where the database file is and what is in it — useful from DevTools."""
    try:
        return jsonify({"success": True, **db.stats()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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

            anthropic_model = model if model else DEFAULT_ANTHROPIC_MODEL
            request_kwargs = {
                "model": anthropic_model,
                # Room for thinking tokens plus the JSON payload on 5-series models.
                "max_tokens": 8192 if anthropic_model in ADAPTIVE_THINKING_MODELS else 1024,
                "system": [
                    {
                        "type": "text",
                        "text": AI_SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"}
                    }
                ],
                "messages": messages,
            }

            # Opus 5 / Sonnet 5 / Opus 4.7 use adaptive thinking with an effort hint.
            # Low effort keeps latency and cost down for this structured task.
            if anthropic_model in ADAPTIVE_THINKING_MODELS:
                request_kwargs["thinking"] = {"type": "adaptive"}
                request_kwargs["output_config"] = {"effort": "low"}

            response = anthropic_client.messages.create(**request_kwargs)

            if getattr(response, 'stop_reason', None) == 'refusal':
                return jsonify({
                    "error": "The model declined this request. Try rephrasing the description.",
                    "provider": provider,
                }), 400

            # Thinking blocks come first, so pick the text block instead of content[0].
            ai_text = ''
            for block in response.content:
                if getattr(block, 'type', None) == 'text':
                    ai_text = block.text.strip()
                    break
            if not ai_text:
                return jsonify({
                    "error": "The model returned no text output. Try again.",
                    "provider": provider,
                }), 500

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


@app.route('/api/ai/variants', methods=['POST'])
def ai_variants():
    """
    Generate several distinct candidate faces in a single call.

    Returns a "shared" block — hair, eyebrows, beard, colouring, age, sex,
    marks, accessories — alongside the per-candidate morph sets. Candidates are
    readings of one person, so everything but bone structure is identical
    between them; emitting it once keeps the response the same size while
    letting the picker build faces to the same standard as the single-face
    builder, which is the only reason a candidate looks like anyone at all.

    Backs the witness variant picker. The picker only calls this twice at most
    in a normal session — once to open, and again if the witness rejects the
    whole set — because every round after a pick is generated locally by
    jittering the chosen face. Producing the candidates in one response rather
    than one call each is deliberate: asked separately the model tends to
    converge on the same reading of the description, and seeing all of them
    together is what lets it deliberately differentiate.
    """
    data = request.json or {}
    prompt = (data.get('prompt') or '').strip()
    count = max(2, min(8, int(data.get('count', 6))))
    avoid = data.get('avoid') or []
    reference_images = data.get('referenceImages') or []
    provider = data.get('provider', DEFAULT_AI_PROVIDER).lower()
    model = data.get('model', None)

    if not prompt and not reference_images:
        return jsonify({"error": "No description provided"}), 400

    try:
        image_payloads = _parse_reference_images(reference_images)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if provider == 'anthropic' and not anthropic_client:
        return jsonify({"error": "Anthropic API key not set in .env file (ANTHROPIC_API_KEY)"}), 500
    if provider == 'gemini' and not gemini_client:
        return jsonify({"error": "Gemini API key not set in .env file (GEMINI_API_KEY)"}), 500
    if provider not in ('anthropic', 'gemini'):
        return jsonify({"error": f"Invalid provider '{provider}'. Use 'anthropic' or 'gemini'"}), 400

    user_content = (
        f"Description of the person:\n{prompt or 'See the attached reference images.'}\n\n"
        f"Produce exactly {count} candidate faces."
    )
    if image_payloads:
        n = len(image_payloads)
        user_content += f"\n\n{n} reference image{'s are' if n > 1 else ' is'} attached."
    if avoid:
        # Without this the model re-derives the same reading of an unchanged
        # description and the second set looks like the first.
        user_content += (
            "\n\nThe witness has already looked at these candidates and said none "
            "of them resemble the person. Produce a set that is clearly different "
            "from all of them — change the structural choices, do not just nudge "
            "the numbers:\n```json\n"
            + json.dumps(avoid, indent=2)
            + "\n```"
        )

    ai_text = ''
    try:
        if provider == 'anthropic':
            if image_payloads:
                blocks = [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": p["mime_type"],
                            "data": p["base64_data"],
                        },
                    }
                    for p in image_payloads
                ]
                blocks.append({"type": "text", "text": user_content})
                messages = [{"role": "user", "content": blocks}]
            else:
                messages = [{"role": "user", "content": user_content}]

            anthropic_model = model if model else DEFAULT_ANTHROPIC_MODEL
            request_kwargs = {
                "model": anthropic_model,
                # Several full morph sets in one response needs far more room
                # than the single-face path.
                "max_tokens": 16384 if anthropic_model in ADAPTIVE_THINKING_MODELS else 8192,
                "system": [
                    {
                        "type": "text",
                        "text": AI_VARIANTS_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                "messages": messages,
            }
            if anthropic_model in ADAPTIVE_THINKING_MODELS:
                request_kwargs["thinking"] = {"type": "adaptive"}
                request_kwargs["output_config"] = {"effort": "low"}

            response = anthropic_client.messages.create(**request_kwargs)

            if getattr(response, 'stop_reason', None) == 'refusal':
                return jsonify({
                    "error": "The model declined this request. Try rephrasing the description.",
                    "provider": provider,
                }), 400

            for block in response.content:
                if getattr(block, 'type', None) == 'text':
                    ai_text = block.text.strip()
                    break
            if not ai_text:
                return jsonify({"error": "The model returned no text output. Try again.", "provider": provider}), 500

        else:
            full_prompt = f"{AI_VARIANTS_PROMPT}\n\nUser: {user_content}\n\nAssistant: "
            gemini_model = genai.GenerativeModel(model) if model else gemini_client
            if image_payloads:
                parts = [full_prompt]
                parts.extend({"mime_type": p["mime_type"], "data": p["raw_bytes"]} for p in image_payloads)
                response = gemini_model.generate_content(parts)
            else:
                response = gemini_model.generate_content(full_prompt)
            ai_text = response.text.strip()

        if ai_text.startswith('```'):
            lines = ai_text.split('\n')
            json_lines, in_block = [], False
            for line in lines:
                if line.startswith('```') and not in_block:
                    in_block = True
                    continue
                if line.startswith('```') and in_block:
                    break
                if in_block:
                    json_lines.append(line)
            ai_text = '\n'.join(json_lines)

        parsed = json.loads(ai_text)
        variants = parsed.get('variants') if isinstance(parsed, dict) else parsed
        # Colouring, hair and worn items come back once and apply to the whole
        # set. Passed through unvalidated, exactly like /api/ai/generate does —
        # each frontend system checks its own payload in applyFromAI. Only
        # morphTargets is stripped, so a stray copy here cannot fight the
        # per-candidate values.
        shared = parsed.get('shared') if isinstance(parsed, dict) else None
        if isinstance(shared, dict):
            shared = {k: v for k, v in shared.items() if k != 'morphTargets'}
        else:
            shared = None
        if not isinstance(variants, list) or not variants:
            return jsonify({
                "error": "The model did not return a variants array.",
                "rawResponse": ai_text,
                "provider": provider,
            }), 500

        # Keep only well-formed entries so one malformed candidate cannot break
        # the whole set.
        clean = []
        for v in variants:
            if not isinstance(v, dict):
                continue
            morphs = v.get('morphTargets')
            if not isinstance(morphs, dict) or not morphs:
                continue
            clean.append({
                "label": str(v.get('label') or f"Variant {len(clean) + 1}")[:60],
                "morphTargets": {
                    k: max(0, min(100, int(round(float(val)))))
                    for k, val in morphs.items()
                    if isinstance(val, (int, float))
                },
            })

        if not clean:
            return jsonify({
                "error": "The model returned no usable candidates.",
                "rawResponse": ai_text,
                "provider": provider,
            }), 500

        return jsonify({"success": True, "variants": clean, "shared": shared, "provider": provider})

    except json.JSONDecodeError as e:
        print(f"[AI Variants - JSON] {e}")
        return jsonify({"error": f"AI returned invalid JSON: {e}", "rawResponse": ai_text, "provider": provider}), 500
    except Exception as e:
        print(f"[AI Variants - {provider}] {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"{provider.capitalize()} API error: {e}", "provider": provider}), 500


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
