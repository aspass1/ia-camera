(() => {
 const $=id=>document.getElementById(id),names={good:'Peça boa',residue:'Resíduo',none:'Máquina parada'};
 let stream=null,recorder=null,timer=0,source=null,sourceId=null,objectUrl=null,duration=0,busy=false,recording=false,dirty=false,rangeEnd=null;
 const status=text=>{$('status').textContent=text;$('saveStatus').textContent=text;};
 for(let i=1;i<=27;i++){const o=document.createElement('option');o.value=i;o.textContent=`Máquina ${String(i).padStart(2,'0')}`;$('machine').append(o);}
 $('session').value=new Date().toLocaleDateString('sv-SE')+'-sessao-1';
 async function request(path,options={}){const response=await fetch('/api/training'+path,{...options,headers:{'X-Training-Request':'1',...options.headers}});const body=await response.json();if(!response.ok)throw Error(body.error||'Falha no registro');return body;}
 const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 function buttons(){for(const id of ['file','camera','save','markStart','markEnd','playRange','start','end','machine','session'])$(id).disabled=busy||recording;$('record').disabled=busy||recording||!stream;$('stop').disabled=!recording;}
 function resetPreview(blob,knownDuration=0){
  if(objectUrl)URL.revokeObjectURL(objectUrl);source=blob;sourceId=null;duration=knownDuration;dirty=true;objectUrl=URL.createObjectURL(blob);
  $('preview').src=objectUrl;$('start').value=0;$('end').value=knownDuration?knownDuration.toFixed(2):1;$('reviewed').checked=false;rangeEnd=null;
 }
 $('preview').onloadedmetadata=()=>{if(Number.isFinite($('preview').duration))duration=$('preview').duration;if(duration&&!sourceId)$('end').value=Math.min(duration,20).toFixed(2);};
 $('file').onchange=()=>{const file=$('file').files[0];if(!file)return;if(file.size>80*1024*1024){status('Escolha um vídeo de até 80 MB.');return;}if(dirty&&!confirm('Trocar o vídeo sem salvar o exemplo atual?'))return;resetPreview(file);status('Vídeo aberto. Marque início e fim de uma ação, reveja e escolha o destino.');};
 $('camera').onclick=async()=>{
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;$('live').srcObject=null;$('live').hidden=true;$('camera').textContent='Conectar câmera';buttons();return;}
  busy=true;buttons();try{
   if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw Error('Gravação indisponível neste navegador. Use Abrir vídeo.');
   stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false});
   $('live').srcObject=stream;$('live').hidden=false;await $('live').play();$('camera').textContent='Desconectar câmera';status('Câmera pronta. Inicie o trecho antes da ação. Esta coleta não conta produção.');
  }catch(e){stream?.getTracks().forEach(t=>t.stop());stream=null;status(e.message);}finally{busy=false;buttons();}
 };
 $('record').onclick=()=>{
  if(!stream||recording||busy)return;if(dirty&&!confirm('Gravar outro trecho sem salvar o atual?'))return;
  try{
   const mime=['video/webm;codecs=vp8','video/webm','video/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
   const chunks=[];let failed=false;const started=performance.now();
   recorder=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:1800000});
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
   recorder.onerror=()=>{failed=true;status('A gravação falhou. Repita o trecho.');};
   recorder.onstop=()=>{clearTimeout(timer);recording=false;buttons();const seconds=Math.min(20,(performance.now()-started)/1000);if(failed||seconds<1||!chunks.length){status('Trecho inválido. Grave novamente por pelo menos 1 segundo.');return;}resetPreview(new Blob(chunks,{type:recorder.mimeType}),seconds);status('Trecho capturado. Assista, marque o destino e salve.');};
   recorder.start();recording=true;buttons();status('GRAVANDO · finalize após concluir uma ação. Limite de 20 segundos.');timer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},20000);
  }catch(e){status(e.message);recording=false;buttons();}
 };
 $('stop').onclick=()=>{if(recorder?.state==='recording')recorder.stop();};
 const mark=id=>{$(id).value=$('preview').currentTime.toFixed(2);$('reviewed').checked=false;dirty=true;};
 $('markStart').onclick=()=>mark('start');$('markEnd').onclick=()=>mark('end');
 for(const id of ['start','end'])$(id).onchange=()=>{$('reviewed').checked=false;dirty=true;};
 $('playRange').onclick=async()=>{try{const start=Number($('start').value),end=Number($('end').value);if(!source&&!sourceId)throw Error('Abra ou grave um vídeo primeiro');if(end<=start)throw Error('O fim deve vir depois do início');rangeEnd=end;$('preview').currentTime=start;await $('preview').play();}catch(e){status(e.message);}};
 $('preview').ontimeupdate=()=>{if(rangeEnd!==null&&$('preview').currentTime>=rangeEnd){$('preview').pause();rangeEnd=null;}};
 $('save').onclick=async()=>{
  if(busy||recording)return;const label=document.querySelector('input[name="label"]:checked')?.value,start=Number($('start').value),end=Number($('end').value),session=$('session').value.trim(),machine=Number($('machine').value);
  if(!source&&!sourceId){status('Falta abrir ou gravar um vídeo. Se recarregou a página, use Rever no exemplo salvo ou abra o arquivo novamente.');return;}
  if(!label){status('Falta escolher o destino: Peça boa, Resíduo ou Sem contagem.');return;}
  if(!session){status('Preencha a sessão de coleta.');$('session').focus();return;}
  if(!$('start').value.trim()||!$('end').value.trim()||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start){status('O fim precisa ser maior que o início. Marque o começo e o fim da ação no vídeo.');return;}
  if(end-start<1||end-start>20){status(`O trecho selecionado tem ${(end-start).toFixed(2)} s. Selecione uma única ação entre 1 e 20 segundos, não o vídeo inteiro.`);return;}
  if(duration&&end>duration+.1){status(`O fim (${end.toFixed(2)} s) ultrapassa a duração do vídeo (${duration.toFixed(2)} s). Ajuste o fim.`);return;}
  busy=true;buttons();try{
   status('Salvando vídeo e marcação neste computador…');
   if(!sourceId)sourceId=(await request('/source',{method:'POST',body:source})).id;
   const manifest=await request('/manifest');
   const existing=manifest.examples.find(e=>e.sourceId===sourceId&&Math.round(e.start*1000)===Math.round(start*1000)&&Math.round(e.end*1000)===Math.round(end*1000));
   let message;
   if(existing){
    if(existing.machine!==machine||existing.session!==session){status('Este intervalo já pertence a outra máquina ou sessão. Use Rever na lista para abrir o registro original; escolha outro intervalo para uma nova peça.');return;}
    if(existing.label!==label){
     if(!confirm(`Este mesmo trecho (${start.toFixed(2)} a ${end.toFixed(2)} s) já está salvo como ${names[existing.label]}.\n\nDeseja CORRIGIR para ${names[label]}? Isso altera o exemplo existente, não cria outra peça.\n\nSe é OUTRA peça, cancele e mude o início e o fim.`)){status('Registro anterior preservado. Para salvar outra peça boa, mude o início e o fim para o trecho dessa peça.');return;}
     await request('/example',json('PATCH',{id:existing.id,label}));message=`Marcação corrigida para ${names[label]}, sem duplicar o exemplo.`;
    }else message=`Este trecho já está salvo como ${names[label]}. Não foi duplicado.`;
   }else{
    await request('/example',json('POST',{sourceId,start,end,label,machine,session}));message=`${names[label]} salva: ${start.toFixed(2)} a ${end.toFixed(2)} segundos.`;
   }
   dirty=false;$('reviewed').checked=false;
   try{await refresh();}catch{status(message+' Salvo, mas a lista não atualizou. Recarregue para conferir.');return;}
   status(message+' Para marcar outra peça, escolha um novo início e fim neste vídeo.');
  }catch(e){status(e.message+' A marcação permanece na tela; você pode tentar salvar novamente.');}finally{busy=false;buttons();}
 };
 async function refresh(){
  const data=await request('');for(const k of Object.keys(names))$(k+'Total').textContent=data.counts[k];$('summary').textContent=`${data.total} exemplos em ${data.sessions} sessões. Mostrando os 100 mais recentes.`;$('examples').replaceChildren();
  for(const e of data.examples){const row=document.createElement('div');row.className='example';const text=document.createElement('span');text.textContent=`Máquina ${e.machine} · ${e.session} · ${e.start.toFixed(2)}–${e.end.toFixed(2)} s`;const play=document.createElement('button');play.textContent='Rever';play.onclick=()=>{if(busy||recording)return;if(dirty&&!confirm('Abrir o exemplo salvo sem salvar a marcação atual?'))return;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;source=null;sourceId=e.sourceId;duration=0;dirty=false;$('preview').src='/api/training/video/'+e.sourceId;$('start').value=e.start;$('end').value=e.end;$('machine').value=e.machine;$('session').value=e.session;$('reviewed').checked=false;status('Exemplo aberto. Use Rever trecho para assistir ao intervalo.');};const select=document.createElement('select');select.setAttribute('aria-label','Corrigir destino do exemplo');for(const [value,label]of Object.entries(names)){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}select.value=e.label;const correct=document.createElement('button');correct.textContent='Corrigir marcação';correct.onclick=async()=>{if(busy||recording||select.value===e.label)return;if(!confirm('Alterar a marcação deste exemplo? O histórico da correção será preservado.'))return;busy=true;buttons();try{await request('/example',json('PATCH',{id:e.id,label:select.value}));await refresh();status('Marcação corrigida sem duplicar o exemplo.');}catch(error){status(error.message);}finally{busy=false;buttons();}};row.append(text,play,select,correct);$('examples').append(row);}
 }
 $('export').onclick=async()=>{try{const data=await request('/manifest'),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='marcacoes-treinamento.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(e.message);}};
 window.addEventListener('beforeunload',e=>{if(dirty||recording||busy){e.preventDefault();e.returnValue='';}});
 buttons();refresh().then(()=>status('Base local pronta. Abra um vídeo ou conecte a câmera para começar.')).catch(e=>status('Base indisponível: '+e.message));
})();
