(() => {
  const VERSION = '0.42';
  document.getElementById('s-version').textContent = VERSION;

  /* ════════════════════════════════════════════════
   *  Canvas setup
   * ════════════════════════════════════════════════ */
  const canvas = document.getElementById('main');
  const ctx = canvas.getContext('2d');
  const score = document.createElement('canvas');
  let sctx = score.getContext('2d');
  const baseSctx = sctx;

  // Parallax layers — each stroke gets a random layer with its own scroll speed
  const NUM_LAYERS = 4;
  const scoreLayers = [];
  for (let i = 0; i < NUM_LAYERS; i++) {
    const cvs = document.createElement('canvas');
    const lctx = cvs.getContext('2d');
    scoreLayers.push({ canvas: cvs, ctx: lctx, speed: 0.82 + (i / (NUM_LAYERS - 1)) * 0.36 });
  }
  // speeds: 0.82, 0.94, 1.06, 1.18

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
    const r = parseInt(drawColor.slice(1,3),16), g = parseInt(drawColor.slice(3,5),16), b = parseInt(drawColor.slice(5,7),16);
    grad.addColorStop(0, drawColor);
    grad.addColorStop(Math.min(hard, 0.99), drawColor);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    dabCtx.fillStyle = grad;
    dabCtx.beginPath();
    dabCtx.arc(c, c, c, 0, Math.PI * 2);
    dabCtx.fill();
  }

  let activeDabCvs = dabCvs;
  const mirrorDabCvs = [document.createElement('canvas'), document.createElement('canvas')];
  mirrorDabCvs.forEach(c => { c.width = c.height = DAB_RES; });

  function buildDabFor(targetCvs, color) {
    const tctx = targetCvs.getContext('2d');
    tctx.clearRect(0, 0, DAB_RES, DAB_RES);
    const c = DAB_RES / 2;
    const grad = tctx.createRadialGradient(c, c, 0, c, c, c);
    const hard = Math.max(0.01, 1 - brush.softness);
    const cr = parseInt(color.slice(1,3),16), cg = parseInt(color.slice(3,5),16), cb = parseInt(color.slice(5,7),16);
    grad.addColorStop(0, color);
    grad.addColorStop(Math.min(hard, 0.99), color);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    tctx.fillStyle = grad;
    tctx.beginPath();
    tctx.arc(c, c, c, 0, Math.PI * 2);
    tctx.fill();
  }

  /* ════════════════════════════════════════════════
   *  App state
   * ════════════════════════════════════════════════ */
  let W, H, dpr;
  const SIDEBAR_W = 100;
  let drawColor = '#ffffff';
  let parallaxEnabled = false;
  let mirrorHueEnabled = false;
  let mirrorWild = false;
  let shakeEnabled = false;
  let shakeIntensity = 0;
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
    tiltInfluence: 0.25,
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
      silkFibers: [null, null, null],
      layer: -1,
    };
  }

  /* ════════════════════════════════════════════════
   *  Layout / resize
   * ════════════════════════════════════════════════ */
  const MARGIN = 0.22;
  const GAP = 0.02;
  let trackLineOpacity = 0.15;

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
      baseSctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, score.width, score.height);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    baseSctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const layer of scoreLayers) {
      layer.canvas.width = W * dpr;
      layer.canvas.height = H * dpr;
      layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

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
    return Math.min(1, scaled * scaled);
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
    sctx.drawImage(activeDabCvs, -r, -r, d, d);
    sctx.restore();
  }

  /* ── Silk brush: volumetric ribbon fibers ── */
  const SILK_COUNT = 24;

  function initSilkFibers(x, y) {
    const fibers = [];
    for (let i = 0; i < SILK_COUNT; i++) {
      fibers.push({ x, y, px: x, py: y, has: false });
    }
    return fibers;
  }

  let activeStampChannel = 0;
  let stampLastStampOverride = null;
  const mirrorLastStamp = [
    { x: 0, y: 0, r: 0, has: false },
    { x: 0, y: 0, r: 0, has: false },
  ];
  const mirrorQueue = [];
  let scrollAccum = 0;
  let bleedEnabled = false;
  let bleedParticles = [];
  let bleedFrame = 0;
  const MAX_BLEED_PARTICLES = 1000;

  let flowEnabled = false;
  const flowPaths = [];
  const MAX_FLOW_PATHS = 40;

  let growEnabled = false;
  let growBranches = [];
  const MAX_GROW = 400;

  let flockEnabled = false;
  let flockParticles = [];
  const MAX_FLOCK = 250;

  let intenseEnabled = false;
  let intensePressure = 0;

  let sprayEnabled = false;
  let sprayParticles = [];
  const MAX_SPRAY = 600;

  let constellationEnabled = false;
  let constellationStars = [];
  const MAX_STARS = 300;
  const STAR_CONNECT_DIST = 120; // CSS px

  let pulseEnabled = false;

  // Shared edge sampling canvas (GPU→CPU fast at low res)
  const BLEED_SCALE = 4;
  const bleedSample = document.createElement('canvas');
  const bsCtx = bleedSample.getContext('2d', { willReadFrequently: true });

  function stamp(x, y, pressure, velocity, angle, aspect, taperMul) {
    let r = computeRadius(pressure, velocity);
    if (taperMul !== undefined) r *= taperMul;

    // Smooth radius to prevent sudden blob jumps
    const ls = stampLastStampOverride || cur.lastStamp[activeStampChannel];
    if (ls.has && ls.r > 0) {
      const maxGrow = 1.25; // max 25% growth per stamp
      r = Math.min(r, ls.r * maxGrow);
      r = ls.r + (r - ls.r) * 0.25;
    }

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
    } else if (brush.type === 'silk') {
      // Silk brush — volumetric ribbon with 3D lighting
      const ch = activeStampChannel;
      if (!cur.silkFibers[ch]) cur.silkFibers[ch] = initSilkFibers(x, y);
      const fibers = cur.silkFibers[ch];
      const halfW = r;

      // Perpendicular to stroke direction
      const ls = stampLastStampOverride || cur.lastStamp[activeStampChannel];
      let perpX = 0, perpY = -1;
      if (ls.has) {
        const ddx = x - ls.x, ddy = y - ls.y;
        const dd = Math.hypot(ddx, ddy);
        if (dd > 0.5) { perpX = -ddy / dd; perpY = ddx / dd; }
      }

      // Light direction from tilt angle
      const lightAngle = cur.angle || 0;

      sctx.save();
      sctx.strokeStyle = drawColor;
      sctx.lineCap = 'round';

      for (let i = 0; i < SILK_COUNT; i++) {
        const f = fibers[i];
        const t = (i / (SILK_COUNT - 1)) * 2 - 1; // -1 to 1
        const offset = t * halfW;
        const fx = x + perpX * offset;
        const fy = y + perpY * offset;

        if (f.has) {
          // Cylindrical lighting: Lambertian + rim
          const cosLight = Math.cos(t * Math.PI * 0.5 - lightAngle);
          const rim = Math.pow(1 - Math.abs(t), 0.3) * 0.15;
          const lightVal = Math.max(0, cosLight) * 0.65 + rim + 0.05;

          sctx.globalAlpha = alpha * lightVal;
          sctx.lineWidth = 0.5 + r * 0.015;
          sctx.beginPath();
          sctx.moveTo(f.px, f.py);
          sctx.lineTo(fx, fy);
          sctx.stroke();
        }

        f.px = f.x; f.py = f.y;
        f.x = fx; f.y = fy; f.has = true;
      }

      sctx.restore();
      ls.x = x; ls.y = y; ls.r = r; ls.has = true;

    } else {
      // Normal ink brush — filled capsule stamps
      sctx.save();
      sctx.globalAlpha = alpha;
      sctx.fillStyle = drawColor;

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

      ls.x = x; ls.y = y; ls.r = r; ls.has = true;

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
    // Record path for Flow effect
    if (flowEnabled && cur.flowPath) {
      const pts = cur.flowPath;
      if (pts.length === 0 || Math.hypot(x - pts[pts.length - 1].x, y - pts[pts.length - 1].y) > 4) {
        pts.push({ x, y });
      }
    }

    // Primary stroke (channel 0)
    activeStampChannel = 0;
    stamp(x, y, pressure, velocity, angle, aspect, taperMul);
    mirrorTime++;

    // Constellation: place star points along strokes
    if (constellationEnabled && constellationStars.length < MAX_STARS && Math.random() < 0.015) {
      constellationStars.push({ x, y });
      // Draw small bright dot on score canvas
      sctx.save();
      sctx.globalAlpha = 0.9;
      sctx.fillStyle = drawColor;
      sctx.beginPath();
      sctx.arc(x, y, 1.5, 0, Math.PI * 2);
      sctx.fill();
      sctx.restore();
    }

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

        // Sparse: randomly skip stamps for minimal, independent feel
        if (Math.random() > mo.drawChance) continue;

        const t = mirrorTime * mo.wanderSpeed;
        let wx, wy;
        if (mirrorWild) {
          wx = Math.sin(t * mo.wanderFreq + mo.wanderPhaseX) * mo.wanderAmpX
             + Math.sin(t * mo.wanderFreq * 3.7 + mo.wanderPhaseY) * mo.wanderAmpX * 0.4
             + (Math.random() - 0.5) * mo.wanderAmpX * 0.5;
          wy = Math.cos(t * mo.wanderFreq * 1.3 + mo.wanderPhaseY) * mo.wanderAmpY
             + Math.cos(t * mo.wanderFreq * 2.9 + mo.wanderPhaseX) * mo.wanderAmpY * 0.4
             + (Math.random() - 0.5) * mo.wanderAmpY * 0.5;
        } else {
          wx = Math.sin(t * mo.wanderFreq + mo.wanderPhaseX) * mo.wanderAmpX;
          wy = Math.cos(t * mo.wanderFreq * 1.3 + mo.wanderPhaseY) * mo.wanderAmpY;
        }
        const mx = x + mo.xOff + wx;
        const my = trackMid + relY * trackHalf * mo.yScale + wy;

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
            color: mo.color || null,
            layer: cur.layer,
            newStroke: false,
          });
        } else {
          // Immediate mirror stamp (no delay)
          const savedType = brush.type;
          const savedMax = brush.maxRadius;
          const savedOpac = brush.opacity;
          const savedColor = drawColor;
          brush.type = mo.brushType;
          brush.maxRadius = savedMax * mo.rScale;
          brush.opacity = savedOpac * mo.opacScale;
          if (mo.color) { drawColor = mo.color; activeDabCvs = mirrorDabCvs[m]; }
          activeStampChannel = m + 1;
          stamp(mx, my, pressure * mo.pScale, velocity * mo.vScale, angle, aspect, taperMul);
          brush.type = savedType;
          brush.maxRadius = savedMax;
          brush.opacity = savedOpac;
          drawColor = savedColor;
          activeDabCvs = dabCvs;
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
      if (!cur) continue;
      if (e.layer >= 0) sctx = scoreLayers[e.layer].ctx;
      const scrollDelta = scrollAccum - e.scrollAt;
      const savedType = brush.type;
      const savedMax = brush.maxRadius;
      const savedOpac = brush.opacity;
      const savedColor = drawColor;

      brush.type = e.brushType;
      brush.maxRadius = e.maxRadius;
      brush.opacity = e.opacity;
      if (e.color) { drawColor = e.color; activeDabCvs = mirrorDabCvs[e.channel]; }
      stampLastStampOverride = mirrorLastStamp[e.channel];
      activeStampChannel = 0;

      stamp(e.x - scrollDelta, e.y, e.pressure, e.velocity, e.angle, e.aspect, e.taperMul);

      stampLastStampOverride = null;
      brush.type = savedType;
      brush.maxRadius = savedMax;
      brush.opacity = savedOpac;
      drawColor = savedColor;
      activeDabCvs = dabCvs;
      sctx = baseSctx;
    }
  }

  function strokeSegment(x0, y0, p0, x1, y1, p1, vel, angle, aspect) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) { mirrorStamp(x1, y1, p1, vel, angle, aspect); return; }

    const avgP = (p0 + p1) / 2;
    const pMapped = Math.pow(Math.max(avgP, 0.001), brush.pressureCurve);
    const avgR = brush.maxRadius * Math.max(brush.minSizePct, 1 - brush.pressureToSize * (1 - pMapped));
    const spacing = Math.max(0.3, avgR * 0.015);
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

    const x = e.clientX, y = e.clientY, p = Math.min(e.pressure || 0.5, 0.5);

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

    // Each mirror track: different brush type + organic path wandering
    const types = ['normal', 'splatter', 'particle', 'silk'];
    const drift = brush.mirrorDrift;
    const hueColors = mirrorHueEnabled
      ? [...document.querySelectorAll('.cp-swatch')].map(s => s.dataset.color).filter(c => c !== drawColor)
      : null;
    cur.mirrorOffsets = [0, 1].map((_, m) => {
      const delay = drift ? 150 + m * 200 + Math.random() * 300 : 0;
      const xOff = drift ? 100 + m * 150 + Math.random() * 200 : 0;
      if (delay > 0) {
        mirrorQueue.push({ executeAt: performance.now() + delay, newStroke: true, channel: m });
      }
      const color = hueColors ? hueColors[Math.floor(Math.random() * hueColors.length)] : null;
      if (color) buildDabFor(mirrorDabCvs[m], color);
      return {
        xOff,
        color,
        yScale: 0.3 + Math.random() * 1.2,
        pScale: 0.15 + Math.random() * 0.8,
        vScale: 0.3 + Math.random() * 1.2,
        rScale: 0.15 + Math.random() * 1.8,
        opacScale: 1,
        brushType: types[Math.floor(Math.random() * types.length)],
        // Organic path wandering — large deviation for independent feel
        wanderFreq: 0.003 + Math.random() * 0.015,
        wanderAmpX: 20 + Math.random() * 60,
        wanderAmpY: 15 + Math.random() * 50,
        wanderPhaseX: Math.random() * Math.PI * 2,
        wanderPhaseY: Math.random() * Math.PI * 2,
        wanderSpeed: 0.4 + Math.random() * 0.8,
        // Sparse drawing — skip stamps randomly for minimal feel
        drawChance: 0.25 + Math.random() * 0.4,
        delay,
      };
    });
    computeTilt(e);

    // Assign stroke to a random parallax layer
    if (parallaxEnabled) {
      cur.layer = Math.floor(Math.random() * NUM_LAYERS);
      sctx = scoreLayers[cur.layer].ctx;
    }

    // Seed only primary channel lastStamp — mirror channels stay unseeded
    // to avoid drawing lines between tracks
    const initR = Math.max(1, brush.maxRadius * 0.05);
    cur.lastStamp[0].x = x; cur.lastStamp[0].y = y; cur.lastStamp[0].r = initR; cur.lastStamp[0].has = true;

    mirrorStamp(x, y, p, 0, cur.angle, cur.aspect, 0.15);
    sctx = baseSctx;
    updateHUD(e);
  }

  function onMove(e) {
    updateHUD(e);
    const s = strokes.get(e.pointerId);
    if (!s || !s.active) return;
    cur = s;
    if (cur.layer >= 0) sctx = scoreLayers[cur.layer].ctx;
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
      cur.smoothP += (rp - cur.smoothP) * 0.2;

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
        const stepSize = Math.max(0.3, avgR * 0.015);
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
    sctx = baseSctx;
  }

  function onUp(e) {
    const s = strokes.get(e.pointerId);
    if (!s) return;
    cur = s;
    if (cur.layer >= 0) sctx = scoreLayers[cur.layer].ctx;

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
    if (flowEnabled && cur.flowPath && cur.flowPath.length > 5) {
      const path = { points: cur.flowPath, runners: [] };
      const numRunners = Math.min(4, 1 + Math.floor(cur.flowPath.length / 30));
      for (let i = 0; i < numRunners; i++) {
        path.runners.push({
          t: i / numRunners,
          speed: 0.002 + Math.random() * 0.004,
          size: 1.5 + Math.random() * 2.5,
          z: 0.2 + Math.random() * 0.8,
        });
      }
      flowPaths.push(path);
      if (flowPaths.length > MAX_FLOW_PATHS) flowPaths.shift();
    }

    cur.active = false;
    strokes.delete(e.pointerId);
    sctx = baseSctx;
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
      const baseShift = Math.round(brush.scrollSpeed * dpr);

      if (baseShift > 0) {
        // Scroll base score canvas (VFX content)
        baseSctx.save();
        baseSctx.setTransform(1, 0, 0, 1, 0, 0);
        baseSctx.globalCompositeOperation = 'copy';
        baseSctx.drawImage(score, -baseShift, 0);
        baseSctx.globalCompositeOperation = 'source-over';
        baseSctx.clearRect(score.width - baseShift, 0, baseShift, score.height);
        baseSctx.restore();

        // Scroll each parallax layer at its own speed
        for (const layer of scoreLayers) {
          const layerShift = parallaxEnabled ? Math.round(baseShift * layer.speed) : baseShift;
          if (layerShift > 0) {
            layer.ctx.save();
            layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
            layer.ctx.globalCompositeOperation = 'copy';
            layer.ctx.drawImage(layer.canvas, -layerShift, 0);
            layer.ctx.globalCompositeOperation = 'source-over';
            layer.ctx.clearRect(layer.canvas.width - layerShift, 0, layerShift, layer.canvas.height);
            layer.ctx.restore();
          }
        }
      }

      // Adjust active stroke coordinates per layer speed
      for (const s of strokes.values()) {
        if (s.active) {
          const speed = (parallaxEnabled && s.layer >= 0) ? scoreLayers[s.layer].speed : 1;
          const sShift = Math.round(baseShift * speed) / dpr;
          s.prevX -= sShift;
          s.smoothX -= sShift;
        }
      }
      const cssShift = baseShift / dpr;
      for (const bp of bleedParticles) {
        const pShift = baseShift * (0.85 + bp.z * 0.15);
        bp.x -= pShift;
        bp.px -= pShift;
      }
      for (const fp of flowPaths) {
        for (const pt of fp.points) pt.x -= cssShift;
      }
      for (const gb of growBranches) { gb.x -= baseShift * (0.85 + gb.z * 0.15); }
      for (const fp of flockParticles) {
        const fShift = baseShift * (0.85 + fp.z * 0.15);
        fp.x -= fShift;
        for (const tp of fp.trail) tp.x -= fShift;
      }
      for (const sp of sprayParticles) {
        const sShift = baseShift * (0.85 + sp.z * 0.15);
        sp.x -= sShift;
        sp.px -= sShift;
      }
      const cssShift2 = baseShift / dpr;
      for (let i = constellationStars.length - 1; i >= 0; i--) {
        constellationStars[i].x -= cssShift2;
        if (constellationStars[i].x < -20) constellationStars.splice(i, 1);
      }
    }

    // ── Intense: pressure-driven VFX boost ──
    if (intenseEnabled) {
      let maxP = 0;
      for (const s of strokes.values()) {
        if (s.active) maxP = Math.max(maxP, s.smoothP);
      }
      intensePressure += (maxP - intensePressure) * 0.3;
    } else {
      intensePressure *= 0.9;
    }
    const intSz = 0.5 + brush.maxRadius / 80;
    const intMul = 1 + intensePressure * 5 * intSz;

    // ── Spray: radial energy burst from pen position ──
    if (sprayEnabled) {
      for (const s of strokes.values()) {
        if (!s.active) continue;
        const p = s.smoothP;
        if (p < 0.1) continue;
        const intensity = (p - 0.1) / 0.9;
        const spraySz = 0.5 + brush.maxRadius / 80;
        const count = Math.floor(intensity * 12 * spraySz);
        for (let i = 0; i < count && sprayParticles.length < MAX_SPRAY; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = (1.5 + Math.random() * 5) * intensity * dpr;
          const life = 30 + Math.random() * 70;
          sprayParticles.push({
            x: s.smoothX * dpr, y: s.smoothY * dpr,
            px: s.smoothX * dpr, py: s.smoothY * dpr,
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
            life, maxLife: life,
            size: (0.4 + Math.random() * 2.5) * dpr,
            alpha: 0.2 + Math.random() * 0.6,
            z: 0.2 + Math.random() * 0.8,
          });
        }
      }
    }

    // ── Shared edge sampling for all VFX ──
    const anyVfx = bleedEnabled || growEnabled || flockEnabled;
    if (anyVfx) {
      bleedFrame++;
      if (bleedFrame % 2 === 0) {
        const sw = bleedSample.width, sh = bleedSample.height;
        bsCtx.clearRect(0, 0, sw, sh);
        bsCtx.drawImage(score, 0, 0, sw, sh);
        for (const layer of scoreLayers) bsCtx.drawImage(layer.canvas, 0, 0, sw, sh);
        const img = bsCtx.getImageData(0, 0, sw, sh);
        const px = img.data;

        const attempts = Math.round(80 * intMul);
        for (let a = 0; a < attempts; a++) {
          const sx = Math.floor(Math.random() * sw);
          const sy = Math.floor(Math.random() * sh);
          const idx = (sy * sw + sx) * 4;
          if (px[idx] < 40) continue;

          let isEdge = false;
          let dirX = 0, dirY = 0;
          for (const [ddx, ddy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
            const enx = sx + ddx, eny = sy + ddy;
            if (enx < 0 || enx >= sw || eny < 0 || eny >= sh) { isEdge = true; continue; }
            if (px[(eny * sw + enx) * 4] < 30) { isEdge = true; dirX += ddx; dirY += ddy; }
          }
          if (!isEdge) continue;

          const dirLen = Math.hypot(dirX, dirY) || 1;
          const ndx = dirX / dirLen, ndy = dirY / dirLen;
          const ex = sx * BLEED_SCALE, ey = sy * BLEED_SCALE;

          // Spawn for each active effect
          if (bleedEnabled && bleedParticles.length < MAX_BLEED_PARTICLES) {
            const speed = (0.5 + Math.random() * 1.2) * (1 + intensePressure);
            const life = 80 + Math.random() * 160;
            bleedParticles.push({ x: ex, y: ey, px: ex, py: ey,
              vx: ndx * speed, vy: ndy * speed + 0.15,
              life, maxLife: life, size: (1.5 + Math.random() * 4.5) * dpr * (1 + intensePressure * 0.5),
              alpha: (0.08 + Math.random() * 0.14) * (1 + intensePressure * 2), z: 0.2 + Math.random() * 0.8,
              wobbleFreq: 0.05 + Math.random() * 0.15, wobbleAmp: 0.4 + Math.random() * 1.2,
              wobblePhase: Math.random() * Math.PI * 2 });
          }
          if (growEnabled && growBranches.length < MAX_GROW && Math.random() < 0.3 * intMul) {
            const life = (70 + Math.random() * 140) * (1 + intensePressure * 0.5);
            growBranches.push({ x: ex, y: ey,
              angle: Math.atan2(ndy, ndx), speed: (0.4 + Math.random() * 1.0) * dpr * (1 + intensePressure),
              curvature: (Math.random() - 0.5) * 0.1,
              life, maxLife: life, size: (0.8 + Math.random() * 1.8) * dpr * (1 + intensePressure * 0.5),
              z: 0.2 + Math.random() * 0.8, branchProb: 0.02 + Math.random() * 0.03 });
          }
          if (flockEnabled && flockParticles.length < MAX_FLOCK && Math.random() < 0.4 * intMul) {
            const speed = (1 + Math.random() * 1.5) * dpr;
            const angle = Math.atan2(ndy, ndx) + (Math.random() - 0.5) * 1.0;
            const life = 200 + Math.random() * 400;
            flockParticles.push({ x: ex, y: ey,
              vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
              wander: angle, life, maxLife: life, size: (0.8 + Math.random() * 1.5) * dpr,
              z: 0.2 + Math.random() * 0.8, trail: [{ x: ex, y: ey }] });
          }
        }
      }
    }

    // ── Bleed: watercolor diffusion ──
    if (bleedEnabled && bleedParticles.length > 0) {
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.fillStyle = drawColor;
      sctx.strokeStyle = drawColor;
      sctx.lineCap = 'round';
      for (let i = bleedParticles.length - 1; i >= 0; i--) {
        const p = bleedParticles[i];
        p.px = p.x; p.py = p.y;
        p.wobblePhase += p.wobbleFreq;
        const zW = 0.5 + p.z * 0.5;
        p.vx += (Math.random() - 0.5) * 0.25 + Math.sin(p.wobblePhase) * p.wobbleAmp * 0.08 * zW;
        p.vy += (Math.random() - 0.5) * 0.25 + Math.cos(p.wobblePhase * 1.3) * p.wobbleAmp * 0.06 * zW;
        p.vy += 0.015 * (0.3 + p.z * 0.7); p.vx *= 0.97; p.vy *= 0.97;
        p.x += p.vx; p.y += p.vy; p.life--;
        if (p.life <= 0 || p.x < -50) { bleedParticles.splice(i, 1); continue; }
        const lifePct = p.life / p.maxLife;
        sctx.globalAlpha = p.alpha * lifePct * lifePct * (0.3 + p.z * 0.7);
        sctx.lineWidth = p.size * (0.3 + lifePct * 0.7) * (0.4 + p.z * 0.6);
        sctx.beginPath(); sctx.moveTo(p.px, p.py); sctx.lineTo(p.x, p.y); sctx.stroke();
        if (Math.random() < 0.07 && bleedParticles.length < MAX_BLEED_PARTICLES) {
          const ba = Math.atan2(p.vy, p.vx) + (Math.random() - 0.5) * Math.PI * 0.8;
          const bs = 0.2 + Math.random() * 0.5;
          const bl = Math.floor(p.life * 0.5);
          bleedParticles.push({ x: p.x, y: p.y, px: p.x, py: p.y,
            vx: Math.cos(ba) * bs, vy: Math.sin(ba) * bs + 0.06,
            life: bl, maxLife: bl, size: p.size * 0.7, alpha: p.alpha * 0.7,
            z: p.z * (0.8 + Math.random() * 0.2),
            wobbleFreq: 0.06 + Math.random() * 0.12, wobbleAmp: 0.3 + Math.random() * 0.8,
            wobblePhase: Math.random() * Math.PI * 2 });
        }
      }
      sctx.restore();
    }

    // ── Grow: branching vine tendrils ──
    if (growEnabled && growBranches.length > 0) {
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.strokeStyle = drawColor;
      sctx.lineCap = 'round';
      for (let i = growBranches.length - 1; i >= 0; i--) {
        const g = growBranches[i];
        const px = g.x, py = g.y;
        g.angle += g.curvature;
        g.curvature += (Math.random() - 0.5) * 0.02;
        g.curvature *= 0.98;
        g.x += Math.cos(g.angle) * g.speed;
        g.y += Math.sin(g.angle) * g.speed;
        g.life--;
        if (g.life <= 0 || g.x < -20) { growBranches.splice(i, 1); continue; }
        const lifePct = g.life / g.maxLife;
        sctx.globalAlpha = Math.min(lifePct * 3, 1) * lifePct * lifePct * 0.6 * (0.3 + g.z * 0.7);
        sctx.lineWidth = g.size * (0.2 + lifePct * 0.6) * (0.4 + g.z * 0.6);
        sctx.beginPath(); sctx.moveTo(px, py); sctx.lineTo(g.x, g.y); sctx.stroke();
        if (Math.random() < g.branchProb && growBranches.length < MAX_GROW && lifePct > 0.2) {
          const side = Math.random() < 0.5 ? 1 : -1;
          const ba = g.angle + side * (Math.PI / 6 + Math.random() * Math.PI / 6);
          const cl = Math.floor(g.life * (0.3 + Math.random() * 0.4));
          growBranches.push({ x: g.x, y: g.y, angle: ba,
            speed: g.speed * (0.6 + Math.random() * 0.3),
            curvature: (Math.random() - 0.5) * 0.08,
            life: cl, maxLife: cl, size: g.size * (0.5 + Math.random() * 0.3),
            z: g.z * (0.85 + Math.random() * 0.15),
            branchProb: g.branchProb * 0.4 });
          g.branchProb *= 0.5;
        }
      }
      sctx.restore();
    }

    // ── Spray: radial energy particles ──
    if (sprayParticles.length > 0) {
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.strokeStyle = drawColor;
      sctx.lineCap = 'round';
      for (let i = sprayParticles.length - 1; i >= 0; i--) {
        const p = sprayParticles[i];
        p.px = p.x; p.py = p.y;
        p.vx *= 0.96; p.vy *= 0.96;
        p.vy += 0.03;
        p.x += p.vx; p.y += p.vy;
        p.life--;
        if (p.life <= 0 || p.x < -30) { sprayParticles.splice(i, 1); continue; }
        const lifePct = p.life / p.maxLife;
        sctx.globalAlpha = p.alpha * lifePct * (0.3 + p.z * 0.7);
        sctx.lineWidth = p.size * (0.3 + lifePct * 0.7) * (0.4 + p.z * 0.6);
        sctx.beginPath();
        sctx.moveTo(p.px, p.py);
        sctx.lineTo(p.x, p.y);
        sctx.stroke();
      }
      sctx.restore();
    }

    // ── Flock: boids simulation (update only, drawing is on display canvas) ──
    if (flockEnabled && flockParticles.length > 0) {
      const SEP_R = 18 * dpr, ALI_R = 50 * dpr, COH_R = 80 * dpr;
      const MAX_SPD = 2.5 * dpr, MAX_F = 0.15 * dpr;
      const TRAIL_LEN = 20;
      for (let i = flockParticles.length - 1; i >= 0; i--) {
        const b = flockParticles[i]; b.life--;
        if (b.life <= 0 || b.x < -40) { flockParticles.splice(i, 1); continue; }
        let sx = 0, sy = 0, sc = 0, ax = 0, ay = 0, ac = 0, cx = 0, cy = 0, cc = 0;
        for (let j = 0; j < flockParticles.length; j++) {
          if (i === j) continue;
          const o = flockParticles[j];
          const dz = Math.abs(b.z - o.z);
          if (dz > 0.3) continue;
          const zInf = 1 - dz / 0.3;
          const ddx = b.x - o.x, ddy = b.y - o.y, d = Math.hypot(ddx, ddy);
          if (d < SEP_R && d > 0) { sx += ddx / d / d * zInf; sy += ddy / d / d * zInf; sc++; }
          if (d < ALI_R) { ax += o.vx * zInf; ay += o.vy * zInf; ac++; }
          if (d < COH_R) { cx += o.x * zInf; cy += o.y * zInf; cc++; }
        }
        b.wander += (Math.random() - 0.5) * 0.25;
        let fx = Math.cos(b.wander) * 0.05 + (Math.random() - 0.5) * 0.3, fy = Math.sin(b.wander) * 0.05 + (Math.random() - 0.5) * 0.3;
        if (sc > 0) { const l = Math.hypot(sx, sy) || 1; fx += sx / l * 1.8; fy += sy / l * 1.8; }
        if (ac > 0) { ax /= ac; ay /= ac; const l = Math.hypot(ax, ay) || 1; fx += (ax / l * MAX_SPD - b.vx) * 0.05; fy += (ay / l * MAX_SPD - b.vy) * 0.05; }
        if (cc > 0) { cx = cx / cc - b.x; cy = cy / cc - b.y; const l = Math.hypot(cx, cy) || 1; fx += cx / l * 0.04; fy += cy / l * 0.04; }
        const fl = Math.hypot(fx, fy); if (fl > MAX_F) { fx = fx / fl * MAX_F; fy = fy / fl * MAX_F; }
        b.vx += fx; b.vy += fy;
        const spd = Math.hypot(b.vx, b.vy); if (spd > MAX_SPD) { b.vx = b.vx / spd * MAX_SPD; b.vy = b.vy / spd * MAX_SPD; }
        b.x += b.vx; b.y += b.vy;
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > TRAIL_LEN) b.trail.shift();
      }
    }

    // Pressure-driven screen shake
    if (shakeEnabled) {
      let maxP = 0;
      for (const s of strokes.values()) {
        if (s.active) maxP = Math.max(maxP, s.smoothP);
      }
      const shakeSz = 0.5 + brush.maxRadius / 80;
      shakeIntensity += (maxP * 24 * dpr * shakeSz - shakeIntensity) * 0.3;
    } else {
      shakeIntensity *= 0.85;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const shakeOX = shakeIntensity > 0.5 ? (Math.random() - 0.5) * 2 * shakeIntensity : 0;
    const shakeOY = shakeIntensity > 0.5 ? (Math.random() - 0.5) * 2 * shakeIntensity : 0;
    ctx.drawImage(score, shakeOX, shakeOY);
    for (const layer of scoreLayers) {
      ctx.drawImage(layer.canvas, shakeOX, shakeOY);
    }

    ctx.restore();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.strokeStyle = `rgba(255,255,255,${trackLineOpacity})`;
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

      ctx.fillStyle = drawColor;
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

          const rzS = 0.4 + runner.z * 0.6;
          const rzA = 0.3 + runner.z * 0.7;

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
            ctx.globalAlpha = fade * 0.4 * rzA;
            ctx.beginPath();
            ctx.arc(tx, ty, runner.size * fade * rzS, 0, Math.PI * 2);
            ctx.fill();
          }

          // Soft glow halo
          ctx.globalAlpha = 0.15 * rzA;
          ctx.beginPath();
          ctx.arc(rx, ry, runner.size * 5 * rzS, 0, Math.PI * 2);
          ctx.fill();

          // Bright core
          ctx.globalAlpha = 0.9 * rzA;
          ctx.beginPath();
          ctx.arc(rx, ry, runner.size * rzS, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Flock: draw trails on display canvas (tail fades, head bright)
    if (flockEnabled && flockParticles.length > 0) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = drawColor;
      ctx.lineCap = 'round';
      for (const b of flockParticles) {
        const t = b.trail;
        if (t.length < 2) continue;
        const lp = b.life / b.maxLife;
        const fzA = 0.3 + b.z * 0.7;
        const fzS = 0.4 + b.z * 0.6;
        const headAlpha = Math.min(lp * 5, 1) * lp * 0.8 * fzA;
        for (let k = 1; k < t.length; k++) {
          const fade = k / t.length; // 0 at tail, 1 at head
          ctx.globalAlpha = headAlpha * fade * fade;
          ctx.lineWidth = b.size * (0.2 + fade * 0.8) * fzS;
          ctx.beginPath();
          ctx.moveTo(t[k - 1].x, t[k - 1].y);
          ctx.lineTo(t[k].x, t[k].y);
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
    }

    // Constellation: connecting lines between nearby star points
    if (constellationEnabled && constellationStars.length > 1) {
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = 0.5;
      const stars = constellationStars;
      const cd2 = STAR_CONNECT_DIST * STAR_CONNECT_DIST;
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const dx = stars[i].x - stars[j].x, dy = stars[i].y - stars[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < cd2) {
            const d = Math.sqrt(d2);
            const fade = 1 - d / STAR_CONNECT_DIST;
            ctx.globalAlpha = fade * fade * 0.25;
            ctx.beginPath();
            ctx.moveTo(stars[i].x, stars[i].y);
            ctx.lineTo(stars[j].x, stars[j].y);
            ctx.stroke();
          }
        }
      }
      // Draw star dots on overlay
      ctx.fillStyle = drawColor;
      for (const s of stars) {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() * 0.003 + s.x * 0.1);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Pulse: breathing glow on all marks
    if (pulseEnabled) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      const pulseA = 0.03 + 0.03 * Math.sin(performance.now() * 0.0008);
      ctx.globalAlpha = pulseA;
      ctx.drawImage(score, 0, 0);
      for (const layer of scoreLayers) ctx.drawImage(layer.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    brushDot.style.background = drawColor;
  }

  setupSlider('vs-size', 'vsf-size', 0.5, 80, brush.maxRadius, v => {
    brush.maxRadius = v;
    updatePreview();
  });

  setupSlider('vs-speed', 'vsf-speed', 0, 3, brush.scrollSpeed, v => {
    brush.scrollSpeed = v;
  });

  setupSlider('vs-opacity', 'vsf-opacity', 0.05, 1, brush.opacity, v => {
    brush.opacity = v;
    updatePreview();
  });

  setupSlider('vs-lines', 'vsf-lines', 0, 0.5, trackLineOpacity, v => {
    trackLineOpacity = v;
  });

  // Color palette
  const swatches = document.querySelectorAll('.cp-swatch');
  swatches.forEach(sw => {
    sw.style.background = sw.dataset.color;
    sw.addEventListener('click', e => {
      e.stopPropagation();
      drawColor = sw.dataset.color;
      swatches.forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      buildDab();
      updatePreview();
    });
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
    const types = ['normal', 'splatter', 'particle', 'silk'];
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
    brush.opacity = 1.0;
    drawColor = '#ffffff';
    swatches.forEach(s => s.classList.toggle('active', s.dataset.color === '#ffffff'));
    document.getElementById('vsf-size').style.height = '100%';
    document.getElementById('vsf-opacity').style.height = '100%';
    buildDab();
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
    baseSctx.save();
    baseSctx.setTransform(1, 0, 0, 1, 0, 0);
    baseSctx.clearRect(0, 0, score.width, score.height);
    baseSctx.restore();
    for (const layer of scoreLayers) {
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      layer.ctx.restore();
    }
    mirrorQueue.length = 0;
    mirrorLastStamp[0].has = false;
    mirrorLastStamp[1].has = false;
    flowPaths.length = 0;
    bleedParticles.length = 0;
    growBranches.length = 0;
    flockParticles.length = 0;
    sprayParticles.length = 0;
    constellationStars.length = 0;
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

  const btnHue = document.getElementById('btn-hue');
  btnHue.addEventListener('click', () => {
    mirrorHueEnabled = !mirrorHueEnabled;
    btnHue.classList.toggle('active', mirrorHueEnabled);
  });

  const btnWild = document.getElementById('btn-wild');
  btnWild.addEventListener('click', () => {
    mirrorWild = !mirrorWild;
    btnWild.classList.toggle('active', mirrorWild);
  });

  const btnConstellation = document.getElementById('btn-constellation');
  btnConstellation.addEventListener('click', () => {
    constellationEnabled = !constellationEnabled;
    btnConstellation.classList.toggle('active', constellationEnabled);
  });

  const btnPulse = document.getElementById('btn-pulse');
  btnPulse.addEventListener('click', () => {
    pulseEnabled = !pulseEnabled;
    btnPulse.classList.toggle('active', pulseEnabled);
  });

  const btnParallax = document.getElementById('btn-parallax');
  btnParallax.addEventListener('click', () => {
    parallaxEnabled = !parallaxEnabled;
    btnParallax.classList.toggle('active', parallaxEnabled);
  });

  const btnShake = document.getElementById('btn-shake');
  btnShake.addEventListener('click', () => {
    shakeEnabled = !shakeEnabled;
    btnShake.classList.toggle('active', shakeEnabled);
  });

  const btnIntense = document.getElementById('btn-intense');
  btnIntense.addEventListener('click', () => {
    intenseEnabled = !intenseEnabled;
    btnIntense.classList.toggle('active', intenseEnabled);
  });

  const btnSpray = document.getElementById('btn-spray');
  btnSpray.addEventListener('click', () => {
    sprayEnabled = !sprayEnabled;
    btnSpray.classList.toggle('active', sprayEnabled);
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

  const btnGrow = document.getElementById('btn-grow');
  btnGrow.addEventListener('click', () => {
    growEnabled = !growEnabled;
    btnGrow.classList.toggle('active', growEnabled);
  });

  const btnFlock = document.getElementById('btn-flock');
  btnFlock.addEventListener('click', () => {
    flockEnabled = !flockEnabled;
    btnFlock.classList.toggle('active', flockEnabled);
  });

  let paused = false;
  let savedSpeed = brush.scrollSpeed;
  const btnPause = document.getElementById('btn-pause');
  btnPause.addEventListener('click', () => {
    paused = !paused;
    if (paused) {
      savedSpeed = brush.scrollSpeed;
      brush.scrollSpeed = 0;
      btnPause.textContent = 'Play';
      btnPause.classList.add('active');
    } else {
      brush.scrollSpeed = savedSpeed;
      btnPause.textContent = 'Pause';
      btnPause.classList.remove('active');
    }
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
   *  Init
   * ════════════════════════════════════════════════ */
  window.addEventListener('resize', resize);
  resize();
  buildDab();
  requestAnimationFrame(frame);
})();
