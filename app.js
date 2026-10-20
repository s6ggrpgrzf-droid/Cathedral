/* Cathedral — old time radio. Turn the knob, tune through the static, land on a show. */
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }

  var player = $("player"), dial = $("dial"), needle = $("needle"),
      labelsBox = $("dialLabels"), status = $("dialStatus"),
      tuneKnob = $("knobTune"), tunePtr = $("tunePtr"),
      volKnob = $("knobVol"), volPtr = $("volPtr"),
      pow = $("btnPower");

  var stations = [], curIdx = -1, powerOn = false;
  var epCache = {};          // station idx -> [episode urls]
  var tuneGen = 0;           // guards async races while tuning

  /* ---------- audio: synth clicks, static, and the tube hum ---------- */
  var AC = null, hissGain = null, humNodes = null;
  function ac() {
    if (!AC) {
      try {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        // looping white-noise buffer for the static
        var len = AC.sampleRate * 2;
        var buf = AC.createBuffer(1, len, AC.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        var src = AC.createBufferSource();
        src.buffer = buf; src.loop = true;
        var filt = AC.createBiquadFilter();
        filt.type = "bandpass"; filt.frequency.value = 1800; filt.Q.value = 0.4;
        hissGain = AC.createGain(); hissGain.gain.value = 0;
        src.connect(filt); filt.connect(hissGain); hissGain.connect(AC.destination);
        src.start();
      } catch (e) {}
    }
    if (AC && AC.state === "suspended") AC.resume();
    return AC;
  }
  function hiss(level, ramp) {
    var a = ac(); if (!a || !hissGain) return;
    hissGain.gain.cancelScheduledValues(a.currentTime);
    hissGain.gain.setTargetAtTime(level, a.currentTime, ramp || 0.08);
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
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(a.destination);
    o1.start(); o2.start();
    humNodes = { g: g, stop: function () {
      g.gain.setTargetAtTime(0.0001, a.currentTime, 0.25);
      setTimeout(function () { try { o1.stop(); o2.stop(); } catch (e) {} }, 900);
      humNodes = null;
    } };
  }
  function click(freq) {
    var a = ac(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = "square"; o.frequency.value = freq || 700;
    g.gain.setValueAtTime(0.05, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.05);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + 0.07);
  }
  function thunk() {
    var a = ac(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(110, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(40, a.currentTime + 0.16);
    g.gain.setValueAtTime(0.2, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.2);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + 0.22);
  }

  /* ---------- episode lists (fetched once per station, then cached) ---------- */
  function fetchEpisodes(idx, done) {
    if (epCache[idx]) { done(epCache[idx]); return; }
    var st = stations[idx], all = [], pending = st.collections.length;
    if (!pending) { done([]); return; }
    st.collections.forEach(function (coll) {
      fetch("https://archive.org/metadata/" + coll)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          (j.files || []).forEach(function (f) {
            if (/\.mp3$/i.test(f.name || "")) {
              all.push("https://archive.org/download/" + coll + "/" +
                f.name.split("/").map(encodeURIComponent).join("/"));
            }
          });
        })
        .catch(function () {})
        .then(function () {
          if (--pending === 0) { epCache[idx] = all; done(all); }
        });
    });
  }

  /* ---------- tuning: sweep the dial, snap to the nearest station ---------- */
  function stationPos(i) { return 5 + (i / Math.max(1, stations.length - 1)) * 90; }
  var sweepPos = 5;        // needle position in % while sweeping (5..95)
  var sweeping = false;

  function distToNearest(pos) {
    var best = 1e9, idx = 0;
    stations.forEach(function (s, i) {
      var d = Math.abs(stationPos(i) - pos);
      if (d < best) { best = d; idx = i; }
    });
    return { dist: best, idx: idx };
  }

  function sweepMove(pos) {
    sweepPos = Math.min(95, Math.max(5, pos));
    sweeping = true;
    var n = distToNearest(sweepPos);
    needle.style.left = sweepPos + "%";
    status.textContent = n.dist < 2 ? stations[n.idx].name + "…" : "Tuning…";
    document.body.classList.remove("listening");
    // static swells between stations, dies as you approach one
    var spacing = stations.length > 1 ? 90 / (stations.length - 1) : 90;
    hiss(Math.min(0.2, 0.02 + 0.18 * Math.min(1, n.dist / (spacing / 2))), 0.04);
  }

  function sweepEnd() {
    if (!sweeping) return;
    sweeping = false;
    tuneTo(distToNearest(sweepPos).idx);
  }

  function tuneTo(idx) {
    if (!powerOn || !stations.length) return;
    curIdx = ((idx % stations.length) + stations.length) % stations.length;
    sweepPos = stationPos(curIdx);
    var st = stations[curIdx], gen = ++tuneGen;
    needle.style.left = sweepPos + "%";
    tunePtr.style.transform = "rotate(" + (-135 + (curIdx / (stations.length - 1)) * 270) + "deg)";
    status.textContent = "Tuning…";
    document.body.classList.remove("listening");
    player.pause();
    hiss(0.16);
    fetchEpisodes(curIdx, function (eps) {
      if (gen !== tuneGen || !powerOn) return;
      if (!eps.length) { status.textContent = "Nothing but static on this band."; hiss(0.05); return; }
      var url = eps[Math.floor(Math.random() * eps.length)];
      player.src = url;
      try {
        var pr = player.play();
        if (pr && pr.catch) pr.catch(function () { if (gen === tuneGen) status.textContent = "Tap the dial to listen."; });
      } catch (e) {}
    });
  }

  player.addEventListener("playing", function () {
    if (!powerOn) return;
    hiss(0);
    if (humNodes) humNodes.stop();
    document.body.classList.add("listening");
    var st = stations[curIdx];
    if (st) status.textContent = st.name + " — on the air.";
  });
  player.addEventListener("waiting", function () { if (powerOn) hiss(0.08); });
  player.addEventListener("error", function () {
    if (!powerOn || curIdx < 0) return;
    status.textContent = "That signal faded. Tuning again…";
    var g = curIdx;
    setTimeout(function () { if (powerOn) tuneTo(g); }, 600);
  });
  player.addEventListener("ended", function () {
    // one episode ends, another from the same station fades up
    if (powerOn) tuneTo(curIdx);
  });

  /* ---------- tuning knob: drag to sweep the dial; click = next station ---------- */
  (function wireSweep(el) {
    el.addEventListener("pointerdown", function (e) {
      if (!powerOn) return;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      var x0 = e.clientX, pos0 = sweepPos, moved = 0;
      player.pause();
      tuneGen++;   // cancel any in-flight tune
      function mv(ev) {
        var dx = ev.clientX - x0;
        moved = Math.max(moved, Math.abs(dx));
        if (moved > 4) sweepMove(pos0 + dx / 2.6);   // ~235px = full band
      }
      function up() {
        el.removeEventListener("pointermove", mv);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        if (moved <= 4) { click(800); tuneTo(curIdx + 1); }   // simple tap
        else sweepEnd();
      }
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  })(tuneKnob);
  // and the dial face itself sweeps on drag
  (function wireDialSweep() {
    var glass = dial.querySelector(".dial-glass");
    glass.style.cursor = "ew-resize";
    glass.addEventListener("pointerdown", function (e) {
      if (!powerOn) return;
      var target = e.target;
      if (target && target.dataset && target.dataset.idx !== undefined) return; // label clicks handled separately
      try { glass.setPointerCapture(e.pointerId); } catch (err) {}
      var r = glass.getBoundingClientRect(), movedY = 0;
      player.pause(); tuneGen++;
      function toPos(ev) { return 5 + ((ev.clientX - r.left) / r.width) * 90; }
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
  // tapping a dial label tunes straight there
  labelsBox.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.dataset && t.dataset.idx !== undefined) {
      if (!powerOn) return;
      click(800);
      tuneTo(parseInt(t.dataset.idx, 10));
    }
  });

  /* ---------- volume knob ---------- */
  function paintVol() {
    var v = player.muted ? 0 : player.volume;
    volPtr.style.transform = "rotate(" + (-135 + v * 270) + "deg)";
  }
  player.volume = 0.75; paintVol();
  volKnob.addEventListener("pointerdown", function (e) {
    try { volKnob.setPointerCapture(e.pointerId); } catch (err) {}
    var y0 = e.clientY, v0 = player.muted ? 0 : player.volume, moved = 0;
    click(900);
    function mv(ev) {
      moved = Math.max(moved, Math.abs(ev.clientY - y0));
      player.volume = Math.min(1, Math.max(0, v0 + (y0 - ev.clientY) / 170));
      player.muted = false; paintVol();
    }
    function up() {
      volKnob.removeEventListener("pointermove", mv);
      volKnob.removeEventListener("pointerup", up);
      volKnob.removeEventListener("pointercancel", up);
      if (moved < 8) { player.muted = !player.muted; click(player.muted ? 500 : 1000); paintVol(); }
    }
    volKnob.addEventListener("pointermove", mv);
    volKnob.addEventListener("pointerup", up);
    volKnob.addEventListener("pointercancel", up);
  });

  /* ---------- power ---------- */
  pow.addEventListener("click", function () {
    thunk();
    if (powerOn) {
      powerOn = false;
      tuneGen++;
      player.pause();
      hiss(0);
      dial.classList.remove("on");
      pow.classList.remove("on");
      document.body.classList.remove("listening");
      status.textContent = "The set is dark. Turn it on.";
    } else {
      powerOn = true;
      dial.classList.add("on");
      pow.classList.add("on");
      status.textContent = "The tubes are warming…";
      humOn();                                  // mains hum while the tubes heat
      setTimeout(function () {                  // then the set comes alive
        if (powerOn) tuneTo(curIdx < 0 ? 0 : curIdx);
      }, 1100);
    }
  });

  /* ---------- load stations, build the dial ---------- */
  fetch("stations.json")
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (d) {
      stations = d.stations || [];
      stations.forEach(function (st, i) {
        var s = document.createElement("span");
        s.textContent = st.dial;
        s.dataset.idx = i;
        s.style.left = stationPos(i) + "%";
        s.style.cursor = "pointer";
        labelsBox.appendChild(s);
      });
    })
    .catch(function () { stations = []; });

  // test hook
  window.__cathedral = {
    get stations() { return stations; },
    get curIdx() { return curIdx; },
    tune: tuneTo,
    power: function () { pow.click(); }
  };
})();
