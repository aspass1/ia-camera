(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const canvas = $('analysisCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const stage = $('stage');
  const area = $('analysisArea');
  const line = $('countLine');
  const countValue = $('countValue');
  const eventList = $('eventList');
  const armedSwitch = $('armedSwitch');
  const cameraButton = $('cameraButton');
  const cameraSelect = $('cameraSelect');
  const flipCameraButton = $('flipCameraButton');
  const fileInput = $('fileInput');
  const trackerBox = $('trackerBox');
  const trackerLabel = $('trackerLabel');
  const machineId = Number(new URLSearchParams(location.search).get('machine'));
  const STORAGE_KEY = machineId >= 1 && machineId <= 27 ? `linhacount-station-${machineId}` : 'linhacount-v2';

  const edgeDetector = new EdgeDetector();
  const destinationDetector = new DestinationDetector();
  let videoFrameId = 0;
  let frameWatchdog = 0;
  let frameTicket = 0;
  let lastMediaTime = -1;
  let replayAfterEnd = false;
  let stream = null;
  let fileUrl = null;
  let rafId = 0;
  let count = 0;
  let categories = {good:0,residue:0,pending:0,review:0,legacy:0};
  let correctionBusy = false;
  let events = [];
  let previousGray = null;
  let frameCounter = 0;
  let fpsStartedAt = performance.now();
  let sessionStartedAt = null;
  let toastTimer = 0;
  let preferredFacingMode = 'environment';
  let taughtExamples = [];
  let taughtStarted = new Set();
  let taughtFired = new Set();
  let taughtSourceId = null;
  let flowRun = 0;
  let cycleSamples = [];
  let cycleLastCount = -Infinity;

  const settings = {
    sensitivity: 55,
    line: 36,
    roiX: 2,
    roiY: 13,
    roiW: 96,
    roiH: 74,
    searchSpan: 20,
  };

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      count = Number.isFinite(saved.count) ? saved.count : 0;
      if(saved.categories && ['good','residue','review','legacy'].every(k=>Number.isSafeInteger(saved.categories[k]) && saved.categories[k]>=0)) categories={pending:0,...saved.categories};
      else categories.legacy=Math.max(0,Math.floor(count));
      // Version 16 changes the visible number from a delayed destination total
      // to a live exit-flow total. Old browser-only test readings stay archived
      // and the new flow begins cleanly at zero.
      if ((saved.detectorVersion || 0) < 16) {
        categories.legacy += categories.good + categories.residue + categories.pending;
        categories.good = 0; categories.residue = 0; categories.pending = 0;
      }
      count=Object.values(categories).reduce((n,v)=>n+v,0);
      events = Array.isArray(saved.events) ? saved.events.slice(0, 50) : [];
      if (!saved.detectorVersion && saved.settings?.line === 58) saved.settings.line = 36;
      if ((saved.detectorVersion || 0) < 15 && saved.settings?.roiX === 12 && saved.settings?.roiW === 76) {
        saved.settings.roiX = 2; saved.settings.roiW = 96;
      }
      Object.keys(settings).forEach((key) => {
        if (Number.isFinite(saved.settings?.[key])) settings[key] = saved.settings[key];
      });
    } catch { /* armazenamento indisponível */ }
    Object.entries(settings).forEach(([key, value]) => {
      const input = $(key === 'line' ? 'linePosition' : key);
      if (input) input.value = String(value);
    });
    updateOverlay();
    renderCount();
    renderEvents();
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ count, categories, events, settings, detectorVersion: 16 })); } catch { /* armazenamento indisponível */ }
  }

  function updateOverlay() {
    const scale = video.videoWidth ? Math.min(stage.clientWidth / video.videoWidth, stage.clientHeight / video.videoHeight) : 1;
    const width = video.videoWidth ? video.videoWidth * scale : stage.clientWidth;
    const height = video.videoHeight ? video.videoHeight * scale : stage.clientHeight;
    area.style.left = `${(stage.clientWidth - width) / 2 + width * settings.roiX / 100}px`;
    area.style.top = `${(stage.clientHeight - height) / 2 + height * settings.roiY / 100}px`;
    area.style.width = `${width * Math.min(settings.roiW, 100 - settings.roiX) / 100}px`;
    area.style.height = `${height * Math.min(settings.roiH, 100 - settings.roiY) / 100}px`;
    line.style.top = `${settings.line}%`;
    // Draw the same bounds used by the detector, not the entire crop/pile.
    const bounds = EdgeDetector.bounds(settings.line/100, $('direction').value, settings.searchSpan/100);
    $('searchBand').style.left = `${bounds.left*100}%`;
    $('searchBand').style.width = `${(bounds.right-bounds.left)*100}%`;
    $('searchBand').style.top = `${bounds.top*100}%`;
    $('searchBand').style.height = `${(bounds.bottom-bounds.top)*100}%`;
    line.style.left = `${bounds.left*100}%`;
    line.style.width = `${(bounds.right-bounds.left)*100}%`;
    $('lineValue').textContent = `${settings.line}%`;
    $('sensitivityValue').textContent = `${settings.sensitivity}%`;
  }

  function setStatus(text, active = false) {
    $('statusText').textContent = text;
    $('statusDot').classList.toggle('active', active);
  }

  function setConnected(connected, label = 'Câmera conectada') {
    publishPreview();
    stage.classList.toggle('has-video', connected);
    $('systemBadge').classList.toggle('live', connected);
    $('systemBadge').querySelector('span').textContent = connected ? label : 'Sistema em espera';
    cameraButton.textContent = connected ? 'Desconectar' : 'Conectar câmera';
    cameraButton.classList.toggle('primary', !connected);
    cameraButton.classList.toggle('secondary', connected);
    flipCameraButton.hidden = !connected || !stream;
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    const current = cameraSelect.value;
    cameraSelect.innerHTML = '<option value="">Câmera padrão</option>';
    cameras.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Câmera ${index + 1}`;
      cameraSelect.append(option);
    });
    if ([...cameraSelect.options].some((option) => option.value === current)) cameraSelect.value = current;
  }

  function stopSource() {
    window.ProductionStation?.stop();
    frameTicket++;
    clearTimeout(frameWatchdog);
    cancelAnimationFrame(rafId);
    if (videoFrameId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameId);
    replayAfterEnd = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = null;
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    previousGray = null;
    taughtExamples = []; taughtStarted.clear(); taughtFired.clear(); taughtSourceId = null;
    resetDetector();
    setConnected(false);
    armedSwitch.checked = false;
    setStatus('Câmera desconectada');
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Este navegador não oferece acesso à câmera');
      showToast('Abra pelo arquivo INICIAR LinhaCount');
      return;
    }
    if (stream || fileUrl) {
      stopSource();
      return;
    }
    try {
      setStatus('Solicitando acesso à câmera…', true);
      await window.ProductionStation?.claim();
      const selected = cameraSelect.value;
      stream = await navigator.mediaDevices.getUserMedia({
        video: selected ? { deviceId: { exact: selected }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : { facingMode: { ideal: preferredFacingMode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      await listCameras();
      const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (window.ProductionStation) await window.ProductionStation.bind(activeId || selected || 'default-camera');
      if (activeId) cameraSelect.value = activeId;
      setConnected(true);
      const facing = stream.getVideoTracks()[0]?.getSettings().facingMode;
      preferredFacingMode = facing || preferredFacingMode;
      armedSwitch.checked = true;
      video.controls = false;
      setStatus('Câmera ativa — monitorando a linha de saída', true);
      beginAnalysis();
    } catch (error) {
      window.ProductionStation?.stop();
      stream?.getTracks().forEach(track => track.stop());
      stream = null;
      setConnected(false);
      const denied = error?.name === 'NotAllowedError';
      setStatus(denied ? 'Permissão da câmera negada' : 'Não foi possível abrir a câmera');
      showToast(denied ? 'Libere a câmera nas permissões do navegador' : (error.message || 'Confirme se o DroidCam está conectado'));
    }
  }

  async function flipCamera() {
    if (!stream) return;
    preferredFacingMode = preferredFacingMode === 'environment' ? 'user' : 'environment';
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    cameraSelect.value = '';
    setConnected(false);
    await startCamera();
  }

  async function openVideoFile(file) {
    stopSource();
    flowRun++;
    count=0;
    categories={good:0,residue:0,pending:0,review:0,legacy:0};
    events=[];
    sessionStartedAt=null;
    renderCount();
    renderEvents();
    updateOverlay();
    persist();
    fileUrl = URL.createObjectURL(file);
    video.src = fileUrl;
    video.loop = false;
    video.controls = true;
    armedSwitch.checked = true;
    // Treino serve para gerar o modelo, nunca para repetir uma contagem.
    // Esta tela sempre executa a detecção visual automática.
    taughtExamples=[]; taughtSourceId=null;
    beginAnalysis();
    await video.play();
    setConnected(true, 'Vídeo de teste');
    setStatus('Analisando vídeo gravado — perfil de tecido ativo', true);
  }

  function scheduleFrame() {
    const ticket = ++frameTicket;
    // Some embedded browsers stop compositor callbacks while media keeps playing.
    // Race a timer against the video callback; only the winner analyzes the frame.
    if (video.requestVideoFrameCallback) {
      videoFrameId = video.requestVideoFrameCallback((now, metadata) => {
        if (ticket !== frameTicket) return;
        clearTimeout(frameWatchdog);
        analyzeFrame(now, metadata);
      });
      frameWatchdog = setTimeout(() => {
        if (ticket !== frameTicket) return;
        video.cancelVideoFrameCallback(videoFrameId);
        analyzeFrame(performance.now());
      }, 40);
    } else frameWatchdog = setTimeout(() => { if (ticket === frameTicket) analyzeFrame(performance.now()); }, 33);
  }

  function beginAnalysis() {
    clearTimeout(frameWatchdog);
    $('frameWarning').hidden = true;
    lastMediaTime = -1;
    edgeDetector.reset();
    destinationDetector.reset();
    previousGray = null;
    frameCounter = 0;
    cycleSamples = [];
    cycleLastCount = -Infinity;
    fpsStartedAt = performance.now();
    cancelAnimationFrame(rafId);
    if (videoFrameId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameId);
    scheduleFrame();
  }

  function analyzeFrame(now, metadata) {
    const mediaTime = metadata ? metadata.mediaTime * 1000 : Math.floor(video.currentTime * 30 + 0.00001) * 1000 / 30;
    if (video.readyState >= 2 && !video.paused && !video.seeking && mediaTime > lastMediaTime) {
      lastMediaTime = mediaTime;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        if (stream && armedSwitch.checked) window.ProductionStation?.frame();
        ctx.drawImage(video, vw * settings.roiX / 100, vh * settings.roiY / 100,
          vw * Math.min(settings.roiW, 100-settings.roiX) / 100,
          vh * Math.min(settings.roiH, 100-settings.roiY) / 100, 0, 0, canvas.width, canvas.height);
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const gray = new Uint8Array(canvas.width * canvas.height);
        let difference = 0;
        let changedX = 0, changedPixels = 0;
        for (let i=0;i<gray.length;i++) {
          gray[i] = (rgba[i*4]*54 + rgba[i*4+1]*183 + rgba[i*4+2]*19) >> 8;
          if (previousGray) {
            const delta=Math.abs(gray[i]-previousGray[i]);
            difference += delta;
            if(delta>24){changedX += i%canvas.width;changedPixels++;}
          }
        }
        const result = edgeDetector.update(mediaTime, gray, canvas.width, canvas.height, settings.line/100, $('direction').value, settings.sensitivity, settings.searchSpan/100);
        const destination = destinationDetector.update(mediaTime,gray,canvas.width,canvas.height,result,settings.line/100,$('direction').value);
        const phaseNames={idle:'Aguardando nova retirada',pulling:'Retirada em análise',settling:'Aguardando tecido permanecer na pilha',discarding:'Saída lateral — aguardando concluir descarte',good:'Peça boa confirmada na pilha',residue:'Resíduo registrado',review:'Leitura não confirmada — não somou produção',interrupted:'Leitura interrompida — aguardando estabilizar'};
        if (result.edge) {
          trackerBox.style.left = '25%';
          trackerBox.style.width = '60%';
          trackerBox.style.top = `${result.edge.y*100}%`;
          trackerBox.style.height = '3px';
          trackerLabel.textContent = destination.phase==='discarding'?'SAÍDA LATERAL':destination.phase==='settling'?'AGUARDANDO PILHA':'EM ANÁLISE';
          trackerBox.classList.add('visible');
          trackerBox.classList.toggle('crossed', destination.phase === 'discarding');
        } else trackerBox.classList.remove('visible');
        if (armedSwitch.checked) {
          if(fileUrl){
            const motion=difference/gray.length;
            const centerX=changedPixels?changedX/changedPixels/canvas.width:.5;
            cycleSamples.push({time:mediaTime,motion,x:centerX});
            if(cycleSamples.length>31)cycleSamples.shift();
            if(cycleSamples.length>=21&&mediaTime>1500){
              const candidate=cycleSamples[cycleSamples.length-8];
              const local=cycleSamples.slice(-15);
              const values=cycleSamples.map(sample=>sample.motion).slice().sort((a,b)=>a-b);
              const baseline=values[Math.floor(values.length*.25)]||0;
              const isPeak=local.every(sample=>candidate.motion>=sample.motion);
              // A retirada completa gera picos para a mão, o tecido e a
              // acomodação. Feche o ciclo antes de aceitar outra contagem.
              if(isPeak&&candidate.motion>baseline+1.35&&candidate.motion>4.0&&candidate.time-cycleLastCount>3400){
                cycleLastCount=candidate.time;
                const kind=candidate.x<.18||candidate.x>.82?'residue':'good';
                addCount(`${kind==='good'?'Peça boa':'Resíduo'} · ciclo ${(candidate.time/1000).toFixed(2)} s`,kind);
              }
            }
            setStatus('Analisando ciclos completos do vídeo',true);
          } else {
          // A long sheet can expose more than one visual edge. It is still one
          // physical withdrawal until its destination is decided, so never open
          // a second flow while one is pending.
          const source=stream?'live':fileUrl?'test':'manual';
          const pendingFlow=events.some(event=>event.kind==='pending'&&event.source===source&&event.run===flowRun);
          const withdrawalStarted=result.count||(result.phase==='tracking'&&result.travel>=0.03);
          if(withdrawalStarted&&!pendingFlow)addFlow(`Saída da máquina detectada · ${(mediaTime/1000).toFixed(2)} s`);
          if(destination.event && (destination.event.kind==='good'||destination.event.kind==='residue'))finalizeFlow(destination.event.kind,`${phaseNames[destination.event.kind]} · ${(mediaTime/1000).toFixed(2)} s`);
          else if(destination.event?.kind==='review')finalizeFlow('residue',`Não permaneceu na pilha · resíduo · ${(mediaTime/1000).toFixed(2)} s`);
          else if(!result.count)setStatus(phaseNames[destination.phase]||'Analisando saída da máquina',true);
          }
        }
        $('motionLabel').textContent = result.edge ? `Contraste da borda ${result.edge.strength.toFixed(0)}` : 'Nenhuma borda na faixa';
        updateQuality(difference/gray.length);
        previousGray = gray;
        frameCounter++;
        if (now-fpsStartedAt >= 1000) {
          const fps = Math.round(frameCounter*1000/(now-fpsStartedAt));
          $('fpsLabel').textContent = `${fps} fps`;
          $('frameWarning').hidden = fps >= 12;
          frameCounter=0; fpsStartedAt=now;
        }
      }
    }
    if (stream || fileUrl) scheduleFrame();
  }

  function resetDetector() {
    edgeDetector.reset();
    destinationDetector.reset();
    cycleSamples=[];
    cycleLastCount=-Infinity;
    trackerBox.classList.remove('visible', 'crossed');
  }

  function updateQuality(averageDifference) {
    const quality = Math.max(0, Math.min(99, Math.round(100 - Math.max(0, averageDifference - 2) * 5)));
    const ring = $('confidenceRing');
    ring.textContent = video.readyState >= 2 ? (quality > 70 ? 'Estável' : 'Movendo') : '—';
    ring.title = 'Estabilidade da imagem — não representa precisão de contagem';
    ring.style.borderColor = quality > 70 ? 'rgba(66,223,160,.35)' : quality > 45 ? 'rgba(244,205,85,.4)' : 'rgba(255,107,99,.45)';
  }

  function addCount(type,kind='good') {
    if(kind!=='good' && kind!=='residue'){
      setStatus('Leitura não confirmada — não somou produção',true);
      showToast('Não foi possível confirmar o destino. Nenhuma peça foi somada.');
      return;
    }
    const id=crypto.randomUUID();
    if (stream && type !== 'manual') window.ProductionStation?.piece(kind,id);
    count++;
    categories[kind]++;
    const timestamp = new Date();
    events.unshift({ id, kind, source:stream?'live':fileUrl?'test':'manual',number: count, time: timestamp.toISOString(), type });
    events = events.slice(0, 100);
    if (!sessionStartedAt) sessionStartedAt = timestamp.getTime();
    renderCount(); renderEvents(); persist();
    const flash = $('countFlash');
    flash.textContent=kind==='good'?'+1 peça boa':kind==='residue'?'+1 resíduo':'Revisar destino';
    flash.classList.remove('show'); void flash.offsetWidth; flash.classList.add('show');
    setStatus(kind==='good'?'Peça boa contabilizada':kind==='residue'?'Resíduo contabilizado — não somou peça boa':'Caso enviado para revisão — não somou peça boa', true);
  }

  function addFlow(type,referenceId=null){
    const id=referenceId?`${referenceId}:run-${flowRun}`:crypto.randomUUID();
    if(events.some(event=>event.id===id))return;
    const timestamp=new Date();
    count++;categories.pending++;
    events.unshift({id,referenceId,run:flowRun,kind:'pending',source:stream?'live':fileUrl?'test':'manual',number:count,time:timestamp.toISOString(),type});
    events=events.slice(0,100);
    if(!sessionStartedAt)sessionStartedAt=timestamp.getTime();
    renderCount();renderEvents();persist();
    const flash=$('countFlash');flash.textContent='+1 saída da máquina';flash.classList.remove('show');void flash.offsetWidth;flash.classList.add('show');
    setStatus('Peça retirada — confirmando boa ou resíduo',true);
  }

  function finalizeFlow(kind,type,stableId=null){
    if(kind!=='good'&&kind!=='residue')return;
    const source=stream?'live':fileUrl?'test':'manual';
    const event=events.find(item=>item.kind==='pending'&&item.source===source&&item.run===flowRun&&(!stableId||item.referenceId===stableId));
    if(!event)return addCount(type,kind);
    categories.pending=Math.max(0,categories.pending-1);categories[kind]++;
    event.kind=kind;event.type=type;
    if(stream)window.ProductionStation?.piece(kind,event.id);
    renderCount();renderEvents();persist();
    const flash=$('countFlash');flash.textContent=kind==='good'?'✓ peça boa':'↗ resíduo';flash.classList.remove('show');void flash.offsetWidth;flash.classList.add('show');
    setStatus(kind==='good'?'Saída confirmada como peça boa':'Saída classificada como resíduo — total não duplicado',true);
  }

  function manualAdjust(delta) {
    if(stream)return showToast('Use Boa → resíduo para corrigir a produção identificada.');
    if (delta > 0) return addCount('manual');
    if (count <= 0) return;
    if(!categories.good)return showToast('Nenhuma peça boa local para retirar');
    count--; categories.good--;
    events.unshift({ number: count, time: new Date().toISOString(), type: 'correção −1' });
    renderCount(); renderEvents(); persist();
  }

  function renderCount() {
    const flowCount=categories.good+categories.residue+categories.pending;
    countValue.textContent = String(flowCount).padStart(3, '0');
    $('goodValue').textContent=categories.good;
    $('residueValue').textContent=categories.residue;
    publishPreview();
    const latest = events[0];
    $('lastEvent').textContent = latest ? new Date(latest.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    if (sessionStartedAt && flowCount) {
      const minutes = Math.max((Date.now() - sessionStartedAt) / 60000, 1 / 60);
      $('rateValue').textContent = `${(flowCount / minutes).toFixed(1).replace('.', ',')}/min`;
    } else $('rateValue').textContent = '0,0/min';
  }

  function publishPreview() {
    window.ProductionStation?.preview({count,...categories, mode:fileUrl?'test':stream?'live':'none', paused:video.paused, ended:video.ended});
  }

  function renderEvents() {
    if (!events.length) { eventList.innerHTML = '<li class="empty-event">Nenhuma retirada registrada</li>'; return; }
    eventList.innerHTML = events.slice(0, 8).map((event) => {
      const time = new Date(event.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<li><b>${event.type.includes('correção') ? '↻' : '+1'}</b><span>Peça ${String(event.number).padStart(3, '0')} · ${event.type}</span><time>${time}</time></li>`;
    }).join('');
  }

  function useTestPosition(frontal = false) {
    Object.assign(settings, { sensitivity: 55, line: frontal ? 40 : 36, searchSpan: frontal ? 16 : 20, roiX: 2, roiY: 13, roiW: 96, roiH: 74 });
    Object.entries(settings).forEach(([key, value]) => { $(key === 'line' ? 'linePosition' : key).value = String(value); });
    resetDetector(); previousGray = null; updateOverlay(); persist();
    showToast('Posição do vídeo aplicado. Ao vivo, ajuste a linha no caminho da borda.');
  }

  function exportCSV() {
    if (!events.length) return showToast('Ainda não existem eventos para exportar');
    const rows = ['numero,data_hora,classificacao,tipo', ...events.slice().reverse().map((event) => `${event.number},${event.time},${event.kind||'legacy'},${event.type}`)];
    const blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `linhacount-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    URL.revokeObjectURL(url);
  }

  cameraButton.addEventListener('click', startCamera);
  flipCameraButton.addEventListener('click', flipCamera);
  cameraSelect.addEventListener('change', () => { if (stream) { stopSource(); startCamera(); } });
  $('fileButton').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) openVideoFile(file); });
  $('plusButton').addEventListener('click', () => manualAdjust(1));
  $('minusButton').addEventListener('click', () => manualAdjust(-1));
  $('resetButton').addEventListener('click', () => {
    if(correctionBusy)return showToast('Aguarde a correção terminar antes de zerar.');
    if (!count) return;
    if (confirm('Zerar o contador e iniciar um novo lote?')) {
      count = 0; categories={good:0,residue:0,pending:0,review:0,legacy:0};events = []; sessionStartedAt = null; resetDetector();renderCount(); renderEvents(); persist(); showToast('Contadores locais zerados; registros do dia preservados');
    }
  });
  $('calibrateButton').addEventListener('click', () => useTestPosition(false));
  $('frontalPresetButton').addEventListener('click', () => useTestPosition(true));
  $('exportButton').addEventListener('click', exportCSV);
  $('residueButton').addEventListener('click',async()=>{
    if(correctionBusy)return;
    const source=stream?'live':fileUrl?'test':'manual';
    const event=events.find(e=>e.kind==='good'&&e.source===source&&e.id);
    if(!event)return showToast('Nenhuma peça boa identificada nesta fonte para corrigir');
    if(!confirm(`Marcar a peça boa ${event.number}, de ${new Date(event.time).toLocaleTimeString('pt-BR')}, como resíduo?`))return;
    correctionBusy=true;
    try{
      if(stream)await window.ProductionStation.reclassify(event.id);
      event.kind='residue';event.type='Boa → resíduo (correção confirmada)';categories.good--;categories.residue++;
      renderCount();renderEvents();persist();showToast('−1 boa / +1 resíduo. Total não duplicado.');
    }catch(e){showToast(e.message||'Não foi possível corrigir o registro');}
    finally{correctionBusy=false;}
  });
  armedSwitch.addEventListener('change', () => {
    resetDetector();
    setStatus(armedSwitch.checked ? 'Monitorando retiradas' : 'Detecção pausada', armedSwitch.checked);
  });
  $('sensitivity').addEventListener('input', (event) => { settings.sensitivity = Number(event.target.value); resetDetector(); updateOverlay(); persist(); });
  $('linePosition').addEventListener('input', (event) => { settings.line = Number(event.target.value); resetDetector(); updateOverlay(); persist(); });
  ['roiX', 'roiY', 'roiW', 'roiH', 'searchSpan'].forEach((id) => $(id).addEventListener('input', (event) => { settings[id] = Number(event.target.value); resetDetector(); updateOverlay(); persist(); }));
  video.addEventListener('pause', () => { trackerBox.classList.remove('visible'); publishPreview(); });
  video.addEventListener('play', publishPreview);
  video.addEventListener('ended', publishPreview);
  video.addEventListener('waiting', () => { trackerBox.classList.remove('visible'); });
  video.addEventListener('ended', () => { trackerBox.classList.remove('visible'); replayAfterEnd = armedSwitch.checked; armedSwitch.checked = false; setStatus('Fim do vídeo — reproduza novamente para repetir o teste'); });
  video.addEventListener('play', () => { if (fileUrl && replayAfterEnd) { armedSwitch.checked = true; replayAfterEnd = false; } });
  video.addEventListener('seeking', () => { previousGray = null; lastMediaTime = -1; resetDetector(); if(video.currentTime<1){taughtStarted.clear();taughtFired.clear();} });
  $('direction').addEventListener('change', () => { resetDetector(); updateOverlay(); });
  video.addEventListener('loadedmetadata', updateOverlay);
  new ResizeObserver(updateOverlay).observe(stage);
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input,select')) return;
    if (event.key === '+') manualAdjust(1);
    if (event.key === '-') manualAdjust(-1);
    if (event.key.toLowerCase() === 'p') { armedSwitch.checked = !armedSwitch.checked; armedSwitch.dispatchEvent(new Event('change')); }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => listCameras().catch(() => {}));

  restore();
  listCameras().catch(() => {});
})();
