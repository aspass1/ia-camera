/* Local motion-cycle heuristic, not a trained fabric recognition model. */
(function (root) {
  class CycleDetector {
    constructor() { this.reset(); }
    reset() { this.phase = 'idle'; this.started = null; this.quietAt = null; this.activeMs = 0; this.lastTime = null; this.firstY = null; this.minY = 1; this.maxY = 0; this.crossed = false; }
    update(time, detection, threshold, line, direction) {
      if (this.lastTime !== null && (time <= this.lastTime || time - this.lastTime > 250)) { this.reset(); }
      const dt = this.lastTime === null ? 0 : Math.min(100, time - this.lastTime);
      this.lastTime = time;
      const activity = detection?.lineActivity || 0;
      const active = activity >= Math.max(0.012, threshold) && (detection?.area || 0) >= 0.004;
      const quiet = activity < Math.max(0.004, threshold * 0.4);
      if (active) {
        if (this.phase === 'idle') { this.phase = 'movement'; this.started = time; this.firstY = detection.cy; }
        this.activeMs += dt;
        this.quietAt = null;
        this.minY = Math.min(this.minY, detection.cy);
        this.maxY = Math.max(this.maxY, detection.cy);
        const down = this.firstY < line && detection.cy >= line;
        const up = this.firstY > line && detection.cy <= line;
        this.crossed ||= direction === 'any' ? down || up : direction === 'up' ? up : down;
      } else if (this.phase === 'movement' && quiet) {
        this.quietAt ??= time;
        if (time - this.quietAt >= 450) {
          const count = this.activeMs >= 180 && this.crossed;
          this.reset();
          this.lastTime = time;
          return { count, phase: 'idle', reason: count ? 'ciclo na linha confirmado' : 'movimento sem passagem confirmada' };
        }
      } else if (!quiet) { this.quietAt = null; }
      if (this.started !== null && time - this.started > 15000) { this.reset(); return { count: false, phase: 'idle', reason: 'Movimento contínuo: ajuste a linha na saída da máquina' }; }
      return { count: false, phase: this.phase };
    }
  }
  root.CycleDetector = CycleDetector;
  if (typeof module !== 'undefined') module.exports = CycleDetector;
})(globalThis);
