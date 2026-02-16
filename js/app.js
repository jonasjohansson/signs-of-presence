(() => {
  const BUILD = '2026-02-16 11:10';
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
    maxRadius: 80,
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
    mirrorDrift: false,
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
      flowPath: [],
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
    bleedSample.width = Math.ceil(W * dpr / BLEED_SCALE);
    bleedSample.height = Math.ceil(H * dpr / BLEED_SCALE);

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
  function remapPressure(p) {
    // Keep low pressures thin, scale up so 0.75 hits max
    const scaled = p / 0.75;
    return Math.min(1, scaled * scaled); // quadratic: preserves thin at light touch
  }

  function computeRadius(pressure, velocity) {
    const pMapped = Math.pow(Math.max(remapPressure(pressure), 0.001), brush.pressureCurve);
    const sizeT = 1 - brush.pressureToSize * (1 - pMapped);
    let r = brush.maxRadius * Math.max(brush.minSizePct, sizeT);
    if (brush.speedThinning > 0 && velocity > 0) {
      const vn = Math.min(velocity / 2.5, 1);
      r *= 1 - brush.speedThinning * vn * 0.7;
    }
    return Math.max(0.4, r);
  }

  function computeAlpha(pressure) {
    const pMapped = Math.pow(Math.max(remapPressure(pressure), 0.001), brush.pressureCurve);
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
  let stampLastStampOverride = null;
  const mirrorLastStamp = [
    { x: 0, y: 0, r: 0, has: false },
    { x: 0, y: 0, r: 0, has: false },
  ];
  const mirrorQueue = [];
  let scrollAccum = 0;
  let warpEnabled = false;
  let warpPhase = 0;
  let bleedEnabled = false;
  let bleedParticles = [];
  let bleedFrame = 0;
  const MAX_BLEED_PARTICLES = 800;

  let flowEnabled = false;
  const flowPaths = [];
  const MAX_FLOW_PATHS = 40;

  // Bleed: small canvas for edge sampling (GPU→CPU fast at low res)
  const BLEED_SCALE = 4;
  const bleedSample = document.createElement('canvas');
  const bsCtx = bleedSample.getContext('2d', { willReadFrequently: true });

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

      const ls = stampLastStampOverride || cur.lastStamp[activeStampChannel];
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
    // Record path for Flow/Warp effects
    if ((flowEnabled || warpEnabled) && cur.flowPath) {
      const pts = cur.flowPath;
      if (pts.length === 0 || Math.hypot(x - pts[pts.length - 1].x, y - pts[pts.length - 1].y) > 4) {
        pts.push({ x, y });
      }
    }

    // Primary stroke (channel 0)
    activeStampChannel = 0;
    stamp(x, y, pressure, velocity, angle, aspect, taperMul);
    mirrorTime++;

    if (brush.mirror && trackBounds.length === 3) {
      const srcTrack = cur.sourceTrack;
      const srcTb = trackBounds[srcTrack];
      const srcMid = (srcTb.top + srcTb.bot) / 2;
      const relY = (y - srcMid) / ((srcTb.bot - srcTb.top) / 2);
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

        if (mo.delay > 0) {
          mirrorQueue.push({
            executeAt: performance.now() + mo.delay,
            scrollAt: scrollAccum,
            x: mx, y: my,
            pressure: pressure * mo.pScale,
            velocity: velocity * mo.vScale,
            angle, aspect, taperMul,
            brushType: mo.brushType,
            maxRadius: brush.maxRadius * mo.rScale,
            opacity: brush.opacity * mo.opacScale,
            channel: m,
            newStroke: false,
          });
        } else {
          // Immediate mirror stamp (no delay)
          const savedType = brush.type;
          const savedMax = brush.maxRadius;
          const savedOpac = brush.opacity;
          brush.type = mo.brushType;
          brush.maxRadius = savedMax * mo.rScale;
          brush.opacity = savedOpac * mo.opacScale;
          activeStampChannel = m + 1;
          stamp(mx, my, pressure * mo.pScale, velocity * mo.vScale, angle, aspect, taperMul);
          brush.type = savedType;
          brush.maxRadius = savedMax;
          brush.opacity = savedOpac;
        }
      }
    }
    activeStampChannel = 0;
  }

  function processMirrorQueue() {
    const now = performance.now();
    while (mirrorQueue.length > 0 && mirrorQueue[0].executeAt <= now) {
      const e = mirrorQueue.shift();
      if (e.newStroke) {
        mirrorLastStamp[e.channel].has = false;
        continue;
      }
      const scrollDelta = scrollAccum - e.scrollAt;
      const savedType = brush.type;
      const savedMax = brush.maxRadius;
      const savedOpac = brush.opacity;

      brush.type = e.brushType;
      brush.maxRadius = e.maxRadius;
      brush.opacity = e.opacity;
      stampLastStampOverride = mirrorLastStamp[e.channel];
      activeStampChannel = 0;

      stamp(e.x - scrollDelta, e.y, e.pressure, e.velocity, e.angle, e.aspect, e.taperMul);

      stampLastStampOverride = null;
      brush.type = savedType;
      brush.maxRadius = savedMax;
      brush.opacity = savedOpac;
    }
  }

  function strokeSegment(x0, y0, p0, x1, y1, p1, vel, angle, aspect) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) { mirrorStamp(x1, y1, p1, vel, angle, aspect); return; }

    const avgP = (p0 + p1) / 2;
    const pMapped = Math.pow(Math.max(avgP, 0.001), brush.pressureCurve);
    const avgR = brush.maxRadius * Math.max(brush.minSizePct, 1 - brush.pressureToSize * (1 - pMapped));
    const spacing = Math.max(0.3, avgR * 0.04);
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
    pos: document.getElementById('s-pos'),
  };

  let _flashHUD = null; // set after init

  function updateHUD(e) {
    if (_flashHUD) _flashHUD();
    hud.type.textContent = e.pointerType || '--';
    const p = e.pressure ?? 0;
    hud.pressure.textContent = p.toFixed(3);
    hud.pbar.style.width = (p * 100) + '%';
    hud.tiltX.textContent = (e.tiltX ?? 0) + '\u00B0';
    hud.tiltY.textContent = (e.tiltY ?? 0) + '\u00B0';
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
    const drift = brush.mirrorDrift;
    cur.mirrorOffsets = [0, 1].map((_, m) => {
      const delay = drift ? 200 + Math.random() * 400 : 0;
      if (delay > 0) {
        mirrorQueue.push({ executeAt: performance.now() + delay, newStroke: true, channel: m });
      }
      return {
        xOff: drift ? 120 + Math.random() * 400 : 0,
        yScale: 0.7 + Math.random() * 0.6,
        pScale: 0.5 + Math.random() * 0.5,
        vScale: 0.6 + Math.random() * 0.8,
        rScale: 0.5 + Math.random() * 1.0,
        opacScale: 1,
        brushType: types[Math.floor(Math.random() * types.length)],
        driftFreq: 0.005 + Math.random() * 0.015,
        driftAmp: 5 + Math.random() * 20,
        driftPhaseX: Math.random() * Math.PI * 2,
        driftPhaseY: Math.random() * Math.PI * 2,
        timeScale: 0.7 + Math.random() * 0.6,
        delay,
      };
    });
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
        const stepSize = Math.max(0.3, avgR * 0.04);
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
    // Finalize flow path — spawn runners
    if ((flowEnabled || warpEnabled) && cur.flowPath && cur.flowPath.length > 5) {
      const path = { points: cur.flowPath, runners: [] };
      const numRunners = Math.min(4, 1 + Math.floor(cur.flowPath.length / 30));
      for (let i = 0; i < numRunners; i++) {
        path.runners.push({
          t: i / numRunners,
          speed: 0.002 + Math.random() * 0.004,
          size: 1.5 + Math.random() * 2.5,
        });
      }
      flowPaths.push(path);
      if (flowPaths.length > MAX_FLOW_PATHS) flowPaths.shift();
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
    // Process delayed mirror stamps
    processMirrorQueue();

    if (brush.scrollSpeed > 0) {
      scrollAccum += brush.scrollSpeed;
      const shift = Math.round(brush.scrollSpeed * dpr); // integer pixels to prevent sub-pixel ghosting
      if (shift > 0) {
        sctx.save();
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = 'copy';
        sctx.drawImage(score, -shift, 0);
        sctx.globalCompositeOperation = 'source-over';
        // Clear the revealed strip on the right to prevent ghost artifacts
        sctx.clearRect(score.width - shift, 0, shift, score.height);
        sctx.restore();
      }
      const cssShift = shift / dpr; // actual CSS-pixel shift (matches score canvas)
      for (const s of strokes.values()) {
        if (s.active) {
          s.prevX -= cssShift;
          s.smoothX -= cssShift;
        }
      }
      for (const bp of bleedParticles) {
        bp.x -= shift;
        bp.px -= shift;
      }
      for (const fp of flowPaths) {
        for (const pt of fp.points) pt.x -= cssShift;
      }
    }

    // Bleed: particle-based watercolor diffusion
    if (bleedEnabled) {
      bleedFrame++;

      // Sample edges every 3 frames via downscaled canvas
      if (bleedFrame % 2 === 0) {
        const sw = bleedSample.width, sh = bleedSample.height;
        bsCtx.clearRect(0, 0, sw, sh);
        bsCtx.drawImage(score, 0, 0, sw, sh);
        const img = bsCtx.getImageData(0, 0, sw, sh);
        const px = img.data;

        const attempts = 80;
        for (let a = 0; a < attempts; a++) {
          if (bleedParticles.length >= MAX_BLEED_PARTICLES) break;
          const sx = Math.floor(Math.random() * sw);
          const sy = Math.floor(Math.random() * sh);
          const idx = (sy * sw + sx) * 4;
          if (px[idx] < 40) continue;

          // Edge check: bright pixel with at least one dark neighbor
          let isEdge = false;
          let dirX = 0, dirY = 0;
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
            const nx = sx + dx, ny = sy + dy;
            if (nx < 0 || nx >= sw || ny < 0 || ny >= sh) { isEdge = true; continue; }
            if (px[(ny * sw + nx) * 4] < 30) {
              isEdge = true;
              dirX += dx; dirY += dy;
            }
          }
          if (!isEdge) continue;

          const dirLen = Math.hypot(dirX, dirY) || 1;
          dirX /= dirLen; dirY /= dirLen;
          const fx = sx * BLEED_SCALE;
          const fy = sy * BLEED_SCALE;
          const speed = 0.5 + Math.random() * 1.2;
          const life = 80 + Math.random() * 160;

          bleedParticles.push({
            x: fx, y: fy, px: fx, py: fy,
            vx: dirX * speed,
            vy: dirY * speed + 0.15,
            life, maxLife: life,
            size: (1.0 + Math.random() * 3.5) * dpr,
            alpha: 0.06 + Math.random() * 0.10,
            wobbleFreq: 0.05 + Math.random() * 0.15,
            wobbleAmp: 0.4 + Math.random() * 1.2,
            wobblePhase: Math.random() * Math.PI * 2,
          });
        }
      }

      // Update and draw particles onto score
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.fillStyle = '#fff';
      sctx.strokeStyle = '#fff';
      sctx.lineCap = 'round';

      for (let i = bleedParticles.length - 1; i >= 0; i--) {
        const p = bleedParticles[i];
        p.px = p.x; p.py = p.y;

        // Brownian motion + wobble → organic tendril paths
        p.wobblePhase += p.wobbleFreq;
        p.vx += (Math.random() - 0.5) * 0.25 + Math.sin(p.wobblePhase) * p.wobbleAmp * 0.08;
        p.vy += (Math.random() - 0.5) * 0.25 + Math.cos(p.wobblePhase * 1.3) * p.wobbleAmp * 0.06;
        p.vy += 0.015; // slight gravity
        p.vx *= 0.97; p.vy *= 0.97; // damping
        p.x += p.vx; p.y += p.vy;
        p.life--;

        if (p.life <= 0 || p.x < -50) {
          bleedParticles.splice(i, 1);
          continue;
        }

        const lifePct = p.life / p.maxLife;
        const alpha = p.alpha * lifePct * lifePct;
        const size = p.size * (0.3 + lifePct * 0.7);

        // Draw tendril line from previous to current position
        sctx.globalAlpha = alpha;
        sctx.lineWidth = size;
        sctx.beginPath();
        sctx.moveTo(p.px, p.py);
        sctx.lineTo(p.x, p.y);
        sctx.stroke();

        // Branching: occasionally spawn sub-tendril
        if (Math.random() < 0.07 && bleedParticles.length < MAX_BLEED_PARTICLES) {
          const ba = Math.atan2(p.vy, p.vx) + (Math.random() - 0.5) * Math.PI * 0.8;
          const bs = 0.2 + Math.random() * 0.5;
          const bl = Math.floor(p.life * 0.5);
          bleedParticles.push({
            x: p.x, y: p.y, px: p.x, py: p.y,
            vx: Math.cos(ba) * bs, vy: Math.sin(ba) * bs + 0.06,
            life: bl, maxLife: bl,
            size: p.size * 0.7, alpha: p.alpha * 0.7,
            wobbleFreq: 0.06 + Math.random() * 0.12,
            wobbleAmp: 0.3 + Math.random() * 0.8,
            wobblePhase: Math.random() * Math.PI * 2,
          });
        }
      }

      sctx.restore();
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(score, 0, 0);

    ctx.restore();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 0.5;
    for (const y of lanes) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Flow: animated lights traveling along stroke spines
    if (flowEnabled && flowPaths.length > 0) {
      // Cull off-screen paths
      while (flowPaths.length > 0) {
        const pts = flowPaths[0].points;
        if (pts.length > 0 && pts[0].x < -100 &&
            pts[pts.length - 1].x < -100 &&
            pts[Math.floor(pts.length / 2)].x < -100) {
          flowPaths.shift();
        } else break;
      }

      ctx.fillStyle = '#fff';
      for (const fp of flowPaths) {
        const pts = fp.points;
        if (pts.length < 2) continue;
        const totalPts = pts.length - 1;

        for (const runner of fp.runners) {
          runner.t += runner.speed;
          if (runner.t > 1) runner.t -= 1;

          // Current position
          const idx = runner.t * totalPts;
          const i = Math.floor(idx);
          const frac = idx - i;
          const p0 = pts[Math.min(i, pts.length - 1)];
          const p1 = pts[Math.min(i + 1, pts.length - 1)];
          const rx = p0.x + (p1.x - p0.x) * frac;
          const ry = p0.y + (p1.y - p0.y) * frac;

          // Comet trail (6 trailing dots)
          for (let j = 1; j <= 6; j++) {
            let tt = runner.t - runner.speed * j * 5;
            if (tt < 0) tt += 1;
            const tidx = tt * totalPts;
            const ti = Math.floor(tidx);
            const tf = tidx - ti;
            const tp0 = pts[Math.min(ti, pts.length - 1)];
            const tp1 = pts[Math.min(ti + 1, pts.length - 1)];
            const tx = tp0.x + (tp1.x - tp0.x) * tf;
            const ty = tp0.y + (tp1.y - tp0.y) * tf;
            const fade = 1 - j / 7;
            ctx.globalAlpha = fade * 0.4;
            ctx.beginPath();
            ctx.arc(tx, ty, runner.size * fade, 0, Math.PI * 2);
            ctx.fill();
          }

          // Soft glow halo
          ctx.globalAlpha = 0.15;
          ctx.beginPath();
          ctx.arc(rx, ry, runner.size * 5, 0, Math.PI * 2);
          ctx.fill();

          // Bright core
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.arc(rx, ry, runner.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Warp: animated sine waves following each stroke's spine
    if (warpEnabled && flowPaths.length > 0) {
      warpPhase += 0.06;
      ctx.strokeStyle = '#fff';
      ctx.lineCap = 'round';

      for (const fp of flowPaths) {
        const pts = fp.points;
        if (pts.length < 4) continue;

        // Draw 4 wave layers at different frequencies/amplitudes
        for (let w = 0; w < 4; w++) {
          const freq = 0.12 + w * 0.08;
          const amp = 3 + w * 3;
          const phase = warpPhase * (1 + w * 0.25) + w * 1.5;
          ctx.globalAlpha = 0.18 - w * 0.03;
          ctx.lineWidth = 1.5 - w * 0.2;

          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const next = pts[Math.min(i + 1, pts.length - 1)];
            const prev = pts[Math.max(i - 1, 0)];
            const dx = next.x - prev.x, dy = next.y - prev.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len, ny = dx / len;
            const wave = Math.sin(i * freq + phase) * amp;
            const wx = p.x + nx * wave;
            const wy = p.y + ny * wave;
            if (i === 0) ctx.moveTo(wx, wy);
            else ctx.lineTo(wx, wy);
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
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

  setupSlider('vs-size', 'vsf-size', 0.5, 80, brush.maxRadius, v => {
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

    const size = 0.5 + Math.random() * 79.5;
    brush.maxRadius = size;
    const sizePct = (size - 0.5) / (80 - 0.5);
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

  function resetBrushDefaults() {
    autoRandom = false;
    btnRandom.classList.remove('active');

    brush.type = 'normal';
    document.querySelectorAll('.bt-btn[data-type]').forEach(b =>
      b.classList.toggle('active', b.dataset.type === 'normal'));

    brush.maxRadius = 80;
    document.getElementById('vsf-size').style.height = '100%';
    updatePreview();

    setSlider('bp-stream',  'bpv-stream',  60);
    setSlider('bp-curve',   'bpv-curve',   80);
    setSlider('bp-pcurve',  'bpv-pcurve',  70);
    setSlider('bp-psize',   'bpv-psize',   100);
    setSlider('bp-popac',   'bpv-popac',   0);
    setSlider('bp-vel',     'bpv-vel',     30);
    setSlider('bp-min',     'bpv-min',     1);
    setSlider('bp-soft',    'bpv-soft',    15);
    setSlider('bp-tilt',    'bpv-tilt',    70);
    setSlider('bp-taper',   'bpv-taper',   20);
    setSlider('bp-tremor',  'bpv-tremor',  0);
    setSlider('bp-inertia', 'bpv-inertia', 20);
    setSlider('bp-scatter', 'bpv-scatter', 0);
    setSlider('bp-sdens',   'bpv-sdens',   4);
  }

  const btnRandom = document.getElementById('btn-random');
  btnRandom.addEventListener('click', () => {
    autoRandom = !autoRandom;
    btnRandom.classList.toggle('active', autoRandom);
    if (autoRandom) randomizeBrush();
  });

  document.getElementById('btn-default').addEventListener('click', resetBrushDefaults);

  function clearCanvas() {
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, score.width, score.height);
    sctx.restore();
    mirrorQueue.length = 0;
    mirrorLastStamp[0].has = false;
    mirrorLastStamp[1].has = false;
    flowPaths.length = 0;
    bleedParticles.length = 0;
  }

  document.getElementById('btn-clear').addEventListener('click', clearCanvas);

  const btnMirror = document.getElementById('btn-mirror');
  btnMirror.addEventListener('click', () => {
    brush.mirror = !brush.mirror;
    btnMirror.classList.toggle('active', brush.mirror);
  });

  const btnDrift = document.getElementById('btn-drift');
  btnDrift.addEventListener('click', () => {
    brush.mirrorDrift = !brush.mirrorDrift;
    btnDrift.classList.toggle('active', brush.mirrorDrift);
  });

  const btnWarp = document.getElementById('btn-warp');
  btnWarp.addEventListener('click', () => {
    warpEnabled = !warpEnabled;
    btnWarp.classList.toggle('active', warpEnabled);
  });

  const btnFlow = document.getElementById('btn-flow');
  btnFlow.addEventListener('click', () => {
    flowEnabled = !flowEnabled;
    btnFlow.classList.toggle('active', flowEnabled);
  });

  const btnBleed = document.getElementById('btn-bleed');
  btnBleed.addEventListener('click', () => {
    bleedEnabled = !bleedEnabled;
    btnBleed.classList.toggle('active', bleedEnabled);
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
   *  Keyboard shortcuts (for external keyboard use)
   * ════════════════════════════════════════════════ */
  document.addEventListener('keydown', e => {
    if (brushPanel.classList.contains('open')) return;
    switch (e.key.toLowerCase()) {
      case 'm': btnMirror.click(); break;
      case 'd': btnDrift.click(); break;
      case 'f': btnFlow.click(); break;
      case 'w': btnWarp.click(); break;
      case 'b': btnBleed.click(); break;
      case 'r': btnRandom.click(); break;
      case 'c': clearCanvas(); break;
      case '0': resetBrushDefaults(); break;
      case '1': document.querySelector('.bt-btn[data-type="normal"]').click(); break;
      case '2': document.querySelector('.bt-btn[data-type="splatter"]').click(); break;
      case '3': document.querySelector('.bt-btn[data-type="particle"]').click(); break;
    }
  });

  /* ════════════════════════════════════════════════
   *  HUD auto-hide (fades after 3s inactivity)
   * ════════════════════════════════════════════════ */
  const topBar = document.getElementById('top-bar');
  topBar.style.transition = 'opacity 0.5s';
  let hudTimeout = setTimeout(() => { topBar.style.opacity = '0'; }, 3000);

  _flashHUD = function() {
    topBar.style.opacity = '1';
    clearTimeout(hudTimeout);
    hudTimeout = setTimeout(() => { topBar.style.opacity = '0'; }, 3000);
  };

  canvas.addEventListener('pointerenter', _flashHUD);

  /* ════════════════════════════════════════════════
   *  Hamburger menu toggle
   * ════════════════════════════════════════════════ */
  const menuToggle = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');

  // Start collapsed on small screens
  if (window.innerWidth < 768) {
    sidebar.classList.add('collapsed');
  }

  menuToggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isCollapsed = sidebar.classList.toggle('collapsed');
    if (isCollapsed) brushPanel.classList.remove('open');
  });

  // Keyboard shortcut: 'h' to toggle sidebar
  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'h' && !brushPanel.classList.contains('open')) {
      menuToggle.click();
    }
  });

  /* ════════════════════════════════════════════════
   *  Init
   * ════════════════════════════════════════════════ */
  window.addEventListener('resize', resize);
  resize();
  buildDab();
  requestAnimationFrame(frame);
})();
