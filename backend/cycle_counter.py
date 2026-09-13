"""Streaming fixed-machine experimental counter. Never writes production totals.
The learned model contains motion features only, no video timestamps.
"""
import argparse
from collections import deque
import json
from pathlib import Path
import time
import cv2
import numpy as np


class CycleCounter:
    def __init__(self, model, view='original'):
        if view not in ('original','wide'):raise ValueError('Invalid view')
        self.view=view
        self.side_samples=deque()
        self.model=model;self.samples=deque();self.pending=deque()
        self.previous=None;self.last_sample=None;self.occupied=None;self.empty=None
        self.armed=False;self.last_event=-99
        self.gate_box=None
        self.sampling_gaps=0
        self.reference_losses=0
        self.input_valid=True
        self.last_interval=None

    def quality(self):
        return {'sampling_gaps':self.sampling_gaps,'reference_losses':self.reference_losses,
                'last_interval':self.last_interval,'input_valid':self.input_valid,
                'reference_found':self.gate_box is not None,
                'reliable_sampling':self.sampling_gaps==0}

    def classify(self, endpoint, incomplete=False):
        if incomplete:
            return {'seconds':round(endpoint,3),'kind':'review','reason':'incomplete_cycle','incomplete':True}
        if self.view=='wide':
            # Observe the destination after the withdrawal, not a video timestamp.
            hits=[t for t,amount in self.side_samples if endpoint<=t<=endpoint+1.5 and amount>.15]
            lateral=any(0<b-a<=.6 for a,b in zip(hits,hits[1:]))
            return {'seconds':round(endpoint,3),'confirmed_seconds':round(self.last_sample,3),
                    'kind':'residue' if lateral else 'good','experimental':True,
                    'method':'lateral-cloth-motion-v1','lateral_samples':len(hits)}
        features=[]
        for lo,hi in [(-2.4,-1.4),(-1.4,-.4),(-.4,.6)]:
            values=[v for t,v in self.samples if endpoint+lo<=t<endpoint+hi]
            if not values:return {'seconds':endpoint,'kind':'review','reason':'incomplete_history'}
            features.extend(np.mean(values,axis=0).tolist())
        z=(np.array(features)-np.array(self.model['mean']))/np.array(self.model['scale'])
        if 'coefficient' in self.model:
            score=float(z@np.array(self.model['coefficient'])+self.model['intercept'])
            return {'seconds':round(endpoint,3),'kind':'residue' if score>0 else 'good',
                    'score':round(score,4),'experimental':True}
        distances=sorted((float(np.mean((z-np.array(c))**2)),k) for k,c in self.model['centroids'].items())
        margin=(distances[1][0]-distances[0][0])/max(distances[1][0],1e-8)
        review=incomplete or margin<self.model['minimum_margin'] or distances[0][0]>self.model['maximum_distance']
        return {'seconds':round(endpoint,3),'kind':'review' if review else distances[0][1],
                'proposed':distances[0][1],'margin':round(margin,4),
                'distance':round(distances[0][0],4),'incomplete':incomplete}

    def update(self,t,frame):
        # A stopped/reordered source must never advance a partially observed cycle.
        if not np.isfinite(t) or t<0 or (self.last_sample is not None and t<=self.last_sample):
            return []
        self.last_interval=t-self.last_sample if self.last_sample is not None else None
        if self.last_interval is not None and self.last_interval>.12:
            self.sampling_gaps+=1
        if frame is None or not isinstance(frame,np.ndarray) or frame.ndim!=3 or frame.shape[2]!=3 or frame.size==0:
            self.input_valid=False;self.gate_box=None;self.samples.clear();self.pending.clear();self.side_samples.clear()
            self.previous=None;self.armed=False;self.occupied=self.empty=None;self.last_sample=t
            return []
        self.input_valid=True
        if self.last_sample is not None and t-self.last_sample>.5:
            self.samples.clear();self.pending.clear();self.side_samples.clear();self.previous=None;self.armed=False
            self.occupied=self.empty=None
        self.last_sample=t
        small=cv2.resize(frame,(144,240));gray=cv2.cvtColor(small,cv2.COLOR_BGR2GRAY)
        # Grayscale before resizing matches training's interpolation exactly.
        gray=cv2.resize(cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY),(144,240))
        hsv=cv2.cvtColor(small,cv2.COLOR_BGR2HSV)
        mask=cv2.inRange(hsv,(15,65,65),(45,255,255))[:96,28:129]
        beam=np.where(mask.mean(axis=1)>75)[0]
        if self.view=='wide' and len(beam):
            # Ignore isolated yellow cloth/reflections below the machine beam.
            beam=max(np.split(beam,np.where(np.diff(beam)>1)[0]+1),key=len)
        self.gate_box=None
        if len(beam):
            gate_y=int(beam[-1]+(6 if self.view=='wide' else 13));gate=float(np.mean(gray[gate_y:gate_y+9,40:115]>100))
            self.gate_box=(40/144,gate_y/240,115/144,(gate_y+9)/240)
            if gate>.65:
                self.empty=None
                if self.occupied is None:self.occupied=t
                if t-self.occupied>=.15:self.armed=True
            elif gate<.25:
                self.occupied=None
                if self.empty is None:self.empty=t
                # At ~10 Hz a fast withdrawal may expose the gate for only two
                # samples. Require both samples, not a third one; keep the
                # occupied re-arm and one-second duplicate guard unchanged.
                if self.armed and t-self.empty>=.09 and t-self.last_event>1:
                    self.pending.append(self.empty);self.last_event=self.empty;self.armed=False
            else:self.occupied=self.empty=None
        else:
            if self.armed or self.pending:self.reference_losses+=1
            self.armed=False;self.occupied=self.empty=None
            lost=[{'seconds':t,'kind':'review','reason':'reference_lost'} for t in self.pending]
            self.pending.clear()
        if self.previous is not None:
            flow=cv2.calcOpticalFlowFarneback(self.previous,gray,None,.5,3,15,3,5,1.2,0)
            if self.view=='wide':
                # Compensate common camera translation using the lower table.
                dx=flow[:,:,0]-np.median(flow[160:200,:,0])
                dy=flow[:,:,1]-np.median(flow[160:200,:,1])
                cloth=(gray[45:145,:45]>100)&(self.previous[45:145,:45]>100)
                side=float(np.mean(cloth&(dx[45:145,:45]<-1)&
                                   (np.abs(dx[45:145,:45])>np.abs(dy[45:145,:45]))))
                self.side_samples.append((t,side))
                while self.side_samples and t-self.side_samples[0][0]>5:self.side_samples.popleft()
            features=[]
            for row in range(3):
                for col in range(3):
                    cell=flow[row*80:(row+1)*80,col*48:(col+1)*48]
                    for axis in range(2):features.extend(np.quantile(cell[:,:,axis],[.1,.5,.9]).tolist())
            self.samples.append((t,np.array(features)))
        self.previous=gray
        events=lost if not len(beam) else []
        while self.pending and t-self.pending[0]>=(1.5 if self.view=='wide' else .6):events.append(self.classify(self.pending.popleft()))
        while self.samples and t-self.samples[0][0]>5:self.samples.popleft()
        return events

    def finish(self):
        events=[self.classify(t,incomplete=True) for t in self.pending];self.pending.clear()
        return events


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--model',required=True)
    p.add_argument('--output',required=True);p.add_argument('--show',action='store_true')
    p.add_argument('--view',choices=['original','wide'],default='original');a=p.parse_args()
    source=int(a.source) if a.source.isdigit() else a.source;live=isinstance(source,int)
    cap=cv2.VideoCapture(source)
    if not cap.isOpened():raise SystemExit('Camera/video indisponivel')
    fps=cap.get(cv2.CAP_PROP_FPS) or 30;step=max(1,round(fps/10))
    counter=CycleCounter(json.loads(Path(a.model).read_text()),view=a.view)
    events=[];counts={'good':0,'residue':0,'review':0};i=0;start=time.monotonic();last=-1
    while True:
        ok,frame=cap.read()
        if not ok:break
        t=time.monotonic()-start if live else i/fps;i+=1
        sample=t-last>=.095 if live else i%step==0
        if sample:
            last=t
            for event in counter.update(t,frame):
                events.append(event);counts[event['kind']]+=1;print(json.dumps(event),flush=True)
        if a.show:
            cv2.putText(frame,'MODELO EXPERIMENTAL - TESTE',(10,25),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,170,255),1)
            cv2.putText(frame,str(counts),(10,50),cv2.FONT_HERSHEY_SIMPLEX,.45,(0,170,255),1)
            cv2.imshow('LinhaCount - modelo de ciclos',frame)
            if cv2.waitKey(max(1,round(1000/fps)) if not live else 1)&255 in (27,ord('q')):break
    for event in counter.finish():events.append(event);counts[event['kind']]+=1
    cap.release();cv2.destroyAllWindows();out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    report={'frames':i,'view':a.view,'candidate_counts':counts,'events':events,'production_ready':False,
            'note':'Same-video training replay; no independent count verification. No production writes.'}
    (out/'streaming-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(counts))

if __name__=='__main__':main()
