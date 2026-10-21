/* Cathedral — old time radio. Turn the knob, tune through the static, land on a show. */
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }

  var REDUCED = false;
  try { REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  var player = $("player"), dial = $("dial"), needle = $("needle"),
      labelsBox = $("dialLabels"), status = $("dialStatus"),
      tuneKnob = $("knobTune"), tunePtr = $("tunePtr"),
      volKnob = $("knobVol"), volPtr = $("volPtr"),
      pow = $("btnPower");
  var nowCard = $("nowCard"), nowShow = $("nowShow"), nowTag = $("nowTag"),
      nowEp = $("nowEp"), nowDate = $("nowDate"), nowSpecial = $("nowSpecial");

  var stations = [], curIdx = -1, powerOn = false, isPlaying = false;
  var ticksBox = $("dialTicks");
  var epCache = {};          // station name -> [{url,title,date}]
  var tuneGen = 0;           // guards async races while tuning
  var failStreak = 0;        // consecutive failed streams (cap: 3 tries)
  var curEp = null;
  var eyeGlass = $("eyeGlass"), eyeWedge = $("eyeWedge");

  /* ---------- remembered station & volume ---------- */
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem("cathedral_state_v1") || "{}") || {}; } catch (e) { saved = {}; }
  var volLevel = (typeof saved.vol === "number") ? Math.min(1, Math.max(0, saved.vol)) : 0.75;
  var muted = !!saved.muted;
  function saveState() {
    try {
      var name = (curIdx >= 0 && stations[curIdx]) ? stations[curIdx].name : saved.station;
      localStorage.setItem("cathedral_state_v1", JSON.stringify({ station: name, vol: volLevel, muted: muted }));
    } catch (e) {}
  }
  /* episode-list cache (localStorage) so the first tune is fast */
  try {
    var c = JSON.parse(localStorage.getItem("cathedral_eps_v1") || "{}");
    if (c && typeof c === "object") epCache = c;
  } catch (e) {}
  function persistEpCache() { try { localStorage.setItem("cathedral_eps_v1", JSON.stringify(epCache)); } catch (e) {} }

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
  /* flutter loop: the wedge breathes with the broadcast level (AnalyserNode) */
  var analyser = null, eyeData = null;
  (function eyeLoop() {
    requestAnimationFrame(eyeLoop);
    if (!powerOn || REDUCED || !analyser) return;
    if (!eyeData) eyeData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(eyeData);
    var sum = 0;
    for (var i = 0; i < eyeData.length; i++) { var v = (eyeData[i] - 128) / 128; sum += v * v; }
    var rms = Math.sqrt(sum / eyeData.length);
    var target = Math.min(1, Math.max(0, eyeBase * (0.88 + Math.min(0.5, rms * 2.6))));
    eyeShown += (target - eyeShown) * 0.35;
    drawEyeRaw(eyeShown);
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
      var t = a.currentTime, amp = (0.05 + Math.random() * 0.1) * (lastHiss > 0.04 ? 1 : 0.35);
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
  var eqDone = false;
  function cabinetVoice() {
    var a = ac(); if (!a || eqDone) return; eqDone = true;
    try {
      var src = a.createMediaElementSource(player);
      warmLP = a.createBiquadFilter(); warmLP.type = "lowpass"; warmLP.frequency.value = 14000;
      var hp = a.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 170;
      var box = a.createBiquadFilter(); box.type = "peaking";
      box.frequency.value = 740; box.Q.value = 0.7; box.gain.value = 4.5;
      var lp = a.createBiquadFilter(); lp.type = "lowpass";
      lp.frequency.value = 2700; lp.Q.value = 0.4;
      var shaper = a.createWaveShaper();
      var curve = new Float32Array(256);
      for (var i = 0; i < 256; i++) { var x = i / 128 - 1; curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); }
      shaper.curve = curve; shaper.oversample = "2x";
      fadeGain = a.createGain(); fadeGain.gain.value = 0.95;
      analyser = a.createAnalyser(); analyser.fftSize = 256;
      src.connect(warmLP); warmLP.connect(hp); hp.connect(box); box.connect(lp);
      lp.connect(shaper); shaper.connect(fadeGain); fadeGain.connect(analyser); analyser.connect(master);
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
  function click(freq) {
    var a = ac(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = "square"; o.frequency.value = freq || 700;
    g.gain.setValueAtTime(0.05, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.05);
    o.connect(g); g.connect(out());
    o.start(); o.stop(a.currentTime + 0.07);
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
  function thunk() {
    var a = ac(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(110, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(40, a.currentTime + 0.16);
    g.gain.setValueAtTime(0.2, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.2);
    o.connect(g); g.connect(out());
    o.start(); o.stop(a.currentTime + 0.22);
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
            all.sort(function (a, b) { return a.url < b.url ? -1 : 1; });
            epCache[st.name] = all; persistEpCache(); done(all);
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
  }
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.setActionHandler("play", function () { if (powerOn) player.play(); });
      navigator.mediaSession.setActionHandler("pause", function () { player.pause(); });
      navigator.mediaSession.setActionHandler("nexttrack", function () { if (powerOn) tuneTo(curIdx + 1); });
      navigator.mediaSession.setActionHandler("previoustrack", function () { if (powerOn) tuneTo(curIdx - 1); });
    } catch (e) {}
  }

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

  function paintNeedle() {
    needle.style.left = sweepPos + "%";
    /* the tuning knob turns LIVE with the needle, not only at lock */
    if (stations.length > 1) tunePtr.style.transform = "rotate(" + (-135 + ((sweepPos - 13) / 74) * 270) + "deg)";
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
    if (REDUCED) {   // reduced motion: the needle simply goes there
      sweepPos = sweepTarget; sweepVel = 0; chaseOn = false;
      needle.style.transition = "";
      paintNeedle();
      if (!sweeping && lockIdx >= 0) { var li = lockIdx; lockIdx = -1; tuneTo(li); }
      return;
    }
    sweepVel += (sweepTarget - sweepPos) * 0.16;
    sweepVel *= 0.68;
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
      if (!sweeping && lockIdx >= 0) { var li2 = lockIdx; lockIdx = -1; tuneTo(li2); }
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

  function tuneTo(idx) {
    if (!powerOn || !stations.length) return;
    whistleOff();
    curIdx = ((idx % stations.length) + stations.length) % stations.length;
    saveState();
    sweepPos = stationPos(curIdx); sweepTarget = sweepPos; sweepVel = 0;
    var st = stations[curIdx], gen = ++tuneGen;
    needle.style.left = sweepPos + "%";
    tunePtr.style.transform = "rotate(" + (-135 + (curIdx / Math.max(1, stations.length - 1)) * 270) + "deg)";
    status.textContent = "Tuning…";
    document.body.classList.remove("listening");
    isPlaying = false;
    player.pause();
    hiss(0.16);
    drawEye(0.5);
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
      var ep = eps[Math.floor(Math.random() * eps.length)];
      curEp = ep; updateNowCard();
      player.src = ep.url;
      try {
        var pr = player.play();
        if (pr && pr.catch) pr.catch(function () { if (gen === tuneGen) status.textContent = "Tap the dial to listen."; });
      } catch (e) {}
    });
  }

  player.addEventListener("playing", function () {
    if (!powerOn) return;
    isPlaying = true; failStreak = 0;
    hiss(0);
    if (humNodes) humNodes.stop();
    drawEye(1);
    document.body.classList.add("listening");
    var st = stations[curIdx];
    if (st) status.textContent = st.name + " — on the air.";
    updateNowCard();
    if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "playing"; } catch (e) {} }
  });
  player.addEventListener("pause", function () {
    isPlaying = false;
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
        if (moved <= 4) { click(800); tuneTo(curIdx + 1); }
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
  labelsBox.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.dataset && t.dataset.idx !== undefined) {
      if (!powerOn) return;
      click(800);
      tuneTo(parseInt(t.dataset.idx, 10));
    }
  });

  /* ---------- volume knob: turns the MASTER gain (every sound obeys) ---------- */
  function paintVol() {
    volPtr.style.transform = "rotate(" + (-135 + (muted ? 0 : volLevel) * 270) + "deg)";
  }
  player.volume = 1;   // the element stays at full; the master gain does the work
  paintVol();
  function setVol(v) {
    volLevel = Math.min(1, Math.max(0, v));
    if (volLevel > 0) muted = false;
    applyMaster(); paintVol(); saveState();
  }
  volKnob.addEventListener("pointerdown", function (e) {
    try { volKnob.setPointerCapture(e.pointerId); } catch (err) {}
    var y0 = e.clientY, v0 = muted ? 0 : volLevel, moved = 0;
    ac(); click(900);
    function mv(ev) {
      moved = Math.max(moved, Math.abs(ev.clientY - y0));
      setVol(v0 + (y0 - ev.clientY) / 170);
    }
    function up() {
      volKnob.removeEventListener("pointermove", mv);
      volKnob.removeEventListener("pointerup", up);
      volKnob.removeEventListener("pointercancel", up);
      if (moved < 8) { muted = !muted; ac(); applyMaster(); click(muted ? 500 : 1000); paintVol(); saveState(); }
    }
    volKnob.addEventListener("pointermove", mv);
    volKnob.addEventListener("pointerup", up);
    volKnob.addEventListener("pointercancel", up);
  });

  /* ---------- arrow keys work the focused knob ---------- */
  tuneKnob.addEventListener("keydown", function (e) {
    if (!powerOn) return;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); click(800); tuneTo(curIdx + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); click(800); tuneTo(curIdx - 1); }
  });
  volKnob.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); ac(); setVol((muted ? 0 : volLevel) + 0.05); click(1000); }
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); ac(); setVol((muted ? 0 : volLevel) - 0.05); click(700); }
  });

  /* ---------- power ---------- */
  pow.addEventListener("click", function () {
    thunk();
    if (powerOn) {
      powerOn = false; isPlaying = false;
      tuneGen++;
      player.pause();
      hiss(0);
      whistleOff();
      ghostKill();
      drawEye(0.15);
      eyeGlass.classList.remove("lit");
      dial.classList.remove("on");
      pow.classList.remove("on");
      document.body.classList.remove("listening");
      status.textContent = "The set is dark. Turn it on.";
      nowCard.hidden = true;
      if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    } else {
      powerOn = true;
      cabinetVoice();
      applyMaster();
      if (!crackleTimer) crackle();
      if (!fadeTimer) fadeLoop();
      dial.classList.add("on");
      eyeGlass.classList.add("lit");
      pow.classList.add("on");
      status.textContent = "The tubes are warming…";
      humOn();
      /* the tubes heat: the broadcast fades from muffled to full over ~3 seconds */
      if (AC && warmLP) {
        warmLP.frequency.cancelScheduledValues(AC.currentTime);
        warmLP.frequency.setValueAtTime(480, AC.currentTime);
        warmLP.frequency.exponentialRampToValueAtTime(14000, AC.currentTime + 3);
      }
      /* prefetch the first station's episodes while the tubes warm */
      var startIdx = curIdx < 0 ? 0 : curIdx;
      if (stations.length) fetchEpisodes(startIdx, function () {});
      setTimeout(function () {
        if (powerOn) tuneTo(curIdx < 0 ? 0 : curIdx);
      }, 1100);
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
        var s = document.createElement("span");
        s.textContent = st.dial;
        s.dataset.idx = i;
        s.style.left = stationPos(i) + "%";
        /* labels ride the curved glass arc in two staggered rows — high at
           centre, falling to the ends — so 13 stations never collide */
        var frac = stations.length > 1 ? i / (stations.length - 1) : 0.5;
        var arc = Math.pow(2 * frac - 1, 2);
        s.style.top = (i % 2 === 0 ? 20 + 16 * arc : 61 + 11 * arc) + "%";
        s.style.cursor = "pointer";
        labelsBox.appendChild(s);
        var tick = document.createElement("i");
        tick.style.left = stationPos(i) + "%";
        ticksBox.appendChild(tick);
      });
      if (curIdx >= 0) { sweepPos = stationPos(curIdx); sweepTarget = sweepPos; needle.style.left = sweepPos + "%"; }
    })
    .catch(function () { stations = []; });

  // test hook
  window.__cathedral = {
    get stations() { return stations; },
    get curIdx() { return curIdx; },
    get vol() { return volLevel; },
    get failStreak() { return failStreak; },
    tune: tuneTo,
    power: function () { pow.click(); }
  };
})();
