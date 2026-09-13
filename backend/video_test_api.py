"""Local video test endpoint; results are never added to production."""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Literal
from fastapi import APIRouter, HTTPException, Request

router = APIRouter()
gate = asyncio.Lock()
ROOT = Path(__file__).resolve().parents[1]

def analyse(source, output, view='original'):
    try:
        result = subprocess.run(
            [sys.executable, str(ROOT/'backend'/'cycle_counter.py'),
             '--source', str(source), '--model', str(ROOT/'models'/'candidate-model.json'),
             '--output', str(output), '--view', view],
            capture_output=True, timeout=180,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except subprocess.TimeoutExpired:
        raise HTTPException(504, 'O vídeo excedeu o tempo de teste. Use um trecho menor.')
    if result.returncode:
        raise HTTPException(422, 'Não foi possível analisar este vídeo.')
    report = json.loads((output/'streaming-report.json').read_text(encoding='utf-8'))
    if not report['frames']:
        raise HTTPException(422, 'Vídeo sem quadros legíveis.')
    return report

@router.post('/api/test-video')
async def test_video(request: Request, view: Literal['original','wide']='original'):
    # Prevent another origin from using this local processing endpoint.
    origin = request.headers.get('origin')
    if origin and origin.rstrip('/') != str(request.base_url).rstrip('/'):
        raise HTTPException(403, 'Origem não permitida.')
    if request.headers.get('content-type','').split(';')[0] != 'application/octet-stream':
        raise HTTPException(415, 'Envie o arquivo de vídeo.')
    if gate.locked():
        raise HTTPException(409, 'Outro vídeo está em análise. Aguarde e tente novamente.')
    async with gate:
        with tempfile.TemporaryDirectory(prefix='linhacount-test-') as folder:
            folder=Path(folder);source=folder/'input.mp4';size=0
            with source.open('wb') as output:
                async for chunk in request.stream():
                    size+=len(chunk)
                    if size>150*1024*1024:
                        raise HTTPException(413, 'Limite de 150 MB por vídeo.')
                    output.write(chunk)
            if not size: raise HTTPException(422, 'Arquivo vazio.')
            return await asyncio.to_thread(analyse,source,folder,view)
