"""
ai_keys.py — the API keys an operator enters in the app, and the clients
built from them.

Keys used to arrive only through a .env file sitting beside the source. An
installed build has no such file and no shell to create one, so every AI
feature died the moment the app was compiled — and the only fix was to edit
.env and compile again. Keys are therefore entered in the app and kept here,
in the same user-data directory as reface.db: the one path that survives a
reinstall and means the same thing for `npm start` as for a packaged build.

Design notes:

  * A key saved through the app outranks the environment. The app's dialog is
    the only control an operator can see, so a key saved there must be the one
    that takes effect — otherwise changing it would appear to do nothing.

  * Clients are cached against the key that built them, so a key replaced
    mid-session takes effect on the very next request with no restart, while
    an unchanged key does not pay for a fresh client on every call.

  * A key is verified against the provider before it is written. A typo that
    is only discovered on the next face generation is a typo the operator has
    no way to attribute to the key.

  * The file is written 0600 with the key in clear — the same exposure as the
    .env it replaces. Anything stronger needs an OS keychain, which this
    process does not have.
"""

import os
import json
import threading
from pathlib import Path

import anthropic
import google.generativeai as genai

import db


# ─── Providers ────────────────────────────────────────────────────────────────

# `console` is shown in the key dialog — an operator who has no key needs to be
# told where keys come from, not just that one is missing.
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
}


class UnknownProvider(ValueError):
    pass


def normalize(provider: str) -> str:
    """Lower-case and verify a provider name, raising UnknownProvider if bogus."""
    provider = (provider or '').lower().strip()
    if provider not in PROVIDERS:
        raise UnknownProvider(
            f"Unknown provider '{provider}'. Use one of: {', '.join(PROVIDERS)}"
        )
    return provider


# ─── Store ────────────────────────────────────────────────────────────────────

_STORE_PATH: Path = db.DATA_DIR / 'ai_keys.json'

# Every mutation goes through this: Flask serves on multiple threads, and two
# saves landing together must not interleave a read-modify-write of the file.
_lock = threading.Lock()

_saved = None          # provider -> key, mirror of the file; None until first read
_clients = {}          # provider -> (key, client), so a rebuild is only paid on change


def _load() -> dict:
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
        # A corrupt store must not take the backend down — the operator can
        # always re-enter the key, and everything else in the app still works.
        print(f"[AI keys] Ignoring unreadable {_STORE_PATH}: {e}")
        _saved = {}

    return _saved


def _write(keys: dict) -> None:
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _STORE_PATH.with_name(_STORE_PATH.name + '.tmp')
    tmp.write_text(json.dumps(keys, indent=2), encoding='utf-8')
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass  # Windows ACLs; the file is under the user's own profile either way
    # Replace rather than truncate-and-write: a crash mid-save cannot leave a
    # half-written key behind.
    tmp.replace(_STORE_PATH)


def get(provider: str):
    """The key in force for a provider, or None. Saved keys beat the environment."""
    provider = normalize(provider)
    saved = _load().get(provider)
    if saved:
        return saved
    env = os.getenv(PROVIDERS[provider]['env'], '').strip()
    return env or None


def source(provider: str):
    """Where the key in force came from: 'saved', 'env', or None."""
    provider = normalize(provider)
    if _load().get(provider):
        return 'saved'
    if os.getenv(PROVIDERS[provider]['env'], '').strip():
        return 'env'
    return None


def hint(provider: str):
    """A masked tail of the key in force, for the UI. Never the key itself."""
    key = get(provider)
    if not key:
        return None
    tail = key[-4:] if len(key) > 4 else ''
    return f"••••{tail}"


def status() -> dict:
    """Per-provider availability, for /api/ai/providers and the key dialog."""
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
    """Persist a key. Caller is expected to have run validate() first."""
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
    """Forget the saved key. An environment key, if any, takes over again."""
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
    """A client for the current Anthropic key, or None when no key is set."""
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


def gemini_model(model_name: str):
    """
    A Gemini model handle for the current key, or None when no key is set.

    genai keeps its credentials in module-level state, so the key is applied
    on every call rather than once at import — that is what lets a key changed
    in the app take effect without restarting the backend.
    """
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
    """
    Check a key against the provider before it is saved.

    Returns None when the key works, or an operator-readable reason when it
    does not. Both probes are metadata listings — no tokens are generated and
    nothing is billed.
    """
    provider = normalize(provider)
    key = (key or '').strip()
    if not key:
        return 'Enter a key.'

    try:
        if provider == 'anthropic':
            anthropic.Anthropic(api_key=key).models.list(limit=1)
        else:
            genai.configure(api_key=key)
            next(iter(genai.list_models()), None)
    except anthropic.AuthenticationError:
        return 'That key was rejected. Check that it was copied in full.'
    except anthropic.PermissionDeniedError:
        return 'That key is valid but not permitted to use the Messages API.'
    except anthropic.APIConnectionError:
        return 'Could not reach Anthropic. Check the network connection and try again.'
    except Exception as e:
        if is_auth_error(e):
            return 'That key was rejected. Check that it was copied in full.'
        return f'Could not verify the key: {e}'

    return None


def is_auth_error(exc: BaseException) -> bool:
    """
    Whether a failed AI call failed because of the key.

    A key can stop working long after it was verified — revoked, rotated, or
    out of credit — and when it does the operator should be asked for a new
    one rather than shown a raw SDK traceback. Anthropic raises a typed error;
    Gemini reports the same condition as a generic exception, so its wording
    is all there is to match on.
    """
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return True
    text = str(exc).lower()
    return any(
        marker in text for marker in
        ('api key', 'api_key_invalid', 'unauthenticated', 'permission denied', 'invalid authentication')
    )
