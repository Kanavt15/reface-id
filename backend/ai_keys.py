"""Stores the AI provider keys the operator enters in the app (in the user-data folder) and builds the API clients from them."""

import os
import json
import threading
from pathlib import Path

import anthropic
import google.generativeai as genai
import requests

import db


# ─── Providers ────────────────────────────────────────────────────────────────

# `console` is the provider's key page, shown in the key dialog.
PROVIDERS = {
    'anthropic': {
        'label': 'Claude',
        'env': 'ANTHROPIC_API_KEY',
        'placeholder': 'sk-ant-...',
        'console': 'https://console.anthropic.com/settings/keys',
    },
    'gemini': {
        'label': 'Gemini',
        'env': 'GEMINI_API_KEY',
        'placeholder': 'AIza...',
        'console': 'https://aistudio.google.com/app/apikey',
    },
    'groq': {
        'label': 'Groq',
        'env': 'GROQ_API_KEY',
        'placeholder': 'gsk_...',
        'console': 'https://console.groq.com/keys',
    },
}

# Groq has an OpenAI-style API, so plain requests calls are enough and no extra SDK is needed.
GROQ_BASE_URL = 'https://api.groq.com/openai/v1'


class UnknownProvider(ValueError):
    pass


def normalize(provider: str) -> str:
    """Lower-cases and checks a provider name, raising UnknownProvider if it isn't known."""
    provider = (provider or '').lower().strip()
    if provider not in PROVIDERS:
        raise UnknownProvider(
            f"Unknown provider '{provider}'. Use one of: {', '.join(PROVIDERS)}"
        )
    return provider


# ─── Store ────────────────────────────────────────────────────────────────────

_STORE_PATH: Path = db.DATA_DIR / 'ai_keys.json'

# Flask runs on several threads, so every change to the key file goes through this lock.
_lock = threading.Lock()

_saved = None          # provider -> key, mirror of the file; None until first read
_clients = {}          # provider -> (key, client), so a rebuild is only paid on change


def _load() -> dict:
    """Reads the saved keys file once and caches it, ignoring a corrupt file."""
    global _saved
    if _saved is not None:
        return _saved

    try:
        raw = json.loads(_STORE_PATH.read_text(encoding='utf-8'))
        _saved = {
            p: k.strip() for p, k in raw.items()
            if p in PROVIDERS and isinstance(k, str) and k.strip()
        }
    except FileNotFoundError:
        _saved = {}
    except (OSError, ValueError) as e:
        # A corrupt key file shouldn't stop the backend; the operator can re-enter the key.
        print(f"[AI keys] Ignoring unreadable {_STORE_PATH}: {e}")
        _saved = {}

    return _saved


def _write(keys: dict) -> None:
    """Writes the keys file safely: to a temp file first, owner-only permissions where possible, then swapped in."""
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _STORE_PATH.with_name(_STORE_PATH.name + '.tmp')
    tmp.write_text(json.dumps(keys, indent=2), encoding='utf-8')
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass  # Windows ACLs; the file is under the user's own profile either way
    # Swap in the new file so a crash can't leave a half-written key.
    tmp.replace(_STORE_PATH)


def get(provider: str):
    """Returns the key in use for a provider, or None; a saved key beats the environment."""
    provider = normalize(provider)
    saved = _load().get(provider)
    if saved:
        return saved
    env = os.getenv(PROVIDERS[provider]['env'], '').strip()
    return env or None


def source(provider: str):
    """Says where the key in use came from: 'saved', 'env' or None."""
    provider = normalize(provider)
    if _load().get(provider):
        return 'saved'
    if os.getenv(PROVIDERS[provider]['env'], '').strip():
        return 'env'
    return None


def hint(provider: str):
    """Returns the last few characters of the key for display, never the whole key."""
    key = get(provider)
    if not key:
        return None
    tail = key[-4:] if len(key) > 4 else ''
    return f"••••{tail}"


def status() -> dict:
    """Returns each provider's key status for the app."""
    return {
        provider: {
            'label': meta['label'],
            'available': get(provider) is not None,
            'source': source(provider),
            'hint': hint(provider),
            'placeholder': meta['placeholder'],
            'console': meta['console'],
            'envVar': meta['env'],
        }
        for provider, meta in PROVIDERS.items()
    }


def save(provider: str, key: str) -> None:
    """Saves a key; call validate() first."""
    provider = normalize(provider)
    key = (key or '').strip()
    if not key:
        raise ValueError('No key provided')

    with _lock:
        keys = dict(_load())
        keys[provider] = key
        _write(keys)
        _saved.clear()
        _saved.update(keys)
        _clients.pop(provider, None)


def clear(provider: str) -> None:
    """Forgets the saved key, so any environment key takes over again."""
    provider = normalize(provider)
    with _lock:
        keys = dict(_load())
        if keys.pop(provider, None) is None:
            return
        _write(keys)
        _saved.clear()
        _saved.update(keys)
        _clients.pop(provider, None)


# ─── Clients ──────────────────────────────────────────────────────────────────

def anthropic_client():
    """Returns an Anthropic client for the current key, or None if there is no key."""
    key = get('anthropic')
    if not key:
        return None

    cached_key, client = _clients.get('anthropic', (None, None))
    if client is not None and cached_key == key:
        return client

    try:
        client = anthropic.Anthropic(api_key=key)
    except Exception as e:
        print(f"[AI keys] Failed to build Anthropic client: {e}")
        return None

    _clients['anthropic'] = (key, client)
    return client


def groq_headers():
    """Returns the auth headers for a Groq call, or None if there is no key."""
    key = get('groq')
    if not key:
        return None
    return {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}


def gemini_model(model_name: str):
    """Returns a Gemini model for the current key, or None; the key is applied on every call so a new key works without a restart."""
    key = get('gemini')
    if not key:
        return None

    try:
        genai.configure(api_key=key)
        return genai.GenerativeModel(model_name)
    except Exception as e:
        print(f"[AI keys] Failed to build Gemini model '{model_name}': {e}")
        return None


# ─── Verification ─────────────────────────────────────────────────────────────

def validate(provider: str, key: str):
    """Checks a key with the provider before saving it; returns None if it works, or a readable reason if not (no tokens are used)."""
    provider = normalize(provider)
    key = (key or '').strip()
    if not key:
        return 'Enter a key.'

    try:
        if provider == 'anthropic':
            anthropic.Anthropic(api_key=key).models.list(limit=1)
        elif provider == 'groq':
            res = requests.get(
                f'{GROQ_BASE_URL}/models',
                headers={'Authorization': f'Bearer {key}'},
                timeout=20,
            )
            if res.status_code in (401, 403):
                return 'That key was rejected. Check that it was copied in full.'
            if res.status_code != 200:
                return f'Groq refused the key check ({res.status_code}).'
        else:
            genai.configure(api_key=key)
            next(iter(genai.list_models()), None)
    except anthropic.AuthenticationError:
        return 'That key was rejected. Check that it was copied in full.'
    except anthropic.PermissionDeniedError:
        return 'That key is valid but not permitted to use the Messages API.'
    except anthropic.APIConnectionError:
        return 'Could not reach Anthropic. Check the network connection and try again.'
    except requests.RequestException as e:
        return f'Could not reach Groq: {e}'
    except Exception as e:
        if is_auth_error(e):
            return 'That key was rejected. Check that it was copied in full.'
        return f'Could not verify the key: {e}'

    return None


def is_auth_error(exc: BaseException) -> bool:
    """Tells whether a failed AI call failed because of the key, so the app can ask for a new one."""
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return True
    text = str(exc).lower()
    return any(
        marker in text for marker in
        ('api key', 'api_key_invalid', 'unauthenticated', 'permission denied',
         'invalid authentication', 'invalid_api_key', 'error (401)', 'error (403)')
    )
