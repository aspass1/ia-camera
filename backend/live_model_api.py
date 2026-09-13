"""Machine-bound streaming inference; test sessions never write production."""
import asyncio
import hashlib
import json
import math
import time
import uuid
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from .cycle_counter import CycleCounter

router = APIRouter()
sessions = {}
model = json.loads((Path(__file__).resolve().parents[1]/'models/candidate-model.json').read_text())
MODEL_VERSION = 'destinos-3-residuos-v1'
DETECTOR_VERSION = 'lateral-cloth-motion-v4'


def local(request):
    origin = request.headers.get('origin')
    if origin and origin.rstrip('/') != str(request.base_url).rstrip('/'):
        raise HTTPException(403, 'Origem não permitida')


class Start(BaseModel):
    machine: int = Field(default=1, ge=1, le=27)
    mode: Literal['test', 'camera'] = 'test'
    device: str = Field(default='', max_length=300)
    view: Literal['original','wide'] = 'original'


def heartbeat(session, healthy):
    if session['mode'] != 'camera':
        return
    now = time.monotonic()
    if session.get('healthy') == healthy and now-session.get('beat', 0) < 2:
        return
    from .server import connection
    with connection() as db:
        db.execute(
            'INSERT INTO heartbeats(machine,seen_ms,healthy) VALUES(?,?,?) '
            'ON CONFLICT(machine) DO UPDATE SET seen_ms=excluded.seen_ms,healthy=excluded.healthy',
            (session['machine'], int(time.time()*1000), int(healthy)))
    session.update(healthy=healthy, beat=now)


def record(session, result):
    if session['mode'] == 'camera':
        from .server import ai_event, AIEvent
        for event in result['events']:
            if event['kind'] in {'good', 'residue'}:
                ai_event(AIEvent(machine=session['machine'], kind=event['kind'],
                                 track_id=event['id'], at=event['at']))
        heartbeat(session, result['reference_found'])


@router.post('/api/live-model')
async def create(request: Request, options: Start = Start()):
    local(request)
    if options.view=='wide' and options.mode=='camera':
        raise HTTPException(422, 'Enquadramento amplo ainda em validação. Desmarque registrar produção para testar.')
    for key in list(sessions):
        if time.monotonic()-sessions[key]['seen'] > 30 and not sessions[key]['lock'].locked():
            heartbeat(sessions.pop(key), False)
    if len(sessions) >= 27:
        raise HTTPException(429, 'Limite de sessões atingido')
    if options.mode == 'camera':
        for s in sessions.values():
            if s['mode'] == 'camera' and (s['machine'] == options.machine or
                    (options.device and s['device'] == options.device)):
                raise HTTPException(409, 'Esta máquina ou câmera já está em uso. Desconecte a outra captura.')
    key = uuid.uuid4().hex
    sessions[key] = {'counter': CycleCounter(model,view=options.view), 'seen': time.monotonic(), 'time': -1,
                     'counts': {'good': 0, 'residue': 0, 'review': 0}, 'lock': asyncio.Lock(),
                     'machine': options.machine, 'mode': options.mode, 'device': options.device,
                     'result': None, 'digest': None, 'sequence': 0}
    return {'session': key, 'machine': options.machine, 'mode': options.mode,
            'model': MODEL_VERSION, 'detector': DETECTOR_VERSION, 'production_ready': False}


@router.delete('/api/live-model/{key}')
async def close(key: str, request: Request):
    local(request)
    session = sessions.get(key)
    if session:
        async with session['lock']:
            sessions.pop(key, None)
            await asyncio.to_thread(heartbeat, session, False)
    return {'closed': True}


@router.post('/api/live-model/{key}')
async def frame(key: str, request: Request, seconds: float):
    local(request)
    session = sessions.get(key)
    if not session:
        raise HTTPException(404, 'Sessão encerrada; reconecte a câmera')
    if not math.isfinite(seconds) or seconds < 0:
        raise HTTPException(422, 'Tempo inválido')
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8*1024*1024:
            raise HTTPException(413, 'Quadro muito grande')
    digest = hashlib.sha256(raw).digest()
    async with session['lock']:
        if key not in sessions:
            raise HTTPException(404, 'Sessão encerrada')
        if seconds == session['time'] and digest == session['digest']:
            # Retrying a lost HTTP reply must not rerun detection or count twice.
            await asyncio.to_thread(record, session, session['result'])
            session['seen'] = time.monotonic()
            return session['result']
        if seconds <= session['time']:
            raise HTTPException(409, 'Quadro repetido com outro conteúdo ou fora de ordem')
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR) if raw else None
        if image is None or max(image.shape[:2]) > 1920:
            raise HTTPException(422, 'Quadro inválido ou maior que 1920 pixels')
        events = await asyncio.to_thread(session['counter'].update, seconds, image)
        for event in events:
            session['sequence'] += 1
            event['id'] = f"{key}:{session['sequence']}"
            event['at'] = int(time.time()*1000)
            session['counts'][event['kind']] += 1
        result = {'counts': dict(session['counts']), 'events': events,
                  'machine': session['machine'], 'mode': session['mode'], 'model': MODEL_VERSION,
                  'detector': DETECTOR_VERSION, 'quality': session['counter'].quality(),
                  'reference_found': session['counter'].gate_box is not None,
                  'production_ready': False}
        session.update(time=seconds, seen=time.monotonic(), digest=digest, result=result)
        await asyncio.to_thread(record, session, result)
        return result
