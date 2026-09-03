/* Tracks a contrasting horizontal edge. Classical vision, not semantic AI. */
(function(root) {
  class EdgeDetector {
    constructor() { this.reset(); }
    reset() { this.lastTime = null; this.edge = null; this.origin = null; this.counted = false; this.countedAt = null; this.lastCountAt = null; this.repeated = false; this.lastSeen = null; this.phase = 'idle'; this.pending = null; this.progressY = null; this.progressAt = null; }
    static bounds(line, direction, searchSpan) {
      const span = Math.max(.10, Math.min(.30, searchSpan));
      return { left: .25, right: .85, top: Math.max(0, line-(direction === 'up' ? .12 : span)), bottom: Math.min(1, line+(direction === 'up' ? span : .12)) };
    }
    update(time, gray, width, height, line = .36, direction = 'down', sensitivity = 55, searchSpan = .20) {
      if (this.lastTime !== null && time <= this.lastTime) return { count: false, edge: this.edge, phase: this.phase };
      // Preserve the counted latch across dropped frames. Only explicit source/seek
      // resets erase it; a delivery stall must not make the same edge new again.
      this.lastTime = time;
      const rows = new Float32Array(height);
      const bounds = EdgeDetector.bounds(line, direction, searchSpan);
      const left = Math.floor(width * bounds.left), right = Math.floor(width * bounds.right);
      const strips = Array.from({length:3}, () => new Float32Array(height));
      for (let y=0;y<height;y++) {
        for (let x=left;x<right;x++) {
          rows[y] += gray[y*width+x];
          strips[Math.min(2, Math.floor((x-left)*3/(right-left)))][y] += gray[y*width+x] / ((right-left)/3);
        }
        rows[y] /= right-left;
      }
      const upward = direction === 'up';
      const minimum = Math.max(2, Math.floor(bounds.top*height));
      const maximum = Math.min(height-3, Math.ceil(bounds.bottom*height));
      const limit = Math.max(6, 22 - sensitivity * .2);
      const peaks = [];
      for(let y=minimum;y<=maximum;y++) {
        const strength = upward ? rows[y+2]-rows[y-2] : rows[y-2]-rows[y+2];
        // A hand/shadow confined to one third must not stand in for a cloth edge.
        // Allow a small vertical offset between strips for curved/slanted fabric.
        if (strength >= limit) {
          const support = strips.filter(strip => {
            for (let dy=-2;dy<=2;dy++) {
              const a=Math.max(0,y+dy-2), b=Math.min(height-1,y+dy+2);
              if ((upward ? strip[b]-strip[a] : strip[a]-strip[b]) >= limit*.55) return true;
            }
            return false;
          }).length;
          if (support >= 2) peaks.push({ y: y/height, strength, support });
        }
      }
      peaks.sort((a,b) => b.strength-a.strength);
      const candidates = [];
      for (const peak of peaks) if (candidates.every(other => Math.abs(other.y-peak.y) > .03)) candidates.push(peak);
      const sign = upward ? -1 : 1;
      let candidate = null;
      if (this.edge && time-this.lastSeen <= 700) {
        // Position continuity wins over contrast. Large backwards jumps are not
        // movement of the tracked sheet, even if the other line is darker.
        candidate = candidates.filter(p => (p.y-this.edge.y)*sign >= -.025 && Math.abs(p.y-this.edge.y) <= Math.min(.22,.05+(time-this.lastSeen)/1000*.8))
          .sort((a,b) => Math.abs(a.y-this.edge.y)-Math.abs(b.y-this.edge.y))[0] || null;
      }
      // Acquire the NEXT edge independently: a counted edge sitting on the pile
      // used to monopolize continuity forever, blocking subsequent withdrawals.
      const canAcquire = !candidate || this.counted || time-this.progressAt > 700;
      if (canAcquire) {
        const available = candidates.filter(p => !candidate || (candidate.y-p.y)*sign > .065);
        const upstream = available.filter(p => (p.y-line)*sign < -.06);
        if (this.pending && time-this.pending.lastSeen > 250) this.pending = null;
        let fresh = this.pending ? available.filter(p => (p.y-this.pending.y)*sign >= -.025 && Math.abs(p.y-this.pending.y) < .14)
          .sort((a,b) => Math.abs(a.y-this.pending.y)-Math.abs(b.y-this.pending.y))[0] : upstream[0];
        if (!fresh) { this.pending = null; fresh = upstream[0]; }
        if (fresh) {
          if (!this.pending) this.pending = { y: fresh.y, origin: fresh.y, lastSeen: time, hits: 1 };
          else { this.pending.y = fresh.y; this.pending.lastSeen = time; this.pending.hits++; }
          const movement = (fresh.y-this.pending.origin)*sign;
          if ((this.pending.hits >= 3 && movement >= .015) || (this.pending.hits >= 2 && movement >= .03)) {
            candidate = fresh; this.origin = this.pending.origin; this.counted = false;
            this.countedAt = null; this.repeated = false;
            this.edge = null; this.progressY = fresh.y; this.progressAt = time; this.pending = null;
          }
        } else this.pending = null;
        if (!candidate) {
          this.phase = this.edge && time-this.lastSeen <= 700 ? 'lost' : 'idle';
          return { count: false, edge: null, phase: this.phase };
        }
      } else {
        this.pending = null;
      }
      if (this.progressY === null || Math.abs(candidate.y-this.progressY) > .008) {
        this.progressY = candidate.y; this.progressAt = time;
      }
      const travel = this.origin === null ? 0 : (candidate.y-this.origin)*sign;
      const crossed = (candidate.y-line)*sign >= .008;
      const passage = !this.counted && crossed && travel >= .075;
      // Short-cycle guard for the supplied ~3.5 s withdrawals. This is not
      // object identity: true separate pieces less than 900 ms apart need a
      // different validated profile. Latch rejected contours too, otherwise
      // a stationary fold becomes a delayed count when the guard expires.
      const repeated = passage && this.lastCountAt !== null && time-this.lastCountAt < 900;
      const count = passage && !repeated;
      if (passage) { this.counted = true; this.countedAt = time; this.repeated = repeated; }
      if (count) this.lastCountAt = time;
      this.edge = candidate; this.lastSeen = time;
      this.phase = this.counted ? this.repeated ? 'duplicate' : 'counted' : this.origin !== null ? 'tracking' : 'idle';
      const stationary = time-this.progressAt > 700;
      // Confirmation is brief; keep identity internally, not a frozen yellow marker.
      const acknowledged = this.counted && time-this.countedAt > 350;
      return { count, edge: stationary || acknowledged ? null : candidate, phase: this.counted ? this.phase : stationary ? 'stationary' : this.phase, travel };
    }
  }
  root.EdgeDetector = EdgeDetector;
  if (typeof module !== 'undefined') module.exports = EdgeDetector;
})(globalThis);
