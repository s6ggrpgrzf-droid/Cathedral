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

  /* ---------- audio: synth clicks + static ---------- */
  var AC = null, hissGain = null;
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

  /* ---------- tuning ---------- */
  function stationPos(i) { return 5 + (i / Math.max(1, stations.length - 1)) * 90; }

  function tuneTo(idx) {
    if (!powerOn || !stations.length) return;
    curIdx = ((idx % stations.length) + stations.length) % stations.length;
    var st = stations[curIdx], gen = ++tuneGen;
    needle.style.left = stationPos(curIdx) + "%";
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

  /* ---------- tuning knob: click = next station, also spin visual ---------- */
  tuneKnob.addEventListener("click", function () {
    if (!powerOn) return;
    click(800);
    tuneTo(curIdx + 1);
  });
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
      tuneTo(curIdx < 0 ? 0 : curIdx);
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
