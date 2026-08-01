/* Aim 3D for Maybaah's Arcade.
   A gridshot: three spheres on a wall ten metres out, one replaced every time
   you break one, thirty to clear. The mouse turns a camera rather than moving a
   cursor, so a run is a list of the angles you fired at: the gap since the last
   shot and the yaw and pitch of the shot itself, in thousandths of a degree.

   Sensitivity never leaves the browser. It only decides how many degrees a
   mouse count is worth, and only the resulting angles are submitted, so no
   setting can buy a score. */

(() => {
  "use strict";

  /* ── the engine ──────────────────────────────────────────────────────────
     Everything between these markers is duplicated, byte for byte, in
     site/worker/src/index.js. Drift means the page calls a shot the referee
     rebuilds differently, and every submission stops verifying. */

  const AIM3_ROUNDS = 30;
  const AIM3_POOL = 3;
  const AIM3_DIST = 10;
  const AIM3_HALF_W = 4.5;
  const AIM3_HALF_H = 2.5;
  const AIM3_PENALTY = 250;
  const AIM3_MAX_MISSES = 200;
  const AIM3_MIN_GAP = 40;
  const AIM3_MAX_GAP = 20000;
  const AIM3_PITCH_OFFSET = 90000;
  const AIM3_YAW_SPAN = 360000;
  /* The silhouette is where a sine's last bit can differ between two builds of
     the same engine, so a shot inside this sliver of the edge is taken as the
     page called it. It is a millionth of the radius: nothing to aim with. */
  const AIM3_EPS = 1e-6;

  const AIM3_MODES = {
    easy: { r: 0.55, spread: 3.2 },
    medium: { r: 0.35, spread: 4.0 },
    hard: { r: 0.22, spread: 5.0 },
  };

  function aim3Mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Spheres are drawn one at a time as the pool needs them, each pushed clear
     of the ones already up, so the generator is consumed in hit order and both
     sides walk it the same way. The reject loop is bounded, so it always ends. */
  function aim3Draw(active, rnd, cfg) {
    const gap = cfg.r * cfg.spread;
    let x = 0, y = 0;
    for (let t = 0; t < 24; t++) {
      x = -AIM3_HALF_W + rnd() * (2 * AIM3_HALF_W);
      y = -AIM3_HALF_H + rnd() * (2 * AIM3_HALF_H);
      let clear = true;
      for (let i = 0; i < active.length; i++) {
        const dx = x - active[i].x, dy = y - active[i].y;
        if (dx * dx + dy * dy < gap * gap) { clear = false; break; }
      }
      if (clear) break;
    }
    return { x, y, z: -AIM3_DIST, r: cfg.r };
  }

  function aim3New(mode, seed) {
    const cfg = AIM3_MODES[mode];
    const rnd = aim3Mulberry32(seed >>> 0);
    const active = [];
    for (let i = 0; i < AIM3_POOL; i++) active.push(aim3Draw(active, rnd, cfg));
    return { cfg, rnd, active, hits: 0, misses: 0, timeMs: 0 };
  }

  /* Yaw is measured from straight ahead, which is -Z, and turns right. Pitch
     rides the offset so the tape never has to carry a sign. */
  function aim3Dir(yawMdeg, pitchMdeg) {
    const yaw = (yawMdeg / 1000) * Math.PI / 180;
    const pitch = ((pitchMdeg - AIM3_PITCH_OFFSET) / 1000) * Math.PI / 180;
    const cp = Math.cos(pitch);
    return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  }

  /* One ray against the whole pool. `struck` is the nearest sphere the ray
     actually enters; `nearestRatio` is how close the ray came to the closest
     one, in units of its radius, which is what the sliver above is measured in. */
  function aim3Resolve(active, dir) {
    let struck = -1, strikeT = Infinity, nearest = -1, nearestRatio = Infinity;
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      const t = s.x * dir.x + s.y * dir.y + s.z * dir.z;
      if (t <= 0) continue;
      const px = s.x - dir.x * t, py = s.y - dir.y * t, pz = s.z - dir.z * t;
      const ratio = (px * px + py * py + pz * pz) / (s.r * s.r);
      if (ratio <= 1 && t < strikeT) { strikeT = t; struck = i; }
      if (ratio < nearestRatio) { nearestRatio = ratio; nearest = i; }
    }
    return { struck, nearest, nearestRatio };
  }

  /* `claim` is null on the page, which decides the shot, and the page's own
     mark in the Worker, which only has to agree with it. */
  function aim3Apply(st, dir, claim) {
    const r = aim3Resolve(st.active, dir);
    let hit = r.struck >= 0;
    let index = r.struck;
    if (claim !== null && claim !== hit) {
      if (r.nearestRatio < 1 - AIM3_EPS || r.nearestRatio > 1 + AIM3_EPS) {
        return { ok: false, reason: "shot log does not match the run" };
      }
      hit = claim;
      index = claim ? r.nearest : -1;
    }
    if (hit) {
      st.hits++;
      st.active.splice(index, 1);
      st.active.push(aim3Draw(st.active, st.rnd, st.cfg));
    } else {
      st.misses++;
    }
    return { ok: true, hit };
  }

  const AIM3_TAPE_RE = /^(\d{1,5}[hm]\d{1,6},\d{1,6};)*$/;

  function aim3Encode(shots) {
    return shots.map((s) => s.dt + (s.hit ? "h" : "m") + s.yaw + "," + s.pitch + ";").join("");
  }

  function aim3Decode(tape) {
    if (typeof tape !== "string" || tape.length > 24 * (AIM3_ROUNDS + AIM3_MAX_MISSES)) return null;
    if (!AIM3_TAPE_RE.test(tape)) return null;
    const shots = [];
    const re = /(\d{1,5})([hm])(\d{1,6}),(\d{1,6});/g;
    let m;
    while ((m = re.exec(tape))) {
      shots.push({ dt: +m[1], hit: m[2] === "h", yaw: +m[3], pitch: +m[4] });
    }
    return shots;
  }

  /* The clock is the sum of the gaps, first target to thirtieth kill, and every
     miss buys a quarter second. Spraying the wall is slower than aiming at it. */
  function aim3Replay(mode, seed, shots) {
    if (!AIM3_MODES[mode]) return { ok: false, reason: "bad mode" };
    if (!Array.isArray(shots) || shots.length > AIM3_ROUNDS + AIM3_MAX_MISSES) {
      return { ok: false, reason: "bad shot log" };
    }
    const st = aim3New(mode, seed);
    for (const s of shots) {
      if (st.hits >= AIM3_ROUNDS) return { ok: false, reason: "the tape runs past the last target" };
      if (s.dt < AIM3_MIN_GAP || s.dt > AIM3_MAX_GAP) return { ok: false, reason: "impossible shot timing" };
      if (s.yaw >= AIM3_YAW_SPAN || s.pitch > 2 * AIM3_PITCH_OFFSET) {
        return { ok: false, reason: "shot fired from an impossible angle" };
      }
      st.timeMs += s.dt;
      const shot = aim3Apply(st, aim3Dir(s.yaw, s.pitch), s.hit);
      if (!shot.ok) return { ok: false, reason: shot.reason };
    }
    if (st.hits < AIM3_ROUNDS) return { ok: false, reason: "that run never cleared every target" };
    return {
      ok: true,
      timeMs: st.timeMs,
      misses: st.misses,
      acc: Math.round((AIM3_ROUNDS / (AIM3_ROUNDS + st.misses)) * 100),
      avg: Math.round(st.timeMs / AIM3_ROUNDS),
      score: st.timeMs + st.misses * AIM3_PENALTY,
    };
  }

  /* ── end of the engine ── */

  const stage = document.getElementById("stage");
  const cv = document.getElementById("screen");
  const ctx = cv.getContext("2d");
  const overlay = document.getElementById("overlay");
  const ovTitle = document.getElementById("ov-title");
  const ovSub = document.getElementById("ov-sub");
  const ovStart = document.getElementById("ov-start");
  const elRound = document.getElementById("h-round");
  const elTime = document.getElementById("h-time");
  const elMisses = document.getElementById("h-misses");
  const elAvg = document.getElementById("h-avg");
  const elBest = document.getElementById("h-best");
  const btnNew = document.getElementById("btn-new");
  const btnSound = document.getElementById("btn-sound");
  const btnFull = document.getElementById("btn-full");
  const submitWrap = document.getElementById("submit-run");
  const runName = document.getElementById("run-name");
  const runStatus = document.getElementById("run-status");
  const btnSubmit = document.getElementById("btn-submit-run");
  const selPreset = document.getElementById("set-preset");
  const inValue = document.getElementById("set-value");
  const inDpi = document.getElementById("set-dpi");
  const inFov = document.getElementById("set-fov");
  const labValue = document.getElementById("set-value-label");
  const setOut = document.getElementById("set-out");

  /* The backing store follows the element, so full screen is drawn at the size
     it is shown at rather than a 960 wide picture blown up. */
  let W = cv.width, H = cv.height;
  const PITCH_LIMIT = 80;
  const MAX_BACKING = 2560;

  let mode = "easy";
  let S = null;
  let cam = { yaw: 0, pitch: 0 };
  let locked = false;

  /* ── settings ────────────────────────────────────────────────────────────
     Kept in the one arcade store rather than a key of this game's own, so the
     site still has a single place where a player's things live. None of it is
     ever submitted. */

  const DEFAULTS = { preset: "cm360", value: 30, dpi: 800, fov: 103 };
  let cfg = Object.assign({}, DEFAULTS);

  const VALUE_LABEL = {
    cm360: "cm / 360",
    cs: "CS sens",
    valorant: "Valorant sens",
    deg: "deg / count",
  };

  function loadCfg() {
    const saved = (window.Arcade && Arcade.prefs) ? Arcade.prefs("aim3d") : null;
    cfg = Object.assign({}, DEFAULTS, saved || {});
    if (!VALUE_LABEL[cfg.preset]) cfg.preset = DEFAULTS.preset;
    cfg.value = clamp(Number(cfg.value) || DEFAULTS.value, 0.001, 1000);
    cfg.dpi = clamp(Math.round(Number(cfg.dpi) || DEFAULTS.dpi), 100, 32000);
    cfg.fov = clamp(Math.round(Number(cfg.fov) || DEFAULTS.fov), 60, 130);
  }

  function saveCfg() {
    if (window.Arcade && Arcade.setPrefs) Arcade.setPrefs("aim3d", cfg);
  }

  /* The one number the mouse actually needs: how far the camera turns per count
     the browser reports. Every preset is a different way of writing it down. */
  function degPerCount() {
    if (cfg.preset === "cs") return 0.022 * cfg.value;
    if (cfg.preset === "valorant") return 0.07 * cfg.value;
    if (cfg.preset === "deg") return cfg.value;
    const counts = (cfg.value / 2.54) * cfg.dpi;
    return counts > 0 ? 360 / counts : 0.022;
  }

  function paintSettings() {
    selPreset.value = cfg.preset;
    inValue.value = cfg.value;
    inDpi.value = cfg.dpi;
    inFov.value = cfg.fov;
    labValue.textContent = VALUE_LABEL[cfg.preset];
    const dpc = degPerCount();
    const cm360 = dpc > 0 ? (360 / dpc / cfg.dpi) * 2.54 : 0;
    setOut.textContent = dpc.toFixed(4) + " deg/count · " + cm360.toFixed(1) +
      " cm/360 at " + cfg.dpi + " DPI · " + cfg.fov + "° fov";
  }

  function readSettings() {
    cfg.preset = VALUE_LABEL[selPreset.value] ? selPreset.value : DEFAULTS.preset;
    cfg.value = clamp(Number(inValue.value) || DEFAULTS.value, 0.001, 1000);
    cfg.dpi = clamp(Math.round(Number(inDpi.value) || DEFAULTS.dpi), 100, 32000);
    cfg.fov = clamp(Math.round(Number(inFov.value) || DEFAULTS.fov), 60, 130);
    saveCfg();
    paintSettings();
  }

  /* ── sound ── */
  let audio = null;
  let muted = false;

  function blip(from, to, dur, type, level) {
    if (muted) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audio) audio = new Ctx();
      if (audio.state === "suspended") {
        const back = audio.resume();
        if (back && back.catch) back.catch(() => {});
      }
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + dur);
      amp.gain.setValueAtTime(level, t);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(amp);
      amp.connect(audio.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch (_) {}
  }

  const hitSound = () => blip(760, 1600, 0.06, "triangle", 0.16);
  const missSound = () => blip(220, 70, 0.13, "sawtooth", 0.1);

  function setMuted(next) {
    muted = next;
    btnSound.setAttribute("aria-pressed", String(!muted));
    btnSound.textContent = muted ? "♪ muted" : "♪ sound";
  }

  /* ── camera and drawing ── */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function token(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  let paint = { accent: "#e8e8e8", border: "#2a2a2a", surface: "#111111", muted: "#555555" };

  function readTokens() {
    paint = {
      accent: token("--accent", "#e8e8e8"),
      border: token("--border", "#2a2a2a"),
      surface: token("--bg-surface", "#111111"),
      muted: token("--text-muted", "#555555"),
    };
  }

  function basis() {
    const f = aim3Dir(yawMdeg(), pitchMdeg());
    /* world up is +Y, so right is forward crossed with it and up closes the set */
    const right = { x: -f.z, y: 0, z: f.x };
    const len = Math.hypot(right.x, right.z) || 1;
    right.x /= len; right.z /= len;
    const up = {
      x: right.y * f.z - right.z * f.y,
      y: right.z * f.x - right.x * f.z,
      z: right.x * f.y - right.y * f.x,
    };
    return { f, right, up };
  }

  function project(p, b, focal) {
    const depth = p.x * b.f.x + p.y * b.f.y + p.z * b.f.z;
    if (depth <= 0.05) return null;
    const sx = p.x * b.right.x + p.y * b.right.y + p.z * b.right.z;
    const sy = p.x * b.up.x + p.y * b.up.y + p.z * b.up.z;
    return { x: W / 2 + (sx / depth) * focal, y: H / 2 - (sy / depth) * focal, depth };
  }

  function fitCanvas() {
    const shown = cv.getBoundingClientRect().width;
    if (!shown) return;
    const dpr = window.devicePixelRatio || 1;
    /* never below the size the view was drawn for, or a small window would be
       a coarser picture than the fixed canvas it replaced */
    const want = clamp(Math.round(shown * dpr), 960, MAX_BACKING);
    const wide = want - (want % 2);
    const tall = Math.round((wide * 9) / 16);
    if (wide === cv.width && tall === cv.height) return;
    cv.width = wide;
    cv.height = tall;
    W = wide;
    H = tall;
  }

  /* In full screen the page's own row of numbers is gone, so the same figures
     are painted into the corner of the view. */
  function drawHud() {
    if (!document.fullscreenElement || !S) return;
    const scale = W / 960;
    const pad = Math.round(18 * scale);
    ctx.font = "500 " + Math.round(15 * scale) + "px 'Geist Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = paint.muted;
    const clock = S.result ? S.result.score : (S.running ? performance.now() - S.t0 : 0);
    ctx.fillText(
      S.st.hits + "/" + AIM3_ROUNDS + "   " + fmt(clock) + "   " + S.st.misses +
      (S.st.misses === 1 ? " miss" : " misses"),
      pad, pad + Math.round(12 * scale)
    );
  }

  function draw() {
    fitCanvas();
    const b = basis();
    const focal = (W / 2) / Math.tan((cfg.fov * Math.PI / 180) / 2);
    /* every line and glyph is measured against the 960 wide view it was drawn
       for, so full screen is the same picture rather than a thinner one */
    const k = W / 960;

    ctx.fillStyle = paint.surface;
    ctx.fillRect(0, 0, W, H);

    // the wall the spheres sit on, drawn as its own grid so distance reads
    ctx.strokeStyle = paint.border;
    ctx.lineWidth = k;
    const step = 1.5;
    ctx.beginPath();
    for (let x = -AIM3_HALF_W; x <= AIM3_HALF_W + 0.001; x += step) {
      const a = project({ x, y: -AIM3_HALF_H, z: -AIM3_DIST }, b, focal);
      const c = project({ x, y: AIM3_HALF_H, z: -AIM3_DIST }, b, focal);
      if (a && c) { ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); }
    }
    for (let y = -AIM3_HALF_H; y <= AIM3_HALF_H + 0.001; y += step) {
      const a = project({ x: -AIM3_HALF_W, y, z: -AIM3_DIST }, b, focal);
      const c = project({ x: AIM3_HALF_W, y, z: -AIM3_DIST }, b, focal);
      if (a && c) { ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); }
    }
    ctx.stroke();

    if (S) {
      const seen = S.st.active.map((s) => ({ s, p: project(s, b, focal) }))
        .filter((e) => e.p)
        .sort((a, c) => c.p.depth - a.p.depth);
      for (const e of seen) {
        const rpx = (e.s.r / e.p.depth) * focal;
        if (rpx < 0.4) continue;
        const g = ctx.createRadialGradient(
          e.p.x - rpx * 0.35, e.p.y - rpx * 0.35, rpx * 0.1,
          e.p.x, e.p.y, rpx
        );
        g.addColorStop(0, paint.accent);
        g.addColorStop(1, paint.border);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(e.p.x, e.p.y, rpx, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = paint.accent;
        ctx.lineWidth = k;
        ctx.stroke();
      }
    }

    // crosshair
    ctx.strokeStyle = paint.accent;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 9 * k, H / 2); ctx.lineTo(W / 2 - 3 * k, H / 2);
    ctx.moveTo(W / 2 + 3 * k, H / 2); ctx.lineTo(W / 2 + 9 * k, H / 2);
    ctx.moveTo(W / 2, H / 2 - 9 * k); ctx.lineTo(W / 2, H / 2 - 3 * k);
    ctx.moveTo(W / 2, H / 2 + 3 * k); ctx.lineTo(W / 2, H / 2 + 9 * k);
    ctx.stroke();
    ctx.fillStyle = paint.accent;
    ctx.fillRect(W / 2 - k, H / 2 - k, 2 * k, 2 * k);

    // a nudge back toward the wall when the view has swung off it
    const centre = project({ x: 0, y: 0, z: -AIM3_DIST }, b, focal);
    if (!centre || centre.x < 0 || centre.x > W || centre.y < 0 || centre.y > H) {
      const side = (0 * b.right.x + 0 * b.right.y + -AIM3_DIST * b.right.z) >= 0 ? 1 : -1;
      ctx.fillStyle = paint.muted;
      ctx.font = "600 " + Math.round(22 * k) + "px 'Geist Mono', monospace";
      ctx.textAlign = side > 0 ? "right" : "left";
      ctx.fillText(side > 0 ? "▶" : "◀", side > 0 ? W - 16 * k : 16 * k, H / 2 + 8 * k);
    }

    drawHud();
  }

  /* ── run ── */

  function yawMdeg() {
    return (((Math.round(cam.yaw * 1000) % AIM3_YAW_SPAN) + AIM3_YAW_SPAN) % AIM3_YAW_SPAN);
  }

  function pitchMdeg() {
    return Math.round(cam.pitch * 1000) + AIM3_PITCH_OFFSET;
  }

  function fmt(ms) {
    return window.Arcade ? Arcade.fmtTime(ms) : (ms / 1000).toFixed(1) + "s";
  }

  function bestFor(m) {
    if (!window.Arcade) return null;
    const runs = Arcade.getScores("aim3d").filter((s) => s.mode === m && typeof s.ms === "number");
    if (!runs.length) return null;
    return runs.sort((a, b) => a.ms - b.ms)[0];
  }

  function syncHud() {
    const done = S ? S.st.hits : 0;
    elRound.textContent = done + "/" + AIM3_ROUNDS;
    elMisses.textContent = S ? S.st.misses : 0;
    if (S && S.result) elTime.textContent = fmt(S.result.score);
    else if (S && S.running) elTime.textContent = fmt(performance.now() - S.t0);
    else elTime.textContent = fmt(0);
    if (S && S.result) elAvg.textContent = S.result.avg + "ms";
    else if (S && S.running && done) elAvg.textContent = Math.round((performance.now() - S.t0) / done) + "ms";
    else elAvg.textContent = "0ms";
    const best = bestFor(mode);
    elBest.textContent = best ? fmt(best.ms) : "none";
  }

  function showOverlay(title, sub, button) {
    ovTitle.textContent = title;
    ovSub.textContent = sub;
    ovStart.textContent = button;
    ovStart.style.display = button ? "" : "none";
    overlay.classList.add("show");
  }

  const MODE_COPY = {
    easy: "Easy: wide spheres, three up at a time, thirty to clear.",
    medium: "Medium: the same wall, spheres at about a third of the area.",
    hard: "Hard: small spheres. Every miss still costs a quarter second.",
  };

  function newRun() {
    const seed = Math.floor(Math.random() * 0x100000000) >>> 0;
    S = {
      seed,
      st: aim3New(mode, seed),
      shots: [],
      t0: 0,
      last: 0,
      running: false,
      dead: false,
      result: null,
    };
    cam = { yaw: 0, pitch: 0 };
    submitWrap.style.display = "none";
    runStatus.textContent = "";
    showOverlay("Aim 3D", MODE_COPY[mode] + " Click to take the mouse.", "Click to start");
    syncHud();
    draw();
  }

  function start() {
    if (!S || S.result || S.dead) newRun();
    if (!cv.requestPointerLock) {
      showOverlay("No pointer lock here",
        "This browser will not hand over the mouse, so the camera cannot follow it. The flat trainer at /aim/ plays fine.",
        "");
      return;
    }
    /* raw counts where the browser has them, so OS pointer acceleration does
       not sit between the mouse and the camera */
    let req;
    try {
      req = cv.requestPointerLock({ unadjustedMovement: true });
    } catch (_) {
      req = null;
    }
    if (req && req.catch) req.catch(() => { try { cv.requestPointerLock(); } catch (_) {} });
    else if (!req) { try { cv.requestPointerLock(); } catch (_) {} }
  }

  function beginRun() {
    overlay.classList.remove("show");
    S.running = true;
    S.t0 = performance.now();
    S.last = S.t0;
    syncHud();
  }

  function abandon(why) {
    S.running = false;
    S.dead = true;
    S.shots = [];
    showOverlay("Run void", why, "Start again");
    syncHud();
  }

  function finish() {
    S.running = false;
    const run = aim3Replay(mode, S.seed, S.shots);
    if (!run.ok) {
      abandon("This run did not verify locally: " + run.reason + ".");
      return;
    }
    S.result = run;
    if (document.pointerLockElement) document.exitPointerLock();
    showOverlay("Cleared",
      fmt(run.score) + " with " + run.misses + " " + (run.misses === 1 ? "miss" : "misses") +
      " · " + run.avg + "ms per target · " + run.acc + "% accuracy. " +
      "Name the run for the leaderboard.",
      "Play again");
    if (window.Arcade) {
      Arcade.addScore("aim3d", {
        mode,
        ms: run.score,
        timeMs: run.timeMs,
        misses: run.misses,
        acc: run.acc,
        avg: run.avg,
      });
      submitWrap.style.display = "flex";
      runName.value = (Arcade.getPlayer && Arcade.getPlayer()) || "";
    }
    syncHud();
  }

  function onMove(e) {
    if (!locked) return;
    const dpc = degPerCount();
    cam.yaw += e.movementX * dpc;
    cam.pitch = clamp(cam.pitch - e.movementY * dpc, -PITCH_LIMIT, PITCH_LIMIT);
    if (cam.yaw > 1e6 || cam.yaw < -1e6) cam.yaw = ((cam.yaw % 360) + 360) % 360;
  }

  function fire() {
    if (!S || !S.running) return;
    const now = performance.now();
    const dt = Math.round(now - S.last);
    /* the tape has a floor under it, so a shot inside that floor is dropped
       here rather than written down as something the Worker would refuse */
    if (dt < AIM3_MIN_GAP) return;
    if (dt > AIM3_MAX_GAP) {
      abandon("Nothing was fired for twenty seconds, so the tape stops being a run.");
      return;
    }

    const yaw = yawMdeg(), pitch = pitchMdeg();
    const shot = aim3Apply(S.st, aim3Dir(yaw, pitch), null);
    S.shots.push({ dt, hit: shot.hit, yaw, pitch });
    S.last = now;

    if (shot.hit) {
      hitSound();
      if (S.st.hits >= AIM3_ROUNDS) {
        finish();
        return;
      }
    } else {
      missSound();
      if (S.st.misses > AIM3_MAX_MISSES) {
        abandon("Too many misses in one run.");
        return;
      }
    }
    syncHud();
  }

  /* Escape leaves full screen and releases the mouse at once, which ends a run
     in progress, so the two are never taken apart here. */
  function toggleFull() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    if (!stage.requestFullscreen) return;
    const req = stage.requestFullscreen();
    if (req && req.catch) req.catch(() => {});
  }

  function paintFull() {
    const on = !!document.fullscreenElement;
    btnFull.setAttribute("aria-pressed", String(on));
    btnFull.textContent = on ? "⛶ windowed" : "⛶ full screen";
  }

  function setMode(next) {
    if (!AIM3_MODES[next] || next === mode) return;
    mode = next;
    document.querySelectorAll("[data-mode]").forEach((p) => {
      p.setAttribute("aria-pressed", String(p.dataset.mode === mode));
    });
    if (document.pointerLockElement) document.exitPointerLock();
    newRun();
  }

  async function submitRun() {
    if (!window.Arcade || !S || !S.result) return;
    const name = (runName.value || "").trim();
    if (name && Arcade.setPlayer) Arcade.setPlayer(name);
    runStatus.textContent = "submitting…";
    btnSubmit.disabled = true;
    try {
      const res = await Arcade.submit("aim3d", {
        mode,
        seed: S.seed,
        moves: aim3Encode(S.shots),
      });
      runStatus.textContent = res && res.rank ? "ranked #" + res.rank : "submitted";
    } catch (err) {
      runStatus.textContent = (err && err.message) || "submission failed";
    } finally {
      btnSubmit.disabled = false;
    }
  }

  document.addEventListener("pointerlockchange", () => {
    locked = document.pointerLockElement === cv;
    stage.classList.toggle("locked", locked);
    if (locked) {
      if (S && !S.running && !S.result && !S.dead) beginRun();
      return;
    }
    if (S && S.running) abandon("The mouse was released, so the run stops here.");
  });

  cv.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (locked) fire();
    else start();
  });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("mousemove", onMove);
  ovStart.addEventListener("click", start);
  btnNew.addEventListener("click", () => {
    if (document.pointerLockElement) document.exitPointerLock();
    newRun();
  });
  btnSubmit.addEventListener("click", submitRun);
  btnSound.addEventListener("click", () => setMuted(!muted));
  btnFull.addEventListener("click", toggleFull);
  document.addEventListener("fullscreenchange", () => {
    paintFull();
    draw();
  });
  window.addEventListener("resize", draw);
  [selPreset, inValue, inDpi, inFov].forEach((el) => {
    el.addEventListener("change", readSettings);
    el.addEventListener("input", readSettings);
  });
  document.querySelectorAll("[data-mode]").forEach((p) => {
    p.addEventListener("click", () => setMode(p.dataset.mode));
  });

  document.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "m" || e.key === "M") {
      setMuted(!muted);
      return;
    }
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      toggleFull();
      return;
    }
    if (e.key === " " || e.key === "Enter") {
      if (S && S.running) return;
      e.preventDefault();
      start();
    }
  });

  function loop() {
    if (S && S.running) syncHud();
    draw();
    requestAnimationFrame(loop);
  }

  loadCfg();
  paintSettings();
  readTokens();
  paintFull();
  newRun();
  /* the attract frame is painted here rather than waiting on the first
     animation frame, which a tab that opens in the background never gets */
  draw();
  requestAnimationFrame(loop);
})();
