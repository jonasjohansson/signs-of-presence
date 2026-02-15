(() => {
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
  let lanes = [];
  let trackBounds = [];
  let paused = false;

  const brush = {
    maxRadius: 100,
    opacity: 1.0,
    streamline: 0.30,
    pressureCurve: 0.20,
    pressureToSize: 1.00,
    pressureToOpac: 0.15,
    speedThinning: 0.30,
    minSizePct: 0.01,
    softness: 0.15,
    tiltInfluence: 0.70,
    scatterRadius: 0,
    scatterDensity: 4,
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

  function stamp(x, y, pressure, velocity, angle, aspect) {
    const r = computeRadius(pressure, velocity);
    const alpha = computeAlpha(pressure);

    drawDab(x, y, r, alpha, angle, aspect);

    if (brush.scatterRadius > 0) {
      const spread = r * brush.scatterRadius * 3;
      for (let s = 0; s < brush.scatterDensity; s++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * spread;
        const sr = r * (0.3 + Math.random() * 0.7);
        const sa = alpha * (0.4 + Math.random() * 0.6);
        drawDab(x + Math.cos(a) * d, y + Math.sin(a) * d, sr, sa, angle, aspect);
      }
    }
  }

  function strokeSegment(x0, y0, p0, x1, y1, p1, vel, angle, aspect) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) { stamp(x1, y1, p1, vel, angle, aspect); return; }

    const avgP = (p0 + p1) / 2;
    const pMapped = Math.pow(Math.max(avgP, 0.001), brush.pressureCurve);
    const avgR = brush.maxRadius * Math.max(brush.minSizePct, 1 - brush.pressureToSize * (1 - pMapped));
    const spacing = Math.max(0.5, avgR * (0.18 + brush.softness * 0.12));
    const n = Math.max(1, Math.ceil(dist / spacing));

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      stamp(x0 + dx * t, y0 + dy * t, p0 + (p1 - p0) * t, vel, angle, aspect);
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

    if (x < W * 0.75) return;

    for (const tb of trackBounds) {
      if (y >= tb.top && y <= tb.bot) {
        stroke.trackTop = tb.top;
        stroke.trackBot = tb.bot;
        break;
      }
    }

    stroke.active = true;
    const cy = Math.max(stroke.trackTop, Math.min(stroke.trackBot, y));
    stroke.smoothX = stroke.prevX = x;
    stroke.smoothY = stroke.prevY = cy;
    stroke.smoothP = stroke.prevP = p;
    stroke.lastTime = performance.now();
    stroke.velocity = 0;
    stroke.smTiltCos = 0;
    stroke.smTiltSin = 0;
    stroke.smAspect = 1;
    computeTilt(e);

    stamp(x, cy, p, 0, stroke.angle, stroke.aspect);
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
      const ry = Math.max(stroke.trackTop, Math.min(stroke.trackBot, ce.clientY));
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

      strokeSegment(
        stroke.prevX, stroke.prevY, stroke.prevP,
        stroke.smoothX, stroke.smoothY, stroke.smoothP,
        stroke.velocity, stroke.angle, stroke.aspect
      );
      stroke.prevX = stroke.smoothX;
      stroke.prevY = stroke.smoothY;
      stroke.prevP = stroke.smoothP;
    }
  }

  function onUp(e) {
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
    if (!paused && brush.scrollSpeed > 0) {
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

    if (trackBounds.length) {
      // Non-track areas
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(0, 0, W, trackBounds[0].top);
      ctx.fillRect(0, trackBounds[0].bot, W, trackBounds[1].top - trackBounds[0].bot);
      ctx.fillRect(0, trackBounds[1].bot, W, trackBounds[2].top - trackBounds[1].bot);
      ctx.fillRect(0, trackBounds[2].bot, W, H - trackBounds[2].bot);

      // Tint each track in the draw zone
      const trackColors = [
        'rgb(80,120,200)',
        'rgb(120,200,80)',
        'rgb(200,100,80)',
      ];
      for (let i = 0; i < 3; i++) {
        const tb = trackBounds[i];
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = trackColors[i];
        ctx.fillRect(W * 0.75, tb.top, W * 0.25, tb.bot - tb.top);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = trackColors[i];
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(W * 0.75, tb.top);
        ctx.lineTo(W, tb.top);
        ctx.moveTo(W * 0.75, tb.bot);
        ctx.lineTo(W, tb.bot);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    for (const y of lanes) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W * 0.75, 0);
    ctx.lineTo(W * 0.75, H);
    ctx.stroke();

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

  setupSlider('vs-size', 'vsf-size', 1, 300, brush.maxRadius, v => {
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

  document.getElementById('bp-close').addEventListener('click', () => {
    brushPanel.classList.remove('open');
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
  bindRange('bp-pcurve',  'bpv-pcurve',  v => { brush.pressureCurve = v / 100; });
  bindRange('bp-psize',   'bpv-psize',   v => { brush.pressureToSize = v / 100; });
  bindRange('bp-popac',   'bpv-popac',   v => { brush.pressureToOpac = v / 100; });
  bindRange('bp-vel',     'bpv-vel',     v => { brush.speedThinning = v / 100; });
  bindRange('bp-min',     'bpv-min',     v => { brush.minSizePct = v / 100; });
  bindRange('bp-soft',    'bpv-soft',    v => { brush.softness = v / 100; buildDab(); });
  bindRange('bp-tilt',    'bpv-tilt',    v => { brush.tiltInfluence = v / 100; });
  bindRange('bp-scatter', 'bpv-scatter', v => { brush.scatterRadius = v / 100; });
  bindRange('bp-sdens',   'bpv-sdens',   v => { brush.scatterDensity = Math.round(v); });

  /* ════════════════════════════════════════════════
   *  UI: action buttons
   * ════════════════════════════════════════════════ */
  document.getElementById('btn-clear').addEventListener('click', () => {
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, score.width, score.height);
    sctx.restore();
  });

  const btnPause = document.getElementById('btn-pause');
  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.classList.toggle('active', paused);
    btnPause.innerHTML = paused ? '&#9654;' : '&#9646;&#9646;';
  });

  /* ════════════════════════════════════════════════
   *  Init
   * ════════════════════════════════════════════════ */
  window.addEventListener('resize', resize);
  resize();
  buildDab();
  requestAnimationFrame(frame);
})();
