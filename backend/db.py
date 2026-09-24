"""SQLite storage for cases and snapshots, kept in the user-data folder; deletes are soft and snapshot saves are safe to retry."""

import os
import sys
import json
import base64
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

# Snapshots recovered from the old localStorage storage wait on this placeholder case until a real case adopts them.
PENDING_CASE_ID = '__pending_migration__'


# ─── Location ─────────────────────────────────────────────────────────────────

def _default_data_dir() -> Path:
    """Finds the folder for reface.db, preferring REFACE_DATA_DIR from Electron."""
    env_dir = os.getenv('REFACE_DATA_DIR')
    if env_dir:
        return Path(env_dir)

    if sys.platform == 'win32':
        base = os.getenv('APPDATA') or str(Path.home() / 'AppData' / 'Roaming')
    elif sys.platform == 'darwin':
        base = str(Path.home() / 'Library' / 'Application Support')
    else:
        base = os.getenv('XDG_DATA_HOME') or str(Path.home() / '.local' / 'share')

    return Path(base) / 'reface-id'


DATA_DIR = _default_data_dir()
DB_PATH = DATA_DIR / 'reface.db'


# ─── Connections ──────────────────────────────────────────────────────────────

# sqlite3 connections can't cross threads, so each Flask thread gets its own; WAL lets reads and writes overlap.
_local = threading.local()


def connect() -> sqlite3.Connection:
    """Returns this thread's database connection, opening and configuring it the first time."""
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        return conn

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=15.0)
    conn.row_factory = sqlite3.Row

    # WAL: concurrent reads during a write, and no lost database on a crash.
    conn.execute('PRAGMA journal_mode=WAL')
    # Foreign keys are off by default in SQLite, so turn them on for the cascade to work.
    conn.execute('PRAGMA foreign_keys=ON')
    # Write volume here is a handful of rows per session; buy full durability.
    conn.execute('PRAGMA synchronous=FULL')
    conn.execute('PRAGMA busy_timeout=15000')

    _local.conn = conn
    return conn


def _now() -> str:
    """Returns the current UTC time as an ISO string."""
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


# ─── Schema ───────────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
    id           TEXT PRIMARY KEY,
    case_number  TEXT NOT NULL DEFAULT '',
    case_name    TEXT NOT NULL DEFAULT '',
    investigator TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    state_json   TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    client_uuid TEXT UNIQUE,
    name        TEXT NOT NULL,
    state_json  TEXT NOT NULL,
    thumbnail   BLOB,
    thumb_mime  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_case
    ON snapshots(case_id, created_at);

-- Append-only. Nothing in the app updates or deletes from this table.
CREATE TABLE IF NOT EXISTS case_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    kind    TEXT NOT NULL,
    detail  TEXT,
    at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(case_id, at);
"""


def init() -> Path:
    """Creates the tables if they don't exist; safe to call on every start."""
    conn = connect()
    with conn:
        conn.executescript(_SCHEMA)
        conn.execute(
            'INSERT INTO schema_meta (key, value) VALUES (?, ?) '
            'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            ('schema_version', str(SCHEMA_VERSION)),
        )
    return DB_PATH


# ─── Thumbnails ───────────────────────────────────────────────────────────────

def _decode_thumbnail(data_url):
    """Splits a data URL into raw bytes and a mime type, or (None, None) if it isn't one."""
    if not data_url or not isinstance(data_url, str):
        return None, None
    if not data_url.startswith('data:'):
        return None, None
    try:
        header, payload = data_url.split(',', 1)
        mime = header[5:].split(';')[0] or 'image/jpeg'
        return base64.b64decode(payload), mime
    except Exception:
        return None, None


def _encode_thumbnail(blob, mime):
    """Turns stored thumbnail bytes back into a data URL."""
    if not blob:
        return ''
    return 'data:%s;base64,%s' % (mime or 'image/jpeg',
                                  base64.b64encode(blob).decode('ascii'))


# ─── Cases ────────────────────────────────────────────────────────────────────

def upsert_case(case_id: str, case: dict) -> str:
    """Inserts or updates a case, keeping its original created_at."""
    conn = connect()
    now = _now()
    with conn:
        conn.execute(
            """
            INSERT INTO cases (id, case_number, case_name, investigator,
                               description, notes, state_json,
                               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                case_number  = excluded.case_number,
                case_name    = excluded.case_name,
                investigator = excluded.investigator,
                description  = excluded.description,
                notes        = excluded.notes,
                state_json   = excluded.state_json,
                updated_at   = excluded.updated_at
            """,
            (
                case_id,
                case.get('caseNumber', '') or '',
                case.get('caseName', '') or '',
                case.get('investigator', '') or '',
                case.get('description', '') or '',
                case.get('notes', '') or '',
                json.dumps(case),
                now,
                now,
            ),
        )
    return case_id


def ensure_case(case_id: str, meta: dict = None) -> str:
    """Creates an empty case row if it doesn't exist yet; never overwrites."""
    conn = connect()
    now = _now()
    meta = meta or {}
    with conn:
        conn.execute(
            """
            INSERT INTO cases (id, case_number, case_name, investigator,
                               description, notes, state_json,
                               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            (
                case_id,
                meta.get('caseNumber', '') or '',
                meta.get('caseName', '') or '',
                meta.get('investigator', '') or '',
                meta.get('description', '') or '',
                meta.get('notes', '') or '',
                now,
                now,
            ),
        )
    return case_id


def adopt_pending_snapshots(case_id: str, meta: dict = None) -> int:
    """Moves recovered snapshots from the placeholder case onto a real case and returns how many moved."""
    if case_id == PENDING_CASE_ID:
        return 0

    ensure_case(case_id, meta)
    conn = connect()
    with conn:
        cur = conn.execute(
            'UPDATE snapshots SET case_id = ?, updated_at = ? '
            'WHERE case_id = ? AND deleted_at IS NULL',
            (case_id, _now(), PENDING_CASE_ID),
        )
        if cur.rowcount:
            _log(conn, case_id, 'snapshot.adopt',
                 '%d recovered snapshot(s)' % cur.rowcount)
    return cur.rowcount


def list_cases():
    """Lists every case except the placeholder, newest first."""
    rows = connect().execute(
        'SELECT id, case_number, case_name, investigator, created_at, updated_at '
        'FROM cases WHERE deleted_at IS NULL AND id != ? '
        'ORDER BY updated_at DESC', (PENDING_CASE_ID,)
    ).fetchall()
    return [
        {
            'caseId': r['id'],
            'caseNumber': r['case_number'],
            'caseName': r['case_name'],
            'investigator': r['investigator'],
            'createdAt': r['created_at'],
            'modifiedAt': r['updated_at'],
        }
        for r in rows
    ]


# ─── Snapshots ────────────────────────────────────────────────────────────────

def _row_to_meta(row):
    """Converts a snapshot row into the dictionary sent to the app."""
    return {
        'id': row['id'],
        'clientUuid': row['client_uuid'],
        'caseId': row['case_id'],
        'name': row['name'],
        'timestamp': row['created_at'],
        'thumbnail': _encode_thumbnail(row['thumbnail'], row['thumb_mime']),
    }


def list_snapshots(case_id: str):
    """Lists a case's snapshots with thumbnails but without their full state, to keep the list light."""
    rows = connect().execute(
        'SELECT id, client_uuid, case_id, name, thumbnail, thumb_mime, created_at '
        'FROM snapshots WHERE case_id = ? AND deleted_at IS NULL '
        'ORDER BY created_at ASC, id ASC',
        (case_id,),
    ).fetchall()
    return [_row_to_meta(r) for r in rows]


def get_snapshot(snapshot_id: int):
    """Returns one snapshot with its full state, for restore and export."""
    row = connect().execute(
        'SELECT * FROM snapshots WHERE id = ? AND deleted_at IS NULL',
        (snapshot_id,),
    ).fetchone()
    if not row:
        return None
    out = _row_to_meta(row)
    try:
        out['state'] = json.loads(row['state_json'])
    except Exception:
        out['state'] = {}
    return out


def create_snapshot(case_id, name, state, thumbnail=None,
                    client_uuid=None, case_meta=None):
    """Saves a snapshot, or returns the existing one if the same client id was already saved."""
    ensure_case(case_id, case_meta)

    if client_uuid:
        existing = connect().execute(
            'SELECT * FROM snapshots WHERE client_uuid = ?', (client_uuid,)
        ).fetchone()
        if existing:
            # This save already happened, so return the existing row.
            return get_snapshot(existing['id']) or _row_to_meta(existing)

    blob, mime = _decode_thumbnail(thumbnail)
    now = _now()
    conn = connect()
    with conn:
        cur = conn.execute(
            """
            INSERT INTO snapshots (case_id, client_uuid, name, state_json,
                                   thumbnail, thumb_mime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (case_id, client_uuid, name, json.dumps(state), blob, mime, now, now),
        )
        snapshot_id = cur.lastrowid
        _log(conn, case_id, 'snapshot.create', name)

    return get_snapshot(snapshot_id)


def rename_snapshot(snapshot_id: int, name: str):
    """Renames a snapshot and logs the change."""
    conn = connect()
    with conn:
        cur = conn.execute(
            'UPDATE snapshots SET name = ?, updated_at = ? '
            'WHERE id = ? AND deleted_at IS NULL',
            (name, _now(), snapshot_id),
        )
        if cur.rowcount:
            row = conn.execute('SELECT case_id FROM snapshots WHERE id = ?',
                               (snapshot_id,)).fetchone()
            _log(conn, row['case_id'], 'snapshot.rename', name)
    return cur.rowcount > 0


def delete_snapshot(snapshot_id: int):
    """Soft-deletes a snapshot; the row stays for the audit trail."""
    conn = connect()
    with conn:
        row = conn.execute('SELECT case_id, name FROM snapshots WHERE id = ?',
                           (snapshot_id,)).fetchone()
        if not row:
            return False
        cur = conn.execute(
            'UPDATE snapshots SET deleted_at = ?, updated_at = ? '
            'WHERE id = ? AND deleted_at IS NULL',
            (_now(), _now(), snapshot_id),
        )
        if cur.rowcount:
            _log(conn, row['case_id'], 'snapshot.delete', row['name'])
    return cur.rowcount > 0


def delete_all_snapshots(case_id: str):
    """Soft-deletes every snapshot of a case and returns how many."""
    conn = connect()
    with conn:
        cur = conn.execute(
            'UPDATE snapshots SET deleted_at = ?, updated_at = ? '
            'WHERE case_id = ? AND deleted_at IS NULL',
            (_now(), _now(), case_id),
        )
        if cur.rowcount:
            _log(conn, case_id, 'snapshot.clear', '%d snapshots' % cur.rowcount)
    return cur.rowcount


# ─── Audit log ────────────────────────────────────────────────────────────────

def _log(conn, case_id, kind, detail=''):
    """Adds an entry to the case event log using an open connection."""
    conn.execute(
        'INSERT INTO case_events (case_id, kind, detail, at) VALUES (?, ?, ?, ?)',
        (case_id, kind, str(detail)[:500], _now()),
    )


def log_event(case_id, kind, detail=''):
    """Adds an entry to the case event log in its own transaction."""
    conn = connect()
    with conn:
        _log(conn, case_id, kind, detail)


def stats():
    """Returns database statistics: file path and row counts."""
    conn = connect()
    return {
        'path': str(DB_PATH),
        'cases': conn.execute(
            'SELECT COUNT(*) c FROM cases WHERE deleted_at IS NULL').fetchone()['c'],
        'snapshots': conn.execute(
            'SELECT COUNT(*) c FROM snapshots WHERE deleted_at IS NULL').fetchone()['c'],
        'sizeBytes': DB_PATH.stat().st_size if DB_PATH.exists() else 0,
    }
