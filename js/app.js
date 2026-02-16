(() => {
  const BUILD = '2026-02-16T09:10';
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
    pressureCurve: 1.50,
    pressureToSize: 1.00,
    pressureToOpac: 0,
    speedThinning: 0.30,
    minSizePct: 0.01,
    softness: 0.15,
    tiltInfluence: 0.70,
    scatterRadius: 0,
    scatterDensity: 4,
    taper: 0.2,         // 0–1: taper strokes at start/end
    tremor: 0,          // 0–1: organic wobble perpendicular to stroke
    inertia: 0.2,       // 0–1: stroke continues after pen lifts
    mirror: false,
    scrollSpeed: 0.5,
  };

  const stroke = {
    active: false,
    prevX: 0, prevY: 0, prevP: 0,
    smoothX: 0, smoothY: 0, smoothP: 0,
    lastTime: 0,
    velocity: 0,
    trackTop: 0, trackBot: 0,
    // tilt smoothing
    smTiltCos: 0, smTiltSin: 0, smAspect: 1,
    angle: 0, aspect: 1,
    // point history for curve interpolation
    history: [],
    // taper tracking
    totalDist: 0,
    // tremor phase
    tremorPhase: 0,
    // mirror: per-stroke random offsets for top/bottom tracks
    mirrorOffsets: [],
  };

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
   *  Tilt
   * ════════════════════════════════════════════════ */
  function computeTilt(e) {
    if (brush.tiltInfluence <= 0) {
      stroke.angle = 0;
      stroke.aspect = 1;
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
    stroke.smTiltCos += (rc - stroke.smTiltCos) * 0.3;
    stroke.smTiltSin += (rs - stroke.smTiltSin) * 0.3;
    stroke.angle = Math.atan2(stroke.smTiltSin, stroke.smTiltCos);

    const rawAspect = 1 - brush.tiltInfluence * tiltAmount * 0.8;
    stroke.smAspect += (rawAspect - stroke.smAspect) * 0.3;
    stroke.aspect = Math.max(0.1, stroke.smAspect);
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

  // Track last stamp position for line-based drawing (per mirror channel)
  const lastStamp = [
    { x: 0, y: 0, r: 0, has: false },
    { x: 0, y: 0, r: 0, has: false },
    { x: 0, y: 0, r: 0, has: false },
  ];
  let activeStampChannel = 0;

  function stamp(x, y, pressure, velocity, angle, aspect, taperMul) {
    let r = computeRadius(pressure, velocity);
    if (taperMul !== undefined) r *= taperMul;
    const alpha = computeAlpha(pressure);

    if (brush.type === 'splatter') {
      // Central blob
      drawDab(x, y, r * 0.6, alpha, angle, aspect);
      // Radiating streaks and drops
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
        // Drop at the end
        if (Math.random() < 0.5) {
          const dr = r * (0.15 + Math.random() * 0.3);
          drawDab(x + Math.cos(a) * reach, y + Math.sin(a) * reach, dr, alpha * 0.8, angle, aspect);
        }
      }
    } else if (brush.type === 'particle') {
      // Spray of small particles
      const count = 3 + Math.floor(pressure * 12);
      const spread = r * 3;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * spread;
        const pr = 0.5 + Math.random() * r * 0.25;
        drawDab(x + Math.cos(a) * d, y + Math.sin(a) * d, pr, alpha * (0.5 + Math.random() * 0.5), angle, aspect);
      }
    } else {
      // Normal ink brush — draw filled path segments for smooth edges
      sctx.save();
      sctx.globalAlpha = alpha;
      sctx.fillStyle = '#fff';
      sctx.strokeStyle = '#fff';
      sctx.lineCap = 'round';
      sctx.lineJoin = 'round';

      const ls = lastStamp[activeStampChannel];
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
      const centerTb = trackBounds[1];
      const centerMid = (centerTb.top + centerTb.bot) / 2;
      const relY = (y - centerMid) / ((centerTb.bot - centerTb.top) / 2);

      const savedType = brush.type;
      const savedMax = brush.maxRadius;
      const savedOpac = brush.opacity;

      for (let m = 0; m < 2; m++) {
        const tb = trackBounds[m === 0 ? 0 : 2];
        const mo = stroke.mirrorOffsets[m];
        const trackMid = (tb.top + tb.bot) / 2;
        const trackHalf = (tb.bot - tb.top) / 2;

        // Independent path drift using sine waves at different frequencies
        const t = mirrorTime * mo.timeScale;
        const driftX = Math.sin(t * mo.driftFreq + mo.driftPhaseX) * mo.driftAmp;
        const driftY = Math.cos(t * mo.driftFreq * 1.3 + mo.driftPhaseY) * mo.driftAmp * 0.6;

        const mx = x + mo.xOff + driftX;
        const my = trackMid + relY * trackHalf * mo.yScale + driftY;
        const mp = pressure * mo.pScale;

        // Swap brush personality
        brush.type = mo.brushType;
        brush.maxRadius = savedMax * mo.rScale;
        brush.opacity = savedOpac * mo.opacScale;

        activeStampChannel = m + 1;
        stamp(mx, my, mp, velocity * mo.vScale, angle, aspect, taperMul);
      }

      // Restore original brush
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
   *  Pointer events
   * ════════════════════════════════════════════════ */
  function onDown(e) {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const x = e.clientX, y = e.clientY, p = e.pressure || 0.5;

    if (autoRandom && (performance.now() - lastPenDown) > 1200) randomizeBrush();
    lastPenDown = performance.now();

    stroke.active = true;
    const cy = y;
    stroke.smoothX = stroke.prevX = x;
    stroke.smoothY = stroke.prevY = cy;
    stroke.smoothP = stroke.prevP = p;
    stroke.lastTime = performance.now();
    stroke.velocity = 0;
    stroke.smTiltCos = 0;
    stroke.smTiltSin = 0;
    stroke.smAspect = 1;
    stroke.history = [{ x, y: cy, p }];
    stroke.totalDist = 0;
    stroke.tremorPhase = Math.random() * Math.PI * 2;
    lastStamp.forEach(ls => ls.has = false);
    // Randomize mirror personalities per stroke
    const types = ['normal', 'splatter', 'particle'];
    stroke.mirrorOffsets = [0, 1].map(() => ({
      xOff: 60 + Math.random() * 200,
      yScale: 0.4 + Math.random() * 1.2,
      pScale: 0.3 + Math.random() * 0.7,
      vScale: 0.5 + Math.random() * 1.0,
      rScale: 0.3 + Math.random() * 1.7,       // radius multiplier
      opacScale: 1,
      brushType: types[Math.floor(Math.random() * types.length)],
      driftFreq: 0.01 + Math.random() * 0.03,   // path wander frequency
      driftAmp: 10 + Math.random() * 40,         // path wander amplitude
      driftPhaseX: Math.random() * Math.PI * 2,
      driftPhaseY: Math.random() * Math.PI * 2,
      timeScale: 0.7 + Math.random() * 0.6,     // how fast drift evolves
    }));
    computeTilt(e);

    mirrorStamp(x, cy, p, 0, stroke.angle, stroke.aspect, brush.taper > 0 ? 0.1 : 1);
    updateHUD(e);
  }

  function onMove(e) {
    updateHUD(e);
    if (!stroke.active) return;
    e.preventDefault();

    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const now = performance.now();

    for (const ce of events) {
      const rx = ce.clientX;
      const ry = ce.clientY;
      const rp = ce.pressure || 0.5;

      const s = brush.streamline;
      stroke.smoothX += (rx - stroke.smoothX) * (1 - s);
      stroke.smoothY += (ry - stroke.smoothY) * (1 - s);
      stroke.smoothP += (rp - stroke.smoothP) * 0.4;

      computeTilt(ce);

      const dt = Math.max(now - stroke.lastTime, 1);
      const dist = Math.hypot(stroke.smoothX - stroke.prevX, stroke.smoothY - stroke.prevY);
      const vel = dist / dt;
      stroke.velocity += (vel - stroke.velocity) * 0.3;
      stroke.lastTime = now;
      stroke.totalDist += dist;

      // Compute taper multiplier (ease-in at stroke start)
      const taperIn = brush.taper > 0
        ? Math.min(1, stroke.totalDist / (brush.maxRadius * 3 * brush.taper))
        : 1;

      // Compute tremor: perpendicular displacement
      const dirX = stroke.smoothX - stroke.prevX;
      const dirY = stroke.smoothY - stroke.prevY;
      const dirLen = Math.hypot(dirX, dirY) || 1;
      const perpX = -dirY / dirLen;
      const perpY = dirX / dirLen;

      const h = stroke.history;
      h.push({ x: stroke.smoothX, y: stroke.smoothY, p: stroke.smoothP });
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
        const avgR = computeRadius((p1.p + p2.p) / 2, stroke.velocity);
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
          const lx = stroke.prevX + (stroke.smoothX - stroke.prevX) * (i / steps);
          const ly = stroke.prevY + (stroke.smoothY - stroke.prevY) * (i / steps);
          let fx = lx + (cx - lx) * bias;
          let fy = ly + (cy - ly) * bias;
          // Apply tremor
          if (brush.tremor > 0) {
            stroke.tremorPhase += 0.3;
            const wobble = Math.sin(stroke.tremorPhase) * brush.tremor * brush.maxRadius * 0.3;
            fx += perpX * wobble;
            fy += perpY * wobble;
          }
          mirrorStamp(fx, fy, cp, stroke.velocity, stroke.angle, stroke.aspect, taperIn);
        }
      } else {
        strokeSegment(
          stroke.prevX, stroke.prevY, stroke.prevP,
          stroke.smoothX, stroke.smoothY, stroke.smoothP,
          stroke.velocity, stroke.angle, stroke.aspect
        );
      }

      stroke.prevX = stroke.smoothX;
      stroke.prevY = stroke.smoothY;
      stroke.prevP = stroke.smoothP;
    }
  }

  function onUp(e) {
    if (stroke.active && brush.inertia > 0 && stroke.velocity > 0.01) {
      // Continue stroke with decaying momentum
      const dx = stroke.smoothX - stroke.prevX;
      const dy = stroke.smoothY - stroke.prevY;
      const len = Math.hypot(dx, dy) || 1;
      const vx = (dx / len) * stroke.velocity;
      const vy = (dy / len) * stroke.velocity;
      const steps = Math.floor(brush.inertia * 20);
      let ix = stroke.smoothX, iy = stroke.smoothY;
      let ip = stroke.smoothP;
      for (let i = 1; i <= steps; i++) {
        const decay = 1 - i / steps;
        const d2 = decay * decay;
        ix += vx * d2 * 8;
        iy += vy * d2 * 8;
        ip *= 0.85;
        // Taper out at stroke end
        const taperOut = brush.taper > 0 ? decay * decay : 1;
        mirrorStamp(ix, iy, ip, stroke.velocity * d2, stroke.angle, stroke.aspect, taperOut);
      }
    }
    stroke.active = false;
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
      if (stroke.active) {
        stroke.prevX -= brush.scrollSpeed;
        stroke.smoothX -= brush.scrollSpeed;
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

  // Helper to set a slider value and trigger its update
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
    setSlider('bp-pcurve',  'bpv-pcurve',  Math.floor(50 + Math.random() * 250));
    setSlider('bp-psize',   'bpv-psize',   Math.floor(30 + Math.random() * 70));
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
