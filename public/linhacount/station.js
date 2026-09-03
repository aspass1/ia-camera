(() => {
  const machine=Number(new URLSearchParams(location.search).get('machine'));
  if(!Number.isInteger(machine)||machine<1||machine>27)return;
  const embedded=new URLSearchParams(location.search).get('embedded')==='1';
  if(embedded){
    document.body.classList.add('embedded-station');
    const settings=document.querySelector('.control-card');
    const details=document.createElement('details');details.className='embedded-settings';
    const summary=document.createElement('summary');summary.textContent='Ajustes de leitura';details.append(summary);settings.before(details);details.append(settings);
    document.querySelector('.counter-top label').textContent='Peças boas · local / teste';
    const sendHeight=()=>parent.postMessage({type:'capture-height',machine,height:Math.ceil(document.body.getBoundingClientRect().height)+4},location.origin);
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='capture-view')return;
      document.body.classList.toggle('expanded-station',event.data.expanded===true);
      requestAnimationFrame(sendHeight);
    });
    window.addEventListener('keydown',event=>{if(event.key==='Escape')parent.postMessage({type:'capture-back'},location.origin);});
    new ResizeObserver(sendHeight).observe(document.body);
    window.addEventListener('load',sendHeight);
  }
  const session=crypto.randomUUID();let active=false,lastFrame=0,chain=Promise.resolve();
  const notice=document.createElement('p');notice.className='station-notice';notice.style.cssText='padding:12px 20px;background:#30271b;color:#ffd39b;font:12px system-ui;margin:0';notice.textContent=`Máquina ${machine} · câmera ao vivo registra produção; vídeos são somente teste.`;document.body.prepend(notice);
  async function request(payload){const r=await fetch('/api/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({machine,session,...payload}),signal:AbortSignal.timeout(5000)});const body=await r.json();if(!r.ok){const e=Error(body.error||'Registro indisponível');e.permanent=r.status<500;throw e;}}
  const report=e=>{notice.textContent=`Máquina ${machine} · ERRO NO REGISTRO: ${e.message}. Confira antes de continuar.`;notice.style.color='#ffaaa0';};
  window.ProductionStation={
    preview(value){
      if(value.mode==='test')notice.textContent=`Máquina ${machine} · VÍDEO DE TESTE. Contador também exibido no painel, separado da produção real.`;
      if(embedded)parent.postMessage({type:'capture-reading',machine,...value},location.origin);
    },
    async claim(){await request({action:'claim'});active=true;lastFrame=0;notice.textContent=`Máquina ${machine} · captura autorizada. Aguardando imagem.`;},
    async bind(device){await request({action:'bind',device});notice.textContent=`Máquina ${machine} · registro de produção ativo. Vídeos continuam separados.`;},
    frame(){lastFrame=performance.now();},
    piece(kind='review',eventId=crypto.randomUUID()){if(!active)return;const payload={action:'piece',eventId,kind,at:Date.now()};chain=chain.then(async()=>{for(;;){try{await request(payload);return;}catch(e){report(e);if(e.permanent)throw e;notice.textContent+= ' Reenviando a peça; não feche a captura.';await new Promise(resolve=>setTimeout(resolve,2000));}}}).catch(report);},
    async reclassify(eventId){if(!active)throw Error('Reconecte a câmera para corrigir o registro');await chain;await request({action:'reclassify',eventId,changeId:`residue-${eventId}`});},
    stop(){if(active){active=false;chain=chain.then(()=>request({action:'heartbeat',healthy:false})).catch(report);}},
  };
  setInterval(()=>{if(!active)return;const healthy=performance.now()-lastFrame<2500 && lastFrame>0 && !document.getElementById('video').paused;chain=chain.then(()=>request({action:'heartbeat',healthy})).catch(report);},2000);
})();
