(() => {
  const $=id=>document.getElementById(id), frames=new Map(), readings=new Map(); let data=null, busy=false, expanded=null;
  const today=()=>new Date(Date.now()-10800000).toISOString().slice(0,10);
  const duration=ms=>{const s=Math.floor(ms/1000);return `${Math.floor(s/3600)}h ${String(Math.floor(s/60)%60).padStart(2,'0')}m`;};
  const names={working:'Produzindo',idle:'Sem produção',learning:'Aguardando primeira peça',unknown:'Sem leitura / não conectada'};
  $('date').value=today();
  for(let id=1;id<=27;id++) {
    const card=document.createElement('article');card.className='machine';card.id=`machine-${id}`;
    card.innerHTML=`<header><h3>Máquina ${String(id).padStart(2,'0')}</h3></header><p class="state">Aguardando registro</p><strong class="qty">—</strong><span class="unit">peças boas no dia</span><dl><dt>Resíduos</dt><dd class="residue">—</dd><dt>Boas nesta hora</dt><dd class="hour">—</dd><dt>Produzindo</dt><dd class="working-time">—</dd><dt>Parada</dt><dd class="idle-time">—</dd><dt>Sem leitura</dt><dd class="unknown-time">—</dd></dl><p class="limit">Sem histórico de ciclo</p><button type="button">Abrir câmera / teste</button>`;
    card.querySelector('button').onclick=()=>openCapture(id);$('machines').append(card);
    const daily=document.createElement('p');daily.className='real-daily';daily.hidden=true;card.querySelector('.unit').after(daily);
  }
  function showReading(id){
    const reading=readings.get(id),card=$(`machine-${id}`),actual=data?.machines.find(m=>m.id===id);
    if(reading?.mode==='test'){
      card.querySelector('.qty').textContent=reading.good??0;
      card.querySelector('.residue').textContent=reading.residue??0;
      card.querySelector('.unit').textContent='boas no teste · não é produção';
      const daily=card.querySelector('.real-daily');daily.hidden=false;daily.textContent=`Dia real: ${actual?.good??'—'} boas / ${actual?.residue??'—'} resíduos. Boas nesta hora e tempos abaixo são reais.`;
      card.querySelector('.state').textContent=reading.ended?'Teste finalizado':reading.paused?'Teste pausado':'Vídeo de teste em reprodução';
      card.querySelector('.state').className='state learning';
    }else{
      card.querySelector('.qty').textContent=actual?.good??'—';
      card.querySelector('.residue').textContent=actual?.residue??'—';
      card.querySelector('.unit').textContent='peças boas no dia';card.querySelector('.real-daily').hidden=true;
      if(actual){card.querySelector('.state').textContent=names[actual.status];card.querySelector('.state').className='state '+actual.status;}
    }
  }
  function openCapture(id){
    if(!frames.has(id)) {
      const card=$(`machine-${id}`);
      const frame=document.createElement('iframe');frame.className='capture inline-capture';frame.title=`Captura da máquina ${id}`;frame.allow='camera; autoplay';frame.src=`index.html?machine=${id}&embedded=1&v=34`;card.querySelector('.state').after(frame);frames.set(id,frame);
      frame.addEventListener('load',()=>frame.contentWindow.postMessage({type:'capture-view',expanded:expanded===id},location.origin));
      card.querySelector('button').textContent='Ver câmera';
    }
    expanded=id;
    frames.forEach((frame,n)=>{frame.classList.toggle('expanded-capture',n===id);frame.inert=n!==id;frame.setAttribute('aria-hidden',String(n!==id));frame.contentWindow.postMessage({type:'capture-view',expanded:n===id},location.origin);});
    $('cameraViewTitle').textContent=`Máquina ${String(id).padStart(2,'0')} · câmera`;
    $('cameraViewBar').hidden=false;document.body.classList.add('camera-view-open');$('backToPanel').focus();
  }
  function returnToPanel(){
    const id=expanded;if(id===null)return;expanded=null;
    const frame=frames.get(id);frame.classList.remove('expanded-capture');
    frame.inert=true;frame.setAttribute('aria-hidden','true');
    frame.contentWindow.postMessage({type:'capture-view',expanded:false},location.origin);
    $('cameraViewBar').hidden=true;document.body.classList.remove('camera-view-open');
    $(`machine-${id}`).querySelector('button').focus({preventScroll:true});
  }
  $('backToPanel').onclick=returnToPanel;
  window.addEventListener('keydown',event=>{if(event.key==='Escape')returnToPanel();});
  window.addEventListener('message',event=>{
    if(event.origin===location.origin&&event.data?.type==='capture-reading'){
      const r=event.data,frame=frames.get(r.machine);
      if(!frame||event.source!==frame.contentWindow||!Number.isSafeInteger(r.count)||r.count<0||!['test','live','none'].includes(r.mode))return;
      if(['good','residue','review','legacy'].some(k=>r[k]!==undefined&&(!Number.isSafeInteger(r[k])||r[k]<0)))return;
      readings.set(r.machine,r);showReading(r.machine);return;
    }
    if(event.origin===location.origin&&event.data?.type==='capture-back'&&frames.get(expanded)?.contentWindow===event.source){returnToPanel();return;}
    if(event.origin!==location.origin||event.data?.type!=='capture-height')return;
    const frame=frames.get(event.data.machine);
    if(!frame||event.source!==frame.contentWindow||!Number.isFinite(event.data.height))return;
    frame.style.height=Math.min(2500,Math.max(360,event.data.height))+'px';
  });
  async function refresh(){
    if(busy)return;busy=true;
    try{
      const response=await fetch(`/api/operations?date=${encodeURIComponent($('date').value)}`);if(!response.ok)throw Error('Registro indisponível');data=await response.json();
      $('connection').textContent='Registro conectado · '+new Date(data.now).toLocaleTimeString('pt-BR');$('connection').classList.remove('error');
      const sum=key=>data.machines.reduce((n,m)=>n+(m[key]||0),0);
      $('total').textContent=sum('good').toLocaleString('pt-BR');$('residueTotal').textContent=sum('residue');$('hour').textContent=data.date===today()?sum('hourGood').toLocaleString('pt-BR'):'—';$('running').textContent=data.machines.filter(m=>m.status==='working').length+' / 27';$('work').textContent=duration(sum('working'));$('idle').textContent=duration(sum('idle'));
      for(const m of data.machines){const el=$(`machine-${m.id}`);el.dataset.state=m.status;const set=(cls,value)=>el.querySelector('.'+cls).textContent=value;set('state',names[m.status]);el.querySelector('.state').className='state '+m.status;set('qty',m.good);set('residue',m.residue??0);set('hour',data.date===today()?m.hourGood:'—');set('working-time',duration(m.working));set('idle-time',duration(m.idle));set('unknown-time',duration(m.unknown));set('limit',`Parada após ${Math.round(m.threshold/1000)} s sem peças · ${m.learned?'ciclo aprendido':'limite inicial'}`);}
      readings.forEach((_,id)=>showReading(id));
    }catch(e){$('connection').textContent='Sem conexão com o registro — dados abaixo podem estar desatualizados';$('connection').classList.add('error');}finally{busy=false;}
  }
  $('date').onchange=refresh;
  $('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{$('connection').textContent='Tela cheia indisponível neste navegador';}};
  $('export').onclick=()=>{if(!data)return;const rows=['dia;maquina;boas;residuos;revisar;anterior_sem_classe;producao_segundos;parada_segundos;sem_leitura_segundos',...data.machines.map(m=>`${data.date};${m.id};${m.good};${m.residue};${m.review};${m.legacy};${Math.floor(m.working/1000)};${Math.floor(m.idle/1000)};${Math.floor(m.unknown/1000)}`)];const url=URL.createObjectURL(new Blob(['\ufeff'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`producao-${data.date}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  refresh();setInterval(refresh,2000);
})();
