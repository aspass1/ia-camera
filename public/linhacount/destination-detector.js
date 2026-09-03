/* Experimental motion/destination classifier, not trained semantic AI.
 * One transaction per pull: crossing is evidence, never an immediate count. */
(function(root) {
  const median=a=>a.length ? a.sort((x,y)=>x-y)[Math.floor(a.length/2)] : 0;
  class DestinationCycle {
    constructor(){this.reset();}
    reset(){this.active=null;this.lastTime=null;this.sequence=0;this.phase='idle';this.locked=false;this.quietSince=null;this.movingSince=null;this.recentForward=[];}
    update(time, signal={}) {
      if(this.lastTime!==null && time<=this.lastTime)return {phase:this.phase,event:null};
      const gap=this.lastTime===null?0:time-this.lastTime;this.lastTime=time;
      if(gap>800){this.active=null;this.locked=true;this.quietSince=null;this.recentForward=[];this.phase='interrupted';return {phase:this.phase,event:null};}
      this.recentForward=this.recentForward.filter(f=>time-f.time<=400);
      const quiet=signal.quiet===true;
      if(quiet){this.movingSince=null;if(this.quietSince===null)this.quietSince=time;}
      else {if(this.movingSince===null)this.movingSince=time;if(time-this.movingSince>=140)this.quietSince=null;}
      if(this.locked){
        if(this.quietSince!==null && time-this.quietSince>=600){this.locked=false;this.phase='idle';}
        return {phase:this.phase,event:null};
      }
      if(!this.active && (signal.crossing || signal.sideExit)) {
        this.active={id:++this.sequence,started:time,crossed:false,forward:this.recentForward.reduce((n,f)=>n+f.dy,0),side:0,sideFrames:0,sideDirection:0,lastEvidence:time};
        this.quietSince=null;
      }
      const a=this.active;
      if(signal.forward)this.recentForward.push({time,dy:Math.max(0,signal.dy||0)});
      if(!a){this.phase='idle';return {phase:this.phase,event:null};}
      if(signal.crossing){a.crossed=true;a.lastEvidence=time;}
      if(signal.forward)a.forward+=Math.max(0,signal.dy||0);
      // Coherent translation AND activity at the corresponding lateral exit.
      // Direction may be either left or right, but alternating wobble cannot add up.
      if(signal.sideExit && Math.abs(signal.dx)>0){
        const sign=Math.sign(signal.dx);
        if(sign!==a.sideDirection){a.side=0;a.sideFrames=0;a.sideDirection=sign;}
        a.side+=Math.abs(signal.dx);a.sideFrames++;a.lastEvidence=time;
      }
      const discarded=a.side>=.10 && a.sideFrames>=3;
      if(discarded){
        // Destination is already observed: record residue once, then ignore
        // folds, reversal and further crossings until this action settles.
        const event={id:a.id,kind:'residue',at:time,started:a.started};
        this.active=null;this.locked=true;this.quietSince=null;
        this.movingSince=null;this.recentForward=[];this.phase='residue';
        return {phase:this.phase,event};
      }
      this.phase=discarded?'discarding':a.crossed?'settling':'pulling';
      const settled=quiet && this.quietSince!==null && time-this.quietSince>=650 && time-a.lastEvidence>=650;
      const timedOut=time-a.started>8000;
      const completedOnMotion=a.crossed && a.forward>=.25 && a.side<.035 && time-a.lastEvidence>=1800;
      if(settled || timedOut || completedOnMotion){
        // Weak lateral evidence is ambiguous, not an automatic good piece.
        // White woven fabric keeps shimmering after it reaches the pile, so a
        // real pull may never look fully quiet. On timeout, accept only a large,
        // coherent forward displacement with no meaningful lateral exit. The
        // stronger threshold keeps hands and diagonal side motion out.
        const kind=(settled && a.crossed && a.side<.035 && a.forward>=.025)||completedOnMotion?'good':'review';
        const event={id:a.id,kind,at:time,started:a.started};
        this.active=null;this.locked=!settled;this.phase=kind;
        // Quiet already observed may release immediately on the following frame;
        // a new cycle still requires fresh pull/crossing/exit evidence.
        return {phase:this.phase,event};
      }
      return {phase:this.phase,event:null};
    }
  }
  class DestinationDetector {
    constructor(){this.cycle=new DestinationCycle();this.reset();}
    reset(){this.previous=null;this.sampleAt=null;this.crossing=false;this.pulling=false;this.cycle.reset();this.result={phase:'idle',event:null};}
    update(time,gray,width,height,edge,line=.36,direction='down') {
      this.crossing ||= edge.count===true;
      this.pulling ||= edge.phase==='tracking' && edge.travel>=.025;
      if(this.sampleAt!==null && time-this.sampleAt<65)return {...this.result,event:null};
      const elapsed=this.sampleAt===null?0:time-this.sampleAt;this.sampleAt=time;
      const prior=this.previous;this.previous=gray.slice();
      if(!prior || prior.length!==gray.length){this.crossing=false;this.pulling=false;return {phase:'idle',event:null};}
      const flow=DestinationDetector.motion(prior,gray,width,height,line);
      flow.dy*=direction==='up'?-1:1;
      flow.forward=flow.forward && flow.dy>0;
      this.result=this.cycle.update(time,{...flow,crossing:this.crossing,pulling:this.pulling});
      this.crossing=false;this.pulling=false;
      if(elapsed>800){this.previous=null;}
      return {...this.result,flow};
    }
    static motion(previous,current,w,h,line=.36) {
      // Keep both physical exits visible. The previous central crop discarded
      // the left edge exactly when the operator pulled a rejected piece away.
      const x0=Math.floor(w*.03),x1=Math.floor(w*.97);
      const y0=Math.max(10,Math.floor((line-.14)*h)),y1=Math.min(h-10,Math.floor((line+.30)*h));
      let delta=0,n=0;
      for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){delta+=current[y*w+x]-previous[y*w+x];n++;}
      delta/=Math.max(1,n);
      let changed=0;
      for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2)if(Math.abs(current[y*w+x]-previous[y*w+x]-delta)>12)changed++;
      const activity=changed/Math.max(1,n);
      let settledPixels=0,pilePixels=0;
      for(let y=Math.floor((line+.12)*h);y<Math.min(h,Math.floor((line+.38)*h));y+=2)
        for(let x=Math.floor(w*.30);x<Math.floor(w*.85);x+=2){
          pilePixels++;if(Math.abs(current[y*w+x]-previous[y*w+x]-delta)>12)settledPixels++;
        }
      const pileActivity=settledPixels/Math.max(1,pilePixels);
      if(activity<.025)return {quiet:true,dx:0,dy:0,sideExit:false,activity};
      const vectors=[];
      for(let y=y0+8;y<y1-7;y+=15)for(let x=x0+9;x<x1-8;x+=23){
        let minimum=255,maximum=0,gx=0;
        for(let py=-6;py<=6;py+=3)for(let px=-6;px<=6;px+=3){
          const v=previous[(y+py)*w+x+px];minimum=Math.min(minimum,v);maximum=Math.max(maximum,v);
          gx+=Math.abs(v-previous[(y+py)*w+x+px+1]);
        }
        if(maximum-minimum<18)continue;
        const score=(dx,dy)=>{
          let sum=0;for(let py=-6;py<=6;py+=3)for(let px=-6;px<=6;px+=3)
            sum+=Math.abs(previous[(y+py)*w+x+px]+delta-current[(y+py+dy)*w+x+px+dx]);
          return sum/25;
        };
        const base=score(0,0);if(base<5)continue;
        let best=base,bx=0,by=0;const matches=[];
        for(let dy=-8;dy<=8;dy+=2)for(let dx=-8;dx<=8;dx+=2){
          const value=score(dx,dy)+.025*(Math.abs(dx)+Math.abs(dy));
          matches.push({dx,dy,value});
          if(value<best){best=value;bx=dx;by=dy;}
        }
        if(best>base*.72 || best>24 || Math.abs(bx)+Math.abs(by)<2)continue;
        // A plain diagonal edge has many equally plausible motions (aperture
        // ambiguity). Do not use it to infer a good piece or a lateral discard.
        if(matches.some(m=>Math.abs(m.dx-bx)+Math.abs(m.dy-by)>=6 && m.value<=best+1))continue;
        vectors.push({x:x/w,dx:gx/25>=2?bx:0,dy:by});
      }
      const horizontal=vectors.filter(v=>Math.abs(v.dx)>=2 && Math.abs(v.dx)>Math.abs(v.dy)*1.5);
      const sign=Math.sign(median(horizontal.map(v=>v.dx)));
      const coherent=horizontal.filter(v=>Math.sign(v.dx)===sign);
      const exits=coherent.filter(v=>sign<0?v.x<.34:v.x>.66);
      const dx=median(coherent.map(v=>v.dx))/w,dy=median(vectors.map(v=>v.dy))/h;
      const vertical=vectors.filter(v=>Math.abs(v.dy)>=2 && Math.abs(v.dy)>Math.abs(v.dx));
      const sideExit=coherent.length>=4 && coherent.length>=vectors.length*.55 && exits.length>=2;
      const quiet=!sideExit && (activity<.045 || (activity<.085 && vectors.length<=4) || (pileActivity<.055 && activity<.10));
      return {quiet,dx,dy,forward:vertical.length>=2,sideExit,activity,pileActivity,vectors:vectors.length};
    }
  }
  root.DestinationCycle=DestinationCycle;root.DestinationDetector=DestinationDetector;
  if(typeof module!=='undefined')module.exports={DestinationCycle,DestinationDetector};
})(globalThis);
