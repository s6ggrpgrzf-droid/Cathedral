/* Cathedral — old time radio. Turn the knob, tune through the static, land on a show. */
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }

  /* this set runs at full motion regardless of the phone's Reduce Motion
     setting — its owner's standing rule for everything he keeps */

  var player = $("player"), dial = $("dial"), needle = $("needle"),
      stationReadout = $("dialStation"), status = $("dialStatus"),
      tuneKnob = $("knobTune"), tunePtr = $("tunePtr"),
      volKnob = $("knobVol"), volPtr = $("volPtr"),
      pow = $("btnPower");
  var nowCard = $("nowCard"), nowShow = $("nowShow"), nowTag = $("nowTag"),
      nowEp = $("nowEp"), nowDate = $("nowDate"), nowSpecial = $("nowSpecial");
  var grilleEl = document.querySelector(".grille"),
      fretEl = document.querySelector(".grille .fret"),
      dialGlassEl = dial.querySelector(".dial-glass");
  var progressFill = $("dialProgressFill"),
      btnBack30 = $("btnBack30"), btnPlayPause = $("btnPlayPause"),
      btnFwd30 = $("btnFwd30"), btnAnother = $("btnAnother"),
      timeElapsed = $("timeElapsed"), timeRemain = $("timeRemain");

  var stations = [], curIdx = -1, powerOn = false, isPlaying = false;
  var ticksBox = $("dialTicks");
  var epCache = {};          // station name -> [{url,title,date}]
  var tuneGen = 0;           // guards async races while tuning
  var failStreak = 0;        // consecutive failed streams (cap: 3 tries)
  var curEp = null;
  var pendingSeek = 0;       // resume position to apply when the episode's metadata lands
  var resumeUsed = false;    // the current episode was resumed, not freshly drawn
  var epPlayed = false;      // the current episode has actually sounded (guards resume saves)
  var eyeGlass = $("eyeGlass"), eyeWedge = $("eyeWedge");

  /* ---------- remembered station & volume ---------- */
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem("cathedral_state_v1") || "{}") || {}; } catch (e) { saved = {}; }
  var volLevel = (typeof saved.vol === "number") ? Math.min(1, Math.max(0, saved.vol)) : 0.75;
  var muted = !!saved.muted;
  /* resume map: station name -> {url,title,date,pos,dur,ts} — the episode in
     progress on that station and where you left it. Entries die at 30 days. */
  var resumeMap = (saved.resume && typeof saved.resume === "object") ? saved.resume : {};
  (function pruneResume() {
    var cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    Object.keys(resumeMap).forEach(function (k) { if (!resumeMap[k] || (resumeMap[k].ts || 0) < cutoff) delete resumeMap[k]; });
  })();
  /* tone: the set's voicing — mellow / full (the original cabinet voice) / clear,
     plus Night, a compressor that tames peaks for low listening */
  var toneMode = (saved.tone === "mellow" || saved.tone === "clear") ? saved.tone : "full";
  var nightOn = !!saved.night;
  function saveState() {
    try {
      var name = (curIdx >= 0 && stations[curIdx]) ? stations[curIdx].name : saved.station;
      localStorage.setItem("cathedral_state_v1", JSON.stringify({ station: name, vol: volLevel, muted: muted, resume: resumeMap, tone: toneMode, night: nightOn }));
    } catch (e) {}
  }
  function saveResume() {
    if (!powerOn || curIdx < 0 || !stations[curIdx] || !curEp) return;
    var name = stations[curIdx].name, pos = player.currentTime, dur = player.duration;
    if (!isFinite(pos)) return;
    if (!epPlayed && pos < 8) return;                                          // never actually played: leave any saved place untouched
    if (pos < 8) { delete resumeMap[name]; saveState(); return; }              // played but barely started: nothing to resume
    if (isFinite(dur) && dur > 0 && pos > dur - 20) { delete resumeMap[name]; saveState(); return; }  // effectively finished
    resumeMap[name] = { url: curEp.url, title: curEp.title, date: curEp.date, pos: Math.floor(pos), dur: isFinite(dur) ? Math.floor(dur) : 0, ts: Date.now() };
    saveState();
  }
  /* episode-list cache (localStorage) so the first tune is fast.
     v2: the Suspense and Benny shelves were widened (pass 6) — the old key
     would have kept serving the narrow lists forever, so it was retired.
     The cache carries a timestamp and refreshes weekly, so episodes the
     Archive adds later still reach the dial. */
  var epCacheTs = 0, WEEK = 7 * 24 * 3600 * 1000;
  try {
    var c = JSON.parse(localStorage.getItem("cathedral_eps_v2") || "{}");
    if (c && typeof c === "object" && c.lists) {
      epCacheTs = c.ts || 0;
      if (Date.now() - epCacheTs < WEEK) epCache = c.lists;
    }
  } catch (e) {}
  function persistEpCache() { try { localStorage.setItem("cathedral_eps_v2", JSON.stringify({ ts: epCacheTs, lists: epCache })); } catch (e) {} }

  /* ---------- the set's serial number: four digits stamped once, at the
     factory (this install's first open), and kept for good ---------- */
  var serialNo = "";
  try { serialNo = localStorage.getItem("cathedral_serial_v1") || ""; } catch (e) {}
  if (!/^\d{4}$/.test(serialNo)) {
    serialNo = ("000" + (1 + Math.floor(Math.random() * 9999))).slice(-4);
    try { localStorage.setItem("cathedral_serial_v1", serialNo); } catch (e) {}
  }
  var serialEl = $("nowSerial");
  if (serialEl) serialEl.textContent = "Model 37 \u00b7 No. " + serialNo;

  /* ---------- knob tick rings (11 ticks, majors at the ends and centre) ---------- */
  document.querySelectorAll("[data-ticks]").forEach(function (box) {
    for (var i = 0; i <= 10; i++) {
      var a = (-135 + i * 27) * Math.PI / 180, t = document.createElement("i");
      t.style.left = (50 + 47 * Math.sin(a)) + "%";
      t.style.top = (50 - 47 * Math.cos(a)) + "%";
      t.style.transform = "translate(-50%,-50%) rotate(" + (-135 + i * 27) + "deg)";
      if (i === 0 || i === 5 || i === 10) t.className = "major";
      box.appendChild(t);
    }
  });

  /* ---------- the magic eye: wedge closes at lock, flutters with the audio ---------- */
  var eyeBase = 0.15, eyeShown = 0.15;
  function drawEyeRaw(s) {
    s = Math.min(1, Math.max(0, s));
    var half = (42 - 39 * s) * Math.PI / 180, cx = 50, cy = 50, r = 54;
    var a0 = -Math.PI / 2 - half, a1 = -Math.PI / 2 + half;
    eyeWedge.setAttribute("d",
      "M " + cx + " " + cy +
      " L " + (cx + r * Math.cos(a0)).toFixed(1) + " " + (cy + r * Math.sin(a0)).toFixed(1) +
      " A " + r + " " + r + " 0 0 1 " +
      (cx + r * Math.cos(a1)).toFixed(1) + " " + (cy + r * Math.sin(a1)).toFixed(1) + " Z");
  }
  function drawEye(s) { eyeBase = s; drawEyeRaw(s); }
  drawEye(0.15);
  /* the set is alive: the eye flutters, the cloth breathes, and the dial
     lamp warms with the signal. The analyser sits AFTER the shortwave fade
     stage in the chain, so everything here rises and sags with the broadcast
     itself — a fade dip cools the glass all on its own. */
  var analyser = null, eyeData = null, breathShown = 0, glowShown = 0.5;
  (function eyeLoop() {
    requestAnimationFrame(eyeLoop);
    if (!powerOn || !analyser) return;
    if (!eyeData) eyeData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(eyeData);
    var sum = 0;
    for (var i = 0; i < eyeData.length; i++) { var v = (eyeData[i] - 128) / 128; sum += v * v; }
    var rms = Math.sqrt(sum / eyeData.length);
    var target = Math.min(1, Math.max(0, eyeBase * (0.88 + Math.min(0.5, rms * 2.6))));
    eyeShown += (target - eyeShown) * 0.35;
    drawEyeRaw(eyeShown);
    /* cloth: heavy and slow, a swell under the program — never a pulse you can point at */
    var sig = isPlaying ? Math.min(1, rms * 2.4) : 0;
    breathShown += (sig - breathShown) * 0.10;
    fretEl.style.transform = "scale(" + (1 + breathShown * 0.018).toFixed(4) + ")";
    grilleEl.style.transform = "scale(" + (1 + breathShown * 0.004).toFixed(4) + ")";
    /* lamp: thermal inertia — warms as the signal strengthens, cools as it fades */
    var glowTarget = isPlaying ? Math.min(1, 0.18 + rms * 2.4) : eyeBase * 0.65;
    glowShown += (glowTarget - glowShown) * 0.05;
    dialGlassEl.style.setProperty("--glow", glowShown.toFixed(3));
  })();

  /* ---------- the room's light: lacquer and brass answer the hand ----------
     Tilt the phone (or move the mouse on a desk machine) and the reflections
     on the clearcoat and the brass slide a little, the way a lamp moves
     across a real finish. Two CSS variables (--lx, --ly, each -1…1) carry it;
     one requestAnimationFrame step eases them and stops once they settle.
     The light answers the hand at full motion, always. */
  (function roomLight() {
    var rs = document.documentElement.style;
    var lx = 0, ly = 0, tx = 0, ty = 0, raf = 0;
    function clamp(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
    function step() {
      raf = 0;
      lx += (tx - lx) * 0.075; ly += (ty - ly) * 0.075;
      if (Math.abs(tx - lx) < 0.002 && Math.abs(ty - ly) < 0.002) { lx = tx; ly = ty; }
      rs.setProperty("--lx", lx.toFixed(3)); rs.setProperty("--ly", ly.toFixed(3));
      if (lx !== tx || ly !== ty) raf = requestAnimationFrame(step);
    }
    function aim(x, y) {
      tx = clamp(x); ty = clamp(y);
      if (!raf && !document.hidden) raf = requestAnimationFrame(step);
    }
    /* desk: the lamp follows a mouse or pen (a finger is busy turning knobs) */
    window.addEventListener("pointermove", function (e) {
      if (e.pointerType === "touch") return;
      aim((e.clientX / Math.max(1, window.innerWidth)) * 2 - 1, (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1);
    }, { passive: true });
    /* hand: tilt, measured from however you happen to hold the phone — the
     neutral pose drifts slowly toward your grip so the light never sticks */
    var b0 = null, g0 = null, oriOn = false;
    function onOrient(e) {
      if (e.beta == null || e.gamma == null) return;
      var b = e.beta, g = e.gamma, ang = 0;
      try { ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0; } catch (err) {}
      if (ang === 90) { var t = b; b = -g; g = t; }
      else if (ang === -90 || ang === 270) { var t2 = b; b = g; g = -t2; }
      if (b0 === null) { b0 = b; g0 = g; }
      b0 += (b - b0) * 0.004; g0 += (g - g0) * 0.004;
      aim(-(g - g0) / 28, -(b - b0) / 28);
    }
    function listen() {
      if (oriOn) return; oriOn = true;
      window.addEventListener("deviceorientation", onOrient, { passive: true });
    }
    if (typeof window.DeviceOrientationEvent === "undefined") return;
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      /* iOS asks first, and only from a tap: ask once, on the first touch of
         the set; a refusal just leaves the light where it is */
      var asked = false;
      var ask = function () {
        if (asked) return; asked = true;
        document.removeEventListener("click", ask, true);
        try {
          DeviceOrientationEvent.requestPermission().then(function (st) { if (st === "granted") listen(); }).catch(function () {});
        } catch (err) {}
      };
      document.addEventListener("click", ask, true);
    } else listen();
  })();

  /* ---------- audio: ONE master gain rules every sound on the set ----------
     iPhones ignore an audio element's own volume, so the Volume knob turns
     this master gain instead — static, crackle, hum, whistle, clicks, the
     ghost and the broadcast all obey it. */
  var AC = null, master = null, hissGain = null, humNodes = null, noiseBuf = null, lastHiss = 0;
  var warmLP = null, fadeGain = null;
  function out() { return master || (AC && AC.destination); }
  function volCurve(v) { return Math.pow(v, 1.5); }
  function applyMaster() {
    if (AC && master) master.gain.setTargetAtTime(muted ? 0 : volCurve(volLevel), AC.currentTime, 0.03);
    else { player.volume = muted ? 0 : volLevel; }
  }
  function ac() {
    if (!AC) {
      try {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        master = AC.createGain(); master.gain.value = muted ? 0 : volCurve(volLevel);
        master.connect(AC.destination);
        var len = AC.sampleRate * 2;
        var buf = AC.createBuffer(1, len, AC.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        noiseBuf = buf;
        var src = AC.createBufferSource();
        src.buffer = buf; src.loop = true;
        var filt = AC.createBiquadFilter();
        filt.type = "bandpass"; filt.frequency.value = 1800; filt.Q.value = 0.4;
        hissGain = AC.createGain(); hissGain.gain.value = 0;
        src.connect(filt); filt.connect(hissGain); hissGain.connect(master);
        src.start();
      } catch (e) {}
    }
    if (AC && AC.state === "suspended") AC.resume();
    return AC;
  }
  function hiss(level, ramp) {
    lastHiss = level;
    var a = ac(); if (!a || !hissGain) return;
    hissGain.gain.cancelScheduledValues(a.currentTime);
    hissGain.gain.setTargetAtTime(level, a.currentTime, ramp || 0.08);
  }
  /* crackle: random short pops — on the static while tuning, faint under a broadcast */
  var crackleTimer = null;
  function crackle() {
    if (!powerOn) { crackleTimer = null; return; }
    var a = ac();
    var onAir = lastHiss > 0.04 || isPlaying;
    if (a && noiseBuf && onAir && Math.random() < 0.55) {
      var s = a.createBufferSource(); s.buffer = noiseBuf;
      s.playbackRate.value = 0.5 + Math.random() * 1.5;
      var f = a.createBiquadFilter(); f.type = "bandpass";
      f.frequency.value = 1600 + Math.random() * 2600; f.Q.value = 2.5;
      var g = a.createGain();
      var t = a.currentTime, amp = (0.05 + Math.random() * 0.1) * (lastHiss > 0.04 ? 1 : 0.35) * (nightOn ? 0.45 : 1);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03 + Math.random() * 0.05);
      s.connect(f); f.connect(g); g.connect(out());
      s.start(t, Math.random() * 1.5); s.stop(t + 0.15);
    }
    crackleTimer = setTimeout(crackle, 140 + Math.random() * 800);
  }
  // the mains hum of warming tubes: low 55Hz + a breath of 110, fading up then away
  function humOn() {
    var a = ac(); if (!a || humNodes) return;
    var o1 = a.createOscillator(), o2 = a.createOscillator(), g = a.createGain();
    o1.type = "sine"; o1.frequency.value = 55;
    o2.type = "sine"; o2.frequency.value = 110;
    var g2 = a.createGain(); g2.gain.value = 0.25;
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.setTargetAtTime(0.045, a.currentTime, 0.9);
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(out());
    o1.start(); o2.start();
    humNodes = { g: g, stop: function () {
      g.gain.setTargetAtTime(0.0001, a.currentTime, 0.25);
      setTimeout(function () { try { o1.stop(); o2.stop(); } catch (e) {} }, 900);
      humNodes = null;
    } };
  }
  /* the broadcast chain: warm-up muffle → cabinet voice → gentle tube
     saturation → slow shortwave fading → analyser (for the eye) → master.
     The cabinet's voice: boxy midrange hump, rolled-off highs, no deep bass
     a 6" speaker never made. */
  var eqDone = false, eqHP = null, eqBox = null, eqLP = null, eqPresence = null, eqComp = null;
  function applyTone() {
    if (!eqDone || !AC) return;
    var t = AC.currentTime;
    function ramp(param, v) { param.setTargetAtTime(v, t, 0.15); }
    if (toneMode === "mellow") {          // darker, rounder — late-evening voicing
      ramp(eqBox.frequency, 640); ramp(eqBox.gain, 5.2);
      ramp(eqLP.frequency, 1850); ramp(eqPresence.gain, -3);
    } else if (toneMode === "clear") {    // speech forward — for muddy recordings
      ramp(eqBox.frequency, 740); ramp(eqBox.gain, 1.6);
      ramp(eqLP.frequency, 3400); ramp(eqPresence.gain, 4.5);
    } else {                              // full: the original cabinet voice, untouched
      ramp(eqBox.frequency, 740); ramp(eqBox.gain, 4.5);
      ramp(eqLP.frequency, 2700); ramp(eqPresence.gain, 0);
    }
    if (nightOn) {                        // lean on the loud parts, spare the quiet ones
      ramp(eqComp.threshold, -24); ramp(eqComp.ratio, 6); ramp(eqComp.knee, 18);
    } else {
      ramp(eqComp.threshold, 0); ramp(eqComp.ratio, 1); ramp(eqComp.knee, 0);
    }
  }
  function cabinetVoice() {
    var a = ac(); if (!a || eqDone) return; eqDone = true;
    try {
      var src = a.createMediaElementSource(player);
      warmLP = a.createBiquadFilter(); warmLP.type = "lowpass"; warmLP.frequency.value = 14000;
      eqHP = a.createBiquadFilter(); eqHP.type = "highpass"; eqHP.frequency.value = 170;
      eqBox = a.createBiquadFilter(); eqBox.type = "peaking";
      eqBox.frequency.value = 740; eqBox.Q.value = 0.7; eqBox.gain.value = 4.5;
      eqLP = a.createBiquadFilter(); eqLP.type = "lowpass";
      eqLP.frequency.value = 2700; eqLP.Q.value = 0.4;
      eqPresence = a.createBiquadFilter(); eqPresence.type = "peaking";
      eqPresence.frequency.value = 2500; eqPresence.Q.value = 0.8; eqPresence.gain.value = 0;
      var shaper = a.createWaveShaper();
      var curve = new Float32Array(256);
      for (var i = 0; i < 256; i++) { var x = i / 128 - 1; curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); }
      shaper.curve = curve; shaper.oversample = "2x";
      eqComp = a.createDynamicsCompressor();
      eqComp.threshold.value = 0; eqComp.ratio.value = 1; eqComp.knee.value = 0;
      eqComp.attack.value = 0.004; eqComp.release.value = 0.24;
      fadeGain = a.createGain(); fadeGain.gain.value = 0.95;
      analyser = a.createAnalyser(); analyser.fftSize = 256;
      src.connect(warmLP); warmLP.connect(eqHP); eqHP.connect(eqBox); eqBox.connect(eqLP);
      eqLP.connect(eqPresence); eqPresence.connect(shaper); shaper.connect(eqComp);
      eqComp.connect(fadeGain); fadeGain.connect(analyser); analyser.connect(master);
      applyTone();   // a remembered voicing greets the first broadcast
    } catch (e) { /* element keeps its direct output */ }
  }
  /* slow shortwave fading: the signal swells and sags like a distant station */
  var fadeTimer = null;
  function fadeLoop() {
    if (!powerOn) { fadeTimer = null; return; }
    var a = AC;
    if (a && fadeGain && isPlaying) {
      var dip = Math.random() < 0.12;
      var target = dip ? 0.5 + Math.random() * 0.15 : 0.84 + Math.random() * 0.16;
      fadeGain.gain.setTargetAtTime(target, a.currentTime, dip ? 0.7 : 1.6);
    }
    fadeTimer = setTimeout(fadeLoop, 900 + Math.random() * 1400);
  }
  /* ---------- the hardware speaks: mechanical sounds, built from noise ----------
     No samples: every switch, detent and relay is a short burst of the set's
     own noise buffer shaped by filters (the snap), a few ringing resonances
     (the metal), and sometimes a falling sine (the wooden body taking the
     knock). Each one varies a little every time, the way a real part never
     clicks the same twice. They run on their own bus under the master gain,
     so they follow the Volume knob and fall silent with mute, and sit well
     under the broadcast. */
  var fxBus = null;
  function fx() {
    var a = ac(); if (!a) return null;
    if (!fxBus) { fxBus = a.createGain(); fxBus.gain.value = 0.55; fxBus.connect(out()); }
    return fxBus;
  }
  function vary(v, amt) { return v * (1 + (Math.random() * 2 - 1) * (amt || 0.06)); }
  /* one noise transient: filter chain → envelope (sub-millisecond attack) */
  function burst(t, o) {
    var a = AC, bus = fx(); if (!a || !bus || !noiseBuf) return;
    var s = a.createBufferSource(); s.buffer = noiseBuf;
    var node = s;
    if (o.hp) { var h = a.createBiquadFilter(); h.type = "highpass"; h.frequency.value = o.hp; node.connect(h); node = h; }
    var g = a.createGain();
    if (o.bands) {
      o.bands.forEach(function (b) {
        var f = a.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = vary(b[0], 0.04); f.Q.value = b[1];
        var bg = a.createGain(); bg.gain.value = b[2];
        node.connect(f); f.connect(bg); bg.connect(g);
      });
    } else node.connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.amp, t + (o.att || 0.0006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dec);
    g.connect(bus);
    s.start(t, Math.random() * 1.8); s.stop(t + o.dec + 0.03);
  }
  /* the body: a short falling sine, the cabinet or the knob shaft taking the knock */
  function body(t, f0, f1, amp, dec) {
    var a = AC, bus = fx(); if (!a || !bus) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dec * 0.7);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + dec + 0.03);
  }
  /* a button key going down: a dry snap voiced by the key (freq keeps the
     old call sites' character: low = soft, high = bright) and a little body */
  function click(freq) {
    var a = ac(); if (!a) return;
    var t = a.currentTime, f = freq || 700;
    burst(t, { hp: 600, bands: [[vary(f * 2.6), 2.2, 1], [vary(f * 5.1), 7, 0.45]], amp: 0.22, dec: 0.022 });
    body(t, vary(f * 0.42), f * 0.3, 0.05, 0.03);
  }
  /* a detent: the knob's spring-loaded ball dropping into the next notch.
     Tiny, bright and dry; `w` (0…1) is how hard it lands */
  var lastDetent = 0;
  function detent(w) {
    var a = AC; if (!a) return;
    var now = a.currentTime;
    if (now - lastDetent < 0.026) return;   // a fast spin blurs into a purr, not a machine gun
    lastDetent = now;
    var k = w == null ? 0.6 : w;
    burst(now, { hp: 1800, bands: [[3900, 6, 1], [6800, 9, 0.5]], amp: 0.09 + 0.13 * k, dec: 0.009 + 0.006 * k });
    body(now, vary(1150), 700, 0.012 + 0.018 * k, 0.014);
  }
  /* the power switch: a heavy rotary snap — the throw, the contacts' metal
     ring, the cabinet's thump, and the rocker settling a beat later */
  function thunk(goingOn) {
    var a = ac(); if (!a) return;
    var t = a.currentTime, on = goingOn !== false;
    burst(t, { hp: 300, bands: [[vary(on ? 1450 : 1200), 1.3, 1], [vary(3100), 22, 0.6], [vary(4700), 28, 0.4]], amp: 0.42, dec: 0.085 });
    body(t + 0.001, on ? 128 : 108, on ? 52 : 46, 0.30, 0.16);
    burst(t + vary(0.034, 0.15), { hp: 2200, bands: [[vary(5200), 10, 1]], amp: 0.07, dec: 0.012 });
  }
  /* the B+ relay pulling in as the rectifier warms: tick-tack, then quiet */
  function relayTick() {
    var a = ac(); if (!a) return;
    var t = a.currentTime;
    burst(t, { hp: 1200, bands: [[vary(2600), 9, 1], [vary(5900), 14, 0.5]], amp: 0.2, dec: 0.016 });
    burst(t + vary(0.019, 0.12), { hp: 1600, bands: [[vary(3400), 11, 1], [vary(7200), 16, 0.4]], amp: 0.12, dec: 0.012 });
    body(t, 210, 150, 0.035, 0.03);
  }
  /* haptics, where the hand can feel them (feature-detected; silently absent on iOS) */
  var canBuzz = typeof navigator.vibrate === "function", lastBuzz = 0;
  function buzz(ms, force) {
    if (!canBuzz) return;
    var now = Date.now();
    if (!force && now - lastBuzz < 45) return;
    lastBuzz = now;
    try { navigator.vibrate(ms); } catch (e) {}
  }
  /* a station drops into place: a deeper notch you can feel */
  function lockFeel() {
    if (AC) { lastDetent = 0; detent(1); body(AC.currentTime, 420, 220, 0.03, 0.04); }
    buzz(12, true);
  }
  /* station-break chime: three soft bell tones, the way the networks signed a break */
  function chime() {
    var a = ac(); if (!a) return;
    [392, 329.6, 261.6].forEach(function (fq, i) {
      var t = a.currentTime + i * 0.3;
      var o = a.createOscillator(), o2 = a.createOscillator(), g = a.createGain();
      o.type = "sine"; o.frequency.value = fq;
      o2.type = "sine"; o2.frequency.value = fq * 2; 
      var g2 = a.createGain(); g2.gain.value = 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(g); o2.connect(g2); g2.connect(g); g.connect(out());
      o.start(t); o.stop(t + 1.2); o2.start(t); o2.stop(t + 1.2);
    });
  }
  /* heterodyne whistle: the beat tone as you close on a carrier.
     Far off = high whine; on the station = it sinks to silence. */
  var whOsc = null, whGain = null;
  function whistle(ratio) {
    var a = ac(); if (!a) return;
    if (!whOsc) {
      whOsc = a.createOscillator(); whGain = a.createGain();
      whOsc.type = "sine"; whOsc.frequency.value = 0; whGain.gain.value = 0;
      whOsc.connect(whGain); whGain.connect(out()); whOsc.start();
    }
    var r = Math.min(1, Math.max(0, ratio));
    whOsc.frequency.setTargetAtTime(r * 1500, a.currentTime, 0.03);
    var g = (r > 0.04 && r < 0.98) ? 0.018 : 0;
    whGain.gain.setTargetAtTime(g, a.currentTime, 0.05);
  }
  function whistleOff() { if (whGain && AC) whGain.gain.setTargetAtTime(0, AC.currentTime, 0.03); }

  /* the ghost: the nearest station bleeding faintly through the static as you
     close in. When you lock, the ghost's episode becomes the program —
     the bleed turns into the broadcast. */
  var ghost = null, ghostGain = null, ghostEqDone = false, ghostIdx = -1, ghostLoading = -1;
  function ghostEl() {
    if (!ghost) {
      ghost = new Audio();
      ghost.crossOrigin = "anonymous";
      ghost.volume = 1;
      var a = ac();
      if (a && !ghostEqDone) {
        try {
          ghostEqDone = true;
          var gs = a.createMediaElementSource(ghost);
          var glp = a.createBiquadFilter();
          glp.type = "lowpass"; glp.frequency.value = 2100;
          ghostGain = a.createGain(); ghostGain.gain.value = 0;
          gs.connect(glp); glp.connect(ghostGain); ghostGain.connect(out());
        } catch (e) { ghostEqDone = true; }
      }
    }
    return ghost;
  }
  function ghostSet(v) {
    var g = ghostEl();
    if (ghostGain && AC) ghostGain.gain.setTargetAtTime(v, AC.currentTime, 0.06);
    else g.volume = v;
  }
  function ghostKill() {
    if (ghost) { try { ghost.pause(); } catch (e) {} ghostSet(0); }
    ghostIdx = -1; ghostLoading = -1;
  }
  function ghostSeek(idx, ratio) {
    if (idx === ghostLoading || idx === ghostIdx) return;
    ghostLoading = idx;
    var g = ghostEl();
    fetchEpisodes(idx, function (eps) {
      if (!powerOn || ghostLoading !== idx) return;
      ghostLoading = -1; ghostIdx = idx;
      if (!eps.length) return;
      var ep = eps[Math.floor(Math.random() * eps.length)];
      g.src = ep.url; g.currentTime = 0;
      ghostSet(0);
      try { var pr = g.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
      ghostDrift(ratio);
    });
  }
  function ghostDrift(ratio) {
    ghostEl();
    var v = ratio < 0.55 ? Math.pow(1 - ratio / 0.55, 2) * 0.32 : 0;
    if (ghostGain && AC) { if (Math.abs(v - ghostGain.gain.value) > 0.015) ghostSet(v); }
    else if (Math.abs(v - ghost.volume) > 0.015) ghost.volume = v;
  }

  /* ---------- episode lists: fetched once per station, then cached ---------- */
  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function parseEp(st, coll, fileName) {
    var url = "https://archive.org/download/" + coll + "/" +
      fileName.split("/").map(encodeURIComponent).join("/");
    var base = fileName.split("/").pop().replace(/\.mp3$/i, "");
    try { base = decodeURIComponent(base); } catch (e) {}
    var s = base.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    var date = "";
    var m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      date = MONTHS[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
      s = s.replace(m[0], " ");
    } else if ((m = s.match(/\b(\d{2})-(\d{2})-(\d{2})\b/))) {
      date = MONTHS[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", 19" + m[1];
      s = s.replace(m[0], " ");
    } else if ((m = s.match(/\b(19\d{2})\b/))) {
      date = m[1];
    }
    // tidy the title: drop leading show-name words, ep numbers and codes
    var title = s.replace(/\s+/g, " ").trim()
      .replace(/^\(?\d{1,4}\)?\s+/, "")
      .replace(/^ep\.?\s*\d+\s+/i, "");
    var nameWords = (st.name || "").replace(/^(The|A)\s+/i, "").split(/\s+/);
    var first = title.split(/\s+/)[0] || "";
    if (nameWords.length && first.toLowerCase() === nameWords[0].toLowerCase() && title.split(/\s+/).length > 2) {
      // leave full titles alone unless the show name clearly prefixes them
      var prefix = (st.name || "").replace(/^The\s+/i, "");
      if (title.toLowerCase().indexOf(prefix.toLowerCase()) === 0 && prefix.length > 3)
        title = title.slice(prefix.length).replace(/^[\s\-—:]+/, "").trim() || title;
    }
    title = title.replace(/\s+/g, " ").trim();
    if (!title || /^(intro|introduction|synopsis|biography)/i.test(title)) title = "";
    return { url: url, title: title, date: date };
  }
  function fetchEpisodes(idx, done) {
    var st = stations[idx]; if (!st) { done([]); return; }
    if (epCache[st.name] && epCache[st.name].length) { done(epCache[st.name]); return; }
    var all = [], pending = st.collections.length;
    if (!pending) { done([]); return; }
    st.collections.forEach(function (coll) {
      fetch("https://archive.org/metadata/" + coll)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          (j.files || []).forEach(function (f) {
            if (/\.mp3$/i.test(f.name || "")) all.push(parseEp(st, coll, f.name));
          });
        })
        .catch(function () {})
        .then(function () {
          if (--pending === 0) {
            /* one episode can live in two collections (Benny's guest-star
               sets overlap its year ranges) — shelve each story once */
            var seen = {}, deduped = [];
            all.forEach(function (ep) {
              var key = ep.title ? ep.title.toLowerCase() + "|" + ep.date : ep.url;
              if (seen[key]) return;
              seen[key] = 1; deduped.push(ep);
            });
            deduped.sort(function (a, b) { return a.url < b.url ? -1 : 1; });
            epCache[st.name] = deduped; epCacheTs = Date.now(); persistEpCache(); done(deduped);
          }
        });
    });
  }

  /* ---------- now on the air ---------- */
  function updateNowCard() {
    var st = stations[curIdx];
    if (!st || !powerOn) { nowCard.hidden = true; return; }
    nowCard.hidden = false;
    nowShow.textContent = st.name;
    nowTag.textContent = st.tag || "";
    nowEp.textContent = curEp ? (curEp.title || "A broadcast from the Archive") : "Tuning in…";
    nowDate.textContent = curEp && curEp.date ? "First aired " + curEp.date : "";
    if (st.special) { nowSpecial.hidden = false; nowSpecial.textContent = st.special; }
    else nowSpecial.hidden = true;
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: curEp && curEp.title ? curEp.title : st.name,
          artist: st.name,
          album: "Cathedral — Old Time Radio"
        });
      } catch (e) {}
    }
    syncTransport();
  }
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.setActionHandler("play", function () { if (powerOn) player.play(); });
      navigator.mediaSession.setActionHandler("pause", function () { player.pause(); });
      navigator.mediaSession.setActionHandler("nexttrack", function () { if (powerOn) tuneTo(curIdx + 1); });
      navigator.mediaSession.setActionHandler("previoustrack", function () { if (powerOn) tuneTo(curIdx - 1); });
      navigator.mediaSession.setActionHandler("seekbackward", function () { seekBy(-30); });
      navigator.mediaSession.setActionHandler("seekforward", function () { seekBy(30); });
    } catch (e) {}
  }

  /* ---------- transport: pause, ±30 seconds, another episode, progress ---------- */
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h > 0 ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function syncTransport() {
    var have = !!(powerOn && curEp && player.src);
    btnBack30.disabled = !have; btnFwd30.disabled = !have;
    btnPlayPause.disabled = !have; btnAnother.disabled = !(powerOn && curIdx >= 0);
    var paused = player.paused;
    btnPlayPause.textContent = paused ? "▶" : "❚❚";
    btnPlayPause.setAttribute("aria-label", paused ? "Play" : "Pause");
    if (!have) {
      progressFill.style.width = "0%";
      timeElapsed.textContent = ""; timeRemain.textContent = "";
    }
  }
  function paintProgress() {
    var d = player.duration;
    if (isFinite(d) && d > 0) {
      progressFill.style.width = Math.min(100, (player.currentTime / d) * 100) + "%";
      timeElapsed.textContent = fmtTime(player.currentTime);
      timeRemain.textContent = "−" + fmtTime(d - player.currentTime) + " left";
    }
  }
  function togglePlay() {
    if (!powerOn || !curEp) return;
    if (player.paused) {
      var pr = player.play();
      if (pr && pr.catch) pr.catch(function () {});
    } else {
      player.pause();
      status.textContent = stations[curIdx].name + " — paused. It'll keep your place.";
    }
  }
  function seekBy(sec) {
    if (!powerOn || !curEp) return;
    var d = player.duration;
    var t = (player.currentTime || 0) + sec;
    if (t < 0) t = 0;
    if (isFinite(d) && d > 0 && t > d - 2) t = Math.max(0, d - 2);
    try { player.currentTime = t; } catch (e) {}
    paintProgress();
  }
  btnPlayPause.addEventListener("click", function (e) { e.stopPropagation(); click(800); togglePlay(); });
  btnBack30.addEventListener("click", function (e) { e.stopPropagation(); click(700); seekBy(-30); });
  btnFwd30.addEventListener("click", function (e) { e.stopPropagation(); click(700); seekBy(30); });
  btnAnother.addEventListener("click", function (e) {
    e.stopPropagation();
    if (!powerOn || curIdx < 0) return;
    click(900); failStreak = 0; tuneTo(curIdx, { fresh: true });
  });
  /* tapping the card itself (not a button) pauses or resumes */
  nowCard.addEventListener("click", function () { togglePlay(); });

  /* ---------- tone controls ---------- */
  var toneBtns = document.querySelectorAll("[data-tone]"), btnNight = $("btnNight");
  function paintTone() {
    toneBtns.forEach(function (b) {
      var on = b.getAttribute("data-tone") === toneMode;
      if (on) b.classList.add("active"); else b.classList.remove("active");
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (nightOn) btnNight.classList.add("active"); else btnNight.classList.remove("active");
    btnNight.setAttribute("aria-pressed", nightOn ? "true" : "false");
  }
  toneBtns.forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      toneMode = b.getAttribute("data-tone");
      ac(); applyTone(); paintTone(); saveState(); click(800);
    });
  });
  btnNight.addEventListener("click", function (e) {
    e.stopPropagation();
    nightOn = !nightOn;
    ac(); applyTone(); paintTone(); saveState(); click(nightOn ? 600 : 900);
  });
  paintTone();
  player.addEventListener("timeupdate", paintProgress);
  /* keep the resume point warm while listening (throttled — localStorage is cheap, but not 4× a second) */
  var lastResumeSave = 0;
  player.addEventListener("timeupdate", function () {
    if (!isPlaying) return;
    var now = Date.now();
    if (now - lastResumeSave > 5000) { lastResumeSave = now; saveResume(); }
  });
  player.addEventListener("loadedmetadata", function () {
    if (pendingSeek > 0) { try { player.currentTime = pendingSeek; } catch (e) {} pendingSeek = 0; }
    paintProgress(); syncTransport();
  });
  document.addEventListener("visibilitychange", function () { if (document.hidden) saveResume(); });
  window.addEventListener("pagehide", saveResume);

  /* ---------- failure handling: three tries, then plain words ---------- */
  function handleFail() {
    failStreak++;
    if (failStreak > 3) {
      hiss(0.03); whistleOff(); drawEye(0.2);
      status.textContent = "That station's gone silent on us — three tries and the signal won't hold. Give the tuning knob a turn and try another station.";
      if (curEp) { nowEp.textContent = "The signal won't hold tonight."; nowDate.textContent = "Turn the tuning knob and try another station."; }
      return;
    }
    status.textContent = "That signal faded. Tuning again…";
    var g = curIdx;
    setTimeout(function () { if (powerOn) tuneTo(g); }, 700);
  }

  /* ---------- the knobs have weight: a pointer never snaps to its angle,
     it is carried there by a soft spring — a little lag as it gets going,
     a few degrees past, and a settle — the feel of a heavy Bakelite knob on
     a greased shaft, carried at full motion always. ---------- */
  function knobSpring(el) {
    var a = null, v = 0, t = 0, raf = 0;
    function write() { el.style.transform = "rotate(" + a.toFixed(2) + "deg)"; }
    function step() {
      raf = 0;
      v += (t - a) * 0.18; v *= 0.62; a += v;
      if (Math.abs(t - a) < 0.05 && Math.abs(v) < 0.05) { a = t; v = 0; write(); return; }
      write(); raf = requestAnimationFrame(step);
    }
    return function (deg) {
      t = deg;
      if (a === null) { a = deg; v = 0; write(); return; }
      if (!raf) raf = requestAnimationFrame(step);
    };
  }
  var turnTune = knobSpring(tunePtr), turnVol = knobSpring(volPtr);

  /* ---------- tuning: the needle has mass — a spring chases your finger,
     and the station pulls it the last of the way in ---------- */
  function stationPos(i) { return 13 + (i / Math.max(1, stations.length - 1)) * 74; }
  var sweepPos = 13, sweepTarget = 13, sweepVel = 0, sweeping = false, chaseOn = false, lockIdx = -1;

  function distToNearest(pos) {
    var best = 1e9, idx = 0;
    stations.forEach(function (s, i) {
      var d = Math.abs(stationPos(i) - pos);
      if (d < best) { best = d; idx = i; }
    });
    return { dist: best, idx: idx };
  }

  /* the backlit readout under the glass: while you sweep it names the
     station you're passing (dim, still coming through static); at rest it
     holds the tuned station's full name at full lamp brightness */
  var readoutName = "\u0001", readoutMode = "\u0001";
  function paintReadout() {
    if (!stations.length) return;
    var name = "", mode = "";
    if (powerOn) {
      if (sweeping) { name = stations[distToNearest(sweepPos).idx].name; mode = "seeking"; }
      else if (curIdx >= 0) { name = stations[curIdx].name; mode = "lit"; }
    }
    if (name === readoutName && mode === readoutMode) return;
    readoutName = name; readoutMode = mode;
    stationReadout.textContent = name;
    stationReadout.className = "dial-station" + (mode ? " " + mode : "");
  }

  /* detents: the tuning shaft has 27 notches across its sweep */
  var DETENT = 74 / 27, lastNotch = null;
  function notchTick() {
    var n = Math.round((sweepPos - 13) / DETENT);
    if (lastNotch !== null && n !== lastNotch && (sweeping || chaseOn)) { detent(0.55); buzz(3); }
    lastNotch = n;
  }
  function paintNeedle() {
    needle.style.left = sweepPos + "%";
    notchTick();
    paintReadout();
    /* the tuning knob turns LIVE with the needle, not only at lock */
    if (stations.length > 1) turnTune(-135 + ((sweepPos - 13) / 74) * 270);
    var n = distToNearest(sweepPos);
    var spacing = stations.length > 1 ? 74 / (stations.length - 1) : 74;
    var ratio = Math.min(1, n.dist / (spacing / 2));
    hiss(Math.min(0.2, 0.02 + 0.18 * ratio), 0.04);
    whistle(ratio);
    drawEye(1 - ratio);
    if (sweeping) {
      status.textContent = n.dist < 2 ? stations[n.idx].name + "…" : "Tuning…";
      if (ratio < 0.55) { ghostSeek(n.idx, ratio); ghostDrift(ratio); }
      else ghostDrift(1);
    }
  }

  function chase() {
    /* under the hand the needle is heavy and well damped; let go, and the
       station pulls it in on a looser spring — a hair past, then home */
    var locking = !sweeping && lockIdx >= 0;
    sweepVel += (sweepTarget - sweepPos) * (locking ? 0.09 : 0.11);
    sweepVel *= locking ? 0.76 : 0.65;
    sweepPos += sweepVel;
    if (sweepPos < 5) { sweepPos = 5; sweepVel = 0; }
    if (sweepPos > 95) { sweepPos = 95; sweepVel = 0; }
    paintNeedle();
    if (Math.abs(sweepTarget - sweepPos) > 0.04 || Math.abs(sweepVel) > 0.04) {
      requestAnimationFrame(chase);
    } else {
      chaseOn = false;
      sweepPos = sweepTarget;
      paintNeedle();
      needle.style.transition = "";
      if (!sweeping && lockIdx >= 0) { var li2 = lockIdx; lockIdx = -1; lockFeel(); tuneTo(li2); }
    }
  }
  function startChase() {
    if (chaseOn) return;
    chaseOn = true;
    needle.style.transition = "none";
    requestAnimationFrame(chase);
  }
  function sweepMove(pos) {
    sweepTarget = Math.min(87, Math.max(13, pos));
    sweeping = true; lockIdx = -1; isPlaying = false;
    document.body.classList.remove("listening");
    startChase();
  }
  function sweepEnd() {
    if (!sweeping) return;
    sweeping = false;
    lockIdx = distToNearest(sweepTarget).idx;
    sweepTarget = stationPos(lockIdx);
    startChase();
  }

  function tuneTo(idx, opts) {
    if (!powerOn || !stations.length) return;
    saveResume();   // wherever we were, the old station keeps its place
    var prevUrl = curEp ? curEp.url : "";
    whistleOff();
    curIdx = ((idx % stations.length) + stations.length) % stations.length;
    saveState();
    sweepPos = stationPos(curIdx); sweepTarget = sweepPos; sweepVel = 0;
    lastNotch = Math.round((sweepPos - 13) / DETENT);
    var st = stations[curIdx], gen = ++tuneGen;
    needle.style.left = sweepPos + "%";
    turnTune(-135 + (curIdx / Math.max(1, stations.length - 1)) * 270);
    paintReadout();
    status.textContent = "Tuning…";
    document.body.classList.remove("listening");
    isPlaying = false;
    player.pause();
    hiss(0.16);
    drawEye(0.5);
    resumeUsed = false; pendingSeek = 0; epPlayed = false;
    curEp = null; updateNowCard();
    if (ghostIdx === curIdx && ghost && ghost.src && ghost.readyState >= 2) {
      try {
        player.src = ghost.src;
        player.currentTime = ghost.currentTime || 0;
        var gp = player.play();
        if (gp && gp.catch) gp.catch(function () {});
      } catch (e) {}
      ghostKill();
      return;
    }
    ghostKill();
    fetchEpisodes(curIdx, function (eps) {
      if (gen !== tuneGen || !powerOn) return;
      if (!eps.length) { handleFail(); return; }
      /* resume first: an episode in progress on this station, left part-way,
         beats a fresh draw — unless "another episode" was asked for plainly */
      var ep = null;
      if ((!opts || !opts.fresh) && resumeMap[st.name]) {
        var cand = resumeMap[st.name];
        for (var ri = 0; ri < eps.length; ri++) {
          if (eps[ri].url === cand.url && cand.pos >= 8 && (!cand.dur || cand.pos < cand.dur - 20)) {
            ep = eps[ri]; pendingSeek = cand.pos; resumeUsed = true; break;
          }
        }
      }
      if (!ep) {
        /* never serve the same episode twice running when the shelf has more */
        ep = eps[Math.floor(Math.random() * eps.length)];
        var tries = 0;
        while (eps.length > 1 && ep.url === prevUrl && tries < 4) { ep = eps[Math.floor(Math.random() * eps.length)]; tries++; }
      }
      curEp = ep; updateNowCard();
      player.src = ep.url;
      if (pendingSeek > 0) { try { player.currentTime = pendingSeek; } catch (e) {} }
      try {
        var pr = player.play();
        if (pr && pr.catch) pr.catch(function () { if (gen === tuneGen) status.textContent = "Tap the dial to listen."; });
      } catch (e) {}
    });
  }

  player.addEventListener("playing", function () {
    if (!powerOn) return;
    isPlaying = true; epPlayed = true; failStreak = 0;
    hiss(0);
    if (humNodes) humNodes.stop();
    drawEye(1);
    document.body.classList.add("listening");
    var st = stations[curIdx];
    if (st) status.textContent = resumeUsed ? st.name + " — back where you left it." : st.name + " — on the air.";
    resumeUsed = false;
    updateNowCard();
    syncTransport();
    if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "playing"; } catch (e) {} }
  });
  player.addEventListener("pause", function () {
    isPlaying = false;
    saveResume();
    syncTransport();
    if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "paused"; } catch (e) {} }
  });
  player.addEventListener("waiting", function () { if (powerOn) hiss(0.08); });
  player.addEventListener("error", function () {
    if (!powerOn || curIdx < 0 || !player.src) return;
    isPlaying = false;
    handleFail();
  });
  player.addEventListener("ended", function () {
    /* station break: a breath of static, the chime, then the next episode */
    if (!powerOn) return;
    isPlaying = false;
    if (stations[curIdx]) { delete resumeMap[stations[curIdx].name]; saveState(); }   // finished: no resuming a done episode
    var g0 = tuneGen, idx = curIdx;
    hiss(0.15, 0.1);
    status.textContent = "A word from our sponsor…";
    chime();
    setTimeout(function () { hiss(0.04, 0.3); }, 500);
    setTimeout(function () {
      if (powerOn && tuneGen === g0) tuneTo(idx);
    }, 1700);
  });

  /* ---------- tuning knob: drag to sweep the dial; click = next station ---------- */
  (function wireSweep(el) {
    el.addEventListener("pointerdown", function (e) {
      if (!powerOn) return;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      var x0 = e.clientX, pos0 = sweepTarget, moved = 0;
      player.pause();
      tuneGen++;
      function mv(ev) {
        var dx = ev.clientX - x0;
        moved = Math.max(moved, Math.abs(dx));
        if (moved > 4) sweepMove(pos0 + dx / 2.6);
      }
      function up() {
        el.removeEventListener("pointermove", mv);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        if (moved <= 4) { click(800); lockFeel(); tuneTo(curIdx + 1); }
        else sweepEnd();
      }
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  })(tuneKnob);
  (function wireDialSweep() {
    var glass = dial.querySelector(".dial-glass");
    glass.style.cursor = "ew-resize";
    glass.addEventListener("pointerdown", function (e) {
      if (!powerOn) return;
      var target = e.target;
      if (target && target.dataset && target.dataset.idx !== undefined) return;
      try { glass.setPointerCapture(e.pointerId); } catch (err) {}
      var r = glass.getBoundingClientRect();
      player.pause(); tuneGen++;
      function toPos(ev) { return 13 + ((ev.clientX - r.left) / r.width) * 74; }
      sweepMove(toPos(e));
      function mv(ev) { sweepMove(toPos(ev)); }
      function up() {
        glass.removeEventListener("pointermove", mv);
        glass.removeEventListener("pointerup", up);
        glass.removeEventListener("pointercancel", up);
        sweepEnd();
      }
      glass.addEventListener("pointermove", mv);
      glass.addEventListener("pointerup", up);
      glass.addEventListener("pointercancel", up);
    });
  })();
  /* ---------- volume knob: turns the MASTER gain (every sound obeys) ---------- */
  function paintVol() {
    turnVol(-135 + (muted ? 0 : volLevel) * 270);
  }
  player.volume = 1;   // the element stays at full; the master gain does the work
  paintVol();
  var volNotch = null;
  function setVol(v) {
    volLevel = Math.min(1, Math.max(0, v));
    var vn = Math.round(volLevel * 20);
    if (volNotch !== null && vn !== volNotch) { detent(0.35 + volLevel * 0.4); buzz(3); }
    volNotch = vn;
    if (volLevel > 0) muted = false;
    applyMaster(); paintVol(); saveState();
  }
  volKnob.addEventListener("pointerdown", function (e) {
    try { volKnob.setPointerCapture(e.pointerId); } catch (err) {}
    var y0 = e.clientY, v0 = muted ? 0 : volLevel, moved = 0;
    ac(); click(900); volNotch = Math.round((muted ? 0 : volLevel) * 20);
    function mv(ev) {
      moved = Math.max(moved, Math.abs(ev.clientY - y0));
      setVol(v0 + (y0 - ev.clientY) / 170);
    }
    function up() {
      volKnob.removeEventListener("pointermove", mv);
      volKnob.removeEventListener("pointerup", up);
      volKnob.removeEventListener("pointercancel", up);
      if (moved < 8) { muted = !muted; ac(); applyMaster(); click(muted ? 500 : 1000); buzz(8, true); paintVol(); saveState(); }
    }
    volKnob.addEventListener("pointermove", mv);
    volKnob.addEventListener("pointerup", up);
    volKnob.addEventListener("pointercancel", up);
  });

  /* ---------- arrow keys work the focused knob ---------- */
  tuneKnob.addEventListener("keydown", function (e) {
    if (!powerOn) return;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); click(800); lockFeel(); tuneTo(curIdx + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); click(800); lockFeel(); tuneTo(curIdx - 1); }
  });
  volKnob.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); ac(); setVol((muted ? 0 : volLevel) + 0.05); }   // the detent is the click
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); ac(); setVol((muted ? 0 : volLevel) - 0.05); }
  });

  /* ---------- power ---------- */
  var powerGen = 0;   // guards the warm-up ceremony against a quick off/on
  pow.addEventListener("click", function () {
    thunk(!powerOn); buzz(powerOn ? 14 : 20, true);
    powerGen++;
    if (powerOn) {
      saveResume();   // powering down leaves every station where it was
      powerOn = false; isPlaying = false;
      tuneGen++;
      player.pause();
      hiss(0);
      whistleOff();
      ghostKill();
      drawEye(0.15);
      eyeGlass.classList.remove("lit");
      dial.classList.remove("on"); dial.classList.remove("filament");
      pow.classList.remove("on");
      document.body.classList.remove("listening");
      paintReadout();
      status.textContent = "The set is dark. Turn it on.";
      nowCard.hidden = true;
      progressFill.style.width = "0%"; timeElapsed.textContent = ""; timeRemain.textContent = "";
      breathShown = 0; glowShown = 0.5;   // the set settles as it goes dark
      fretEl.style.transform = ""; grilleEl.style.transform = "";
      dialGlassEl.style.setProperty("--glow", "0.5");
      if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    } else {
      powerOn = true;
      cabinetVoice();
      applyMaster();
      if (!crackleTimer) crackle();
      if (!fadeTimer) fadeLoop();
      /* the warm-up, in the order a real set wakes:
           0 ms     the pilot jewel — the switch is closed
         ~180 ms    the dial lamp's filament glows a dull red…
         ~950 ms    …and warms through to amber as it heats
         ~1500 ms   the B+ relay pulls in: the tubes hum, the magic eye greens
         ~1950 ms   and only then, sound — muffled at first, opening over ~2.6 s */
      var pg = powerGen;
      function stage(ms, fn) { setTimeout(function () { if (powerOn && pg === powerGen) fn(); }, ms); }
      pow.classList.add("on");
      status.textContent = "The tubes are warming…";
      stage(180, function () { dial.classList.add("filament"); });
      stage(950, function () { dial.classList.remove("filament"); dial.classList.add("on"); });
      stage(1500, function () { relayTick(); humOn(); eyeGlass.classList.add("lit"); drawEye(0.3); });
      /* the tubes heat: the broadcast is held muffled until sound arrives, then opens out */
      if (AC && warmLP) {
        var t0 = AC.currentTime;
        warmLP.frequency.cancelScheduledValues(t0);
        warmLP.frequency.setValueAtTime(480, t0);
        warmLP.frequency.setValueAtTime(480, t0 + 1.95);
        warmLP.frequency.exponentialRampToValueAtTime(14000, t0 + 4.6);
      }
      /* prefetch the first station's episodes while the tubes warm */
      var startIdx = curIdx < 0 ? 0 : curIdx;
      if (stations.length) fetchEpisodes(startIdx, function () {});
      stage(1950, function () { tuneTo(curIdx < 0 ? 0 : curIdx); });
    }
  });

  /* ---------- load stations, build the dial ---------- */
  fetch("stations.json")
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (d) {
      stations = d.stations || [];
      /* restore the last station by name (dial order may grow) */
      if (saved.station) {
        for (var k = 0; k < stations.length; k++) if (stations[k].name === saved.station) { curIdx = k; break; }
      }
      stations.forEach(function (st, i) {
        /* the glass carries numbers and ticks only, like the real sets —
           the station's name lives in the backlit readout under the glass */
        var tick = document.createElement("i");
        tick.style.left = stationPos(i) + "%";
        ticksBox.appendChild(tick);
      });
      if (curIdx >= 0) { sweepPos = stationPos(curIdx); sweepTarget = sweepPos; needle.style.left = sweepPos + "%"; }
    })
    .catch(function () { stations = []; });

  /* ---------- first launch: the set fades up from darkness, once. A small
     card names it, then lifts itself (or on a tap) and is never shown again. */
  (function reveal() {
    var root = document.documentElement;
    if (!/\breveal\b/.test(root.className)) return;
    try { localStorage.setItem("cathedral_seen_v1", "1"); } catch (e) {}
    var veil = document.createElement("div");
    veil.className = "reveal-veil";
    veil.setAttribute("role", "presentation");
    veil.innerHTML = '<div class="reveal-card"><div class="rc-name">Cathedral \u00b7 Model 37</div>' +
      '<div class="rc-rule"></div><div class="rc-sub">No. ' + serialNo + '</div></div>';
    document.body.appendChild(veil);
    var card = veil.firstChild, done = false, timers = [];
    function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
    function finish() {
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      root.className = root.className.replace(/\s*\b(reveal|revealing)\b/g, "");
    }
    function lift() {
      if (done) return; done = true;
      timers.forEach(clearTimeout);
      veil.classList.add("lift");
      root.classList.add("revealing");
      setTimeout(finish, 3700);
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () { card.classList.add("in"); }); });
    later(2900, lift);
    veil.addEventListener("click", lift);
    document.addEventListener("keydown", function k() { document.removeEventListener("keydown", k); lift(); });
  })();

  /* the shell lives on the device: instant opens, and the set shows its
     face even with no signal (broadcasts still need the network, honestly) */
  if ("serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) {}
  }

  // test hook
  window.__cathedral = {
    get stations() { return stations; },
    get curIdx() { return curIdx; },
    get vol() { return volLevel; },
    get tone() { return toneMode; },
    get night() { return nightOn; },
    get breath() { return breathShown; },
    get glow() { return glowShown; },
    get eq() { return eqDone && eqBox ? { boxGain: eqBox.gain.value, lp: eqLP.frequency.value, pres: eqPresence.gain.value, compThr: eqComp.threshold.value, compRatio: eqComp.ratio.value } : null; },
    get failStreak() { return failStreak; },
    get serial() { return serialNo; },
    get readout() { return stationReadout.textContent + "|" + stationReadout.className; },
    get fx() { return { bus: fx, detent: detent, thunk: thunk, relay: relayTick, click: click, lock: lockFeel }; },
    tune: tuneTo,
    power: function () { pow.click(); }
  };
})();
