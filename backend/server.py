"""
Tolaria Vault API — Phase 2 Cloud Backend (POC)
=================================================
Phase 1 (from previous session):
  - All /api/vault/* CRUD endpoints against any filesystem path

Phase 2 (this session):
  - MongoDB sync metadata tracking (motor async driver)
  - Cloud vault storage: /app/vault_store/{vault_id}/
  - POST /api/vault/sync/push   — push local changes to cloud
  - GET  /api/vault/sync/pull   — pull server-side changes since timestamp
  - GET  /api/vault/sync/status — sync status & stats
  - POST /api/vault/sync/init   — initialise a new cloud vault (seed from any path)

Validates: The REST API layer is clean enough for a real cloud backend to slot
in without any frontend changes.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
import yaml
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MONGO_URL: str = os.environ["MONGO_URL"]
DB_NAME: str = os.environ["DB_NAME"]
VAULT_STORE_ROOT = Path("/app/vault_store")

# ---------------------------------------------------------------------------
# App & DB
# ---------------------------------------------------------------------------

app = FastAPI(title="Tolaria Cloud API – Phase 2 POC")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_mongo_client: Optional[AsyncIOMotorClient] = None


def get_db():
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = AsyncIOMotorClient(MONGO_URL)
    return _mongo_client[DB_NAME]


# ---------------------------------------------------------------------------
# Markdown / frontmatter helpers (unchanged from Phase 1)
# ---------------------------------------------------------------------------

DEDICATED_KEYS = {
    "aliases", "is_a", "is a", "type", "status", "title", "_archived",
    "archived", "_icon", "icon", "color", "_order", "order",
    "_sidebar_label", "sidebar_label", "sidebar label", "template",
    "_sort", "sort", "view", "_width", "width", "visible",
    "_organized", "_favorite", "_favorite_index", "_list_properties_display",
}


def _wiki_links(value: str) -> list[str]:
    return re.findall(r"\[\[[^\]]+\]\]", value)


def _wiki_links_from(value: Any) -> list[str]:
    if isinstance(value, str):
        return _wiki_links(value)
    if isinstance(value, list):
        if len(value) == 1 and isinstance(value[0], str):
            lnks = _wiki_links(value[0])
            return lnks if lnks else [f"[[{value[0]}]]"]
        return [lnk for item in value if isinstance(item, str) for lnk in _wiki_links(item)]
    return []


def _parse_fm(content: str) -> tuple[dict, str]:
    fm: dict = {}
    body = content
    if content.startswith("---"):
        end = content.find("\n---", 3)
        if end != -1:
            try:
                parsed = yaml.safe_load(content[3:end].strip())
                fm = parsed if isinstance(parsed, dict) else {}
            except Exception:
                fm = {}
            body = content[end + 4:].strip()
    return fm, body


def _get(fm: dict, *keys: str) -> Any:
    lo = {k.lower() for k in keys}
    for k, v in fm.items():
        if k.lower() in lo:
            return v
    return None


def _str(fm, *k): v = _get(fm, *k); return v if isinstance(v, str) else None
def _arr(fm, *k):
    v = _get(fm, *k)
    if isinstance(v, list): return [str(i) for i in v]
    if isinstance(v, str): return [v]
    return []
def _bool(fm, *k):
    v = _get(fm, *k)
    if isinstance(v, bool): return v
    if isinstance(v, str): return v.lower() in ("true", "yes")
    return None


def _title(body: str, fm: dict, fallback: str) -> str:
    t = _str(fm, "title")
    if t: return t
    h1 = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
    return h1.group(1).strip() if h1 else fallback


def _body_text(body: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"^#+\s+.+$", "", body, flags=re.MULTILINE)).strip()


def _relationships(fm: dict) -> dict:
    r: dict = {}
    for k, v in fm.items():
        if k.lower() in DEDICATED_KEYS: continue
        lnks = _wiki_links_from(v)
        if lnks: r[k] = lnks
    return r


def _properties(fm: dict) -> dict:
    p: dict = {}
    for k, v in fm.items():
        if k.lower() in DEDICATED_KEYS or k.strip().startswith("_"): continue
        if v is None or isinstance(v, (int, float, bool)):
            p[k] = v
        elif isinstance(v, str) and not _wiki_links(v):
            p[k] = v
        elif isinstance(v, list) and len(v) == 1 and isinstance(v[0], str) and not _wiki_links(v[0]):
            p[k] = v[0]
    return p


def _parse_file(fp: str) -> Optional[dict]:
    try:
        stat = os.stat(fp)
        with open(fp, encoding="utf-8", errors="replace") as f:
            raw = f.read()
        fm, body = _parse_fm(raw)
        fn = os.path.basename(fp)
        title = _title(body, fm, fn.replace(".md", ""))
        txt = _body_text(body)
        return {
            "path": fp, "filename": fn, "title": title,
            "isA": _str(fm, "is_a", "is a", "type"),
            "aliases": _arr(fm, "aliases"),
            "belongsTo": [l for v in _arr(fm, "belongs_to", "belongs to") for l in _wiki_links(v)],
            "relatedTo": [l for v in _arr(fm, "related_to", "related to") for l in _wiki_links(v)],
            "status": _str(fm, "status"),
            "archived": _bool(fm, "archived") or False,
            "trashed": _bool(fm, "trashed") or False,
            "trashedAt": None,
            "modifiedAt": stat.st_mtime * 1000,
            "createdAt": stat.st_ctime * 1000,
            "fileSize": stat.st_size,
            "snippet": txt[:200],
            "wordCount": len([w for w in txt.split() if w]),
            "relationships": _relationships(fm),
            "icon": _str(fm, "icon"), "color": _str(fm, "color"),
            "order": fm.get("order"),
            "sidebarLabel": _str(fm, "sidebar label", "sidebar_label"),
            "template": _str(fm, "template"), "sort": _str(fm, "sort"),
            "view": _str(fm, "view"), "visible": _bool(fm, "visible"),
            "outgoingLinks": [], "properties": _properties(fm),
        }
    except Exception:
        return None


def _scan(dir_path: str) -> list[str]:
    out: list[str] = []
    try:
        for e in os.scandir(dir_path):
            if e.name.startswith("."): continue
            if e.is_dir(follow_symlinks=False): out.extend(_scan(e.path))
            elif e.name.endswith(".md"): out.append(e.path)
    except Exception:
        pass
    return out


def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Phase 1: Vault CRUD endpoints (unchanged contract)
# ---------------------------------------------------------------------------

@app.get("/api/vault/ping")
async def vault_ping():
    return {"ok": True}


@app.get("/api/vault/list")
async def vault_list(path: str = Query(...)):
    if not os.path.isdir(path):
        raise HTTPException(400, "Invalid or missing path")
    return [e for e in (_parse_file(f) for f in _scan(path)) if e]


@app.get("/api/vault/entry")
async def vault_entry(path: str = Query(...)):
    if not os.path.isfile(path):
        raise HTTPException(400, "File not found")
    entry = _parse_file(path)
    if not entry: raise HTTPException(500, "Could not parse file")
    return entry


@app.get("/api/vault/content")
async def vault_content(path: str = Query(...)):
    if not os.path.isfile(path):
        raise HTTPException(400, "File not found")
    with open(path, encoding="utf-8", errors="replace") as f:
        return {"content": f.read()}


@app.get("/api/vault/all-content")
async def vault_all_content(path: str = Query(...)):
    if not os.path.isdir(path):
        raise HTTPException(400, "Invalid path")
    out: dict[str, str] = {}
    for fp in _scan(path):
        try:
            with open(fp, encoding="utf-8", errors="replace") as f:
                out[fp] = f.read()
        except Exception:
            pass
    return out


@app.get("/api/vault/search")
async def vault_search(
    vault_path: str = Query(default=""),
    query: str = Query(default=""),
    mode: str = Query(default="all"),
):
    if not vault_path or not query:
        return {"results": [], "elapsed_ms": 0, "query": query, "mode": mode}
    q = query.lower()
    results = []
    for fp in _scan(vault_path):
        entry = _parse_file(fp)
        if not entry or entry.get("trashed"): continue
        try:
            with open(fp, encoding="utf-8", errors="replace") as f:
                raw = f.read()
        except Exception:
            continue
        if q in entry["title"].lower() or q in raw.lower():
            results.append({
                "title": entry["title"], "path": entry["path"],
                "snippet": entry["snippet"], "score": 1.0,
                "note_type": entry["isA"],
            })
        if len(results) >= 20: break
    return {"results": results, "elapsed_ms": 1 if results else 0, "query": query, "mode": mode}


@app.post("/api/vault/save")
async def vault_save(request: Request):
    body = await request.json()
    fp, content = body.get("path"), body.get("content")
    if not fp or content is None: raise HTTPException(400, "Missing path or content")
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w", encoding="utf-8") as f: f.write(content)

    # Auto-track in MongoDB when saving into a cloud vault_store path
    try:
        fp_path = Path(fp)
        rel = fp_path.relative_to(VAULT_STORE_ROOT)
        if rel.parts:
            vault_id = rel.parts[0]
            filename = fp_path.name
            now = time.time()
            db = get_db()
            await db.vault_files.update_one(
                {"vault_id": vault_id, "filename": filename},
                {"$set": {
                    "vault_id": vault_id, "filename": filename,
                    "storage_path": str(fp_path),
                    "content_hash": _sha256(content),
                    "content_size": len(content.encode()),
                    "modified_at": now, "synced_at": now, "deleted": False,
                }},
                upsert=True,
            )
    except ValueError:
        pass  # Not in vault_store — skip MongoDB tracking

    return None


@app.post("/api/vault/rename")
async def vault_rename(request: Request):
    body = await request.json()
    old, title = body.get("old_path", ""), body.get("new_title", "")
    if not old or not os.path.isfile(old): raise HTTPException(400, "File not found")
    with open(old, encoding="utf-8", errors="replace") as f: raw = f.read()
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    new = os.path.join(os.path.dirname(old), f"{slug}.md")
    updated = re.sub(r"^title:\s*.*$", f"title: {title}", raw, flags=re.MULTILINE)
    with open(new, "w", encoding="utf-8") as f: f.write(updated)
    if new != old: os.unlink(old)
    return {"new_path": new, "updated_files": 0, "failed_updates": 0}


@app.post("/api/vault/rename-filename")
async def vault_rename_filename(request: Request):
    body = await request.json()
    old, stem = body.get("old_path", ""), body.get("new_filename_stem", "").strip().rstrip(".md")
    if not old or not os.path.isfile(old): raise HTTPException(400, "File not found")
    if not stem: raise HTTPException(400, "Invalid filename")
    new = os.path.join(os.path.dirname(old), f"{stem}.md")
    if new != old and os.path.exists(new): raise HTTPException(409, "Name already taken")
    os.rename(old, new)
    return {"new_path": new, "updated_files": 0, "failed_updates": 0}


@app.post("/api/vault/move-to-folder")
async def vault_move_to_folder(request: Request):
    body = await request.json()
    old = body.get("old_path", "")
    folder = body.get("folder_path", "").strip("/")
    root = body.get("vault_path", "").rstrip("/")
    if not old or not os.path.isfile(old): raise HTTPException(400, "File not found")
    new = os.path.join(root, folder, os.path.basename(old))
    if new == old: return {"new_path": old, "updated_files": 0, "failed_updates": 0}
    os.makedirs(os.path.dirname(new), exist_ok=True)
    os.rename(old, new)
    return {"new_path": new, "updated_files": 0, "failed_updates": 0}


@app.post("/api/vault/delete")
async def vault_delete(request: Request):
    body = await request.json()
    fp = body.get("path", "")
    if not fp: raise HTTPException(400, "Missing path")
    if not os.path.isfile(fp): raise HTTPException(404, "File not found")
    os.unlink(fp)

    # Auto-track deletion in MongoDB for cloud vault paths
    try:
        fp_path = Path(fp)
        rel = fp_path.relative_to(VAULT_STORE_ROOT)
        if rel.parts:
            vault_id = rel.parts[0]
            filename = fp_path.name
            now = time.time()
            db = get_db()
            await db.vault_files.update_one(
                {"vault_id": vault_id, "filename": filename},
                {"$set": {"deleted": True, "synced_at": now}},
            )
    except ValueError:
        pass

    return fp


# ---------------------------------------------------------------------------
# Phase 2: Cloud Sync endpoints
# ---------------------------------------------------------------------------

def _cloud_path(vault_id: str, filename: str) -> Path:
    """Resolve a relative filename to an absolute cloud storage path."""
    # Strip any absolute prefix so clients can send either relative or absolute paths
    clean = os.path.basename(filename)
    return VAULT_STORE_ROOT / vault_id / clean


@app.post("/api/vault/sync/init")
async def sync_init(request: Request):
    """
    Initialise a cloud vault, optionally seeding from an existing local path.

    Body: { "vault_id": "default", "seed_path": "/app/demo-vault-v2" }
    Returns: { "vault_id": str, "files_imported": int, "storage_path": str }
    """
    body = await request.json()
    vault_id: str = body.get("vault_id", "default")
    seed_path: str = body.get("seed_path", "")

    vault_dir = VAULT_STORE_ROOT / vault_id
    vault_dir.mkdir(parents=True, exist_ok=True)

    db = get_db()
    imported = 0

    if seed_path and os.path.isdir(seed_path):
        for fp in _scan(seed_path):
            try:
                with open(fp, encoding="utf-8", errors="replace") as f:
                    content = f.read()
                filename = os.path.basename(fp)
                dest = vault_dir / filename
                dest.write_text(content, encoding="utf-8")
                stat = os.stat(fp)
                now = time.time()
                content_hash = _sha256(content)
                await db.vault_files.update_one(
                    {"vault_id": vault_id, "filename": filename},
                    {"$set": {
                        "vault_id": vault_id,
                        "filename": filename,
                        "storage_path": str(dest),
                        "content_hash": content_hash,
                        "content_size": len(content.encode()),
                        "modified_at": stat.st_mtime,
                        "synced_at": now,
                        "deleted": False,
                    }},
                    upsert=True,
                )
                imported += 1
            except Exception:
                pass

    return {
        "vault_id": vault_id,
        "files_imported": imported,
        "storage_path": str(vault_dir),
    }


@app.post("/api/vault/sync/push")
async def sync_push(request: Request):
    """
    Push local changes to the cloud vault.

    Body:
    {
      "vault_id": "default",
      "files": [
        { "filename": "note.md", "content": "...", "modified_at": 1234567890.0 }
      ]
    }

    Returns:
    {
      "saved":     ["note.md"],
      "conflicts": [{ "filename": "note.md", "server_modified_at": 1234567900.0 }],
      "synced_at": 1234567890.0
    }

    Conflict rule: if server version was modified AFTER the client's `modified_at`
    the file is flagged as a conflict and NOT overwritten.
    """
    body = await request.json()
    vault_id: str = body.get("vault_id", "default")
    files: list[dict] = body.get("files", [])

    vault_dir = VAULT_STORE_ROOT / vault_id
    vault_dir.mkdir(parents=True, exist_ok=True)

    db = get_db()
    saved: list[str] = []
    conflicts: list[dict] = []
    now = time.time()

    for item in files:
        filename: str = os.path.basename(item.get("filename", ""))
        content: str = item.get("content", "")
        client_ts: float = float(item.get("modified_at", 0))

        if not filename or not filename.endswith(".md"):
            continue

        dest = vault_dir / filename

        # Check for conflict: does the server have a newer version?
        existing = await db.vault_files.find_one(
            {"vault_id": vault_id, "filename": filename},
            {"modified_at": 1, "_id": 0},
        )
        server_ts: float = existing["modified_at"] if existing else 0.0

        if server_ts > client_ts + 1:  # 1-second grace window
            conflicts.append({"filename": filename, "server_modified_at": server_ts})
            continue

        # Save the file
        dest.write_text(content, encoding="utf-8")
        content_hash = _sha256(content)

        await db.vault_files.update_one(
            {"vault_id": vault_id, "filename": filename},
            {"$set": {
                "vault_id": vault_id,
                "filename": filename,
                "storage_path": str(dest),
                "content_hash": content_hash,
                "content_size": len(content.encode()),
                "modified_at": max(client_ts, now),
                "synced_at": now,
                "deleted": False,
            }},
            upsert=True,
        )
        saved.append(filename)

    return {"saved": saved, "conflicts": conflicts, "synced_at": now}


@app.get("/api/vault/sync/pull")
async def sync_pull(
    vault_id: str = Query(default="default"),
    since: float = Query(default=0.0),
):
    """
    Pull all cloud changes that happened after `since` (Unix timestamp).

    Returns:
    {
      "files":   [{ "filename": str, "content": str, "modified_at": float }],
      "deleted": ["deleted_note.md"],
      "total":   int
    }
    """
    db = get_db()
    cursor = db.vault_files.find(
        {"vault_id": vault_id, "synced_at": {"$gt": since}},
        {"_id": 0, "filename": 1, "storage_path": 1, "modified_at": 1, "deleted": 1},
    )
    docs = await cursor.to_list(length=1000)

    files: list[dict] = []
    deleted: list[str] = []

    for doc in docs:
        if doc.get("deleted"):
            deleted.append(doc["filename"])
            continue
        fp = doc.get("storage_path", "")
        if not os.path.isfile(fp):
            continue
        try:
            with open(fp, encoding="utf-8", errors="replace") as f:
                content = f.read()
            files.append({
                "filename": doc["filename"],
                "content": content,
                "modified_at": doc["modified_at"],
            })
        except Exception:
            pass

    return {"files": files, "deleted": deleted, "total": len(files) + len(deleted)}


@app.get("/api/vault/sync/status")
async def sync_status(vault_id: str = Query(default="default")):
    """
    Return sync status for a vault.

    Returns: { vault_id, total_files, last_synced_at, storage_path, storage_size_bytes }
    """
    db = get_db()
    total = await db.vault_files.count_documents({"vault_id": vault_id, "deleted": False})
    last_doc = await db.vault_files.find_one(
        {"vault_id": vault_id},
        sort=[("synced_at", -1)],
        projection={"synced_at": 1, "_id": 0},
    )
    last_synced = last_doc["synced_at"] if last_doc else None

    vault_dir = VAULT_STORE_ROOT / vault_id
    size = sum(f.stat().st_size for f in vault_dir.rglob("*.md") if f.is_file()) if vault_dir.exists() else 0

    return {
        "vault_id": vault_id,
        "total_files": total,
        "last_synced_at": last_synced,
        "storage_path": str(vault_dir),
        "storage_size_bytes": size,
    }
