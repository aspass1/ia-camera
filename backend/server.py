from __future__ import annotations

import json
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
DB = DATA / "linhacount.db"


def connection():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS events(
          id TEXT PRIMARY KEY, machine INTEGER NOT NULL, kind TEXT NOT NULL,
          created_ms INTEGER NOT NULL, source TEXT NOT NULL, track_id TEXT
        );
        CREATE TABLE IF NOT EXISTS heartbeats(
          machine INTEGER PRIMARY KEY, seen_ms INTEGER NOT NULL, healthy INTEGER NOT NULL
        );
        """
    )
    return db


class AIEvent(BaseModel):
    machine: int
    kind: str
    track_id: str
    at: int | None = None
    confidence: float | None = None


app = FastAPI(title="LinhaCount", version="1.0")


@app.get("/")
def root():
    return RedirectResponse("/linhacount/dashboard.html", status_code=307)


@app.get("/api/health")
def health():
    return {"ok": True, "python": True, "time": int(time.time() * 1000)}


@app.post("/api/ai/event")
def ai_event(event: AIEvent):
    if not 1 <= event.machine <= 27 or event.kind not in {"good", "residue"}:
        raise HTTPException(400, "Evento inválido")
    event_id = f"ai:{event.machine}:{event.track_id}"
    with connection() as db:
        db.execute(
            "INSERT OR IGNORE INTO events(id,machine,kind,created_ms,source,track_id) VALUES(?,?,?,?,?,?)",
            (event_id, event.machine, event.kind, event.at or int(time.time() * 1000), "ai", event.track_id),
        )
        created = db.total_changes > 0
        db.execute(
            "INSERT INTO heartbeats(machine,seen_ms,healthy) VALUES(?,?,1) "
            "ON CONFLICT(machine) DO UPDATE SET seen_ms=excluded.seen_ms,healthy=1",
            (event.machine, int(time.time() * 1000)),
        )
    return {"ok": True, "created": created, "id": event_id}


@app.post("/api/ai/heartbeat")
async def ai_heartbeat(request: Request):
    body = await request.json()
    machine = int(body.get("machine", 0))
    if not 1 <= machine <= 27:
        raise HTTPException(400, "Máquina inválida")
    with connection() as db:
        db.execute(
            "INSERT INTO heartbeats(machine,seen_ms,healthy) VALUES(?,?,?) "
            "ON CONFLICT(machine) DO UPDATE SET seen_ms=excluded.seen_ms,healthy=excluded.healthy",
            (machine, int(time.time() * 1000), int(bool(body.get("healthy", True)))),
        )
    return {"ok": True}


@app.post("/api/capture")
async def capture(request: Request):
    body = await request.json()
    machine = int(body.get("machine", 0))
    if not 1 <= machine <= 27:
        raise HTTPException(400, "Máquina inválida")
    action = body.get("action")
    now = int(time.time() * 1000)
    if action == "piece":
        kind = body.get("kind")
        if kind not in {"good", "residue"}:
            raise HTTPException(400, "Classificação inválida")
        event_id = str(body.get("eventId") or uuid.uuid4())
        with connection() as db:
            db.execute(
                "INSERT OR IGNORE INTO events(id,machine,kind,created_ms,source,track_id) VALUES(?,?,?,?,?,?)",
                (event_id, machine, kind, int(body.get("at") or now), "browser", None),
            )
    elif action == "reclassify":
        event_id = str(body.get("eventId", ""))
        with connection() as db:
            db.execute("UPDATE events SET kind='residue' WHERE id=? AND machine=? AND kind='good'", (event_id, machine))
    if action in {"claim", "bind", "heartbeat"}:
        healthy = bool(body.get("healthy", action != "heartbeat"))
        with connection() as db:
            db.execute(
                "INSERT INTO heartbeats(machine,seen_ms,healthy) VALUES(?,?,?) "
                "ON CONFLICT(machine) DO UPDATE SET seen_ms=excluded.seen_ms,healthy=excluded.healthy",
                (machine, now, int(healthy)),
            )
    return {"ok": True}


@app.get("/api/operations")
def operations(date: str):
    try:
        start = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone(timedelta(hours=-3)))
    except ValueError as exc:
        raise HTTPException(400, "Data inválida") from exc
    start_ms = int(start.timestamp() * 1000)
    end_ms = start_ms + 86_400_000
    now = int(time.time() * 1000)
    hour_ms = now - 3_600_000
    with connection() as db:
        totals = {
            row["machine"]: row
            for row in db.execute(
                "SELECT machine,SUM(kind='good') good,SUM(kind='residue') residue," 
                "SUM(kind='good' AND created_ms>=?) hourGood FROM events "
                "WHERE created_ms>=? AND created_ms<? GROUP BY machine",
                (hour_ms, start_ms, end_ms),
            )
        }
        beats = {row["machine"]: row for row in db.execute("SELECT * FROM heartbeats")}
    machines = []
    for machine in range(1, 28):
        total, beat = totals.get(machine), beats.get(machine)
        connected = bool(beat and beat["healthy"] and now - beat["seen_ms"] < 7000)
        machines.append({
            "id": machine,
            "good": int(total["good"] or 0) if total else 0,
            "residue": int(total["residue"] or 0) if total else 0,
            "hourGood": int(total["hourGood"] or 0) if total else 0,
            "review": 0, "legacy": 0,
            "status": "working" if connected else "unknown",
            "working": 0, "idle": 0, "unknown": 0,
            "threshold": 30000, "learned": False,
        })
    return {"date": date, "now": now, "machines": machines}


app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")
