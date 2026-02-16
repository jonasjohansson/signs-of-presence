(() => {
  const BUILD = '2026-02-16 09:25';
  document.getElementById('s-version').textContent = BUILD;

  /* ════════════════════════════════════════════════
   *  Canvas setup
   * ════════════════════════════════════════════════ */
  const canvas = document.getElementById('main');
  const ctx = canvas.getContext('2d');
  const score = document.createElement('canvas');
  const sctx = score.getContext('2d');

  /* ════════════════════════════════════════════════
   *  Pre-rendered dab texture
   * ════════════════════════════════════════════════ */
  const DAB_RES = 128;
  const dabCvs = document.createElement('canvas');
  const dabCtx = dabCvs.getContext('2d');
  dabCvs.width = dabCvs.height = DAB_RES;

  function buildDab() {
    dabCtx.clearRect(0, 0, DAB_RES, DAB_RES);
    const c = DAB_RES / 2;
    const grad = dabCtx.createRadialGradient(c, c, 0, c, c, c);
    const hard = Math.max(0.01, 1 - brush.softness);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(Math.min(hard, 0.99), '#fff');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    dabCtx.fillStyle = grad;
    dabCtx.beginPath();
    dabCtx.arc(c, c, c, 0, Math.PI * 2);
    dabCtx.fill();
  }

  /* ════════════════════════════════════════════════
   *  App state
   * ════════════════════════════════════════════════ */
  let W, H, dpr;
  const SIDEBAR_W = 100;
  let lanes = [];
  let trackBounds = [];

  const brush = {
    type: 'normal',  // 'normal', 'splatter', 'particle'
    maxRadius: 4,
    opacity: 1.0,
    streamline: 0.60,
    curveBias: 0.8,
    pressureCurve: 0.70,
    pressureToSize: 1.00,
    pressureToOpac: 0,
    speedThinning: 0.30,
    minSizePct: 0.05,
    softness: 0.15,
    tiltInfluence: 0.70,
    scatterRadius: 0,
    scatterDensity: 4,
    taper: 0.2,
    tremor: 0,
    inertia: 0.2,
    mirror: false,
    scrollSpeed: 0.5,
  };

  /* ── Multi-pointer stroke tracking ── */
  const MAX_POINTERS = 3;
  const strokes = new Map();
  let cur = null; // current stroke being processed (set per event)

  function newStroke() {
    return {
      active: false,
      prevX: 0, prevY: 0, prevP: 0,
      smoothX: 0, smoothY: 0, smoothP: 0,
      lastTime: 0,
      velocity: 0,
      smTiltCos: 0, smTiltSin: 0, smAspect: 1,
      angle: 0, aspect: 1,
      history: [],
      totalDist: 0,
      tremorPhase: 0,
      mirrorOffsets: [],
      sourceTrack: 1,
      lastStamp: [
        { x: 0, y: 0, r: 0, has: false },
        { x: 0, y: 0, r: 0, has: false },
        { x: 0, y: 0, r: 0, has: false },
      ],
    };
  }

  /* ════════════════════════════════════════════════
   *  Layout / resize
   * ════════════════════════════════════════════════ */
  const MARGIN = 0.12;
  const GAP = 0.02;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;

    const tmp = document.createElement('canvas');
    tmp.width = score.width;
    tmp.height = score.height;
    if (score.width > 0 && score.height > 0)
      tmp.getContext('2d').drawImage(score, 0, 0);

    canvas.width = W * dpr;
    canvas.height = H * dpr;
    score.width = W * dpr;
    score.height = H * dpr;

    if (tmp.width > 0 && tmp.height > 0)
      sctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, score.width, score.height);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const usable = 1 - MARGIN * 2 - GAP * 2;
    const trackPct = usable / 3;

    trackBounds = [];
    lanes = [];
    for (let i = 0; i < 3; i++) {
      const tTop = H * (MARGIN + i * (trackPct + GAP));
      const tBot = tTop + H * trackPct;
      trackBounds.push({ top: tTop, bot: tBot });
      lanes.push((tTop + tBot) / 2);
    }
  }

  /* ════════════════════════════════════════════════
   *  Track detection
   * ════════════════════════════════════════════════ */
  function detectTrack(y) {
    if (trackBounds.length < 3) return 1;
    let best = 1, bestDist = Infinity;
    for (let i = 0; i < 3; i++) {
      const mid = (trackBounds[i].top + trackBounds[i].bot) / 2;
      const d = Math.abs(y - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  /* ════════════════════════════════════════════════
   *  Tilt
   * ════════════════════════════════════════════════ */
  function computeTilt(e) {
    if (brush.tiltInfluence <= 0) {
      cur.angle = 0;
      cur.aspect = 1;
      return;
    }

    let rawAngle = 0, tiltAmount = 0;

    if (e.altitudeAngle != null && e.azimuthAngle != null) {
      rawAngle = e.azimuthAngle;
      tiltAmount = 1 - (e.altitudeAngle / (Math.PI / 2));
    } else {
      const tx = (e.tiltX || 0) * Math.PI / 180;
      const ty = (e.tiltY || 0) * Math.PI / 180;
      rawAngle = Math.atan2(ty, tx);
      tiltAmount = Math.min(Math.hypot(tx, ty), 1);
    }

    const rc = Math.cos(rawAngle), rs = Math.sin(rawAngle);
    cur.smTiltCos += (rc - cur.smTiltCos) * 0.3;
    cur.smTiltSin += (rs - cur.smTiltSin) * 0.3;
    cur.angle = Math.atan2(cur.smTiltSin, cur.smTiltCos);

    const rawAspect = 1 - brush.tiltInfluence * tiltAmount * 0.8;
    cur.smAspect += (rawAspect - cur.smAspect) * 0.3;
    cur.aspect = Math.max(0.1, cur.smAspect);
  }

  /* ════════════════════════════════════════════════
   *  Brush engine
   * ════════════════════════════════════════════════ */
  function computeRadius(pressure, velocity) {
    const pMapped = Math.pow(Math.max(pressure, 0.001), brush.pressureCurve);
    const sizeT = 1 - brush.pressureToSize * (1 - pMapped);
    let r = brush.maxRadius * Math.max(brush.minSizePct, sizeT);
    if (brush.speedThinning > 0 && velocity > 0) {
      const vn = Math.min(velocity / 2.5, 1);
      r *= 1 - brush.speedThinning * vn * 0.7;
    }
    return Math.max(0.4, r);
  }

  function computeAlpha(pressure) {
    const pMapped = Math.pow(Math.max(pressure, 0.001), brush.pressureCurve);
    const opacT = 1 - brush.pressureToOpac * (1 - pMapped);
    return brush.opacity * Math.max(0.03, opacT);
  }

  function drawDab(x, y, r, alpha, angle, aspect) {
    const d = r * 2;
    sctx.save();
    sctx.translate(x, y);
    if (brush.tiltInfluence > 0 && aspect < 0.98) {
      sctx.rotate(angle);
      sctx.scale(1, aspect);
    }
    sctx.globalAlpha = alpha;
    sctx.drawImage(dabCvs, -r, -r, d, d);
    sctx.restore();
  }

  let activeStampChannel = 0;

  function stamp(x, y, pressure, velocity, angle, aspect, taperMul) {
    let r = computeRadius(pressure, velocity);
    if (taperMul !== undefined) r *= taperMul;
    const alpha = computeAlpha(pressure);

    if (brush.type === 'splatter') {
      drawDab(x, y, r * 0.6, alpha, angle, aspect);
      const count = 4 + Math.floor(pressure * 10);
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const reach = r * (1 + Math.random() * 3) * pressure;
        const steps = Math.ceil(reach / 2);
        for (let j = 0; j < steps; j++) {
          const t = j / steps;
          const sr = r * (0.4 - t * 0.35) * (0.5 + Math.random() * 0.5);
          const sx = x + Math.cos(a) * reach * t;
          const sy = y + Math.sin(a) * reach * t;
          drawDab(sx, sy, Math.max(0.5, sr), alpha * (1 - t * 0.6), angle, aspect);
        }
        if (Math.random() < 0.5) {
          const dr = r * (0.15 + Math.random() * 0.3);
          drawDab(x + Math.cos(a) * reach, y + Math.sin(a) * reach, dr, alpha * 0.8, angle, aspect);
        }
      }
    } else if (brush.type === 'particle') {
      const count = 3 + Math.floor(pressure * 12);
      const spread = r * 3;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * spread;
        const pr = 0.5 + Math.random() * r * 0.25;
        drawDab(x + Math.cos(a) * d, y + Math.sin(a) * d, pr, alpha * (0.5 + Math.random() * 0.5), angle, aspect);
      }
    } else {
      // Normal ink brush — filled path segments
      sctx.save();
      sctx.globalAlpha = alpha;
      sctx.fillStyle = '#fff';
      sctx.strokeStyle = '#fff';
      sctx.lineCap = 'round';
      sctx.lineJoin = 'round';

      const ls = cur.lastStamp[activeStampChannel];
      if (ls.has) {
        const dx = x - ls.x, dy = y - ls.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.1) {
          const nx = -dy / dist, ny = dx / dist;
          sctx.beginPath();
          sctx.moveTo(ls.x + nx * ls.r, ls.y + ny * ls.r);
          sctx.lineTo(x + nx * r, y + ny * r);
          const a1 = Math.atan2(ny, nx);
          sctx.arc(x, y, r, a1, a1 + Math.PI);
          sctx.lineTo(ls.x - nx * ls.r, ls.y - ny * ls.r);
          sctx.arc(ls.x, ls.y, ls.r, a1 + Math.PI, a1 + Math.PI * 2);
          sctx.closePath();
          sctx.fill();
        } else {
          sctx.beginPath();
          sctx.arc(x, y, r, 0, Math.PI * 2);
          sctx.fill();
        }
      } else {
        sctx.beginPath();
        sctx.arc(x, y, r, 0, Math.PI * 2);
        sctx.fill();
      }

      ls.x = x;
      ls.y = y;
      ls.r = r;
      ls.has = true;

      if (brush.scatterRadius > 0) {
        const spread = r * brush.scatterRadius * 3;
        for (let s = 0; s < brush.scatterDensity; s++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * spread;
          const sr = r * (0.3 + Math.random() * 0.7);
          sctx.globalAlpha = alpha * (0.4 + Math.random() * 0.6);
          sctx.beginPath();
          sctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, sr, 0, Math.PI * 2);
          sctx.fill();
        }
      }

      sctx.restore();
    }
  }

  let mirrorTime = 0;

  function mirrorStamp(x, y, pressure, velocity, angle, aspect, taperMul) {
    // Primary stroke (channel 0)
    activeStampChannel = 0;
    stamp(x, y, pressure, velocity, angle, aspect, taperMul);
    mirrorTime++;

    if (brush.mirror && trackBounds.length === 3) {
      const srcTrack = cur.sourceTrack;
      const srcTb = trackBounds[srcTrack];
      const srcMid = (srcTb.top + srcTb.bot) / 2;
      const relY = (y - srcMid) / ((srcTb.bot - srcTb.top) / 2);

      const savedType = brush.type;
      const savedMax = brush.maxRadius;
      const savedOpac = brush.opacity;

      // Mirror to the other two tracks
      const targets = [0, 1, 2].filter(i => i !== srcTrack);

      for (let m = 0; m < 2; m++) {
        const tb = trackBounds[targets[m]];
        const mo = cur.mirrorOffsets[m];
        const trackMid = (tb.top + tb.bot) / 2;
        const trackHalf = (tb.bot - tb.top) / 2;

        const t = mirrorTime * mo.timeScale;
        const driftX = Math.sin(t * mo.driftFreq + mo.driftPhaseX) * mo.driftAmp;
        const driftY = Math.cos(t * mo.driftFreq * 1.3 + mo.driftPhaseY) * mo.driftAmp * 0.6;

        const mx = x + mo.xOff + driftX;
        const my = trackMid + relY * trackHalf * mo.yScale + driftY;
        const mp = pressure * mo.pScale;

        brush.type = mo.brushType;
        brush.maxRadius = savedMax * mo.rScale;
        brush.opacity = savedOpac * mo.opacScale;

        activeStampChannel = m + 1;
        stamp(mx, my, mp, velocity * mo.vScale, angle, aspect, taperMul);
      }

      brush.type = savedType;
      brush.maxRadius = savedMax;
      brush.opacity = savedOpac;
    }
    activeStampChannel = 0;
  }

  function strokeSegment(x0, y0, p0, x1, y1, p1, vel, angle, aspect) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) { mirrorStamp(x1, y1, p1, vel, angle, aspect); return; }

    const avgP = (p0 + p1) / 2;
    const pMapped = Math.pow(Math.max(avgP, 0.001), brush.pressureCurve);
    const avgR = brush.maxRadius * Math.max(brush.minSizePct, 1 - brush.pressureToSize * (1 - pMapped));
    const spacing = Math.max(0.5, avgR * 0.08);
    const n = Math.max(1, Math.ceil(dist / spacing));

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      mirrorStamp(x0 + dx * t, y0 + dy * t, p0 + (p1 - p0) * t, vel, angle, aspect);
    }
  }

  /* ════════════════════════════════════════════════
   *  HUD
   * ════════════════════════════════════════════════ */
  const hud = {
    type: document.getElementById('s-type'),
    pressure: document.getElementById('s-pressure'),
    pbar: document.getElementById('s-pbar'),
    tiltX: document.getElementById('s-tiltx'),
    tiltY: document.getElementById('s-tilty'),
    alt: document.getElementById('s-alt'),
    azi: document.getElementById('s-azi'),
    twist: document.getElementById('s-twist'),
    pos: document.getElementById('s-pos'),
  };

  function updateHUD(e) {
    hud.type.textContent = e.pointerType || '--';
    const p = e.pressure ?? 0;
    hud.pressure.textContent = p.toFixed(3);
    hud.pbar.style.width = (p * 100) + '%';
    hud.tiltX.textContent = (e.tiltX ?? 0) + '\u00B0';
    hud.tiltY.textContent = (e.tiltY ?? 0) + '\u00B0';
    hud.alt.textContent = e.altitudeAngle != null
      ? (e.altitudeAngle * 180 / Math.PI).toFixed(1) + '\u00B0' : '--';
    hud.azi.textContent = e.azimuthAngle != null
      ? (e.azimuthAngle * 180 / Math.PI).toFixed(1) + '\u00B0' : '--';
    hud.twist.textContent = (e.twist ?? 0) + '\u00B0';
    hud.pos.textContent = Math.round(e.clientX) + ', ' + Math.round(e.clientY);
  }

  /* ════════════════════════════════════════════════
   *  Pointer events (multi-pointer: up to 3)
   * ════════════════════════════════════════════════ */
  function onDown(e) {
    if (strokes.size >= MAX_POINTERS) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const x = e.clientX, y = e.clientY, p = e.pressure || 0.5;

    if (autoRandom && (performance.now() - lastPenDown) > 1200) randomizeBrush();
    lastPenDown = performance.now();

    cur = newStroke();
    strokes.set(e.pointerId, cur);

    cur.active = true;
    cur.smoothX = cur.prevX = x;
    cur.smoothY = cur.prevY = y;
    cur.smoothP = cur.prevP = p;
    cur.lastTime = performance.now();
    cur.velocity = 0;
    cur.smTiltCos = 0;
    cur.smTiltSin = 0;
    cur.smAspect = 1;
    cur.history = [{ x, y, p }];
    cur.totalDist = 0;
    cur.tremorPhase = Math.random() * Math.PI * 2;
    cur.sourceTrack = detectTrack(y);

    // Randomize mirror personalities per stroke
    const types = ['normal', 'splatter', 'particle'];
    cur.mirrorOffsets = [0, 1].map(() => ({
      xOff: 60 + Math.random() * 200,
      yScale: 0.4 + Math.random() * 1.2,
      pScale: 0.3 + Math.random() * 0.7,
      vScale: 0.5 + Math.random() * 1.0,
      rScale: 0.3 + Math.random() * 1.7,
      opacScale: 1,
      brushType: types[Math.floor(Math.random() * types.length)],
      driftFreq: 0.01 + Math.random() * 0.03,
      driftAmp: 10 + Math.random() * 40,
      driftPhaseX: Math.random() * Math.PI * 2,
      driftPhaseY: Math.random() * Math.PI * 2,
      timeScale: 0.7 + Math.random() * 0.6,
    }));
    computeTilt(e);

    mirrorStamp(x, y, p, 0, cur.angle, cur.aspect, brush.taper > 0 ? 0.1 : 1);
    updateHUD(e);
  }

  function onMove(e) {
    updateHUD(e);
    cur = strokes.get(e.pointerId);
    if (!cur || !cur.active) return;
    e.preventDefault();

    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const now = performance.now();

    for (const ce of events) {
      const rx = ce.clientX;
      const ry = ce.clientY;
      const rp = ce.pressure || 0.5;

      const s = brush.streamline;
      cur.smoothX += (rx - cur.smoothX) * (1 - s);
      cur.smoothY += (ry - cur.smoothY) * (1 - s);
      cur.smoothP += (rp - cur.smoothP) * 0.4;

      computeTilt(ce);

      const dt = Math.max(now - cur.lastTime, 1);
      const dist = Math.hypot(cur.smoothX - cur.prevX, cur.smoothY - cur.prevY);
      const vel = dist / dt;
      cur.velocity += (vel - cur.velocity) * 0.3;
      cur.lastTime = now;
      cur.totalDist += dist;

      const taperIn = brush.taper > 0
        ? Math.min(1, cur.totalDist / (brush.maxRadius * 3 * brush.taper))
        : 1;

      const dirX = cur.smoothX - cur.prevX;
      const dirY = cur.smoothY - cur.prevY;
      const dirLen = Math.hypot(dirX, dirY) || 1;
      const perpX = -dirY / dirLen;
      const perpY = dirX / dirLen;

      const h = cur.history;
      h.push({ x: cur.smoothX, y: cur.smoothY, p: cur.smoothP });
      const maxHist = 8 + Math.floor(brush.curveBias * 12);
      if (h.length > maxHist) h.shift();

      if (brush.curveBias > 0 && h.length >= 4) {
        const bias = brush.curveBias;
        const sh = [];
        const win = Math.max(1, Math.floor(bias * 4));
        for (let i = 0; i < h.length; i++) {
          let sx = 0, sy = 0, sp = 0, cnt = 0;
          for (let j = Math.max(0, i - win); j <= Math.min(h.length - 1, i + win); j++) {
            sx += h[j].x; sy += h[j].y; sp += h[j].p; cnt++;
          }
          sh.push({ x: sx / cnt, y: sy / cnt, p: sp / cnt });
        }
        const n = sh.length;
        const p0 = sh[n - 4], p1 = sh[n - 3], p2 = sh[n - 2], p3 = sh[n - 1];
        const avgR = computeRadius((p1.p + p2.p) / 2, cur.velocity);
        const stepSize = Math.max(0.5, avgR * 0.08);
        const steps = Math.max(6, Math.ceil(dist / stepSize));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const t2 = t * t, t3 = t2 * t;
          const cx = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
          const cy = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
          const cp = p1.p + (p2.p - p1.p) * t;
          const lx = cur.prevX + (cur.smoothX - cur.prevX) * (i / steps);
          const ly = cur.prevY + (cur.smoothY - cur.prevY) * (i / steps);
          let fx = lx + (cx - lx) * bias;
          let fy = ly + (cy - ly) * bias;
          if (brush.tremor > 0) {
            cur.tremorPhase += 0.3;
            const wobble = Math.sin(cur.tremorPhase) * brush.tremor * brush.maxRadius * 0.3;
            fx += perpX * wobble;
            fy += perpY * wobble;
          }
          mirrorStamp(fx, fy, cp, cur.velocity, cur.angle, cur.aspect, taperIn);
        }
      } else {
        strokeSegment(
          cur.prevX, cur.prevY, cur.prevP,
          cur.smoothX, cur.smoothY, cur.smoothP,
          cur.velocity, cur.angle, cur.aspect
        );
      }

      cur.prevX = cur.smoothX;
      cur.prevY = cur.smoothY;
      cur.prevP = cur.smoothP;
    }
  }

  function onUp(e) {
    cur = strokes.get(e.pointerId);
    if (!cur) return;

    if (cur.active && brush.inertia > 0 && cur.velocity > 0.01) {
      const dx = cur.smoothX - cur.prevX;
      const dy = cur.smoothY - cur.prevY;
      const len = Math.hypot(dx, dy) || 1;
      const vx = (dx / len) * cur.velocity;
      const vy = (dy / len) * cur.velocity;
      const steps = Math.floor(brush.inertia * 20);
      let ix = cur.smoothX, iy = cur.smoothY;
      let ip = cur.smoothP;
      for (let i = 1; i <= steps; i++) {
        const decay = 1 - i / steps;
        const d2 = decay * decay;
        ix += vx * d2 * 8;
        iy += vy * d2 * 8;
        ip *= 0.85;
        const taperOut = brush.taper > 0 ? decay * decay : 1;
        mirrorStamp(ix, iy, ip, cur.velocity * d2, cur.angle, cur.aspect, taperOut);
      }
    }
    cur.active = false;
    strokes.delete(e.pointerId);
    if (e) updateHUD(e);
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  /* ════════════════════════════════════════════════
   *  Render loop
   * ════════════════════════════════════════════════ */
  function frame() {
    if (brush.scrollSpeed > 0) {
      const shift = brush.scrollSpeed * dpr;
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'copy';
      sctx.drawImage(score, -shift, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.restore();
      for (const s of strokes.values()) {
        if (s.active) {
          s.prevX -= brush.scrollSpeed;
          s.smoothX -= brush.scrollSpeed;
        }
      }
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(score, 0, 0);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 0.5;
    for (const y of lanes) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    requestAnimationFrame(frame);
  }

  /* ════════════════════════════════════════════════
   *  UI: vertical sliders
   * ════════════════════════════════════════════════ */
  function setupSlider(id, fillId, min, max, initial, onChange) {
    const el = document.getElementById(id);
    const fill = document.getElementById(fillId);
    let val = initial;
    let active = false;

    function setVal(v) {
      val = Math.max(min, Math.min(max, v));
      fill.style.height = ((val - min) / (max - min) * 100) + '%';
      onChange(val);
    }

    function fromY(clientY) {
      const r = el.getBoundingClientRect();
      const ratio = 1 - (clientY - r.top) / r.height;
      setVal(min + ratio * (max - min));
    }

    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      active = true;
      el.setPointerCapture(e.pointerId);
      fromY(e.clientY);
    });
    el.addEventListener('pointermove', e => { if (active) fromY(e.clientY); });
    el.addEventListener('pointerup', () => active = false);
    el.addEventListener('pointercancel', () => active = false);

    setVal(initial);
    return { get: () => val, set: setVal };
  }

  const brushDot = document.getElementById('brush-dot');

  function updatePreview() {
    const d = Math.max(4, Math.min(36, brush.maxRadius * 2));
    brushDot.style.width = d + 'px';
    brushDot.style.height = d + 'px';
    brushDot.style.opacity = brush.opacity;
  }

  setupSlider('vs-size', 'vsf-size', 0.5, 8, brush.maxRadius, v => {
    brush.maxRadius = v;
    updatePreview();
  });

  setupSlider('vs-speed', 'vsf-speed', 0, 2, brush.scrollSpeed, v => {
    brush.scrollSpeed = v;
  });

  updatePreview();

  /* ════════════════════════════════════════════════
   *  UI: brush settings panel
   * ════════════════════════════════════════════════ */
  const brushPanel = document.getElementById('brush-panel');

  document.getElementById('btn-brush-panel').addEventListener('click', () => {
    brushPanel.classList.toggle('open');
  });

  function setSlider(inputId, valId, value) {
    const input = document.getElementById(inputId);
    const display = document.getElementById(valId);
    if (input) {
      input.value = value;
      display.textContent = Math.round(value);
      input.dispatchEvent(new Event('input'));
    }
  }

  let autoRandom = false;
  let lastPenDown = 0;

  function randomizeBrush() {
    const types = ['normal', 'splatter', 'particle'];
    const type = types[Math.floor(Math.random() * types.length)];
    brush.type = type;
    document.querySelectorAll('.bt-btn[data-type]').forEach(b =>
      b.classList.toggle('active', b.dataset.type === type));

    const size = 0.5 + Math.random() * 7.5;
    brush.maxRadius = size;
    const sizePct = (size - 0.5) / (8 - 0.5);
    document.getElementById('vsf-size').style.height = (sizePct * 100) + '%';
    updatePreview();

    setSlider('bp-stream',  'bpv-stream',  Math.floor(20 + Math.random() * 75));
    setSlider('bp-curve',   'bpv-curve',   Math.floor(Math.random() * 100));
    // pressureCurve and pressureToSize are not randomized — keep user's tuned values
    setSlider('bp-popac',   'bpv-popac',   0);
    setSlider('bp-vel',     'bpv-vel',     Math.floor(Math.random() * 80));
    setSlider('bp-min',     'bpv-min',     Math.floor(1 + Math.random() * 30));
    setSlider('bp-soft',    'bpv-soft',    Math.floor(Math.random() * 60));
    setSlider('bp-tilt',    'bpv-tilt',    Math.floor(Math.random() * 100));
    setSlider('bp-taper',   'bpv-taper',   Math.floor(Math.random() * 60));
    setSlider('bp-tremor',  'bpv-tremor',  Math.floor(Math.random() * 30));
    setSlider('bp-inertia', 'bpv-inertia', Math.floor(Math.random() * 50));
    setSlider('bp-scatter', 'bpv-scatter', Math.floor(Math.random() * 40));
  }

  const btnRandom = document.getElementById('btn-random');
  btnRandom.addEventListener('click', () => {
    autoRandom = !autoRandom;
    btnRandom.classList.toggle('active', autoRandom);
    if (autoRandom) randomizeBrush();
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, score.width, score.height);
    sctx.restore();
  });

  const btnMirror = document.getElementById('btn-mirror');
  btnMirror.addEventListener('click', () => {
    brush.mirror = !brush.mirror;
    btnMirror.classList.toggle('active', brush.mirror);
  });

  document.getElementById('bp-close').addEventListener('click', () => {
    brushPanel.classList.remove('open');
  });

  document.addEventListener('pointerdown', (e) => {
    if (brushPanel.classList.contains('open') &&
        !brushPanel.contains(e.target) &&
        e.target.id !== 'btn-brush-panel') {
      brushPanel.classList.remove('open');
    }
  });

  function bindRange(inputId, valId, mapFn) {
    const input = document.getElementById(inputId);
    const display = document.getElementById(valId);
    input.addEventListener('input', () => {
      display.textContent = input.value;
      mapFn(parseFloat(input.value));
    });
    mapFn(parseFloat(input.value));
  }

  bindRange('bp-stream',  'bpv-stream',  v => { brush.streamline = v / 100; });
  bindRange('bp-curve',   'bpv-curve',   v => { brush.curveBias = v / 100; });
  bindRange('bp-pcurve',  'bpv-pcurve',  v => { brush.pressureCurve = v / 100; });
  bindRange('bp-psize',   'bpv-psize',   v => { brush.pressureToSize = v / 100; });
  bindRange('bp-popac',   'bpv-popac',   v => { brush.pressureToOpac = v / 100; });
  bindRange('bp-vel',     'bpv-vel',     v => { brush.speedThinning = v / 100; });
  bindRange('bp-min',     'bpv-min',     v => { brush.minSizePct = v / 100; });
  bindRange('bp-soft',    'bpv-soft',    v => { brush.softness = v / 100; buildDab(); });
  bindRange('bp-tilt',    'bpv-tilt',    v => { brush.tiltInfluence = v / 100; });
  bindRange('bp-taper',   'bpv-taper',   v => { brush.taper = v / 100; });
  bindRange('bp-tremor',  'bpv-tremor',  v => { brush.tremor = v / 100; });
  bindRange('bp-inertia', 'bpv-inertia', v => { brush.inertia = v / 100; });
  bindRange('bp-scatter', 'bpv-scatter', v => { brush.scatterRadius = v / 100; });
  bindRange('bp-sdens',   'bpv-sdens',   v => { brush.scatterDensity = Math.round(v); });

/* ════════════════════════════════════════════════
   *  UI: brush type selector
   * ════════════════════════════════════════════════ */
  const btBtns = document.querySelectorAll('.bt-btn[data-type]');
  btBtns.forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      btBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      brush.type = btn.dataset.type;
    });
  });

  /* ════════════════════════════════════════════════
   *  Init
   * ════════════════════════════════════════════════ */
  window.addEventListener('resize', resize);
  resize();
  buildDab();
  requestAnimationFrame(frame);
})();
