/* Aim 3D for Maybaah's Arcade.
   Three scenarios on one wall: thirty kills against the clock, as many as you
   can in a minute, and a minute of holding the crosshair on a sphere that will
   not hold still. The mouse turns a camera rather than moving a cursor, so a
   run is the angles it was fired or held at.

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
  const AIM3_SPRINT_MS = 60000;
  const AIM3_SPRINT_MAX_SHOTS = 600;
  /* Tracking is sampled rather than shot, at a rate coarse enough to keep the
     tape small and fine enough that a third of a tenth of a second is the worst
     the clock can be wrong by. */
  const AIM3_TICK_MS = 1000 / 30;
  const AIM3_TRACK_TICKS = 1800;
  const AIM3_MAX_TICK_TURN = 180000;
  /* The silhouette is where a sine's last bit can differ between two builds of
     the same engine, so a shot inside this sliver of the edge is taken as the
     page called it. It is a millionth of the radius: nothing to aim with. */
  const AIM3_EPS = 1e-6;

  const AIM3_MODES = {
    easy: { r: 0.55, spread: 3.2 },
    medium: { r: 0.35, spread: 4.0 },
    hard: { r: 0.22, spread: 5.0 },
  };

  /* A tracked sphere is fatter and slower than a static one, because holding a
     crosshair on a moving 22cm ball for a minute is not training, it is a joke. */
  const AIM3_TRACK = {
    easy: { r: 0.88, speed: 0.09 },
    medium: { r: 0.56, speed: 0.12 },
    hard: { r: 0.35, speed: 0.16 },
  };

  const AIM3_SCENARIOS = ["grid", "sprint", "track"];

  /* Grid keeps the bare mode it shipped with, so the runs already standing on
     those boards stay where they are. */
  function aim3Board(scenario, mode) {
    return scenario === "grid" ? mode : scenario + "-" + mode;
  }

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
    if (typeof tape !== "string" || tape.length > 24 * AIM3_SPRINT_MAX_SHOTS) return null;
    if (!AIM3_TAPE_RE.test(tape)) return null;
    const shots = [];
    const re = /(\d{1,5})([hm])(\d{1,6}),(\d{1,6});/g;
    let m;
    while ((m = re.exec(tape))) {
      shots.push({ dt: +m[1], hit: m[2] === "h", yaw: +m[3], pitch: +m[4] });
    }
    return shots;
  }

  /* Grid is ranked by the clock, first target to thirtieth kill, with a quarter
     second for every miss. Sprint is ranked by kills in a fixed minute, ties
     going to whoever wasted fewer shots getting them. */
  function aim3Replay(scenario, mode, seed, shots) {
    if (!AIM3_MODES[mode]) return { ok: false, reason: "bad mode" };
    const sprint = scenario === "sprint";
    if (!sprint && scenario !== "grid") return { ok: false, reason: "bad scenario" };
    const maxShots = sprint ? AIM3_SPRINT_MAX_SHOTS : AIM3_ROUNDS + AIM3_MAX_MISSES;
    if (!Array.isArray(shots) || shots.length > maxShots) {
      return { ok: false, reason: "bad shot log" };
    }
    const st = aim3New(mode, seed);
    for (const s of shots) {
      if (!sprint && st.hits >= AIM3_ROUNDS) return { ok: false, reason: "the tape runs past the last target" };
      if (s.dt < AIM3_MIN_GAP || s.dt > AIM3_MAX_GAP) return { ok: false, reason: "impossible shot timing" };
      if (s.yaw >= AIM3_YAW_SPAN || s.pitch > 2 * AIM3_PITCH_OFFSET) {
        return { ok: false, reason: "shot fired from an impossible angle" };
      }
      st.timeMs += s.dt;
      if (sprint && st.timeMs > AIM3_SPRINT_MS) return { ok: false, reason: "that run ran past the minute" };
      const shot = aim3Apply(st, aim3Dir(s.yaw, s.pitch), s.hit);
      if (!shot.ok) return { ok: false, reason: shot.reason };
      if (!sprint && st.misses > AIM3_MAX_MISSES) return { ok: false, reason: "too many misses" };
    }
    const acc = Math.round((st.hits / Math.max(1, st.hits + st.misses)) * 100);
    if (sprint) {
      if (st.hits < 1) return { ok: false, reason: "that run never hit anything" };
      return {
        ok: true,
        timeMs: st.timeMs,
        kills: st.hits,
        misses: st.misses,
        acc,
        avg: Math.round(st.timeMs / st.hits),
        score: -(st.hits * 1000) + st.misses,
      };
    }
    if (st.hits < AIM3_ROUNDS) return { ok: false, reason: "that run never cleared every target" };
    return {
      ok: true,
      timeMs: st.timeMs,
      kills: AIM3_ROUNDS,
      misses: st.misses,
      acc,
      avg: Math.round(st.timeMs / AIM3_ROUNDS),
      score: st.timeMs + st.misses * AIM3_PENALTY,
    };
  }

  /* ── tracking ──
     One sphere, one minute, and the score is how long the crosshair was on it.
     The path is drawn from the seed a tick at a time, so it is the same minute
     for the page and for the referee. */

  /* The path is the Worker's to choose, not the player's: a minute of tracking
     rewards a lazy sphere, and a client that picks its own seed can go looking
     for one. Everyone gets the same path on the same day instead. */
  function aim3TrackSeed(day, mode) {
    const salt = mode === "hard" ? 3 : mode === "medium" ? 2 : 1;
    return (Math.imul(day, 2654435761) ^ Math.imul(salt, 40503)) >>> 0;
  }

  function aim3TrackNew(mode, seed) {
    const cfg = AIM3_TRACK[mode];
    const rnd = aim3Mulberry32(seed >>> 0);
    return { cfg, rnd, x: 0, y: 0, vx: 0, vy: 0, hold: 0, r: cfg.r };
  }

  function aim3TrackStep(t) {
    if (t.hold <= 0) {
      const a = t.rnd() * Math.PI * 2;
      const s = t.cfg.speed * (0.6 + 0.8 * t.rnd());
      t.vx = Math.cos(a) * s;
      /* flattened, because a sphere that climbs as readily as it strafes reads
         as noise rather than as something dodging */
      t.vy = Math.sin(a) * s * 0.55;
      t.hold = 8 + Math.floor(t.rnd() * 22);
    }
    t.hold--;
    t.x += t.vx;
    t.y += t.vy;
    if (t.x < -AIM3_HALF_W) { t.x = -AIM3_HALF_W; t.vx = -t.vx; }
    if (t.x > AIM3_HALF_W) { t.x = AIM3_HALF_W; t.vx = -t.vx; }
    if (t.y < -AIM3_HALF_H) { t.y = -AIM3_HALF_H; t.vy = -t.vy; }
    if (t.y > AIM3_HALF_H) { t.y = AIM3_HALF_H; t.vy = -t.vy; }
  }

  function aim3TrackSphere(t) {
    return { x: t.x, y: t.y, z: -AIM3_DIST, r: t.r };
  }

  const AIM3_TRACK_RE = /^(-?\d{1,6},-?\d{1,6};)*$/;

  function aim3TrackEncode(samples) {
    return samples.map((s) => s.dy + "," + s.dp + ";").join("");
  }

  function aim3TrackDecode(tape) {
    if (typeof tape !== "string" || tape.length > 18 * AIM3_TRACK_TICKS) return null;
    if (!AIM3_TRACK_RE.test(tape)) return null;
    const out = [];
    const re = /(-?\d{1,6}),(-?\d{1,6});/g;
    let m;
    while ((m = re.exec(tape))) out.push({ dy: +m[1], dp: +m[2] });
    return out;
  }

  function aim3TrackReplay(mode, seed, samples) {
    if (!AIM3_TRACK[mode]) return { ok: false, reason: "bad mode" };
    if (!Array.isArray(samples) || samples.length !== AIM3_TRACK_TICKS) {
      return { ok: false, reason: "a tracking run is exactly one minute" };
    }
    const t = aim3TrackNew(mode, seed);
    let yaw = 0, pitch = AIM3_PITCH_OFFSET, on = 0;
    for (const s of samples) {
      if (s.dy > AIM3_MAX_TICK_TURN || s.dy < -AIM3_MAX_TICK_TURN ||
          s.dp > AIM3_MAX_TICK_TURN || s.dp < -AIM3_MAX_TICK_TURN) {
        return { ok: false, reason: "the view moved further than a view can" };
      }
      yaw = (((yaw + s.dy) % AIM3_YAW_SPAN) + AIM3_YAW_SPAN) % AIM3_YAW_SPAN;
      pitch += s.dp;
      if (pitch < 0 || pitch > 2 * AIM3_PITCH_OFFSET) {
        return { ok: false, reason: "the view left the world" };
      }
      aim3TrackStep(t);
      if (aim3Resolve([aim3TrackSphere(t)], aim3Dir(yaw, pitch)).struck >= 0) on++;
    }
    const onMs = Math.round(on * AIM3_TICK_MS);
    return {
      ok: true,
      onTargetMs: onMs,
      pct: Math.round((on / AIM3_TRACK_TICKS) * 100),
      score: -onMs,
    };
  }

  /* ── end of the engine ── */

  const stage = document.getElementById("stage");
  const stageBar = document.getElementById("stage-bar");
  const cv = document.getElementById("screen");
  const ctx = cv.getContext("2d");
  const overlay = document.getElementById("overlay");
  const ovTitle = document.getElementById("ov-title");
  const ovSub = document.getElementById("ov-sub");
  const ovStart = document.getElementById("ov-start");
  const slots = ["a", "b", "c", "d", "e"].map((k) => ({
    label: document.getElementById("hud-" + k + "-label"),
    value: document.getElementById("hud-" + k),
  }));
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
  const COUNT_MS = 3000;
  const API = "https://arcade-leaderboard.maybeez.workers.dev";

  let mode = "easy";
  let scenario = "grid";
  let board = null;
  let S = null;
  let R = null;
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

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function loadCfg() {
    const saved = (window.Arcade && Arcade.prefs) ? Arcade.prefs("aim3d") : null;
    cfg = Object.assign({}, DEFAULTS, saved || {});
    if (!VALUE_LABEL[cfg.preset]) cfg.preset = DEFAULTS.preset;
    cfg.value = clamp(Number(cfg.value) || DEFAULTS.value, 0.001, 1000);
    cfg.dpi = clamp(Math.round(Number(cfg.dpi) || DEFAULTS.dpi), 100, 32000);
    cfg.fov = clamp(Math.round(Number(cfg.fov) || DEFAULTS.fov), 60, 130);
    if (AIM3_MODES[cfg.mode]) mode = cfg.mode;
    if (AIM3_SCENARIOS.indexOf(cfg.scenario) !== -1) scenario = cfg.scenario;
  }

  function saveCfg() {
    if (window.Arcade && Arcade.setPrefs) {
      Arcade.setPrefs("aim3d", Object.assign({}, cfg, { mode, scenario }));
    }
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
  const tickSound = () => blip(420, 420, 0.05, "square", 0.07);
  const goSound = () => blip(880, 880, 0.09, "square", 0.09);

  function setMuted(next) {
    muted = next;
    btnSound.setAttribute("aria-pressed", String(!muted));
    btnSound.querySelector("span").textContent = muted ? "Muted" : "Sound";
  }

  /* ── camera and drawing ── */

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

  function view() {
    if (R) return R.view;
    return { yaw: yawMdeg(), pitch: pitchMdeg() };
  }

  function spheres() {
    if (R) return R.scenario === "track" ? [aim3TrackSphere(R.track)] : R.st.active;
    if (!S) return [];
    return scenario === "track" ? [aim3TrackSphere(S.track)] : S.st.active;
  }

  function basis() {
    const v = view();
    const f = aim3Dir(v.yaw, v.pitch);
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
  function drawHud(k) {
    if (!document.fullscreenElement || (!S && !R)) return;
    ctx.font = "500 " + Math.round(15 * k) + "px 'Geist Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = paint.muted;
    ctx.fillText(hudLine(), 18 * k, 30 * k);
  }

  function drawCount(k) {
    if (!S || !S.counting) return;
    const left = S.countUntil - performance.now();
    const n = Math.ceil(left / 1000);
    ctx.textAlign = "center";
    ctx.fillStyle = paint.accent;
    ctx.font = "600 " + Math.round(64 * k) + "px 'Geist Mono', monospace";
    ctx.fillText(n > 0 ? String(n) : "go", W / 2, H / 2 - 40 * k);
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

    const onTarget = (scenario === "track" || (R && R.scenario === "track")) && trackingOn();
    const seen = spheres().map((s) => ({ s, p: project(s, b, focal) }))
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
      ctx.lineWidth = onTarget ? 3 * k : k;
      ctx.stroke();
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
      const side = -AIM3_DIST * b.right.z >= 0 ? 1 : -1;
      ctx.fillStyle = paint.muted;
      ctx.font = "600 " + Math.round(22 * k) + "px 'Geist Mono', monospace";
      ctx.textAlign = side > 0 ? "right" : "left";
      ctx.fillText(side > 0 ? "▶" : "◀", side > 0 ? W - 16 * k : 16 * k, H / 2 + 8 * k);
    }

    if (R) {
      ctx.textAlign = "center";
      ctx.fillStyle = paint.muted;
      ctx.font = "500 " + Math.round(14 * k) + "px 'Geist Mono', monospace";
      ctx.fillText("replay · " + R.name + " · " + R.label, W / 2, H - 22 * k);
    }

    drawCount(k);
    drawHud(k);
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

  function trackingOn() {
    const src = R ? R : S;
    return !!(src && src.onNow);
  }

  function bestFor() {
    if (!window.Arcade) return null;
    const runs = Arcade.getScores("aim3d").filter(
      (s) => s.mode === mode && (s.scenario || "grid") === scenario && typeof s.rank === "number"
    );
    if (!runs.length) return null;
    return runs.sort((a, b) => a.rank - b.rank)[0];
  }

  const SCENARIO_LABEL = { grid: "30 kills", sprint: "60 seconds", track: "tracking" };

  function bestText() {
    const best = bestFor();
    if (!best) return "none";
    if (scenario === "track") return fmt(best.onTargetMs);
    if (scenario === "sprint") return best.kills + " kills";
    return fmt(best.ms);
  }

  function clockLeft() {
    if (!S || !S.running) return scenario === "grid" ? 0 : AIM3_SPRINT_MS;
    const gone = performance.now() - S.t0;
    return Math.max(0, AIM3_SPRINT_MS - gone);
  }

  function hudLine() {
    const src = R || S;
    if (!src) return "";
    if ((R ? R.scenario : scenario) === "track") {
      const on = R ? R.onMs : (S.onTicks * AIM3_TICK_MS);
      return fmt(on) + " on target";
    }
    const st = src.st;
    return st.hits + (R || scenario === "sprint" ? " kills" : "/" + AIM3_ROUNDS) +
      "   " + st.misses + (st.misses === 1 ? " miss" : " misses");
  }

  function setSlot(i, label, value) {
    slots[i].label.textContent = label;
    slots[i].value.textContent = value;
  }

  function syncHud() {
    if (scenario === "track") {
      const on = S ? S.onTicks * AIM3_TICK_MS : 0;
      const done = S ? S.ticks : 0;
      setSlot(0, "on target", fmt(on));
      setSlot(1, "left", fmt(Math.max(0, (AIM3_TRACK_TICKS - done) * AIM3_TICK_MS)));
      setSlot(2, "hold", (done ? Math.round((S.onTicks / done) * 100) : 0) + "%");
      setSlot(3, "", "");
      setSlot(4, "best", bestText());
      return;
    }
    const st = S ? S.st : null;
    const hits = st ? st.hits : 0;
    if (scenario === "sprint") {
      setSlot(0, "kills", String(hits));
      setSlot(1, "left", fmt(S && S.running ? clockLeft() : AIM3_SPRINT_MS));
    } else {
      setSlot(0, "target", hits + "/" + AIM3_ROUNDS);
      setSlot(1, "time", fmt(S && S.result ? S.result.score : (S && S.running ? performance.now() - S.t0 : 0)));
    }
    setSlot(2, "misses", String(st ? st.misses : 0));
    const avg = S && S.result ? S.result.avg : (S && S.running && hits ? Math.round((performance.now() - S.t0) / hits) : 0);
    setSlot(3, "avg", avg + "ms");
    setSlot(4, "best", bestText());
  }

  function showOverlay(title, sub, button) {
    ovTitle.textContent = title;
    ovSub.textContent = sub;
    ovStart.textContent = button;
    ovStart.style.display = button ? "" : "none";
    overlay.classList.add("show");
  }

  const MODE_COPY = {
    grid: "Thirty kills, three spheres up at a time, ranked by the clock.",
    sprint: "One minute. As many kills as you can take in it.",
    track: "One minute of holding the crosshair on a sphere that moves.",
  };

  function today() {
    return window.Arcade && Arcade.utcDayKey ? Arcade.utcDayKey(0) : 0;
  }

  function newRun() {
    const day = today();
    const seed = scenario === "track"
      ? aim3TrackSeed(day, mode)
      : Math.floor(Math.random() * 0x100000000) >>> 0;
    S = {
      seed,
      day,
      scenario,
      mode,
      st: aim3New(mode, seed),
      track: aim3TrackNew(mode, seed),
      shots: [],
      samples: [],
      ticks: 0,
      onTicks: 0,
      onNow: false,
      recYaw: 0,
      recPitch: AIM3_PITCH_OFFSET,
      t0: 0,
      last: 0,
      counting: false,
      countUntil: 0,
      countStep: 0,
      running: false,
      dead: false,
      result: null,
    };
    R = null;
    cam = { yaw: 0, pitch: 0 };
    submitWrap.style.display = "none";
    runStatus.textContent = "";
    showOverlay("Aim 3D", MODE_COPY[scenario] + " Click to take the mouse.", "Click to start");
    syncHud();
    draw();
  }

  function start() {
    if (R) { R = null; newRun(); }
    if (!S || S.result || S.dead) newRun();
    if (!cv.requestPointerLock) {
      showOverlay("No pointer lock here",
        "This browser will not hand over the mouse, so the camera cannot follow it. The flat trainer at /aim/ plays fine.",
        "");
      return;
    }
    /* the stage is put where it can be seen first, so locking the mouse does
       not leave the view half off the bottom of the window */
    stage.scrollIntoView({ block: "center", behavior: "instant" });
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

  /* Three seconds of nothing before the clock, so the first target is not
     found by a hand that was still on its way to the mouse. */
  function beginCountdown() {
    overlay.classList.remove("show");
    S.counting = true;
    S.countUntil = performance.now() + COUNT_MS;
    S.countStep = 4;
    syncHud();
  }

  function beginRun() {
    S.counting = false;
    S.running = true;
    S.t0 = performance.now();
    S.last = S.t0;
    goSound();
    syncHud();
  }

  function abandon(why) {
    S.running = false;
    S.counting = false;
    S.dead = true;
    S.shots = [];
    S.samples = [];
    showOverlay("Run void", why, "Start again");
    syncHud();
  }

  function finish() {
    S.running = false;
    const run = scenario === "track"
      ? aim3TrackReplay(mode, S.seed, S.samples)
      : aim3Replay(scenario, mode, S.seed, S.shots);
    if (!run.ok) {
      abandon("This run did not verify locally: " + run.reason + ".");
      return;
    }
    S.result = run;
    if (document.pointerLockElement) document.exitPointerLock();
    showOverlay("Run over", resultLine(run), "Play again");
    if (window.Arcade) {
      Arcade.addScore("aim3d", Object.assign({ mode, scenario, rank: run.score }, detailOf(run)));
      submitWrap.style.display = "flex";
      runName.value = (Arcade.getPlayer && Arcade.getPlayer()) || "";
    }
    syncHud();
  }

  function detailOf(run) {
    if (scenario === "track") return { onTargetMs: run.onTargetMs, pct: run.pct };
    if (scenario === "sprint") {
      return { kills: run.kills, misses: run.misses, acc: run.acc, avg: run.avg, timeMs: run.timeMs };
    }
    return { ms: run.score, timeMs: run.timeMs, misses: run.misses, acc: run.acc, avg: run.avg };
  }

  function resultLine(run) {
    if (scenario === "track") {
      return fmt(run.onTargetMs) + " on target out of a minute, " + run.pct +
        "% of it. Name the run for the leaderboard.";
    }
    if (scenario === "sprint") {
      return run.kills + " kills in the minute · " + run.acc + "% accuracy · " +
        run.avg + "ms per kill. Name the run for the leaderboard.";
    }
    return fmt(run.score) + " with " + run.misses + " " + (run.misses === 1 ? "miss" : "misses") +
      " · " + run.avg + "ms per target · " + run.acc +
      "% accuracy. Name the run for the leaderboard.";
  }

  function onMove(e) {
    if (!locked) return;
    const dpc = degPerCount();
    cam.yaw += e.movementX * dpc;
    cam.pitch = clamp(cam.pitch - e.movementY * dpc, -PITCH_LIMIT, PITCH_LIMIT);
    if (cam.yaw > 1e6 || cam.yaw < -1e6) cam.yaw = ((cam.yaw % 360) + 360) % 360;
  }

  function fire() {
    if (!S || !S.running || scenario === "track") return;
    const now = performance.now();
    const dt = Math.round(now - S.last);
    /* the tape has a floor under it, so a shot inside that floor is dropped
       here rather than written down as something the Worker would refuse */
    if (dt < AIM3_MIN_GAP) return;
    if (dt > AIM3_MAX_GAP) {
      abandon("Nothing was fired for twenty seconds, so the tape stops being a run.");
      return;
    }
    if (scenario === "sprint" && S.st.timeMs + dt > AIM3_SPRINT_MS) {
      finish();
      return;
    }

    const yaw = yawMdeg(), pitch = pitchMdeg();
    const shot = aim3Apply(S.st, aim3Dir(yaw, pitch), null);
    S.st.timeMs += dt;
    S.shots.push({ dt, hit: shot.hit, yaw, pitch });
    S.last = now;

    if (shot.hit) {
      hitSound();
      if (scenario === "grid" && S.st.hits >= AIM3_ROUNDS) {
        finish();
        return;
      }
    } else {
      missSound();
      if (scenario === "grid" && S.st.misses > AIM3_MAX_MISSES) {
        abandon("Too many misses in one run.");
        return;
      }
      if (scenario === "sprint" && S.shots.length >= AIM3_SPRINT_MAX_SHOTS) {
        finish();
        return;
      }
    }
    syncHud();
  }

  /* One tick of tracking: the angle actually written down is the integer one,
     so the page scores the same view the Worker will rebuild from the tape. */
  function trackTick() {
    let dy = yawMdeg() - S.recYaw;
    if (dy > AIM3_YAW_SPAN / 2) dy -= AIM3_YAW_SPAN;
    if (dy < -AIM3_YAW_SPAN / 2) dy += AIM3_YAW_SPAN;
    dy = clamp(dy, -AIM3_MAX_TICK_TURN, AIM3_MAX_TICK_TURN);
    const dp = clamp(pitchMdeg() - S.recPitch, -AIM3_MAX_TICK_TURN, AIM3_MAX_TICK_TURN);
    S.recYaw = (((S.recYaw + dy) % AIM3_YAW_SPAN) + AIM3_YAW_SPAN) % AIM3_YAW_SPAN;
    S.recPitch += dp;
    S.samples.push({ dy, dp });
    aim3TrackStep(S.track);
    S.onNow = aim3Resolve([aim3TrackSphere(S.track)], aim3Dir(S.recYaw, S.recPitch)).struck >= 0;
    if (S.onNow) S.onTicks++;
    S.ticks++;
  }

  function stepRun(now) {
    if (S.counting) {
      const left = S.countUntil - now;
      const step = Math.ceil(left / 1000);
      if (step !== S.countStep) {
        S.countStep = step;
        if (step > 0) tickSound();
      }
      if (left <= 0) beginRun();
      return;
    }
    if (!S.running) return;
    if (scenario === "track") {
      const want = Math.min(AIM3_TRACK_TICKS, Math.floor((now - S.t0) / AIM3_TICK_MS));
      while (S.ticks < want) trackTick();
      if (S.ticks >= AIM3_TRACK_TICKS) finish();
      return;
    }
    if (scenario === "sprint" && now - S.t0 >= AIM3_SPRINT_MS) finish();
  }

  /* ── replay ──
     The board hands back the tape a run was verified from, so it can be played
     here against the same seed. Only the shot scenarios are kept: a minute of
     tracking is a thousand samples and has no business in a leaderboard row. */

  function startReplay(row) {
    const sc = row.scenario === "sprint" ? "sprint" : "grid";
    const shots = aim3Decode(row.tape);
    if (!shots || !shots.length || !AIM3_MODES[row.mode]) {
      runStatus.textContent = "that run has no tape to play";
      return;
    }
    if (document.pointerLockElement) document.exitPointerLock();
    S = null;
    R = {
      scenario: sc,
      mode: row.mode,
      name: row.name || "someone",
      label: SCENARIO_LABEL[sc] + " · " + row.mode,
      st: aim3New(row.mode, row.seed >>> 0),
      shots,
      i: 0,
      held: 0,
      view: { yaw: shots[0].yaw, pitch: shots[0].pitch },
      from: { yaw: shots[0].yaw, pitch: shots[0].pitch },
      last: performance.now(),
    };
    overlay.classList.remove("show");
    stage.scrollIntoView({ block: "center", behavior: "instant" });
    syncHud();
    draw();
  }

  function stepReplay(now) {
    const dt = now - R.last;
    R.last = now;
    const shot = R.shots[R.i];
    if (!shot) return;
    R.held += dt;
    const span = Math.max(1, shot.dt);
    const t = Math.min(1, R.held / span);
    /* the tape holds where each shot was aimed, not the path between them, so
       the camera is walked from one to the next rather than invented */
    let turn = shot.yaw - R.from.yaw;
    if (turn > AIM3_YAW_SPAN / 2) turn -= AIM3_YAW_SPAN;
    if (turn < -AIM3_YAW_SPAN / 2) turn += AIM3_YAW_SPAN;
    R.view = {
      yaw: (((R.from.yaw + turn * t) % AIM3_YAW_SPAN) + AIM3_YAW_SPAN) % AIM3_YAW_SPAN,
      pitch: R.from.pitch + (shot.pitch - R.from.pitch) * t,
    };
    if (R.held >= span) {
      const res = aim3Apply(R.st, aim3Dir(shot.yaw, shot.pitch), shot.hit);
      if (res.ok && res.hit) hitSound(); else missSound();
      R.from = { yaw: shot.yaw, pitch: shot.pitch };
      R.held = 0;
      R.i++;
      if (R.i >= R.shots.length) {
        const done = R;
        R = null;
        newRun();
        showOverlay("Replay over",
          done.name + " took " + done.st.hits + " kills with " + done.st.misses +
          (done.st.misses === 1 ? " miss" : " misses") + ".", "Click to start");
      }
    }
  }

  async function watchRun(ev) {
    const d = ev.detail || {};
    if (d.game !== "aim3d") return;
    runStatus.textContent = "loading that run…";
    try {
      const res = await fetch(API + "/api/replay?game=aim3d&board=" +
        encodeURIComponent(d.board) + "&rid=" + encodeURIComponent(d.rid));
      const body = await res.json();
      if (!res.ok || !body.tape) throw new Error(body.error || "no tape kept for that run");
      runStatus.textContent = "";
      startReplay(body);
    } catch (err) {
      runStatus.textContent = (err && err.message) || "could not load that run";
    }
  }

  /* ── controls ── */

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
    btnFull.querySelector("span").textContent = on ? "Windowed" : "Full screen";
  }

  function paintPills() {
    document.querySelectorAll("[data-mode]").forEach((p) => {
      p.setAttribute("aria-pressed", String(p.dataset.mode === mode));
    });
    document.querySelectorAll("[data-scenario]").forEach((p) => {
      p.setAttribute("aria-pressed", String(p.dataset.scenario === scenario));
    });
  }

  function setMode(next) {
    if (!AIM3_MODES[next] || next === mode) return;
    if (S && S.running) return;
    mode = next;
    paintPills();
    saveCfg();
    if (document.pointerLockElement) document.exitPointerLock();
    newRun();
    if (board) board.setState({ mode });
  }

  function setScenario(next) {
    if (AIM3_SCENARIOS.indexOf(next) === -1 || next === scenario) return;
    if (S && S.running) return;
    scenario = next;
    paintPills();
    saveCfg();
    if (document.pointerLockElement) document.exitPointerLock();
    newRun();
    if (board) board.setState({ scenario });
  }

  async function submitRun() {
    if (!window.Arcade || !S || !S.result) return;
    const name = (runName.value || "").trim();
    if (name && Arcade.setPlayer) Arcade.setPlayer(name);
    runStatus.textContent = "submitting…";
    btnSubmit.disabled = true;
    try {
      const res = await Arcade.submit("aim3d", {
        scenario,
        mode,
        seed: S.seed,
        day: S.day,
        moves: scenario === "track" ? aim3TrackEncode(S.samples) : aim3Encode(S.shots),
      });
      runStatus.textContent = res && res.rank ? "ranked #" + res.rank : "submitted";
      if (board) board.render();
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
      if (S && !S.running && !S.counting && !S.result && !S.dead) beginCountdown();
      return;
    }
    if (S && (S.running || S.counting)) {
      if (S.counting) {
        S.counting = false;
        showOverlay("Aim 3D", MODE_COPY[scenario] + " Click to take the mouse.", "Click to start");
      } else {
        abandon("The mouse was released, so the run stops here.");
      }
    }
  });

  /* A hidden tab stops animating but not counting, so a run that comes back
     from another window would carry a gap nobody played. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && S && (S.running || S.counting)) {
      abandon("The tab went away mid run, and a run is measured in wall time.");
    }
  });

  cv.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (locked) fire();
    else start();
  });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  /* a locked mouse still scrolls the page underneath it, which is how a run
     ends up looking at the footer */
  stage.addEventListener("wheel", (e) => {
    if (locked) e.preventDefault();
  }, { passive: false });
  document.addEventListener("mousemove", onMove);
  ovStart.addEventListener("click", start);
  btnNew.addEventListener("click", () => {
    if (document.pointerLockElement) document.exitPointerLock();
    R = null;
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
  window.addEventListener("arcade:replay", watchRun);
  document.querySelectorAll("[data-mode]").forEach((p) => {
    p.addEventListener("click", () => setMode(p.dataset.mode));
  });
  document.querySelectorAll("[data-scenario]").forEach((p) => {
    p.addEventListener("click", () => setScenario(p.dataset.scenario));
  });

  const MODE_KEYS = { 1: "easy", 2: "medium", 3: "hard" };
  const SCENARIO_KEYS = { 4: "grid", 5: "sprint", 6: "track" };

  document.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    /* the page never wants the space bar or the arrows: both scroll it out from
       under a run that is still going */
    if (e.key === " " || e.key.indexOf("Arrow") === 0 || e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
    }
    if (e.key === "m" || e.key === "M") { setMuted(!muted); return; }
    if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFull(); return; }
    if (MODE_KEYS[e.key]) { setMode(MODE_KEYS[e.key]); return; }
    if (SCENARIO_KEYS[e.key]) { setScenario(SCENARIO_KEYS[e.key]); return; }
    if (e.key === " " || e.key === "Enter") {
      if (S && (S.running || S.counting)) return;
      start();
    }
  });

  function loop(now) {
    if (R) stepReplay(now);
    else if (S) stepRun(now);
    if (S && (S.running || S.counting)) syncHud();
    draw();
    requestAnimationFrame(loop);
  }

  loadCfg();
  paintSettings();
  paintPills();
  readTokens();
  paintFull();
  newRun();
  /* the attract frame is painted here rather than waiting on the first
     animation frame, which a tab that opens in the background never gets */
  draw();
  requestAnimationFrame(loop);

  if (window.Arcade && Arcade.mountBoard) {
    board = Arcade.mountBoard(document.getElementById("board-embed"), {
      game: "aim3d", title: "Global board", limit: 10, selfLink: false,
      hiddenAxes: ["mode", "scenario"], state: { mode, scenario },
    });
  }
})();
