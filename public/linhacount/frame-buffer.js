/* Ordered, bounded capture buffer. Never silently drops frames. */
(function(root){
  class FrameBuffer {
    constructor(maxFrames=30,maxBytes=64*1024*1024){
      this.maxFrames=maxFrames;this.maxBytes=maxBytes;this.items=[];this.bytes=0;
      this.finished=false;this.error=null;this.lastSeconds=-1;
    }
    push(frame){
      if(this.finished||this.error)return false;
      if(!Number.isFinite(frame.seconds)||frame.seconds<=this.lastSeconds)return false;
      if(this.items.length>=this.maxFrames||this.bytes+frame.blob.size>this.maxBytes){
        this.fail(new Error('Processamento não acompanha a câmera. Leitura interrompida; podem faltar peças.'));return false;
      }
      this.items.push(frame);this.bytes+=frame.blob.size;this.lastSeconds=frame.seconds;return true;
    }
    shift(){const frame=this.items.shift();if(frame)this.bytes-=frame.blob.size;return frame;}
    finish(){this.finished=true;}
    fail(error){this.error=error;this.finished=true;}
    clear(){this.items=[];this.bytes=0;this.finished=true;}
  }
  root.FrameBuffer=FrameBuffer;
  if(typeof module!=='undefined')module.exports=FrameBuffer;
})(typeof window!=='undefined'?window:globalThis);
