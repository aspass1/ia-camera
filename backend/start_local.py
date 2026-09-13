"""Start a persistent local server and open the panel only after health succeeds."""
import json
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
URL = 'http://127.0.0.1:8766'

def healthy():
    try:
        with urllib.request.urlopen(URL+'/api/health', timeout=1) as response:
            state = json.load(response)
            return state.get('ok') is True and state.get('python') is True
    except Exception:
        return False

if not healthy():
    (ROOT/'data').mkdir(exist_ok=True)
    with (ROOT/'data'/'server.log').open('ab') as log:
        subprocess.Popen([sys.executable, '-m', 'uvicorn', 'backend.server:app',
                          '--host', '127.0.0.1', '--port', '8766'], cwd=ROOT,
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    for _ in range(30):
        if healthy():
            break
        time.sleep(.5)
    else:
        raise SystemExit('Servidor nao iniciou. Consulte data/server.log.')
webbrowser.open(URL+'/linhacount/dashboard.html?v=38')
