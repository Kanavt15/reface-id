"""
db.py — SQLite persistence for REface ID.

Cases and snapshots used to live in two places that could not agree with each
other: case JSON files under backend/cases/, and a localStorage key in the
renderer whose name was recomputed on every write. This module replaces the
snapshot half of that with a single transactional file.

Design notes:

  * The database file lives in the OS user-data directory, NOT in the repo.
    Electron passes its own userData path in REFACE_DATA_DIR when it spawns
    this server; the fallbacks below cover running the backend by hand.

  * Deletes are soft (deleted_at). This is a forensic tool — an operator who
    clears a snapshot list should not be able to destroy evidence of what was
    reconstructed, and the rows cost nothing.

  * snapshots.client_uuid is UNIQUE so that a retried write cannot duplicate a
    row. The renderer queues captures in an outbox while the backend is down
    and replays them on reconnect; without idempotency that replay would
    silently double every snapshot taken offline.

  * Thumbnails are stored as raw JPEG bytes rather than base64 data URLs —
    about a third smaller, and the data URL is reassembled on read.
"""

import os
import sys
import json
import base64
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

# Snapshots recovered from the pre-database localStorage era have no case of
# their own — the old code filed everything under one shared bucket because a
# case id was never assigned. They are parked against this sentinel case and
# adopted by the first real case the operator opens, rather than being pinned
# to whichever throwaway case happened to exist at migration time.
PENDING_CASE_ID = '__pending_migration__'


# ─── Location ─────────────────────────────────────────────────────────────────

def _default_data_dir() -> Path:
    """Resolve the directory holding reface.db.

    REFACE_DATA_DIR wins when set — that is Electron handing us
    app.getPath('userData'), which is the only value that keeps the database
    in the same place for a packaged build as for `npm start`.
    """
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

# Flask serves requests on multiple threads and a sqlite3 connection may not
# cross threads, so each thread gets its own. They all point at one file; WAL
# lets readers and the writer proceed without blocking each other.
_local = threading.local()


def connect() -> sqlite3.Connection:
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        return conn

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=15.0)
    conn.row_factory = sqlite3.Row

    # WAL: concurrent reads during a write, and no lost database on a crash.
    conn.execute('PRAGMA journal_mode=WAL')
    # Foreign keys are OFF by default in SQLite — without this the CASCADE on
    # snapshots.case_id is decorative.
    conn.execute('PRAGMA foreign_keys=ON')
    # Write volume here is a handful of rows per session; buy full durability.
    conn.execute('PRAGMA synchronous=FULL')
    conn.execute('PRAGMA busy_timeout=15000')

    _local.conn = conn
    return conn


def _now() -> str:
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
    """Create the schema if absent. Safe to call on every boot."""
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
    """'data:image/jpeg;base64,AAA' -> (bytes, 'image/jpeg'). (None, None) on junk."""
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
    if not blob:
        return ''
    return 'data:%s;base64,%s' % (mime or 'image/jpeg',
                                  base64.b64encode(blob).decode('ascii'))


# ─── Cases ────────────────────────────────────────────────────────────────────

def upsert_case(case_id: str, case: dict) -> str:
    """Insert or update a case row, preserving created_at on update.

    Snapshots carry a foreign key to cases, so every snapshot write calls this
    first. That ordering is deliberate: it makes "snapshot belonging to a case
    that does not exist" unrepresentable rather than merely unlikely.
    """
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
    """Create a stub case row if it does not exist yet. Never overwrites."""
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


def get_case(case_id: str):
    row = connect().execute(
        'SELECT * FROM cases WHERE id = ? AND deleted_at IS NULL', (case_id,)
    ).fetchone()
    if not row:
        return None
    try:
        state = json.loads(row['state_json'])
    except Exception:
        state = {}
    state['caseId'] = row['id']
    return state


def adopt_pending_snapshots(case_id: str, meta: dict = None) -> int:
    """Move recovered snapshots off the sentinel case onto a real one.

    Called when a case with an operator-supplied identity opens. Returns how
    many moved, which is zero on every call after the first.

    `meta` matters: adoption can be the first thing that ever mentions this
    case to the database, and creating the row without it leaves a case with a
    blank name owning the operator's recovered work.
    """
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
    return {
        'id': row['id'],
        'clientUuid': row['client_uuid'],
        'caseId': row['case_id'],
        'name': row['name'],
        'timestamp': row['created_at'],
        'thumbnail': _encode_thumbnail(row['thumbnail'], row['thumb_mime']),
    }


def list_snapshots(case_id: str):
    """Metadata and thumbnails only — state_json is deliberately not selected.

    A case with 30 snapshots holds ~30 full face states; shipping all of them
    to render a list is what made the old localStorage payload hit quota.
    """
    rows = connect().execute(
        'SELECT id, client_uuid, case_id, name, thumbnail, thumb_mime, created_at '
        'FROM snapshots WHERE case_id = ? AND deleted_at IS NULL '
        'ORDER BY created_at ASC, id ASC',
        (case_id,),
    ).fetchall()
    return [_row_to_meta(r) for r in rows]


def get_snapshot(snapshot_id: int):
    """One snapshot including its full state — used by restore and export."""
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
    """Insert a snapshot, or return the existing row for a repeated client_uuid.

    The idempotency check is what makes the renderer's offline outbox safe to
    replay: a capture that reached the database but whose response was lost
    resolves to the same row instead of a duplicate.
    """
    ensure_case(case_id, case_meta)

    if client_uuid:
        existing = connect().execute(
            'SELECT * FROM snapshots WHERE client_uuid = ?', (client_uuid,)
        ).fetchone()
        if existing:
            # A replay of a write that already landed. Undo a prior soft delete
            # only if it is still live; otherwise hand back what is there.
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
    """Soft delete — the row and its state survive for the audit trail."""
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
    conn.execute(
        'INSERT INTO case_events (case_id, kind, detail, at) VALUES (?, ?, ?, ?)',
        (case_id, kind, str(detail)[:500], _now()),
    )


def log_event(case_id, kind, detail=''):
    conn = connect()
    with conn:
        _log(conn, case_id, kind, detail)


def list_events(case_id: str, limit: int = 200):
    rows = connect().execute(
        'SELECT kind, detail, at FROM case_events WHERE case_id = ? '
        'ORDER BY id DESC LIMIT ?',
        (case_id, limit),
    ).fetchall()
    return [{'kind': r['kind'], 'detail': r['detail'], 'at': r['at']} for r in rows]


def stats():
    conn = connect()
    return {
        'path': str(DB_PATH),
        'cases': conn.execute(
            'SELECT COUNT(*) c FROM cases WHERE deleted_at IS NULL').fetchone()['c'],
        'snapshots': conn.execute(
            'SELECT COUNT(*) c FROM snapshots WHERE deleted_at IS NULL').fetchone()['c'],
        'sizeBytes': DB_PATH.stat().st_size if DB_PATH.exists() else 0,
    }
